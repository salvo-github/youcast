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

# Install latest FFmpeg from John Van Sickle's static builds (widely trusted, updated regularly)
# Use /app/bin for both build-time and runtime (consistent, writable in rootless containers)
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') && \
    mkdir -p /app/bin && \
    REMOTE_VERSION=$(curl -fsSL "https://johnvansickle.com/ffmpeg/release-readme.txt" 2>/dev/null | grep -i "version:" | head -1 | awk '{print $2}' || echo "unknown") && \
    echo "Remote FFmpeg version: $REMOTE_VERSION" && \
    if [ "$REMOTE_VERSION" != "unknown" ]; then \
        curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz" \
        -o /tmp/ffmpeg.tar.xz && \
        mkdir -p /tmp/ffmpeg && \
        tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1 && \
        cp /tmp/ffmpeg/ffmpeg /app/bin/ && \
        cp /tmp/ffmpeg/ffprobe /app/bin/ && \
        chmod +x /app/bin/ffmpeg /app/bin/ffprobe && \
        echo "$REMOTE_VERSION" > /app/bin/.ffmpeg-version && \
        rm -rf /tmp/ffmpeg*; \
    else \
        echo "Failed to get remote version, skipping FFmpeg installation"; \
        exit 1; \
    fi

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
# Make /app/bin writable for rootless container users to enable FFmpeg updates
RUN ln -sf /app/config /config && \
    chmod -R 755 /app && \
    chmod 777 /app/bin

# Create update script for dependencies
RUN cat > /usr/local/bin/update-deps.sh << 'EOF'
#!/bin/sh
set -e

# Function to log with timestamp and level (matching YouCast logger format)
log() {
    local level="${1:-INFO}"
    local message="$2"
    local timestamp=$(TZ=${TZ:-UTC} date +"%Y-%m-%dT%H:%M:%SZ")
    local level_padded=$(printf "%-5s" "$level")
    local component_padded=$(printf "%-15s" "UPDATE-DEPS")
    echo "${timestamp} [${level_padded}] ${component_padded} ${message}"
}

# Reusable function to install/update FFmpeg from John Van Sickle's static builds
install_ffmpeg_latest() {
    # Use /app/bin for both build-time and runtime updates (writable in rootless containers)
    local install_dir="${1:-/app/bin}"
    mkdir -p "$install_dir"
    
    local temp_dir="/tmp/ffmpeg-update-$$"
    
    # Detect architecture for John Van Sickle builds (amd64 or arm64)
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    
    # Get remote version from release readme
    REMOTE_VERSION=$(curl -fsSL "https://johnvansickle.com/ffmpeg/release-readme.txt" 2>/dev/null | grep -i "version:" | head -1 | awk '{print $2}' || echo "")
    
    if [ -z "$REMOTE_VERSION" ]; then
        log "ERROR" "Failed to get remote FFmpeg version"
        return 1
    fi
    
    # Get local version if FFmpeg is installed
    LOCAL_VERSION=""
    if command -v "$install_dir/ffmpeg" >/dev/null 2>&1; then
        LOCAL_VERSION=$("$install_dir/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "")
        # Strip -static suffix for comparison (local reports "7.0.2-static", remote reports "7.0.2")
        LOCAL_VERSION=$(echo "$LOCAL_VERSION" | sed 's/-static$//')
    fi
    
    # Compare versions - only download if different or not installed
    if [ -n "$LOCAL_VERSION" ] && [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
        log "INFO" "FFmpeg already at latest version ($LOCAL_VERSION)"
        return 0
    fi
    
    log "INFO" "Updating FFmpeg: ${LOCAL_VERSION:-not installed} → $REMOTE_VERSION"
    
    # Create temporary directory
    mkdir -p "$temp_dir"
    
    # Download latest FFmpeg from John Van Sickle's builds
    if curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz" \
        -o "$temp_dir/ffmpeg.tar.xz" --connect-timeout 30 --max-time 300 2>/dev/null; then
        
        # Extract and install
        if tar -xJf "$temp_dir/ffmpeg.tar.xz" -C "$temp_dir" --strip-components=1 2>/dev/null; then
            cp "$temp_dir/ffmpeg" "$install_dir/" && \
            cp "$temp_dir/ffprobe" "$install_dir/" && \
            chmod +x "$install_dir/ffmpeg" "$install_dir/ffprobe"
            
            # Verify installation
            if command -v "$install_dir/ffmpeg" >/dev/null 2>&1; then
                NEW_VERSION=$("$install_dir/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
                log "INFO" "FFmpeg updated to $NEW_VERSION"
                
                # Save version to marker file (use writable location for rootless containers)
                echo "$NEW_VERSION" > "$install_dir/.ffmpeg-version" 2>/dev/null || true
                
                # Update PATH to prioritize this installation (prepend if not already first)
                case ":$PATH:" in
                    "$install_dir:"*) ;;  # Already first, do nothing
                    *":$install_dir:"*) 
                        # Remove from current position and prepend
                        PATH=$(echo "$PATH" | sed "s|:$install_dir||g")
                        export PATH="$install_dir:$PATH"
                        ;;
                    *) 
                        # Not in PATH, prepend it
                        export PATH="$install_dir:$PATH" 
                        ;;
                esac
            else
                log "ERROR" "FFmpeg installation verification failed"
                rm -rf "$temp_dir"
                return 1
            fi
        else
            log "ERROR" "Failed to extract FFmpeg archive"
            rm -rf "$temp_dir"
            return 1
        fi
    else
        log "ERROR" "Failed to download FFmpeg"
        rm -rf "$temp_dir"
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

# Check and update FFmpeg (version check handled inside install_ffmpeg_latest)
install_ffmpeg_latest

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
    local timestamp=$(TZ=${TZ:-UTC} date +"%Y-%m-%dT%H:%M:%SZ")
    local level_padded=$(printf "%-5s" "$level")
    local component_padded=$(printf "%-15s" "FFMPEG-UPDATE")
    echo "${timestamp} [${level_padded}] ${component_padded} ${message}"
}

