import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import { cpus } from 'os';
import logger from './logger.js';


/**
 * Extract audio from YouTube video using yt-dlp and return as a stream
 * Uses provided profile configuration for audio format and quality settings
 * @param {string} videoId - YouTube video ID (must be valid)
 * @param {string} profile - Profile name (must exist in configuration)
 * @param {Object} profileConfig - Profile configuration object
 * @returns {Promise<{stream: Readable, contentType: string, title: string, fileExtension: string}>} Audio stream, content type, video title, and file extension
 */
async function extractAudioStream(videoId, profile, profileConfig) {
  return new Promise((resolve, reject) => {
    try {
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

      logger.operation('AudioExtractor', `Extracting: ${videoId} (profile: ${profile})`);
      logger.debug('AudioExtractor', `Using profile: ${profileConfig.description}`);

      // Get number of logical CPUs for concurrent processing
      const cpuCount = cpus().length;

      // Check if this profile needs conversion (has postprocessor args)
      const needsConversion = profileConfig.postprocessorArgs && profileConfig.postprocessorArgs.trim() !== '';

      if (needsConversion) {
        // Pipeline: yt-dlp → ffmpeg → consumer
        logger.debug('AudioExtractor', `Using conversion pipeline: yt-dlp → ffmpeg → stream`);
        
        // Step 1: yt-dlp extracts raw audio
        const ytdlpArgs = [
          '-N', cpuCount.toString(),
          '-f', 'bestaudio',
          '--output', '-',
          '--no-playlist',
          '--prefer-ffmpeg',
          videoUrl
        ];
        
        // Step 2: ffmpeg converts to target format using profile's postprocessor args
        // Parse the postprocessorArgs: "ffmpeg:-threads 0 -c:a libmp3lame -b:a 64k -ac 1 -ar 22050"
        const postprocessorArgs = profileConfig.postprocessorArgs.replace(/^ffmpeg:/, '');
        const ffmpegArgs = [
          '-i', 'pipe:0',
          ...postprocessorArgs.split(' ').filter(arg => arg.trim() !== ''),
          '-f', profileConfig.audioFormat,
          'pipe:1'
        ];
        
        const ytdlp = spawn('yt-dlp', ytdlpArgs);
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        // Create the final output stream
        const audioStream = new PassThrough();
        
        // Pipeline: yt-dlp stdout → ffmpeg stdin → ffmpeg stdout → audioStream
        ytdlp.stdout.pipe(ffmpeg.stdin);
        ffmpeg.stdout.pipe(audioStream);
        
        let hasError = false;
        let stderr = '';
        
        // Handle yt-dlp errors
        ytdlp.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        ytdlp.on('error', (error) => {
          if (hasError) return;
          hasError = true;
          logger.error('AudioExtractor', 'yt-dlp error in conversion pipeline', { videoId, error: error.message });
          reject(new Error(`yt-dlp failed: ${error.message}`));
        });
        
        // Handle ffmpeg errors
        ffmpeg.stderr.on('data', (data) => {
          const error = data.toString();
          // Only log actual errors, not progress info
          if (error.includes('error') || error.includes('ERROR')) {
            logger.debug('AudioExtractor', `ffmpeg: ${error.trim()}`);
          }
        });
        
        ffmpeg.on('error', (error) => {
          if (hasError) return;
          hasError = true;
          logger.error('AudioExtractor', 'ffmpeg error in conversion pipeline', { videoId, error: error.message });
          reject(new Error(`ffmpeg conversion failed: ${error.message}`));
        });
        
        // Handle successful completion
        ytdlp.on('close', (code) => {
          if (hasError) return;
          if (code !== 0) {
            hasError = true;
            logger.error('AudioExtractor', `yt-dlp failed`, { videoId, exitCode: code, stderr: stderr.substring(0, 300) });
            reject(new Error(`yt-dlp failed with exit code ${code}`));
          }
        });
        
        ffmpeg.on('close', (code) => {
          if (hasError) return;
          if (code !== 0) {
            hasError = true;
            logger.error('AudioExtractor', `ffmpeg failed`, { videoId, exitCode: code });
            reject(new Error(`ffmpeg failed with exit code ${code}`));
          } else {
            logger.success('AudioExtractor', `Completed conversion pipeline: ${videoId}`);
          }
        });
        
        // Resolve immediately with the stream
        resolve({
          stream: audioStream,
          contentType: profileConfig.contentType,
          title: `Video ${videoId}`,
          fileExtension: profileConfig.fileExtension
        });
        
      } else {
        // Direct yt-dlp streaming (no conversion needed)
        logger.debug('AudioExtractor', `Using direct yt-dlp streaming`);
        
        const args = [
          '-N', cpuCount.toString(),
          '-x', // Extract audio only
          '--audio-format', profileConfig.audioFormat,
          '--output', '-', // Output to stdout
          ...profileConfig.additionalArgs,
          videoUrl
        ];
        
        const ytdlp = spawn('yt-dlp', args);
        const audioStream = new PassThrough();
        
        let stderr = '';
        let streamStarted = false;
        
        // Handle stderr for errors
        ytdlp.stderr.on('data', (data) => {
          const error = data.toString();
          stderr += error;
          
          // Log important messages
          if (error.includes('Downloading 1 format(s):')) {
            logger.info('AudioExtractor', `Format: ${error.trim()}`);
          }
          
          // Check for critical errors
          if (error.includes('error:') || error.includes('ERROR:')) {
            logger.error('AudioExtractor', `yt-dlp critical error`, { videoId, error: error.trim() });
          }
        });

        // Pipe yt-dlp stdout to our stream
        ytdlp.stdout.pipe(audioStream);
        
        // Handle successful start
        ytdlp.stdout.on('data', (chunk) => {
          if (!streamStarted) {
            streamStarted = true;
            resolve({
              stream: audioStream,
              contentType: profileConfig.contentType,
              title: `Video ${videoId}`,
              fileExtension: profileConfig.fileExtension
            });
          }
        });

        // Handle process completion
        ytdlp.on('close', (code) => {
          if (code !== 0 && !streamStarted) {
            logger.error('AudioExtractor', `yt-dlp failed`, { videoId, exitCode: code, stderr: stderr.substring(0, 500) });
            reject(new Error(`yt-dlp failed with exit code ${code}: ${stderr}`));
          } else if (streamStarted) {
            logger.success('AudioExtractor', `Completed direct streaming: ${videoId}`);
          }
        });

        // Handle process errors
        ytdlp.on('error', (error) => {
          logger.error('AudioExtractor', 'Failed to start yt-dlp process', { videoId, error: error.message });
          reject(new Error(`Failed to start yt-dlp: ${error.message}`));
        });
      }

    } catch (error) {
      logger.error('AudioExtractor', `Audio stream extraction failed for video: ${videoId}`, { error: error.message });
      reject(error);
    }
  });
}




export {
  extractAudioStream
};