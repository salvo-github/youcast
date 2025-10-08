import fetch from 'node-fetch';
import logger from '../logger.js';
import { getChannelUUID } from './channelInfo.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * Common function to fetch videos from any YouTube playlist (uploads or regular)
 * @param {string} playlistId - YouTube playlist ID (UUxxxx or PLxxxx)
 * @param {Object} options - Configuration options
 * @param {number} options.limit - Number of videos to retrieve (default: 50, max: 5000)
 * @param {number} options.minDuration - Minimum duration (>0 means fetch detailed info for filtering)
 * @returns {Object} Object with videos array and raw playlist data
 */
async function fetchVideosFromPlaylist(playlistId, options = {}) {
  const { limit = 50, minDuration = 0 } = options;
  
  try {
    logger.debug('YouTube', `Fetching videos from playlist: ${playlistId}`, { limit, minDuration });

    // Fetch videos with pagination support (up to 5,000 videos max per playlist)
    const maxLimit = Math.min(limit, 5000);
    const videos = [];
    let nextPageToken = '';
    let totalFetched = 0;
    let firstPlaylistItem = null; // Store first item for metadata extraction
    
    while (totalFetched < maxLimit) {
      const batchSize = Math.min(50, maxLimit - totalFetched);
      const playlistUrl = `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=${batchSize}&order=date${nextPageToken ? `&pageToken=${nextPageToken}` : ''}&key=${process.env.YOUTUBE_API_KEY}`;
      
      const playlistResponse = await fetch(playlistUrl);
      const playlistData = await playlistResponse.json();

      if (!playlistResponse.ok) {
        logger.error('YouTube', 'Playlist API error', { 
          status: playlistResponse.status, 
          error: playlistData.error, 
          playlistId: playlistId 
        });
        throw new Error(`YouTube API error: ${playlistData.error?.message || 'Unknown error'}`);
      }

      if (!playlistData.items || playlistData.items.length === 0) {
        break; // No more videos
      }

      // Store first playlist item for metadata extraction (by caller)
      if (!firstPlaylistItem && playlistData.items.length > 0) {
        firstPlaylistItem = playlistData.items[0];
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
      playlistId: playlistId
    });

    return {
      videos,
      totalVideos: videos.length,
      hasMore: !!nextPageToken && videos.length < limit,
      firstPlaylistItem // Return first item for metadata extraction
    };

  } catch (error) {
    logger.error('YouTube', 'Error fetching playlist videos', { 
      error: error.message, 
      playlistId: playlistId,
      limit
    });
    throw error;
  }
}

/**
 * Get recent videos from a YouTube channel uploads playlist
 * @param {string} uploadsPlaylistId - YouTube uploads playlist ID (UUxxxx)
 * @param {Object} options - Configuration options
 * @param {number} options.limit - Number of videos to retrieve (default: 50, max: 5000)
 * @param {number} options.minDuration - Minimum duration (>0 means fetch detailed info for filtering)
 * @param {Object} options.providedChannelInfo - Channel info from getChannelUUID if available
 * @returns {Object} Object with videos array and channel info
 */
async function getChannelVideos(uploadsPlaylistId, options = {}) {
  const { providedChannelInfo = null } = options;
  
  try {
    logger.debug('YouTube', `Getting channel videos from uploads playlist: ${uploadsPlaylistId}`);
    
    // Fetch videos using common function
    const result = await fetchVideosFromPlaylist(uploadsPlaylistId, options);
    
    // Extract channel info from first video or use provided info
    let channelInfo = providedChannelInfo;
    if (!channelInfo && result.firstPlaylistItem) {
      const firstItem = result.firstPlaylistItem;
      channelInfo = {
        id: firstItem.snippet.channelId,
        title: firstItem.snippet.channelTitle,
        description: '', // Not available in playlistItems
        thumbnail: '' // Not available in playlistItems
      };
      logger.debug('YouTube', `Extracted channel info from playlist: ${channelInfo.title}`, { channelId: channelInfo.id });
    }
    
    return {
      videos: result.videos,
      totalVideos: result.totalVideos,
      hasMore: result.hasMore,
      channelInfo
    };
    
  } catch (error) {
    logger.error('YouTube', 'Error in getChannelVideos', { 
      error: error.message, 
      uploadsPlaylistId
    });
    throw error;
  }
}

/**
 * Get videos from a YouTube playlist (non-uploads playlist)
 * @param {string} playlistId - YouTube playlist ID (PLxxxx)
 * @param {Object} options - Configuration options
 * @param {number} options.limit - Number of videos to retrieve (default: 50, max: 5000)
 * @param {number} options.minDuration - Minimum duration (>0 means fetch detailed info for filtering)
 * @returns {Object} Object with videos array and playlist info
 */
async function getPlaylistVideos(playlistId, options = {}) {
  try {
    logger.debug('YouTube', `Getting playlist videos: ${playlistId}`);
    
    // Fetch videos using common function
    const result = await fetchVideosFromPlaylist(playlistId, options);
    
    // Extract playlist info from first video
    let playlistInfo = null;
    if (result.firstPlaylistItem) {
      const firstItem = result.firstPlaylistItem;
      playlistInfo = {
        id: playlistId,
        title: firstItem.snippet?.playlistTitle || firstItem.snippet?.channelTitle || 'YouTube Playlist',
        description: 'Podcast feed for YouTube playlist',
        thumbnail: firstItem.snippet?.thumbnails?.high?.url || firstItem.snippet?.thumbnails?.default?.url || ''
      };
      logger.debug('YouTube', `Extracted playlist info: ${playlistInfo.title}`);
    }
    
    return {
      videos: result.videos,
      totalVideos: result.totalVideos,
      hasMore: result.hasMore,
      channelInfo: playlistInfo // Use playlistInfo as channelInfo for RSS generation
    };
    
  } catch (error) {
    logger.error('YouTube', 'Error in getPlaylistVideos', { 
      error: error.message, 
      playlistId
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
    logger.debug('YouTube', `Getting content with videos: ${channelIdentifier}`, { videoLimit, minDuration });
    
    // Step 1: Resolve channel identifier or detect playlist
    const { uploadsPlaylistId, channelInfo: providedChannelInfo, isPlaylist } = await getChannelUUID(channelIdentifier);
    
    // Step 2: Route to appropriate handler based on type
    let videoResults;
    if (isPlaylist) {
      logger.debug('YouTube', `Routing to playlist handler for: ${uploadsPlaylistId}`);
      videoResults = await getPlaylistVideos(uploadsPlaylistId, { 
        limit: videoLimit,
        minDuration
      });
    } else {
      logger.debug('YouTube', `Routing to channel handler for: ${uploadsPlaylistId}`);
      videoResults = await getChannelVideos(uploadsPlaylistId, { 
        limit: videoLimit,
        minDuration,
        providedChannelInfo
      });
    }
    
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

    logger.info('YouTube', `Successfully retrieved content with videos`, {
      contentId: finalChannelInfo.id,
      contentTitle: finalChannelInfo.title,
      videosCount: filteredVideos.length,
      minDuration,
      isPlaylist: isPlaylist || false
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
