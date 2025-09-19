import fetch from 'node-fetch';
import logger from './logger.js';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * Get information about a YouTube channel
 * @param {string} channelId - YouTube channel ID or handle
 * @returns {Object} Channel information
 */
async function getChannelInfo(channelId) {
  try {
    // Handle both channel IDs and channel handles (@username)
    const isHandle = channelId.startsWith('@');
    
    if (isHandle) {
      // Try multiple approaches for handles
      const handleWithoutAt = channelId.substring(1);
      
      // First try: forHandle parameter (recommended method)
      logger.debug('YouTube', `Trying forHandle lookup with: ${handleWithoutAt}`);
      let result = await tryChannelLookup('forHandle', handleWithoutAt);
      
      if (result) {
        logger.debug('YouTube', `Channel found via forHandle: ${result.title}`);
        return result;
      }
      
      // Second try: forUsername parameter (legacy method)
      logger.debug('YouTube', `Trying forUsername lookup with: ${handleWithoutAt}`);
      result = await tryChannelLookup('forUsername', handleWithoutAt);
      
      if (result) {
        logger.debug('YouTube', `Channel found via forUsername: ${result.title}`);
        return result;
      }
      
      // Third try: search API as fallback
      logger.debug('YouTube', `Trying search API for: ${channelId}`);
      return await searchChannelByName(channelId);
      
    } else {
      // Direct channel ID lookup
      logger.debug('YouTube', `Fetching channel info with id: ${channelId}`);
      return await tryChannelLookup('id', channelId);
    }

  } catch (error) {
    logger.error('YouTube', 'Error fetching channel info', { 
      error: error.message, 
      channelId,
      stack: error.stack 
    });
    
    // Provide more specific error information
    if (error.message.includes('API key')) {
      logger.error('YouTube', 'Invalid or missing API key');
      throw new Error('YouTube API key is invalid or missing');
    }
    
    if (error.message.includes('quotaExceeded')) {
      logger.error('YouTube', 'YouTube API quota exceeded');
      throw new Error('YouTube API quota exceeded. Please try again later.');
    }
    
    throw error;
  }
}

/**
 * Try a channel lookup with specified parameter
 * @param {string} searchParam - The parameter type (id, forHandle, forUsername)
 * @param {string} searchValue - The value to search for
 * @param {boolean} includeContentDetails - Whether to include contentDetails part (default: false)
 * @returns {Object|null} Channel information or null if not found
 */
async function tryChannelLookup(searchParam, searchValue, includeContentDetails = false) {
  try {
    const parts = includeContentDetails ? 'snippet,statistics,contentDetails' : 'snippet,statistics';
    const url = `${YOUTUBE_API_BASE}/channels?part=${parts}&${searchParam}=${searchValue}&key=${YOUTUBE_API_KEY}`;
    
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      logger.error('YouTube', `API error response for ${searchParam}=${searchValue}`, { 
        status: response.status, 
        error: data.error 
      });
      throw new Error(`YouTube API error: ${data.error?.message || 'Unknown error'}`);
    }

    if (!data.items || data.items.length === 0) {
      logger.debug('YouTube', `No channel found for ${searchParam}=${searchValue}`);
      return null;
    }

    const channel = data.items[0];
    const channelInfo = {
      id: channel.id,
      title: channel.snippet.title,
      description: channel.snippet.description,
      thumbnail: channel.snippet.thumbnails?.high?.url || channel.snippet.thumbnails?.default?.url,
      customUrl: channel.snippet.customUrl,
      publishedAt: channel.snippet.publishedAt,
      subscriberCount: channel.statistics.subscriberCount,
      videoCount: channel.statistics.videoCount,
      viewCount: channel.statistics.viewCount
    };

    // Add uploads playlist ID if contentDetails was requested
    if (includeContentDetails && channel.contentDetails) {
      channelInfo.uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;
    }
    
    logger.debug('YouTube', `Channel found: ${channelInfo.title}`, { channelId: channelInfo.id });
    return channelInfo;

  } catch (error) {
    logger.error('YouTube', `Channel lookup failed with ${searchParam}=${searchValue}`, { error: error.message });
    throw error;
  }
}

