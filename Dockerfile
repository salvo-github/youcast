# Optimized multi-stage build targeting ~250MB final image
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install && \
    npm install --no-save @rollup/plugin-node-resolve @rollup/plugin-commonjs @rollup/plugin-json rollup compression helmet express-rate-limit
COPY . .
RUN cat > rollup.config.js << 'EOF'
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

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
    json()
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
    ffmpeg \
    ca-certificates \
    curl \
    dumb-init \
    dcron \
    && rm -rf /var/cache/apk/*

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
echo "$LOG_PREFIX Checking for dependency updates..."

# Function to log with timestamp
log() {
    echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $1"
}

# Check and update yt-dlp
log "Checking yt-dlp version..."
CURRENT_YT_DLP=$(yt-dlp --version 2>/dev/null || echo "not installed")
log "Current yt-dlp: $CURRENT_YT_DLP"

# Get latest yt-dlp version from GitHub API with timeout
LATEST_YT_DLP=""
if command -v curl >/dev/null 2>&1; then
    LATEST_YT_DLP=$(curl -s --connect-timeout 10 --max-time 15 https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest 2>/dev/null | grep '"tag_name"' | cut -d'"' -f4 2>/dev/null || echo "")
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

# Check and update ffmpeg (Alpine packages)
log "Checking ffmpeg version..."
CURRENT_FFMPEG=$(ffmpeg -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "not installed")
log "Current ffmpeg: $CURRENT_FFMPEG"

# Update Alpine package index and upgrade ffmpeg if available
if apk update >/dev/null 2>&1; then
    if apk upgrade ffmpeg >/dev/null 2>&1; then
        NEW_FFMPEG=$(ffmpeg -version 2>/dev/null | head -n1 | awk '{print $3}' || echo "unknown")
        if [ "$CURRENT_FFMPEG" != "$NEW_FFMPEG" ]; then
            log "ffmpeg updated from $CURRENT_FFMPEG to $NEW_FFMPEG"
        else
            log "ffmpeg is up to date ($CURRENT_FFMPEG)"
        fi
    else
        log "ffmpeg is up to date ($CURRENT_FFMPEG)"
    fi
else
    log "Could not update package index, using current ffmpeg version"
fi

log "Dependency check complete!"
EOF

# Create startup script that runs updates then starts the app
RUN cat > /usr/local/bin/startup.sh << 'EOF'
#!/bin/sh

# Run dependency updates on startup
/usr/local/bin/update-deps.sh

# Set up hourly cron job for current user (fail gracefully)
setup_cron() {
    CURRENT_USER=$(whoami)
    echo "[STARTUP] Setting up cron for user: $CURRENT_USER"
    
    # Create user crontab in writable location
    mkdir -p /tmp/logs
    
    # Try to set up cron, but don't fail if permissions are denied
    if echo "0 * * * * /usr/local/bin/update-deps.sh >> /tmp/logs/cron.log 2>&1" | crontab - 2>/dev/null; then
        # Start cron daemon for current user
        if crond -b -l 8 2>/dev/null; then
            echo "[STARTUP] Hourly cron job set up successfully for user: $CURRENT_USER"
        else
            echo "[STARTUP] Warning: Could not start cron daemon (permission denied). Dependency updates will only run on startup."
        fi
    else
        echo "[STARTUP] Warning: Could not set up crontab (permission denied). Dependency updates will only run on startup."
    fi
}

# Call setup function
setup_cron

# Execute the main application
exec "$@"
EOF

# Make scripts executable and set up cron directories
RUN chmod +x /usr/local/bin/update-deps.sh /usr/local/bin/startup.sh && \
    mkdir -p /var/spool/cron/crontabs /var/log && \
    chmod 755 /var/spool/cron/crontabs

# NO USER directive - let docker-compose handle user management

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--enable-source-maps=false --max-old-space-size=256" \
    NODE_TLS_REJECT_UNAUTHORIZED=1

EXPOSE 3000

# Use wget instead of curl for health check (works better with different users)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=2 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["/usr/local/bin/startup.sh", "node", "app.bundle.js"]
