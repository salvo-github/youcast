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

# Install latest FFmpeg static binary
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') && \
    curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz" \
    -o /tmp/ffmpeg.tar.xz && \
    mkdir -p /tmp/ffmpeg && \
    tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1 && \
    cp /tmp/ffmpeg/ffmpeg /usr/local/bin/ && \
    cp /tmp/ffmpeg/ffprobe /usr/local/bin/ && \
    chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe && \
    rm -rf /tmp/ffmpeg*

# Install Supercronic (rootless cron for Docker)
RUN curl -fsSL https://github.com/aptible/supercronic/releases/download/v0.2.29/supercronic-linux-amd64 \
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

LOG_PREFIX="[UPDATE-DEPS]"

# Function to log with timestamp
log() {
    echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $1"
}

# Reusable function to install/update FFmpeg from static binary
install_ffmpeg_latest() {
    local install_dir="${1:-/usr/local/bin}"
    local temp_dir="/tmp/ffmpeg-update-$$"
    
    log "Installing/updating FFmpeg to latest version..."
    
    # Detect architecture
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    log "Detected architecture: $ARCH"
    
    # Create temporary directory
    mkdir -p "$temp_dir"
    
    # Download latest FFmpeg static binary
    if curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz" \
        -o "$temp_dir/ffmpeg.tar.xz" --connect-timeout 30 --max-time 300; then
        
        log "Downloaded FFmpeg static binary successfully"
        
        # Extract and install
        if tar -xJf "$temp_dir/ffmpeg.tar.xz" -C "$temp_dir" --strip-components=1 2>/dev/null; then
            # Check if we have write permissions to install directory
            if [ -w "$install_dir" ] || [ "$(whoami)" = "root" ]; then
                cp "$temp_dir/ffmpeg" "$install_dir/" && \
                cp "$temp_dir/ffprobe" "$install_dir/" && \
                chmod +x "$install_dir/ffmpeg" "$install_dir/ffprobe"
                
                # Verify installation
                if command -v "$install_dir/ffmpeg" >/dev/null 2>&1; then
                    NEW_VERSION=$("$install_dir/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
                    log "FFmpeg updated successfully to version: $NEW_VERSION"
                    
                    # Update PATH if not already included
                    case ":$PATH:" in
                        *":$install_dir:"*) ;;
                        *) export PATH="$install_dir:$PATH" ;;
                    esac
                else
                    log "ERROR: FFmpeg installation verification failed"
                    return 1
                fi
            else
                log "WARNING: No write permission to $install_dir, FFmpeg update skipped"
                return 1
            fi
        else
            log "ERROR: Failed to extract FFmpeg archive"
            return 1
        fi
    else
        log "ERROR: Failed to download FFmpeg static binary"
        return 1
    fi
    
    # Cleanup
    rm -rf "$temp_dir"
    return 0
}

# Create a unique session ID for this run
SESSION_ID="$(date '+%Y%m%d-%H%M%S')-$$"

log "=========================================="
log "Starting dependency update session: $SESSION_ID"
log "Triggered by: ${CRON_TRIGGER:-startup}"
log "User: $(whoami)"
log "Working directory: $(pwd)"
log "=========================================="

log "Checking for dependency updates..."

# Check and update yt-dlp
log "Checking yt-dlp version..."
CURRENT_YT_DLP=$(yt-dlp --version 2>/dev/null || echo "not installed")
log "Current yt-dlp: $CURRENT_YT_DLP"

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
    log "Updating yt-dlp from $CURRENT_YT_DLP to $LATEST_YT_DLP..."
    if python3 -m pip install --no-cache-dir --break-system-packages --upgrade --force-reinstall yt-dlp >/dev/null 2>&1; then
        log "yt-dlp updated successfully to $(yt-dlp --version)"
    else
        log "Failed to update yt-dlp, continuing with current version"
    fi
elif [ -n "$LATEST_YT_DLP" ]; then
    log "yt-dlp is up to date ($CURRENT_YT_DLP)"
else
    log "Could not check for yt-dlp updates (network issue), using current version"
fi

# Check and update FFmpeg using our reusable function
log "Checking FFmpeg version..."
CURRENT_FFMPEG=$(ffmpeg -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "not installed")
log "Current FFmpeg: $CURRENT_FFMPEG"

