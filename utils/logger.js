/**
 * Structured logging utility for YouCast application
 * Supports log levels: ERROR, WARN, INFO, DEBUG
 * Log level is controlled by LOG_LEVEL environment variable (defaults to INFO)
 */

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1, 
  INFO: 2,
  DEBUG: 3
};

const LEVEL_COLORS = {
  ERROR: '\x1b[31m', // Red
  WARN: '\x1b[33m',  // Yellow
  INFO: '\x1b[36m',  // Cyan
  DEBUG: '\x1b[37m'  // White
};

const RESET_COLOR = '\x1b[0m';

class Logger {
  constructor() {
    // Get log level from environment, default to INFO
    const envLogLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
    this.currentLevel = LOG_LEVELS[envLogLevel] !== undefined ? LOG_LEVELS[envLogLevel] : LOG_LEVELS.INFO;
    
    // Log the current log level on startup
    this.log('INFO', 'Logger', `Log level set to: ${envLogLevel}`);
  }

  /**
   * Internal log method
   * @param {string} level - Log level (ERROR, WARN, INFO, DEBUG)
   * @param {string} component - Component/module name
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata (optional)
   */
  log(level, component, message, meta = null) {
    const levelNum = LOG_LEVELS[level];
    
    // Only log if the level is enabled
    if (levelNum > this.currentLevel) {
      return;
    }

    const timestamp = new Date().toISOString();
    const color = LEVEL_COLORS[level] || '';
    const levelStr = level.padEnd(5);
    const componentStr = component.padEnd(15);
    
    let logLine = `${timestamp} ${color}[${levelStr}]${RESET_COLOR} ${componentStr} ${message}`;
    
    // Add metadata if provided
    if (meta && typeof meta === 'object') {
      logLine += ` ${JSON.stringify(meta)}`;
    }
    
    // Use appropriate console method
    switch (level) {
      case 'ERROR':
        console.error(logLine);
        break;
      case 'WARN':
        console.warn(logLine);
        break;
      default:
        console.log(logLine);
    }
  }

  /**
   * Log error level message
   * @param {string} component - Component/module name
   * @param {string} message - Log message
   * @param {Object|Error} meta - Additional metadata or error object
   */
  error(component, message, meta = null) {
    // If meta is an Error object, extract useful information
    if (meta instanceof Error) {
      meta = {
        name: meta.name,
        message: meta.message,
        stack: meta.stack
      };
    }
    this.log('ERROR', component, message, meta);
  }

  /**
   * Log warning level message
   * @param {string} component - Component/module name
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata (optional)
   */
  warn(component, message, meta = null) {
    this.log('WARN', component, message, meta);
  }

  /**
   * Log info level message  
   * @param {string} component - Component/module name
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata (optional)
   */
  info(component, message, meta = null) {
    this.log('INFO', component, message, meta);
  }

  /**
   * Log debug level message
   * @param {string} component - Component/module name
   * @param {string} message - Log message  
   * @param {Object} meta - Additional metadata (optional)
   */
  debug(component, message, meta = null) {
    this.log('DEBUG', component, message, meta);
  }

  /**
   * Log HTTP request
   * @param {string} method - HTTP method
   * @param {string} path - Request path
   * @param {number} statusCode - Response status code (optional)
   * @param {number} duration - Request duration in ms (optional)
   */
  request(method, path, statusCode = null, duration = null) {
    const meta = {};
    if (statusCode !== null) meta.status = statusCode;
    if (duration !== null) meta.duration = `${duration}ms`;
    
    this.info('HTTP', `${method} ${path}`, Object.keys(meta).length > 0 ? meta : null);
  }

  /**
   * Log operation start
   * @param {string} component - Component/module name
   * @param {string} operation - Operation name
   * @param {Object} meta - Additional metadata (optional)
   */
  operation(component, operation, meta = null) {
    this.info(component, `Starting ${operation}`, meta);
  }

  /**
   * Log operation success
   * @param {string} component - Component/module name
   * @param {string} operation - Operation name
   * @param {Object} meta - Additional metadata (optional)
   */
  success(component, operation, meta = null) {
    this.info(component, `${operation} completed successfully`, meta);
  }
}

// Export singleton instance
const logger = new Logger();
export default logger;
