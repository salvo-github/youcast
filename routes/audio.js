import express from 'express';
import { extractAudioStream } from '../utils/audio-extractor.js';
import { getProfileConfig } from '../utils/profile-utils.js';
import logger from '../utils/logger.js';

const router = express.Router();


// Stream audio directly from YouTube video
router.get('/:videoId', async (req, res) => {
  const { videoId } = req.params;

  // Validate video ID format
  if (!videoId || videoId.length !== 11) {
    logger.warn('Audio', `Invalid video ID format: ${videoId}`);
    return res.status(400).json({ 
      error: 'Invalid video ID',
      message: 'Video ID must be a valid YouTube video ID (11 characters)' 
    });
  }

  // Get profile configuration (all validation/fallback handled internally)
  const { profile, profileConfig } = getProfileConfig(req.query.profile);

  try {
    logger.operation('Audio', `Processing: ${videoId} (profile: ${profile})`);

    // Extract and stream audio directly using validated profile
    const { stream, contentType, title, fileExtension } = await extractAudioStream(videoId, profile, profileConfig);
    
    // Use video ID as filename for optimal performance (already filename-safe)
    const filename = videoId;
    
    // Set appropriate headers for streaming
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}.${fileExtension}"`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked'
    });

    // Handle client disconnect
    req.on('close', () => {
      logger.info('Audio', `Client disconnected during stream for video: ${videoId}`);
      if (stream && !stream.destroyed) {
        stream.destroy();
      }
    });

    // Handle stream errors
    stream.on('error', (streamError) => {
      logger.error('Audio', 'Stream error during playback', { videoId, error: streamError.message });
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Stream error',
          message: 'Error occurred while streaming audio'
        });
      }
    });

    // Track bytes sent to client
    let bytesSent = 0;
    stream.on('data', (chunk) => {
      bytesSent += chunk.length;
    });

    // Log final stats when stream completes
    stream.on('end', () => {
      const formatBytes = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
      };

      logger.success('Audio', `Downloaded: ${filename}.${fileExtension} (${formatBytes(bytesSent)})`);
    });

    // Pipe the audio stream to response
    stream.pipe(res);

  } catch (error) {
    logger.error('Audio', 'Audio streaming error', { 
      error: error.message, 
      videoId, 
      profile,
      fullError: error.stack ? error.stack.substring(0, 300) : 'No stack trace'
    });
    
    // Handle specific yt-dlp errors with detailed logging
    if (error.message.includes('invalid audio format')) {
      logger.error('Audio', `Invalid audio profile configuration`, { 
        videoId, 
        profile,
        issue: 'yt-dlp rejected the audio profile configuration',
        suggestion: 'Check yt-dlp supported formats and profile configuration'
      });
      return res.status(400).json({ 
        error: 'Configuration error',
        message: 'Invalid audio format specified in yt-dlp configuration' 
      });
    }

    if (error.message.includes('Video unavailable')) {
      logger.warn('Audio', `Video unavailable: ${videoId}`);
      return res.status(404).json({ 
        error: 'Video not found',
        message: 'The requested video is unavailable or private' 
      });
    }
    
    if (error.message.includes('rate limit')) {
      logger.warn('Audio', `Rate limit hit for video: ${videoId}`);
      return res.status(429).json({ 
        error: 'Rate limited',
        message: 'Too many requests, please try again later' 
      });
    }

    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to process audio',
        message: error.message 
      });
    }
  }
});

export default router;
