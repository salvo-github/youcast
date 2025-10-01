# Optimized multi-stage build targeting ~250MB final image
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install && \
    npm install --no-save @rollup/plugin-node-resolve @rollup/plugin-commonjs @rollup/plugin-json @rollup/plugin-terser rollup compression helmet express-rate-limit
COPY . .
RUN cat > rollup.config.js << 'EOF'
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import terser from '@rollup/plugin-terser';

export default {
  input: 'server.js',
  output: {
    file: 'app.bundle.js',
    format: 'es',
    inlineDynamicImports: true
  },
  plugins: [
    nodeResolve({
      preferBuiltins: true,
      exportConditions: ['node'],
    }),
    commonjs({
      ignoreDynamicRequires: true,
    }),
    json(),
    terser({
      compress: {
        drop_console: false, // Keep console logs for server debugging
        drop_debugger: true,
        pure_funcs: ['console.debug'],
      },
      mangle: {
        keep_classnames: false,
        keep_fnames: false, // More aggressive minification
      },
      format: {
        comments: false, // Remove comments to reduce size
      }
    })
  ],
  external: [
    'fs', 'path', 'os', 'child_process', 'stream', 'events', 
    'util', 'url', 'crypto', 'http', 'https', 'net', 'tty', 
    'readline', 'zlib', 'buffer', 'async_hooks', 'dns', 
    'querystring', 'assert', 'timers', 'console'
  ]
};
EOF
RUN node_modules/.bin/rollup -c

# Final production stage - optimized for size and docker-compose compatibility
FROM node:22-alpine AS production