# Reusable function to install/update FFmpeg from John Van Sickle's static builds
install_ffmpeg_latest() {
    # Use /app/bin for both build-time and runtime updates (writable in rootless containers)
    local install_dir="${1:-/app/bin}"
    mkdir -p "$install_dir"
    
    local temp_dir="/tmp/ffmpeg-update-$$"
    
    log "INFO" "Checking FFmpeg version..."
    log "INFO" "Target installation directory: $install_dir"
    
    # Detect architecture for John Van Sickle builds (amd64 or arm64)
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    log "INFO" "Detected architecture: $ARCH"
    
    # Get remote version from release readme
    REMOTE_VERSION=$(curl -fsSL "https://johnvansickle.com/ffmpeg/release-readme.txt" 2>/dev/null | grep -i "version:" | head -1 | awk '{print $2}' || echo "")
    
    if [ -z "$REMOTE_VERSION" ]; then
        log "ERROR" "Failed to get remote FFmpeg version"
        return 1
    fi
    
    log "INFO" "Remote FFmpeg version: $REMOTE_VERSION"
    
    # Get local version if FFmpeg is installed
    LOCAL_VERSION=""
    if command -v "$install_dir/ffmpeg" >/dev/null 2>&1; then
        LOCAL_VERSION=$("$install_dir/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "")
        # Strip -static suffix for comparison (local reports "7.0.2-static", remote reports "7.0.2")
        LOCAL_VERSION=$(echo "$LOCAL_VERSION" | sed 's/-static$//')
        log "INFO" "Local FFmpeg version: $LOCAL_VERSION"
    else
        log "INFO" "FFmpeg not installed locally"
    fi
    
    # Compare versions - only download if different or not installed
    if [ -n "$LOCAL_VERSION" ] && [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
        log "INFO" "FFmpeg already at latest version ($LOCAL_VERSION), skipping download"
        return 0
    fi
    
    log "INFO" "Installing/updating FFmpeg: ${LOCAL_VERSION:-not installed} → $REMOTE_VERSION"
    
    # Create temporary directory
    mkdir -p "$temp_dir"
    
    # Download latest FFmpeg from John Van Sickle's builds
    if curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz" \
        -o "$temp_dir/ffmpeg.tar.xz" --connect-timeout 30 --max-time 300; then
        
        log "INFO" "Downloaded FFmpeg static binary successfully"
        
        # Extract and install
        if tar -xJf "$temp_dir/ffmpeg.tar.xz" -C "$temp_dir" --strip-components=1 2>/dev/null; then
            cp "$temp_dir/ffmpeg" "$install_dir/" && \
            cp "$temp_dir/ffprobe" "$install_dir/" && \
            chmod +x "$install_dir/ffmpeg" "$install_dir/ffprobe"
            
            # Verify installation
            if command -v "$install_dir/ffmpeg" >/dev/null 2>&1; then
                NEW_VERSION=$("$install_dir/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
                log "INFO" "FFmpeg updated successfully to version: $NEW_VERSION"
                
                # Save version to marker file (use writable location for rootless containers)
                echo "$NEW_VERSION" > "$install_dir/.ffmpeg-version" 2>/dev/null || true
                
                # Update PATH to prioritize this installation (prepend if not already first)
                case ":$PATH:" in
                    "$install_dir:"*) ;;  # Already first, do nothing
                    *":$install_dir:"*) 
                        # Remove from current position and prepend
                        PATH=$(echo "$PATH" | sed "s|:$install_dir||g")
                        export PATH="$install_dir:$PATH"
                        ;;
                    *) 
                        # Not in PATH, prepend it
                        export PATH="$install_dir:$PATH" 
                        ;;
                esac
                
                log "INFO" "FFmpeg binaries installed in: $install_dir"
                log "INFO" "FFmpeg version: $NEW_VERSION"
                return 0
            else
                log "ERROR" "FFmpeg installation verification failed"
                rm -rf "$temp_dir"
                return 1
            fi
        else
            log "ERROR" "Failed to extract FFmpeg archive"
            rm -rf "$temp_dir"
            return 1
        fi
    else
        log "ERROR" "Failed to download FFmpeg static binary from John Van Sickle's builds"
        log "ERROR" "Please check your internet connection and try again"
        rm -rf "$temp_dir"
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
    echo "  INSTALL_DIRECTORY  Directory to install FFmpeg binaries (default: /app/bin)"
    echo ""
    echo "Examples:"
    echo "  $0                     # Install to /app/bin (default, writable in rootless containers)"
    echo "  $0 /opt/ffmpeg/bin     # Install to custom directory"
    echo "  $0 \$HOME/bin           # Install to user's bin directory"
    echo ""
    echo "Note: The script will automatically detect your system architecture"
    echo "      and download the appropriate static binary from John Van Sickle's builds"
}

