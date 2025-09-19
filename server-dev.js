import express from 'express';
import cors from 'cors';
import 'dotenv/config';

import rssRoutes from './routes/rss.js';
import audioRoutes from './routes/audio.js';
import { getDefaultProfile } from './utils/profile-utils.js';
import logger from './utils/logger.js';

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Development-friendly middleware
app.use(cors({
  origin: '*', // Allow all origins in development
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' })); // Higher limits for development
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Development request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // Log the request with more details in development
  logger.debug('HTTP', `${req.method} ${req.path}`, {
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    body: req.method === 'POST' && req.body ? 'Present' : undefined
  });
  
  // Override res.end to log response
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - startTime;
    logger.request(req.method, req.path, res.statusCode, duration);
    originalEnd.apply(this, args);
  };
  
  next();
});

// Routes
app.use('/rss', rssRoutes);
app.use('/audio', audioRoutes);

// Health check endpoint with development info
app.get('/health', (req, res) => {
  logger.debug('Health', 'Health check requested');
  res.json({ 
    status: 'OK', 
    environment: 'development',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    defaultProfile: getDefaultProfile()
  });
});

// Development debug endpoint
app.get('/debug', (req, res) => {
  res.json({
    environment: NODE_ENV,
    nodeVersion: process.version,
    platform: process.platform,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    env: {
      PORT: process.env.PORT,
      LOG_LEVEL: process.env.LOG_LEVEL,
      YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY ? 'Set' : 'Not Set'
    }
  });
});

// Development error handling middleware (detailed errors)
app.use((err, req, res, next) => {
  logger.error('Express', 'Unhandled error in request', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    body: req.body,
    query: req.query
  });
  
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: err.message,
    stack: NODE_ENV === 'development' ? err.stack : undefined
  });
});

// 404 handler - must be last middleware
app.use((req, res) => {
  logger.warn('HTTP', `404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'Not Found',
    availableEndpoints: [
      'GET /health - Health check',
      'GET /debug - Debug information',
      'GET /rss/:channelIdentifier - Generate RSS feed',
      'GET /audio/:videoId - Stream audio'
    ]
  });
});

app.listen(PORT, () => {
  logger.info('Server', `YouCast Backend DEV server running on port ${PORT}`);
  logger.info('Server', `Environment: ${NODE_ENV}`);
  logger.info('Server', `Health check: http://localhost:${PORT}/health`);
  logger.info('Server', `Debug info: http://localhost:${PORT}/debug`);
  logger.info('Server', `Default audio profile: ${getDefaultProfile()}`);
  logger.info('Server', 'Development server startup completed successfully');
});

export default app;