# Install runtime dependencies using Alpine packages (much smaller)
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ca-certificates \
    curl \
    dumb-init \
    xz \
    && rm -rf /var/cache/apk/*

# Install latest FFmpeg from BtbN/FFmpeg-Builds (master branch, daily CI-tested builds)
RUN ARCH=$(uname -m | sed 's/x86_64/linux64/;s/aarch64/linuxarm64/') && \
    curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-${ARCH}-gpl.tar.xz" \
    -o /tmp/ffmpeg.tar.xz && \
    mkdir -p /tmp/ffmpeg /var/lib && \
    tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1 && \
    cp /tmp/ffmpeg/bin/ffmpeg /usr/local/bin/ && \
    cp /tmp/ffmpeg/bin/ffprobe /usr/local/bin/ && \
    chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe && \
    curl -s --connect-timeout 5 --max-time 10 "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest" 2>/dev/null | \
    grep -o '"name":[^,]*' | head -1 | cut -d'"' -f4 > /var/lib/ffmpeg-release-name && \
    rm -rf /tmp/ffmpeg*

# Install Supercronic (rootless cron for Docker)
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') && \
    curl -fsSL "https://github.com/aptible/supercronic/releases/download/v0.2.29/supercronic-linux-${ARCH}" \
    -o /usr/local/bin/supercronic && \
    chmod +x /usr/local/bin/supercronic

# Install latest yt-dlp with force upgrade to ensure YouTube compatibility
RUN python3 -m pip install --no-cache-dir --break-system-packages --upgrade --force-reinstall yt-dlp && \
    yt-dlp --version && \
    rm -rf /root/.cache /tmp/* /var/tmp/*

WORKDIR /app

# Copy essential files (docker-compose user: property will handle ownership)
COPY --from=builder /app/app.bundle.js ./
COPY --from=builder /app/config ./config

# Create symlink for config path resolution and make directories accessible
RUN ln -sf /app/config /config && \
    chmod -R 755 /app

# Create update script for dependencies
RUN cat > /usr/local/bin/update-deps.sh << 'EOF'
#!/bin/sh
set -e

# Function to log with timestamp and level (matching YouCast logger format)
log() {
    local level="${1:-INFO}"
    local message="$2"
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local level_padded=$(printf "%-5s" "$level")
    local component_padded=$(printf "%-15s" "UPDATE-DEPS")
    echo "${timestamp} [${level_padded}] ${component_padded} ${message}"
}

# Reusable function to install/update FFmpeg from BtbN/FFmpeg-Builds
install_ffmpeg_latest() {
    local install_dir="${1:-/usr/local/bin}"
    local temp_dir="/tmp/ffmpeg-update-$$"
    
    # Detect architecture for BtbN builds (linux64 or linuxarm64)
    ARCH=$(uname -m | sed 's/x86_64/linux64/;s/aarch64/linuxarm64/')
    
    # Create temporary directory
    mkdir -p "$temp_dir"
    
    # Download latest FFmpeg from BtbN/FFmpeg-Builds (master, daily CI-tested)
    if curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-${ARCH}-gpl.tar.xz" \
        -o "$temp_dir/ffmpeg.tar.xz" --connect-timeout 30 --max-time 300 2>/dev/null; then
        
        # Extract and install (BtbN builds have binaries in bin/ subdirectory)
        if tar -xJf "$temp_dir/ffmpeg.tar.xz" -C "$temp_dir" --strip-components=1 2>/dev/null; then
            # Check if we have write permissions to install directory
            if [ -w "$install_dir" ] || [ "$(whoami)" = "root" ]; then
                cp "$temp_dir/bin/ffmpeg" "$install_dir/" && \
                cp "$temp_dir/bin/ffprobe" "$install_dir/" && \
                chmod +x "$install_dir/ffmpeg" "$install_dir/ffprobe"
                
                # Verify installation
                if command -v "$install_dir/ffmpeg" >/dev/null 2>&1; then
                    NEW_VERSION=$("$install_dir/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
                    log "INFO" "FFmpeg updated to $NEW_VERSION"
                    
                    # Update PATH if not already included
                    case ":$PATH:" in
                        *":$install_dir:"*) ;;
                        *) export PATH="$install_dir:$PATH" ;;
                    esac
                else
                    log "ERROR" "FFmpeg installation verification failed"
                    return 1
                fi
            else
                log "WARN" "No write permission to $install_dir"
                return 1
            fi
        else
            log "ERROR" "Failed to extract FFmpeg archive"
            return 1
        fi
    else
        log "ERROR" "Failed to download FFmpeg"
        return 1
    fi
    
    # Cleanup
    rm -rf "$temp_dir"
    return 0
}

log "INFO" "Checking for dependency updates..."

# Check and update yt-dlp
CURRENT_YT_DLP=$(yt-dlp --version 2>/dev/null || echo "not installed")

# Get latest yt-dlp version from GitHub API with timeout
LATEST_YT_DLP=""
if command -v curl >/dev/null 2>&1; then
    # More robust JSON parsing for tag_name
    LATEST_YT_DLP=$(curl -s --connect-timeout 10 --max-time 15 https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
    # Fallback if sed parsing fails
    if [ -z "$LATEST_YT_DLP" ]; then
        LATEST_YT_DLP=$(curl -s --connect-timeout 10 --max-time 15 https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest 2>/dev/null | grep -o '"tag_name":"[^"]*"' | cut -d'"' -f4)
    fi
fi

if [ -n "$LATEST_YT_DLP" ] && [ "$CURRENT_YT_DLP" != "$LATEST_YT_DLP" ]; then
    log "INFO" "Updating yt-dlp: $CURRENT_YT_DLP → $LATEST_YT_DLP"
    if python3 -m pip install --no-cache-dir --break-system-packages --upgrade --force-reinstall yt-dlp >/dev/null 2>&1; then
        log "INFO" "yt-dlp updated to $(yt-dlp --version)"
    else
        log "ERROR" "Failed to update yt-dlp"
    fi
elif [ -n "$LATEST_YT_DLP" ]; then
    log "INFO" "yt-dlp up to date ($CURRENT_YT_DLP)"
else
    log "WARN" "Could not check yt-dlp updates"
fi

# Check and update FFmpeg using GitHub API (fast, no large downloads)
CURRENT_FFMPEG=$(ffmpeg -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "not installed")

# Marker file to track installed release name (e.g., "Latest Auto-Build (2025-10-01 13:33)")
FFMPEG_RELEASE_MARKER="/var/lib/ffmpeg-release-name"

# Get current installed release name
CURRENT_RELEASE_NAME=""
if [ -f "$FFMPEG_RELEASE_MARKER" ]; then
    CURRENT_RELEASE_NAME=$(cat "$FFMPEG_RELEASE_MARKER" 2>/dev/null || echo "")
fi

# Check latest release using GitHub API (lightweight, ~1KB response)
LATEST_RELEASE_NAME=""
if command -v curl >/dev/null 2>&1; then
    # Get latest release name from GitHub API (contains actual build date/time)
    LATEST_RELEASE_NAME=$(curl -s --connect-timeout 5 --max-time 10 \
        "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest" 2>/dev/null | \
        grep -o '"name":[^,]*' | head -1 | cut -d'"' -f4)
fi

# Compare release names and update if different
if [ -n "$LATEST_RELEASE_NAME" ]; then
    if [ -z "$CURRENT_RELEASE_NAME" ]; then
        log "INFO" "Installing FFmpeg..."
        # First time or marker missing - install
        if install_ffmpeg_latest; then
            echo "$LATEST_RELEASE_NAME" > "$FFMPEG_RELEASE_MARKER"
        fi
    elif [ "$CURRENT_RELEASE_NAME" != "$LATEST_RELEASE_NAME" ]; then
        log "INFO" "FFmpeg update available: $LATEST_RELEASE_NAME"
        if install_ffmpeg_latest; then
            echo "$LATEST_RELEASE_NAME" > "$FFMPEG_RELEASE_MARKER"
        fi
    else
        log "INFO" "FFmpeg up to date ($CURRENT_FFMPEG)"
    fi
else
    log "WARN" "Could not check FFmpeg updates"
fi

log "INFO" "Dependency check complete"
EOF

# Create standalone FFmpeg update script for manual usage
RUN cat > /usr/local/bin/update-ffmpeg.sh << 'EOF'
#!/bin/sh
set -e

# Function to log with timestamp and level (matching YouCast logger format)
log() {
    local level="${1:-INFO}"
    local message="$2"
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local level_padded=$(printf "%-5s" "$level")
    local component_padded=$(printf "%-15s" "FFMPEG-UPDATE")
    echo "${timestamp} [${level_padded}] ${component_padded} ${message}"
}

# Reusable function to install/update FFmpeg from BtbN/FFmpeg-Builds
install_ffmpeg_latest() {
    local install_dir="${1:-/usr/local/bin}"
    local temp_dir="/tmp/ffmpeg-update-$$"
    
    log "INFO" "Installing/updating FFmpeg to latest version..."
    
    # Detect architecture for BtbN builds (linux64 or linuxarm64)
    ARCH=$(uname -m | sed 's/x86_64/linux64/;s/aarch64/linuxarm64/')
    log "INFO" "Detected architecture: $ARCH"
    
    # Create temporary directory
    mkdir -p "$temp_dir"
    
    # Download latest FFmpeg from BtbN/FFmpeg-Builds (master, daily CI-tested)
    if curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-${ARCH}-gpl.tar.xz" \
        -o "$temp_dir/ffmpeg.tar.xz" --connect-timeout 30 --max-time 300; then
        
        log "INFO" "Downloaded FFmpeg static binary successfully"
        
        # Extract and install (BtbN builds have binaries in bin/ subdirectory)
        if tar -xJf "$temp_dir/ffmpeg.tar.xz" -C "$temp_dir" --strip-components=1 2>/dev/null; then
            # Check if we have write permissions to install directory
            if [ -w "$install_dir" ] || [ "$(whoami)" = "root" ]; then
                cp "$temp_dir/bin/ffmpeg" "$install_dir/" && \
                cp "$temp_dir/bin/ffprobe" "$install_dir/" && \
                chmod +x "$install_dir/ffmpeg" "$install_dir/ffprobe"
                
                # Verify installation
                if command -v "$install_dir/ffmpeg" >/dev/null 2>&1; then
                    NEW_VERSION=$("$install_dir/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
                    log "INFO" "FFmpeg updated successfully to version: $NEW_VERSION"
                    
                    # Update PATH if not already included
                    case ":$PATH:" in
                        *":$install_dir:"*) ;;
                        *) export PATH="$install_dir:$PATH" ;;
                    esac
                    
                    log "INFO" "FFmpeg binaries installed in: $install_dir"
                    log "INFO" "FFmpeg version: $NEW_VERSION"
                    return 0
                else
                    log "ERROR" "FFmpeg installation verification failed"
                    return 1
                fi
            else
                log "WARN" "No write permission to $install_dir, FFmpeg update skipped"
                log "WARN" "Try running with appropriate permissions or specify a writable directory:"
                log "WARN" "  $0 /path/to/writable/directory"
                return 1
            fi
        else
            log "ERROR" "Failed to extract FFmpeg archive"
            return 1
        fi
    else
        log "ERROR" "Failed to download FFmpeg static binary from BtbN/FFmpeg-Builds"
        log "ERROR" "Please check your internet connection and try again"
        return 1
    fi
    
    # Cleanup
    rm -rf "$temp_dir"
}

# Show usage information
show_usage() {
    echo "Usage: $0 [INSTALL_DIRECTORY]"
    echo ""
    echo "Download and install the latest FFmpeg static binary"
    echo ""
    echo "Arguments:"
    echo "  INSTALL_DIRECTORY  Directory to install FFmpeg binaries (default: /usr/local/bin)"
    echo ""
    echo "Examples:"
    echo "  $0                     # Install to /usr/local/bin (default)"
    echo "  $0 /opt/ffmpeg/bin     # Install to custom directory"
    echo "  $0 \$HOME/bin           # Install to user's bin directory"
    echo ""
    echo "Note: The script will automatically detect your system architecture"
    echo "      and download the appropriate static binary from BtbN/FFmpeg-Builds"
}

# Main script logic
INSTALL_DIR="${1:-/usr/local/bin}"

# Handle help flags
case "$1" in
    -h|--help|help)
        show_usage
        exit 0
        ;;
esac

log "INFO" "FFmpeg Update Script"

# Check current FFmpeg version if available
if command -v ffmpeg >/dev/null 2>&1; then
    CURRENT_VERSION=$(ffmpeg -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
    log "INFO" "Current FFmpeg version: $CURRENT_VERSION"
else
    log "INFO" "FFmpeg not found in PATH, proceeding with installation"
fi

log "INFO" "Target installation directory: $INSTALL_DIR"

# Perform the update
if install_ffmpeg_latest "$INSTALL_DIR"; then
    log "INFO" "FFmpeg update completed successfully!"
    
    # Show final version
    if command -v "$INSTALL_DIR/ffmpeg" >/dev/null 2>&1; then
        FINAL_VERSION=$("$INSTALL_DIR/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
        log "INFO" "Final FFmpeg version: $FINAL_VERSION"
    fi
    
    exit 0
else
    log "ERROR" "FFmpeg update failed!"
    exit 1
fi
EOF

# Create startup script that runs updates then starts the app
RUN cat > /usr/local/bin/startup.sh << 'EOF'
#!/bin/sh

# Function to log with timestamp and level (matching YouCast logger format)
log() {
    local level="${1:-INFO}"
    local message="$2"
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local level_padded=$(printf "%-5s" "$level")
    local component_padded=$(printf "%-15s" "STARTUP")
    echo "${timestamp} [${level_padded}] ${component_padded} ${message}"
}

# Run dependency updates on startup
/usr/local/bin/update-deps.sh

# Setup and start Supercronic at runtime
setup_cron() {
    CURRENT_USER=$(whoami)
    log "INFO" "Setting up cron scheduler for user: $CURRENT_USER"
    
    # Create cron file at runtime
    CRON_FILE="/tmp/youcast-cron"
    echo "0 * * * * CRON_TRIGGER=hourly /usr/local/bin/update-deps.sh" > "$CRON_FILE"
    
    # Start Supercronic in background (rootless cron scheduler) - suppress its logs
    if command -v supercronic >/dev/null 2>&1; then
        supercronic "$CRON_FILE" >/dev/null 2>&1 &
        log "INFO" "Supercronic started successfully - hourly dependency updates enabled"
    else
        log "WARN" "Supercronic not found - dependency updates will only run on startup"
    fi
}

# Setup and start cron scheduler
setup_cron

# Execute the main application
exec "$@"
EOF

# Make scripts executable and create directories for markers
RUN chmod +x /usr/local/bin/update-deps.sh /usr/local/bin/update-ffmpeg.sh /usr/local/bin/startup.sh && \
    mkdir -p /var/lib

# NO USER directive - let docker-compose handle user management

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--enable-source-maps=false --max-old-space-size=256" \
    NODE_TLS_REJECT_UNAUTHORIZED=1 \
    TZ=UTC

EXPOSE 3000

# Use wget instead of curl for health check (works better with different users)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=2 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["/usr/local/bin/startup.sh", "node", "app.bundle.js"]