/**
 * Search for channel using the search API (fallback method)
 * @param {string} channelName - Channel name or handle to search for
 * @returns {Object|null} Channel information or null if not found
 */
async function searchChannelByName(channelName) {
  try {
    const searchQuery = channelName.startsWith('@') ? channelName.substring(1) : channelName;
    const url = `${YOUTUBE_API_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(searchQuery)}&key=${YOUTUBE_API_KEY}&maxResults=1`;
    
    logger.debug('YouTube', `Searching for channel: ${searchQuery}`);
    
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      logger.warn('YouTube', `Search API error for query: ${searchQuery}`, { status: response.status, error: data.error });
      return null; // Don't throw error for search fallback
    }

    if (!data.items || data.items.length === 0) {
      logger.debug('YouTube', `No channel found in search for: ${searchQuery}`);
      return null;
    }

    // Get full channel details using the found channel ID
    const foundChannelId = data.items[0].snippet.channelId;
    logger.debug('YouTube', `Found channel via search, getting details for ID: ${foundChannelId}`);
    
    return await tryChannelLookup('id', foundChannelId);

  } catch (error) {
    logger.warn('YouTube', 'Search fallback failed', { error: error.message, searchQuery: channelName });
    return null; // Don't throw error for search fallback
  }
}

/**
 * Get recent videos from a YouTube channel
 * @param {string} channelId - YouTube channel ID
 * @param {number} limit - Number of videos to retrieve (default: 50, max: 5000)
 * @param {Object} options - Additional options
 * @param {boolean} options.includeDetails - Include video statistics and duration (default: true)
 * @param {string} options.uploadsPlaylistId - Pre-fetched uploads playlist ID to save API calls
 * @returns {Object} Object with videos array
 */
