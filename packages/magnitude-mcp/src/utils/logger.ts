import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import * as os from 'node:os';

/**
 * Log levels
 */
export enum LogLevel {
  ERROR = 'ERROR',
  INFO = 'INFO',
  DEBUG = 'DEBUG',
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /** Path to the log file */
  logFilePath: string;
  /** Minimum log level to output */
  logLevel: LogLevel;
  /** Whether to also log to console */
  consoleOutput: boolean;
}

/**
 * Default logger configuration
 */
const DEFAULT_CONFIG: LoggerConfig = {
  logFilePath: 'magnitude-mcp.log',
  logLevel: LogLevel.INFO,
  consoleOutput: true,
};

/**
 * Logger for Magnitude MCP
 */
export class Logger {
  private static instance: Logger;
  private config: LoggerConfig;
  private logFileStream: fs.WriteStream | null = null;
  
  /**
   * Create a new logger
   */
  private constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Ensure the directory exists
    const logDir = path.dirname(this.config.logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Create or open the log file
    this.logFileStream = fs.createWriteStream(this.config.logFilePath, { flags: 'a' });
    
    // Log initialization
    this.info('[Setup]', 'Logger initialized');
  }
  
  /**
   * Get the logger instance
   */
  public static getInstance(config?: Partial<LoggerConfig>): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(config);
    } else if (config) {
      // Update config if provided
      Logger.instance.updateConfig(config);
    }
    return Logger.instance;
  }
  
  /**
   * Update logger configuration
   */
  public updateConfig(config: Partial<LoggerConfig>): void {
    const oldPath = this.config.logFilePath;
    
    // Update config
    this.config = { ...this.config, ...config };
    
    // If log file path changed, recreate the stream
    if (config.logFilePath && config.logFilePath !== oldPath) {
      if (this.logFileStream) {
        this.logFileStream.end();
      }
      
      // Ensure the directory exists
      const logDir = path.dirname(this.config.logFilePath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      this.logFileStream = fs.createWriteStream(this.config.logFilePath, { flags: 'a' });
      this.info('[Setup]', `Logger output redirected to ${this.config.logFilePath}`);
    }
  }
  
  /**
   * Format a log message
   */
  private formatLogMessage(level: LogLevel, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.map(arg => 
      typeof arg === 'object' ? util.inspect(arg, { depth: null }) : arg
    ).join(' ');
    
    return `[${timestamp}] [${level}] ${formattedArgs}`;
  }
  
  /**
   * Write a log message
   */
  private log(level: LogLevel, ...args: any[]): void {
    // Check log level
    const levels = Object.values(LogLevel);
    const configLevelIndex = levels.indexOf(this.config.logLevel);
    const messageLevelIndex = levels.indexOf(level);
    
    if (messageLevelIndex < configLevelIndex) {
      return;
    }
    
    const logMessage = this.formatLogMessage(level, ...args);
    
    // Write to file
    if (this.logFileStream) {
      this.logFileStream.write(logMessage + '\n');
    }
    
    // Also log to console if enabled
    if (this.config.consoleOutput) {
      if (level === LogLevel.ERROR) {
        console.error(logMessage);
      } else {
        console.log(logMessage);
      }
    }
  }
  
  /**
   * Log an error message
   */
  public error(...args: any[]): void {
    this.log(LogLevel.ERROR, ...args);
  }
  
  /**
   * Log an info message
   */
  public info(...args: any[]): void {
    this.log(LogLevel.INFO, ...args);
  }
  
  /**
   * Log a debug message
   */
  public debug(...args: any[]): void {
    this.log(LogLevel.DEBUG, ...args);
  }
  
  /**
   * Close the logger
   */
  public close(): void {
    if (this.logFileStream) {
      this.logFileStream.end();
      this.logFileStream = null;
    }
  }
}

// Export a default logger instance
export const logger = Logger.getInstance({ logFilePath: path.join(os.homedir(), '.magnitude', 'mcp.log') });

// Ensure logger is closed on process exit
process.on('exit', () => {
  logger.close();
});