# Main script logic
INSTALL_DIR="${1:-}"

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
    local timestamp=$(TZ=${TZ:-UTC} date +"%Y-%m-%dT%H:%M:%SZ")
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
    
    # Start Supercronic in background (rootless cron scheduler)
    if command -v supercronic >/dev/null 2>&1; then
        # Pipe supercronic through log formatter to match YouCast format
        supercronic "$CRON_FILE" 2>&1 | while IFS= read -r line; do
            # Skip job output (already formatted by update-deps.sh)
            echo "$line" | grep -q 'channel=stdout' && continue
            echo "$line" | grep -q 'channel=stderr' && continue
            
            # Extract timestamp, level, and message from supercronic's structured logs
            timestamp=$(echo "$line" | sed -n 's/.*time="\([^"]*\)".*/\1/p')
            level=$(echo "$line" | sed -n 's/.*level=\([^ ]*\).*/\1/p' | tr '[:lower:]' '[:upper:]')
            msg=$(echo "$line" | sed -n 's/.*msg="\?\([^"]*\)"\?.*/\1/p' | sed 's/msg=//;s/"$//')
            iteration=$(echo "$line" | sed -n 's/.*iteration=\([^ ]*\).*/\1/p')
            
            # Only format actual supercronic messages
            if [ -n "$timestamp" ] && [ -n "$level" ]; then
                level_padded=$(printf "%-5s" "$level")
                component_padded=$(printf "%-15s" "SUPERCRONIC")
                
                # Add iteration info if present
                if [ -n "$iteration" ]; then
                    echo "${timestamp} [${level_padded}] ${component_padded} ${msg} (iteration ${iteration})"
                else
                    echo "${timestamp} [${level_padded}] ${component_padded} ${msg}"
                fi
            fi
        done &
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
    TZ=UTC \
    PATH="/app/bin:$PATH"

EXPOSE 3000

# Use wget instead of curl for health check (works better with different users)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=2 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["/usr/local/bin/startup.sh", "node", "app.bundle.js"]
