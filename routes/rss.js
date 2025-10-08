import express from 'express';
import { getChannelWithVideos } from '../utils/youtube/youtube.js';
import { generateRSS } from '../utils/rss-generator.js';
import { getProfileConfig } from '../utils/profile-utils.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Generate RSS feed for a YouTube channel
router.get('/:channelIdentifier', async (req, res) => {
  try {
    const { channelIdentifier } = req.params;
    
    // Handle limit parameter: number, "none", or default to 50
    let limit = 50; // Default value
    if (req.query.limit) {
      if (req.query.limit.toLowerCase() === 'none') {
        limit = 5000; // Maximum videos per channel (YouTube API playlist limit)
        logger.debug('RSS', 'Limit set to maximum (5000 videos) - fetching everything');
      } else {
        const parsedLimit = parseInt(req.query.limit);
        if (!isNaN(parsedLimit) && parsedLimit > 0) {
          limit = Math.min(parsedLimit, 5000); // Cap at 5000 (API limit)
          if (parsedLimit > 5000) {
            logger.warn('RSS', `Requested limit ${parsedLimit} exceeds maximum, capped at 5000`);
          }
        } else {
          logger.warn('RSS', `Invalid limit parameter: ${req.query.limit}, using default (50)`);
        }
      }
    }
    
    // Handle minDuration parameter: query param overrides env, defaults to 0
    const minDuration = req.query.minDuration ? parseInt(req.query.minDuration) : process.env.MIN_VIDEO_DURATION ? parseInt(process.env.MIN_VIDEO_DURATION) : 0;
    
    // Validate minDuration
    if (isNaN(minDuration) || minDuration < 0) {
      return res.status(400).json({ 
        error: 'Invalid minDuration parameter',
        message: 'minDuration must be a non-negative number (0 to include all videos)' 
      });
    }
    
    // Get profile configuration (all validation/fallback handled internally)
    const { profile, profileConfig } = getProfileConfig(req.query.profile);
    logger.operation('RSS', `Generating RSS feed for: ${channelIdentifier}`, { 
      limit, 
      profile, 
      minDuration 
    });

    // Validate identifier format (can be channel ID, uploads playlist ID, regular playlist ID, or handle)
    if (!channelIdentifier || channelIdentifier.length < 3) {
      return res.status(400).json({ 
        error: 'Invalid identifier',
        message: 'Identifier must be a valid YouTube channel ID (UCxxx), uploads playlist ID (UUxxx), playlist ID (PLxxx), or handle (@channelname)' 
      });
    }

    logger.debug('RSS', `Fetching content with videos: ${channelIdentifier}`);
    
    // Let YouTube utils handle all optimization logic
    const result = await getChannelWithVideos(channelIdentifier, { 
      limit,
      minDuration 
    });
    
    const { channel: channelInfo, videos } = result;
    
    if (!channelInfo) {
      logger.warn('RSS', `Content not found: ${channelIdentifier}`);
      return res.status(404).json({ 
        error: 'Content not found',
        message: `Unable to find YouTube channel or playlist with identifier: ${channelIdentifier}. Please verify the identifier is correct.` 
      });
    }

    logger.info('RSS', `Found channel: ${channelInfo.title}`, { 
      channelId: channelInfo.id
    });

    if (!videos || videos.length === 0) {
      logger.warn('RSS', `No videos found for: ${channelInfo.title}`, { id: channelInfo.id });
      return res.status(404).json({ 
        error: 'No videos found',
        message: 'No videos found for this channel or playlist' 
      });
    }

    logger.info('RSS', `Retrieved ${videos.length} videos`, {
      channel: channelInfo.title
    });
    
    // Generate RSS feed with videos (filtering handled by YouTube utils)
    const rssXML = generateRSS(channelInfo, videos, req.get('host'), profile, profileConfig);

    // Set appropriate headers for RSS
    const cacheMaxAge = process.env.RSS_CACHE_DURATION || 600; // Default: 10 minutes
    res.set({
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${cacheMaxAge}`, // Configurable cache duration
    });

    logger.success('RSS', `RSS feed generated for ${channelInfo.title}`, { 
      videosCount: videos.length
    });
    res.send(rssXML);

  } catch (error) {
    logger.error('RSS', 'RSS generation failed', { error: error.message, channelIdentifier: req.params.channelIdentifier });
    res.status(500).json({ 
      error: 'Failed to generate RSS feed',
      message: error.message 
    });
  }
});

export default router;