# Check for FFmpeg updates by downloading and comparing versions
check_ffmpeg_update() {
    local temp_dir="/tmp/ffmpeg-version-check-$$"
    local latest_version=""
    
    # Create temporary directory
    mkdir -p "$temp_dir"
    
    # Download and extract to get the actual version
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    if curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz" \
        -o "$temp_dir/ffmpeg.tar.xz" --connect-timeout 10 --max-time 30 2>/dev/null; then
        
        if tar -xJf "$temp_dir/ffmpeg.tar.xz" -C "$temp_dir" --strip-components=1 2>/dev/null; then
            if [ -x "$temp_dir/ffmpeg" ]; then
                latest_version=$("$temp_dir/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "")
            fi
        fi
    fi
    
    # Cleanup
    rm -rf "$temp_dir"
    echo "$latest_version"
}

# Get latest version by downloading and checking the binary
LATEST_FFMPEG=""
if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    log "Checking for latest FFmpeg version..."
    LATEST_FFMPEG=$(check_ffmpeg_update)
fi

if [ -n "$LATEST_FFMPEG" ] && [ "$CURRENT_FFMPEG" != "$LATEST_FFMPEG" ]; then
    log "FFmpeg update available: $CURRENT_FFMPEG -> $LATEST_FFMPEG"
    if install_ffmpeg_latest; then
        log "FFmpeg updated successfully"
    else
        log "FFmpeg update failed, continuing with current version"
    fi
elif [ -n "$LATEST_FFMPEG" ]; then
    log "FFmpeg is up to date ($CURRENT_FFMPEG)"
else
    log "Could not check for FFmpeg updates, using current version"
fi

log "Dependency check complete!"
log "Session $SESSION_ID finished successfully"
log "=========================================="
EOF

# Create standalone FFmpeg update script for manual usage
RUN cat > /usr/local/bin/update-ffmpeg.sh << 'EOF'
#!/bin/sh
set -e

LOG_PREFIX="[FFMPEG-UPDATE]"

# Function to log with timestamp
log() {
    echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $1"
}

# Reusable function to install/update FFmpeg from static binary
install_ffmpeg_latest() {
    local install_dir="${1:-/usr/local/bin}"
    local temp_dir="/tmp/ffmpeg-update-$$"
    
    log "Installing/updating FFmpeg to latest version..."
    
    # Detect architecture
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    log "Detected architecture: $ARCH"
    
    # Create temporary directory
    mkdir -p "$temp_dir"
    
    # Download latest FFmpeg static binary
    if curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz" \
        -o "$temp_dir/ffmpeg.tar.xz" --connect-timeout 30 --max-time 300; then
        
        log "Downloaded FFmpeg static binary successfully"
        
        # Extract and install
        if tar -xJf "$temp_dir/ffmpeg.tar.xz" -C "$temp_dir" --strip-components=1 2>/dev/null; then
            # Check if we have write permissions to install directory
            if [ -w "$install_dir" ] || [ "$(whoami)" = "root" ]; then
                cp "$temp_dir/ffmpeg" "$install_dir/" && \
                cp "$temp_dir/ffprobe" "$install_dir/" && \
                chmod +x "$install_dir/ffmpeg" "$install_dir/ffprobe"
                
                # Verify installation
                if command -v "$install_dir/ffmpeg" >/dev/null 2>&1; then
                    NEW_VERSION=$("$install_dir/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
                    log "FFmpeg updated successfully to version: $NEW_VERSION"
                    
                    # Update PATH if not already included
                    case ":$PATH:" in
                        *":$install_dir:"*) ;;
                        *) export PATH="$install_dir:$PATH" ;;
                    esac
                    
                    log "FFmpeg binaries installed in: $install_dir"
                    log "FFmpeg version: $NEW_VERSION"
                    return 0
                else
                    log "ERROR: FFmpeg installation verification failed"
                    return 1
                fi
            else
                log "WARNING: No write permission to $install_dir, FFmpeg update skipped"
                log "Try running with appropriate permissions or specify a writable directory:"
                log "  $0 /path/to/writable/directory"
                return 1
            fi
        else
            log "ERROR: Failed to extract FFmpeg archive"
            return 1
        fi
    else
        log "ERROR: Failed to download FFmpeg static binary"
        log "Please check your internet connection and try again"
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
    echo "      and download the appropriate static binary from johnvansickle.com"
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

log "=========================================="
log "FFmpeg Update Script"
log "=========================================="

# Check current FFmpeg version if available
if command -v ffmpeg >/dev/null 2>&1; then
    CURRENT_VERSION=$(ffmpeg -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
    log "Current FFmpeg version: $CURRENT_VERSION"
else
    log "FFmpeg not found in PATH, proceeding with installation"
fi

log "Target installation directory: $INSTALL_DIR"

# Perform the update
if install_ffmpeg_latest "$INSTALL_DIR"; then
    log "=========================================="
    log "FFmpeg update completed successfully!"
    log "=========================================="
    
    # Show final version
    if command -v "$INSTALL_DIR/ffmpeg" >/dev/null 2>&1; then
        FINAL_VERSION=$("$INSTALL_DIR/ffmpeg" -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
        log "Final FFmpeg version: $FINAL_VERSION"
    fi
    
    exit 0
else
    log "=========================================="
    log "FFmpeg update failed!"
    log "=========================================="
    exit 1
fi
EOF

# Create startup script that runs updates then starts the app
RUN cat > /usr/local/bin/startup.sh << 'EOF'
#!/bin/sh

# Run dependency updates on startup
/usr/local/bin/update-deps.sh

# Setup and start Supercronic at runtime
setup_cron() {
    CURRENT_USER=$(whoami)
    echo "[STARTUP] Setting up cron scheduler for user: $CURRENT_USER"
    
    # Ensure log directory exists
    mkdir -p /tmp/logs
    
    # Create cron file at runtime
    CRON_FILE="/tmp/youcast-cron"
    echo "0 * * * * CRON_TRIGGER=hourly /usr/local/bin/update-deps.sh >> /tmp/logs/cron.log 2>&1" > "$CRON_FILE"
    
    # Start Supercronic in background (rootless cron scheduler)
    if command -v supercronic >/dev/null 2>&1; then
        supercronic "$CRON_FILE" >/dev/null 2>&1 &
        echo "[STARTUP] Supercronic started successfully - hourly dependency updates enabled"
    else
        echo "[STARTUP] Warning: Supercronic not found. Dependency updates will only run on startup."
    fi
}

# Setup and start cron scheduler
setup_cron

# Execute the main application
exec "$@"
EOF

# Make scripts executable and create directories
RUN chmod +x /usr/local/bin/update-deps.sh /usr/local/bin/update-ffmpeg.sh /usr/local/bin/startup.sh && \
    mkdir -p /var/log /tmp/logs && \
    touch /tmp/logs/cron.log && \
    chmod 666 /tmp/logs/cron.log

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
