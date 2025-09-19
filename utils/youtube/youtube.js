import fetch from 'node-fetch';
import logger from '../logger.js';
import { getChannelUUID } from './channel.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * Get recent videos from a YouTube uploads playlist
 * @param {string} uploadsPlaylistId - YouTube uploads playlist ID (required)
 * @param {Object} options - Configuration options
 * @param {number} options.limit - Number of videos to retrieve (default: 50, max: 5000)
 * @param {number} options.minDuration - Minimum duration (>0 means fetch detailed info for filtering)
 * @returns {Object} Object with videos array and channel info extracted from playlist
 */
async function getChannelVideos(uploadsPlaylistId, options = {}) {
  const { limit = 50, minDuration = 0, providedChannelInfo = null } = options;
  
  try {
    logger.debug('YouTube', `Getting videos from playlist: ${uploadsPlaylistId}`, { limit, minDuration });

    // Fetch videos with pagination support (up to 5,000 videos max per playlist)
    const maxLimit = Math.min(limit, 5000);
    const videos = [];
    let nextPageToken = '';
    let totalFetched = 0;
    let channelInfo = providedChannelInfo; // Use channel info from getChannelUUID if available
    
    while (totalFetched < maxLimit) {
      const batchSize = Math.min(50, maxLimit - totalFetched);
      const playlistUrl = `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${batchSize}&order=date${nextPageToken ? `&pageToken=${nextPageToken}` : ''}&key=${process.env.YOUTUBE_API_KEY}`;
      
      const playlistResponse = await fetch(playlistUrl);
      const playlistData = await playlistResponse.json();

      if (!playlistResponse.ok) {
        logger.error('YouTube', 'Playlist API error', { 
          status: playlistResponse.status, 
          error: playlistData.error, 
          playlistId: uploadsPlaylistId 
        });
        throw new Error(`YouTube API error: ${playlistData.error?.message || 'Unknown error'}`);
      }

      if (!playlistData.items || playlistData.items.length === 0) {
        break; // No more videos
      }

      // Extract channel info from first video only if not provided by getChannelUUID
      if (!channelInfo && playlistData.items.length > 0) {
        const firstItem = playlistData.items[0];
        channelInfo = {
          id: firstItem.snippet.channelId,
          title: firstItem.snippet.channelTitle,
          description: '', // Not available in playlistItems
          thumbnail: '' // Not available in playlistItems
        };
        logger.debug('YouTube', `Extracted basic channel info from playlist: ${channelInfo.title}`, { channelId: channelInfo.id });
      }

      // Always collect video IDs first
      const videoIds = playlistData.items.map(item => item.snippet.resourceId.videoId);
      
      // Then get full video details if needed (includes duration)
      if (minDuration > 0 && videoIds.length > 0) {
        const batchIds = videoIds.join(',');
        const videosUrl = `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails&id=${batchIds}&key=${process.env.YOUTUBE_API_KEY}`;
        
        logger.debug('YouTube', `Fetching video details for ${videoIds.length} videos`);
        const videosResponse = await fetch(videosUrl);
        const videosData = await videosResponse.json();

        if (!videosResponse.ok) {
          logger.error('YouTube', 'Videos API error', { 
            status: videosResponse.status, 
            error: videosData.error 
          });
          throw new Error(`YouTube API error: ${videosData.error?.message || 'Unknown error'}`);
        }

        // Map full video details with duration
        const detailedVideos = videosData.items.map(video => ({
          id: video.id,
          title: video.snippet.title,
          description: video.snippet.description,
          publishedAt: video.snippet.publishedAt,
          thumbnail: video.snippet.thumbnails?.high?.url || video.snippet.thumbnails?.default?.url,
          duration: parseDuration(video.contentDetails.duration),
          url: `https://www.youtube.com/watch?v=${video.id}`
        }));

        videos.push(...detailedVideos);
      } else {
        // Basic video info only (no API call to videos endpoint)
        const basicVideos = playlistData.items.map(item => ({
          id: item.snippet.resourceId.videoId,
          title: item.snippet.title,
          description: item.snippet.description,
          publishedAt: item.snippet.publishedAt,
          thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
          url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`
        }));
        videos.push(...basicVideos);
      }

      totalFetched += playlistData.items.length;
      nextPageToken = playlistData.nextPageToken;

      logger.debug('YouTube', `Fetched batch: ${playlistData.items.length} videos, total: ${totalFetched}/${maxLimit}`);

      // Break if no more pages or reached limit
      if (!nextPageToken || totalFetched >= maxLimit) {
        break;
      }
    }
    
    logger.info('YouTube', `Successfully fetched ${videos.length} videos`, { 
      videosCount: videos.length,
      playlistId: uploadsPlaylistId
    });

    return {
      videos,
      totalVideos: videos.length,
      hasMore: !!nextPageToken && videos.length < limit,
      channelInfo // Include channel info extracted from playlist
    };

  } catch (error) {
    logger.error('YouTube', 'Error fetching playlist videos', { 
      error: error.message, 
      playlistId: uploadsPlaylistId,
      limit
    });
    throw error;
  }
}

/**
 * Get channel info and videos with automatic quota optimization
 * Supports channel handles (@username), channel IDs (UCxxx), and playlist IDs (UUxxx)
 * Automatically chooses the most efficient API call strategy based on input type
 * @param {string} channelIdentifier - YouTube channel handle, ID, or uploads playlist ID
 * @param {Object} options - Configuration options
 * @param {number} options.limit - Number of videos to retrieve (default: 50, max: 5000)
 * @param {number} options.minDuration - Minimum duration in seconds (0 = no filtering, >0 = fetch durations for filtering)
 * @returns {Object} Object with channel info and videos
 */
async function getChannelWithVideos(channelIdentifier, options = {}) {
  const { limit: videoLimit = 50, minDuration = 0 } = options;
  
  try {
    logger.debug('YouTube', `Getting channel with videos: ${channelIdentifier}`, { videoLimit, minDuration });
    
    // Step 1: Resolve any channel identifier to uploads playlist ID
    const { uploadsPlaylistId, channelInfo: providedChannelInfo } = await getChannelUUID(channelIdentifier);
    
    // Step 2: Get videos using the uploads playlist ID
    const videoResults = await getChannelVideos(uploadsPlaylistId, { 
      limit: videoLimit,
      minDuration,
      providedChannelInfo
    });
    
    // Apply duration filtering if specified
    let filteredVideos = videoResults.videos;
    if (minDuration > 0) {
      const originalCount = videoResults.videos.length;
      filteredVideos = videoResults.videos.filter(video => {
        // Only filter if video has duration information
        if (video.duration === undefined || video.duration === null) {
          // Keep videos without duration info to avoid losing content
          logger.debug('YouTube', `Video ${video.id} has no duration info, keeping in result`);
          return true;
        }
        return video.duration >= minDuration;
      });
      
      const filteredCount = filteredVideos.length;
      const excludedCount = originalCount - filteredCount;
      
      logger.info('YouTube', `Duration filtering applied: ${excludedCount} videos shorter than ${minDuration}s excluded`, {
        originalCount,
        filteredCount,
        excludedCount,
        minDuration
      });
    }

    // Use the best available channel info
    const finalChannelInfo = videoResults.channelInfo;

    logger.info('YouTube', `Successfully retrieved channel with videos`, {
      channelId: finalChannelInfo.id,
      channelTitle: finalChannelInfo.title,
      videosCount: filteredVideos.length,
      minDuration
    });
    
    return {
      channel: finalChannelInfo,
      videos: filteredVideos,
      totalVideos: filteredVideos.length,
      hasMoreVideos: videoResults.hasMore
    };
    
  } catch (error) {
    logger.error('YouTube', 'Error in getChannelWithVideos', {
      error: error.message,
      channelIdentifier,
      videoLimit
    });
    throw error;
  }
}

/**
 * Parse YouTube duration format (PT4M13S) to seconds
 * @param {string} duration - YouTube duration string
 * @returns {number} Duration in seconds
 */
function parseDuration(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1]) || 0;
  const minutes = parseInt(match[2]) || 0;
  const seconds = parseInt(match[3]) || 0;

  return hours * 3600 + minutes * 60 + seconds;
}

export {
  getChannelWithVideos
};
