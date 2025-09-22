# Optimized multi-stage build targeting ~250MB final image
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install && \
    npm install --no-save @rollup/plugin-node-resolve @rollup/plugin-commonjs @rollup/plugin-json rollup
COPY . .
RUN echo 'import{nodeResolve}from"@rollup/plugin-node-resolve";import commonjs from"@rollup/plugin-commonjs";import json from"@rollup/plugin-json";export default{input:"server.js",output:{file:"app.bundle.js",format:"es",inlineDynamicImports:true},plugins:[nodeResolve({preferBuiltins:true}),commonjs(),json()],external:["fs","path","os","child_process","stream","events","util","url","crypto","http","https","net","tty","readline","zlib","buffer","async_hooks","dns","querystring","assert","timers","console"]};' > rollup.config.js && \
    npx rollup -c

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
    && rm -rf /var/cache/apk/*

# Install yt-dlp efficiently
RUN python3 -m pip install --no-cache-dir --break-system-packages yt-dlp && \
    rm -rf /root/.cache /tmp/* /var/tmp/*

WORKDIR /app

# Copy essential files (docker-compose user: property will handle ownership)
COPY --from=builder /app/app.bundle.js ./
COPY --from=builder /app/config ./config

# Create symlink for config path resolution and make directories accessible
RUN ln -sf /app/config /config && \
    chmod -R 755 /app

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
CMD ["node", "app.bundle.js"]
