import fetch from 'node-fetch';
import logger from '../logger.js';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * Get uploads playlist ID from any channel identifier
 * @param {string} channelIdentifier - YouTube channel handle (@name), channel ID (UCxxx), or playlist ID (UUxxx)
 * @returns {Object} Object with uploadsPlaylistId and channelInfo (if available from API call)
 */
export async function getChannelUUID(channelIdentifier) {
  // Check if YouTube API key is configured
  if (!YOUTUBE_API_KEY) {
    throw new Error('YouTube API key not configured');
  }

  // If it's UUxxxx just give it back as is
  if (channelIdentifier.startsWith('UU') && channelIdentifier.length === 24) {
    logger.debug('YouTube', `Direct uploads playlist ID: ${channelIdentifier}`);
    return {
      uploadsPlaylistId: channelIdentifier,
      channelInfo: null // No API call made, no channel info available
    };
  }
  
  // If it's UCxxxx just change the C to U and give it back
  if (channelIdentifier.startsWith('UC') && channelIdentifier.length === 24) {
    logger.debug('YouTube', `Channel ID detected: ${channelIdentifier}`);
    const uploadsPlaylistId = channelIdentifier.replace('UC', 'UU');
    logger.debug('YouTube', `Generated uploads playlist ID: ${uploadsPlaylistId}`);
    return {
      uploadsPlaylistId,
      channelInfo: null // No API call made, no channel info available
    };
  }
  
  // If it's a channel name, call YouTube API - keep the channel info!
  logger.debug('YouTube', `Channel handle detected: ${channelIdentifier}`);
  
  const handleWithoutAt = channelIdentifier.startsWith('@') ? channelIdentifier.substring(1) : channelIdentifier;
  const url = `${YOUTUBE_API_BASE}/channels?part=snippet&forHandle=${handleWithoutAt}&key=${YOUTUBE_API_KEY}`;
  
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || !data.items || data.items.length === 0) {
    throw new Error(`Channel not found: ${channelIdentifier}`);
  }

  const channel = data.items[0];
  const uploadsPlaylistId = channel.id.replace('UC', 'UU');
  
  // Return both playlist ID and the valuable channel info from API
  const channelInfo = {
    id: channel.id,
    title: channel.snippet.title,
    description: channel.snippet.description,
    thumbnail: channel.snippet.thumbnails?.high?.url || channel.snippet.thumbnails?.default?.url
  };
  
  logger.debug('YouTube', `Found channel via API: ${channelInfo.title}, generated playlist ID: ${uploadsPlaylistId}`);
  
  return {
    uploadsPlaylistId,
    channelInfo // Pass the full API data!
  };
}