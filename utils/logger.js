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

// Configuration for automatic string truncation
const DEFAULT_STRING_LIMIT = 2000;  // For INFO, WARN levels

class Logger {
  constructor() {
    // Get log level from environment, default to INFO
    const envLogLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
    this.currentLevel = LOG_LEVELS[envLogLevel] !== undefined ? LOG_LEVELS[envLogLevel] : LOG_LEVELS.INFO;
    
    // Get timezone from environment, default to UTC
    this.timezone = process.env.TZ || 'UTC';
    
    // Validate timezone
    try {
      new Intl.DateTimeFormat('en', { timeZone: this.timezone });
    } catch (error) {
      console.warn(`Invalid timezone "${this.timezone}", falling back to UTC`);
      this.timezone = 'UTC';
    }
    
    // Log the current configuration on startup
    this.log('INFO', 'Logger', `Log level set to: ${envLogLevel}, Timezone: ${this.timezone}`);
  }

  /**
   * Format timestamp according to configured timezone
   * @returns {string} Formatted timestamp string
   */
  formatTimestamp() {
    const now = new Date();
    
    // Format date and time components
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    const parts = formatter.formatToParts(now);
    const dateParts = {};
    parts.forEach(part => {
      dateParts[part.type] = part.value;
    });
    
    // Format as ISO-like string without milliseconds
    const timestamp = `${dateParts.year}-${dateParts.month}-${dateParts.day}T${dateParts.hour}:${dateParts.minute}:${dateParts.second}`;
    
    // Add timezone suffix
    if (this.timezone === 'UTC') {
      return `${timestamp}Z`;
    } else {
      // For non-UTC timezones, show the timezone name
      return `${timestamp} (${this.timezone})`;
    }
  }

  /**
   * Truncate strings in an object to prevent excessively long log entries
   * @param {any} obj - Object to process
   * @param {number} limit - Character limit for strings
   * @returns {any} Processed object with truncated strings
   */
  truncateStrings(obj, limit = DEFAULT_STRING_LIMIT) {
    if (typeof obj === 'string') {
      return obj.length > limit ? obj.substring(0, limit) + '...[truncated]' : obj;
    }
    
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.truncateStrings(item, limit));
    }
    
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.truncateStrings(value, limit);
    }
    
    return result;
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

    const timestamp = this.formatTimestamp();
    const color = LEVEL_COLORS[level] || '';
    const levelStr = level.padEnd(5);
    const componentStr = component.padEnd(15);
    
    let logLine = `${timestamp} ${color}[${levelStr}]${RESET_COLOR} ${componentStr} ${message}`;
    
    // Add metadata if provided
    if (meta && typeof meta === 'object') {
      // No truncation if DEBUG level is enabled or for ERROR messages
      if (this.currentLevel >= LOG_LEVELS.DEBUG || level === 'ERROR') {
        logLine += ` ${JSON.stringify(meta)}`;
      } else {
        // Truncate INFO and WARN messages when not in DEBUG mode
        const truncatedMeta = this.truncateStrings(meta, DEFAULT_STRING_LIMIT);
        logLine += ` ${JSON.stringify(truncatedMeta)}`;
      }
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
