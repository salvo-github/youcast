# YouCast

Convert YouTube channels into podcast RSS feeds with on-demand audio extraction.

## Quick Start

### Environment Setup
Create a `.env` file:
```bash
YOUTUBE_API_KEY=your_youtube_api_key_here
PORT=3000
RSS_CACHE_DURATION=600
MIN_VIDEO_DURATION=0
LOG_LEVEL=INFO
DEFAULT_AUDIO_PROFILE=mp3
```

Get your YouTube API key from [Google Cloud Console](https://console.developers.google.com/) → Enable "YouTube Data API v3" → Create API Key.

### Local Development
```bash
# Install dependencies
npm install

# Start development server (auto-reload)
npm run dev

# Production server
npm start
```

### Docker Setup
```bash
# Using docker-compose (includes all dependencies)
docker-compose up -d

# Or with standalone Docker
docker build -t youcast .
docker run -p 3000:3000 -e YOUTUBE_API_KEY=your_key youcast
```

#### Docker Compose Configuration
```yaml
services:
  youcast:
    image: ghcr.io/salvo-github/youcast:latest
    container_name: youcast
    ports:
      - "3000:3000"
    environment:
      - YOUTUBE_API_KEY=your_api_key
      - RSS_CACHE_DURATION=600
      - MIN_VIDEO_DURATION=300
    restart: unless-stopped
```

## API Endpoints

### RSS Feed Generation
```
GET /rss/{channelIdentifier}
```

**Parameters:**
- `channelIdentifier` - YouTube channel ID (e.g., `UC_x5XG1OV2P6uZZ5FSM9Ttw`), uploads playlist ID (e.g., `UU_x5XG1OV2P6uZZ5FSM9Ttw`), or handle (e.g., `@username`)

**Query Parameters:**
- `limit` - Number of episodes (default: `50`, max: `5000`, use `"none"` for maximum)
- `minDuration` - Filter videos by minimum duration in seconds (overrides env variable)
- `profile` - Audio profile for RSS feed items (see profile configuration)

**Examples:**
```bash
# Basic RSS feed
curl http://localhost:3000/rss/@channelname

# With channel ID - optimal quota usage
curl http://localhost:3000/rss/UC_x5XG1OV2P6uZZ5FSM9Ttw?limit=10

# With duration filtering (requires extra API calls for video details)
curl http://localhost:3000/rss/UC_x5XG1OV2P6uZZ5FSM9Ttw?limit=10&minDuration=300

# All videos
curl http://localhost:3000/rss/@channelname?limit=none
```

### Audio Streaming
```
GET /audio/{videoId}
```

**Parameters:**
- `videoId` - YouTube video ID (11 characters, e.g., `dQw4w9WgXcQ`)

**Query Parameters:**
- `profile` - Audio extraction profile (affects quality/format)

**Examples:**
```bash
# Stream audio
curl http://localhost:3000/audio/dQw4w9WgXcQ

# With specific profile
curl http://localhost:3000/audio/dQw4w9WgXcQ?profile=high-quality
```

### Health Check  
```
GET /health
```

**Parameters:** None  
**Query Parameters:** None

Returns: `{"status": "OK", "timestamp": "2025-01-01T00:00:00.000Z"}`

## Usage

1. **Add to Podcast App:** Use `http://your-server.com/rss/{channelIdentifier}` as the RSS feed URL
2. **Stream Audio:** RSS episodes link to `/audio/{videoId}` for on-demand extraction
3. **Caching:** RSS feeds are cached (default: 10 minutes) to reduce API calls

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `YOUTUBE_API_KEY` | - | YouTube Data API v3 key (**required**) |
| `PORT` | `3000` | Server port |
| `RSS_CACHE_DURATION` | `600` | RSS cache duration (seconds) |
| `MIN_VIDEO_DURATION` | - | Global minimum video duration filter (seconds) |
| `ALLOWED_ORIGINS` | - | Comma-separated CORS origins for production (if not set, **disables CORS** - no cross-origin requests allowed) |
| `LOG_LEVEL` | `INFO` | Logging level (DEBUG, INFO, WARN, ERROR) |
| `DEFAULT_AUDIO_PROFILE` | `mp3` | Default audio extraction profile |

## Dependencies

- **Node.js** 22.19.0+
- **Python3** + **pip** (for yt-dlp)
- **FFmpeg** (for audio processing)
- **yt-dlp** (YouTube audio extraction)

All dependencies are automatically installed when using Docker.