async function getChannelVideos(channelId, limit = 50, options = {}) {
  const { includeDetails = true, uploadsPlaylistId: providedPlaylistId } = options;
  
  try {
    logger.debug('YouTube', `Getting channel videos for: ${channelId}`, { limit, includeDetails });
    
    let uploadsPlaylistId = providedPlaylistId;
    
    // Get uploads playlist ID if not provided (saves 1 unit when called from getChannelInfo)
    if (!uploadsPlaylistId) {
      const channelUrl = `${YOUTUBE_API_BASE}/channels?part=contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`;
      logger.debug('YouTube', 'Fetching channel content details');
      
      const channelResponse = await fetch(channelUrl);
      const channelData = await channelResponse.json();

      if (!channelResponse.ok) {
        logger.error('YouTube', 'Channel content API error', { 
          status: channelResponse.status, 
          error: channelData.error, 
          channelId 
        });
        throw new Error(`YouTube API error: ${channelData.error?.message || 'Unknown error'}`);
      }

      if (!channelData.items || channelData.items.length === 0) {
        logger.error('YouTube', `No content details found for channel: ${channelId}`);
        throw new Error('Channel not found');
      }

      uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;
      logger.debug('YouTube', `Found uploads playlist: ${uploadsPlaylistId}`);
    }

    // Fetch videos with pagination support (up to 5,000 videos max per playlist)
    const maxLimit = Math.min(limit, 5000);
    const videos = [];
    let nextPageToken = '';
    let totalFetched = 0;
    
    while (totalFetched < maxLimit) {
      const batchSize = Math.min(50, maxLimit - totalFetched);
      const playlistUrl = `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${batchSize}&order=date${nextPageToken ? `&pageToken=${nextPageToken}` : ''}&key=${YOUTUBE_API_KEY}`;
      
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

      // Batch video details requests (up to 50 videos per request)
      const videoIds = playlistData.items.map(item => item.snippet.resourceId.videoId);
      
      if (includeDetails && videoIds.length > 0) {
        // Process video IDs in batches of 50 (API limit)
        for (let i = 0; i < videoIds.length; i += 50) {
          const batchIds = videoIds.slice(i, i + 50).join(',');
          const videosUrl = `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails,statistics&id=${batchIds}&key=${YOUTUBE_API_KEY}`;
          
          const videosResponse = await fetch(videosUrl);
          const videosData = await videosResponse.json();

          if (!videosResponse.ok) {
            logger.error('YouTube', 'Videos API error', { 
              status: videosResponse.status, 
              error: videosData.error 
            });
            throw new Error(`YouTube API error: ${videosData.error?.message || 'Unknown error'}`);
          }

          // Map video details
          const detailedVideos = videosData.items.map(video => ({
            id: video.id,
            title: video.snippet.title,
            description: video.snippet.description,
            publishedAt: video.snippet.publishedAt,
            thumbnail: video.snippet.thumbnails?.high?.url || video.snippet.thumbnails?.default?.url,
            duration: parseDuration(video.contentDetails.duration),
            viewCount: video.statistics?.viewCount || '0',
            likeCount: video.statistics?.likeCount || '0',
            url: `https://www.youtube.com/watch?v=${video.id}`
          }));

          videos.push(...detailedVideos);
        }
      } else {
        // Basic video info without details
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
    
    logger.info('YouTube', `Successfully fetched ${videos.length} videos for channel`, { 
      channelId, 
      videosCount: videos.length, 
      includeDetails 
    });

    return {
      videos,
      totalVideos: videos.length,
      hasMore: !!nextPageToken && videos.length < limit
    };

  } catch (error) {
    logger.error('YouTube', 'Error fetching channel videos', { 
      error: error.message, 
      channelId, 
      limit
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


/**
 * Get channel info and videos
 * @param {string} channelIdentifier - YouTube channel ID or handle
 * @param {number} videoLimit - Number of videos to retrieve (default: 50, max: 5000)
 * @param {Object} options - Additional options
 * @param {boolean} options.includeVideoDetails - Include video statistics and duration (default: true)
 * @returns {Object} Object with channel info and videos
 */
async function getChannelWithVideos(channelIdentifier, videoLimit = 50, options = {}) {
  const { includeVideoDetails = true } = options;
  
  try {
    logger.debug('YouTube', `Getting channel with videos: ${channelIdentifier}`, { videoLimit, includeVideoDetails });
    
    // Step 1: Get channel info with contentDetails
    const channelInfo = await getChannelInfo(channelIdentifier);
    
    if (!channelInfo) {
      throw new Error('Channel not found');
    }
    
    // Step 2: Get uploads playlist ID efficiently
    let uploadsPlaylistId = channelInfo.uploadsPlaylistId;
    
    if (!uploadsPlaylistId) {
      // Fetch contentDetails if not already included
      const enhancedChannelInfo = await tryChannelLookup('id', channelInfo.id, true);
      
      if (!enhancedChannelInfo || !enhancedChannelInfo.uploadsPlaylistId) {
        throw new Error('Unable to find uploads playlist for channel');
      }
      
      uploadsPlaylistId = enhancedChannelInfo.uploadsPlaylistId;
      channelInfo.uploadsPlaylistId = uploadsPlaylistId;
    }
    
    // Step 3: Get videos using the playlist ID
    const videoResults = await getChannelVideos(
      channelInfo.id, 
      videoLimit, 
      { 
        includeDetails: includeVideoDetails, 
        uploadsPlaylistId 
      }
    );
    
    
    logger.info('YouTube', `Successfully retrieved channel with videos`, {
      channelId: channelInfo.id,
      channelTitle: channelInfo.title,
      videosCount: videoResults.videos.length
    });
    
    return {
      channel: channelInfo,
      videos: videoResults.videos,
      totalVideos: videoResults.totalVideos,
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



export {
  getChannelInfo,
  getChannelVideos,
  getChannelWithVideos,
  parseDuration
};
