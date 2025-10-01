/**
 * Profile utility functions for managing audio profiles and defaults
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load yt-dlp profiles configuration once at module load
let profilesConfig;
try {
  const configPath = resolve(__dirname, '../config/yt-dlp-profiles.json');
  profilesConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  logger.info('Config', `Loaded ${Object.keys(profilesConfig).length} yt-dlp profiles`);
} catch (error) {
  logger.error('Config', 'Failed to load yt-dlp profiles configuration', error);
  process.exit(1); // Cannot continue without profile config
}

/**
 * Get the default audio profile from environment or fallback to 'mp3'
 * @returns {string} Default profile name
 */
function getDefaultProfile() {
  return process.env.DEFAULT_AUDIO_PROFILE || 'mp3';
}

/**
 * Get profile configuration with fallback to default
 * @param {string} requestedProfile - The requested profile name (can be null/undefined)
 * @returns {Object} Object containing: { profile: string, profileConfig: Object }
 */
function getProfileConfig(requestedProfile) {
    // If requested profile exists, use it; otherwise use default
  if (requestedProfile && profilesConfig[requestedProfile]) {
    return {
      profile: requestedProfile,
      profileConfig: profilesConfig[requestedProfile]
    };
  }
  
  const defaultProfile = getDefaultProfile();

  return {
    profile: defaultProfile,
    profileConfig: profilesConfig[defaultProfile]
  };
}

export {
  getDefaultProfile,
  getProfileConfig
};
