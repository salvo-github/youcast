import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import rssRoutes from './routes/rss.js';
import audioRoutes from './routes/audio.js';
import { getDefaultProfile } from './utils/profile-utils.js';
import logger from './utils/logger.js';

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

// Production performance middleware (static imports)
// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for RSS feeds
  crossOriginEmbedderPolicy: false // Allow audio embedding
}));

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
}));

// Compression for all responses
app.use(compression({
  filter: (req, res) => {
    // Don't compress if the request includes a cache-control header to prevent transform
    if (req.headers['cache-control'] && req.headers['cache-control'].includes('no-transform')) {
      return false;
    }
    // Use compression filter for everything else
    return compression.filter(req, res);
  },
  level: 6, // Good balance between compression ratio and speed
  threshold: 1024 // Only compress responses larger than 1KB
}));

// Trust proxy for rate limiting and IP detection
app.set('trust proxy', 1);

// CORS configuration - restricted for production
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || false,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// Body parsing with production limits
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Minimal production request logging
app.use((req, res, next) => {
  const startTime = Date.now();
  
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - startTime;
    // Only log errors and slow requests in production
    if (res.statusCode >= 400 || duration > 5000) {
      logger.request(req.method, req.path, res.statusCode, duration);
    }
    originalEnd.apply(this, args);
  };
  
  next();
});

// Routes
app.use('/rss', rssRoutes);
app.use('/audio', audioRoutes);

// Production health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Production error handling middleware
app.use((err, req, res, next) => {
  logger.error('Express', 'Unhandled error', {
    error: err.message,
    url: req.url,
    method: req.method
  });
  
  res.status(500).json({ error: 'Internal Server Error' });
});

// Production 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.listen(PORT, () => {
  logger.info('Server', `YouCast Backend server running on port ${PORT}`);
  logger.info('Server', `Environment: ${NODE_ENV}`);
  logger.info('Server', `Default profile: ${getDefaultProfile()}`);
  logger.info('Server', 'Production server started');
});

export default app;
