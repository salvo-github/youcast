# Multi-stage build for maximum optimization
FROM node:22.19.0-bookworm-slim AS base

# Install build tools and system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    ca-certificates \
    --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create optimized Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir yt-dlp

WORKDIR /app

# Modern bundling stage - 2025 optimization approach
FROM base AS bundle
COPY package*.json ./
RUN npm install && \
    npm install --no-save compression helmet express-rate-limit @rollup/plugin-node-resolve @rollup/plugin-commonjs @rollup/plugin-json rollup
COPY . .
# Create optimized bundle with aggressive tree-shaking
RUN echo 'import{nodeResolve}from"@rollup/plugin-node-resolve";import commonjs from"@rollup/plugin-commonjs";import json from"@rollup/plugin-json";export default{input:"server.js",output:{file:"app.bundle.js",format:"es",inlineDynamicImports:true},plugins:[nodeResolve({preferBuiltins:true}),commonjs(),json()],external:["fs","path","os","child_process","stream","events","util","url","crypto","http","https","net","tty","readline","zlib","buffer","async_hooks","dns","querystring","assert","timers","console"]};' > rollup.config.js && \
    npx rollup -c && \
    # Cleanup - keep only the optimized bundle
    npm uninstall @rollup/plugin-node-resolve @rollup/plugin-commonjs @rollup/plugin-json rollup && \
    npm cache clean --force && \
    ls -la app.bundle.js

# Ultra-minimal production stage
FROM node:22.19.0-bookworm-slim AS production

# Install only essential runtime dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    ffmpeg \
    ca-certificates \
    dumb-init \
    curl \
    --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* && \
    # Remove unnecessary files from system
    rm -rf /usr/share/doc/* /usr/share/man/* /usr/share/info/* /usr/share/locale/*

# Copy optimized Python environment
COPY --from=base /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Create app user (simple approach)
ARG UID=1000
ARG GID=1000
RUN groupadd -f -g ${GID} appgroup && \
    useradd -r -u ${UID} -g appgroup -s /bin/bash -m appuser || \
    echo "User creation handled"

WORKDIR /app

# Copy truly self-contained bundle + config (no node_modules needed!)
COPY --from=bundle --chown=appuser:appgroup /app/app.bundle.js ./
COPY --from=bundle --chown=appuser:appgroup /app/config ./config

# Create symlink for bundled path resolution (as root before switching user)
RUN ln -sf /app/config /config

# No directories or special permissions needed - app streams in memory only

# Switch to non-root user
USER appuser

# Production optimizations
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--enable-source-maps=false" \
    NODE_TLS_REJECT_UNAUTHORIZED=1

EXPOSE 3000

# Lightweight health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=2 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Optimized single-bundle startup
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "app.bundle.js"]
