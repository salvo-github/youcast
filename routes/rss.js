import express from 'express';
import { getChannelInfo, getChannelVideos, getChannelWithVideos } from '../utils/youtube.js';
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
    
    const includeStats = req.query.stats !== 'false'; // Include video stats by default
    
    // Handle minDuration parameter: number, or fall back to env variable, or no filtering
    let minDuration = null;
    const envMinDuration = process.env.MIN_VIDEO_DURATION ? parseInt(process.env.MIN_VIDEO_DURATION) : null;
    
    if (req.query.minDuration !== undefined) {
      // Query parameter has higher priority than env variable
      const parsedMinDuration = parseInt(req.query.minDuration);
      if (!isNaN(parsedMinDuration) && parsedMinDuration >= 0) {
        minDuration = parsedMinDuration;
        logger.debug('RSS', `Using minDuration from query param: ${minDuration} seconds`);
      } else {
        logger.warn('RSS', `Invalid minDuration parameter: ${req.query.minDuration}, must be a non-negative number`);
        return res.status(400).json({ 
          error: 'Invalid minDuration parameter',
          message: 'minDuration must be a non-negative number (0 to include all videos)' 
        });
      }
    } else if (envMinDuration !== null && !isNaN(envMinDuration) && envMinDuration >= 0) {
      // Use environment variable if no query parameter provided
      minDuration = envMinDuration;
      logger.debug('RSS', `Using minDuration from environment: ${minDuration} seconds`);
    }
    // If minDuration is still null, no filtering will be applied
    
    // Get profile configuration (all validation/fallback handled internally)
    const { profile, profileConfig } = getProfileConfig(req.query.profile);
    logger.operation('RSS', `Generating RSS feed for channel: ${channelIdentifier}`, { 
      limit, 
      includeStats, 
      profile, 
      minDuration: minDuration !== null ? minDuration : 'none' 
    });

    // Validate channel identifier format (can be channel ID or handle)
    if (!channelIdentifier || channelIdentifier.length < 3) {
      return res.status(400).json({ 
        error: 'Invalid channel identifier',
        message: 'Channel identifier must be a valid YouTube channel ID or handle (e.g., @channelname)' 
      });
    }

    // Check if YouTube API key is available
    if (!process.env.YOUTUBE_API_KEY) {
      logger.error('RSS', 'YouTube API key not configured');
      return res.status(500).json({
        error: 'Configuration error',
        message: 'YouTube API key not configured'
      });
    }

    logger.debug('RSS', `Fetching channel with videos: ${channelIdentifier}`);
    
    // Get channel and videos
    const result = await getChannelWithVideos(channelIdentifier, limit, { 
      includeVideoDetails: includeStats 
    });
    
    const { channel: channelInfo, videos } = result;
    
    if (!channelInfo) {
      logger.warn('RSS', `Channel not found: ${channelIdentifier}`);
      return res.status(404).json({ 
        error: 'Channel not found',
        message: `Unable to find YouTube channel with identifier: ${channelIdentifier}. Please verify the channel handle or ID is correct.` 
      });
    }

    logger.info('RSS', `Found channel: ${channelInfo.title}`, { 
      channelId: channelInfo.id
    });

    if (!videos || videos.length === 0) {
      logger.warn('RSS', `No videos found for channel: ${channelInfo.title}`, { channelId: channelInfo.id });
      return res.status(404).json({ 
        error: 'No videos found',
        message: 'No videos found for this channel' 
      });
    }

    logger.info('RSS', `Retrieved ${videos.length} videos`, {
      channel: channelInfo.title
    });
    
    // Apply duration filtering if specified
    let filteredVideos = videos;
    if (minDuration !== null && minDuration > 0) {
      const originalCount = videos.length;
      filteredVideos = videos.filter(video => {
        // Only filter if video has duration information
        if (video.duration === undefined || video.duration === null) {
          // Keep videos without duration info to avoid losing content
          logger.debug('RSS', `Video ${video.id} has no duration info, keeping in feed`);
          return true;
        }
        return video.duration >= minDuration;
      });
      
      const filteredCount = filteredVideos.length;
      const excludedCount = originalCount - filteredCount;
      
      logger.info('RSS', `Duration filtering applied: ${excludedCount} videos shorter than ${minDuration}s excluded`, {
        originalCount,
        filteredCount,
        excludedCount,
        minDuration
      });
    } else if (minDuration === 0) {
      logger.debug('RSS', 'minDuration set to 0, including all videos');
    } else {
      logger.debug('RSS', 'No duration filtering applied');
    }
    
    // Generate RSS feed with filtered videos
    const rssXML = generateRSS(channelInfo, filteredVideos, req.get('host'), profile, profileConfig);

    // Set appropriate headers for RSS
    const cacheMaxAge = process.env.RSS_CACHE_DURATION || 600; // Default: 10 minutes
    res.set({
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${cacheMaxAge}`, // Configurable cache duration
    });

    logger.success('RSS', `RSS feed generated for ${channelInfo.title}`, { 
      videosCount: filteredVideos.length
    });
    res.send(rssXML);

  } catch (error) {
    logger.error('RSS', 'RSS generation failed', { error: error.message, channelIdentifier });
    res.status(500).json({ 
      error: 'Failed to generate RSS feed',
      message: error.message 
    });
  }
});

export default router;
