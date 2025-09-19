import RSS from 'rss';

/**
 * Generate RSS feed for a YouTube channel
 * @param {Object} channelInfo - Channel information from YouTube API
 * @param {Array} videos - Array of video objects
 * @param {string} baseUrl - Base URL for this application
 * @param {string} profile - Audio profile name (must be valid)
 * @param {Object} profileConfig - Profile configuration object
 * @returns {string} RSS XML string
 */
function generateRSS(channelInfo, videos, baseUrl, profile, profileConfig) {
  // Get cache duration from environment variable (in seconds) and convert to minutes for TTL
  const cacheSeconds = process.env.RSS_CACHE_DURATION || 600; // Default: 10 minutes
  const cacheMinutes = Math.ceil(cacheSeconds / 60); // Convert seconds to minutes
  
  // Create RSS feed object
  const feed = new RSS({
    title: channelInfo.title,
    description: channelInfo.description || `Podcast feed for ${channelInfo.title}`,
    feed_url: `http://${baseUrl}/rss/${channelInfo.id}`,
    site_url: `https://youtube.com/channel/${channelInfo.id}`,
    image_url: channelInfo.thumbnail,
    managingEditor: channelInfo.title,
    webMaster: channelInfo.title,
    copyright: `© ${new Date().getFullYear()} ${channelInfo.title}`,
    language: 'en',
    categories: ['Technology', 'Podcast'],
    pubDate: videos.length > 0 ? new Date(videos[0].publishedAt) : new Date(),
    ttl: cacheMinutes.toString(), // Cache duration from env variable
    // Podcast-specific iTunes tags
    itunesAuthor: channelInfo.title,
    itunesSubtitle: channelInfo.description ? channelInfo.description.substring(0, 100) + '...' : channelInfo.title,
    itunesSummary: channelInfo.description || `Podcast version of ${channelInfo.title} YouTube channel`,
    itunesOwner: {
      name: channelInfo.title,
      email: 'noreply@youcast.local'
    },
    itunesExplicit: false,
    itunesCategory: [{
      text: 'Technology'
    }],
    itunesImage: channelInfo.thumbnail
  });

  // Use provided profile configuration
  
  // Add each video as a podcast episode
  videos.forEach(video => {
    // Include profile in audio URL to ensure consistency
    const audioUrl = `http://${baseUrl}/audio/${video.id}?profile=${profile}`;
    
    feed.item({
      title: video.title,
      description: video.description || video.title,
      url: audioUrl, // Point to our audio endpoint instead of YouTube
      guid: video.id, // Use video ID as unique identifier
      categories: ['Podcast'],
      author: channelInfo.title,
      date: new Date(video.publishedAt),
      
      // Podcast-specific enclosure (audio file)
      enclosure: {
        url: audioUrl,
        type: profileConfig.contentType  // Use specified profile's content type
        // Note: size is omitted as we don't know it without extracting first
      },
      
      // iTunes podcast tags
      itunesAuthor: channelInfo.title,
      itunesExplicit: false,
      itunesSubtitle: video.title.length > 100 ? video.title.substring(0, 97) + '...' : video.title,
      itunesSummary: video.description ? video.description.substring(0, 300) + '...' : video.title,
      itunesDuration: video.duration ? formatDurationForPodcast(video.duration) : undefined,
      itunesImage: video.thumbnail
    });
  });

  return feed.xml({ indent: true });
}

/**
 * Format duration for podcast RSS (iTunes format: HH:MM:SS or MM:SS)
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration
 */
function formatDurationForPodcast(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}


export {
  generateRSS,
  formatDurationForPodcast
};
