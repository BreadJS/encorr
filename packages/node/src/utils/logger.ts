import winston from 'winston';
import chalk from 'chalk';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

// ============================================================================
// Console Format with Colors
// ============================================================================

const consoleFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const levelUpper = level.toUpperCase();
  let coloredLevel: string;

  switch (level) {
    case 'error':
      coloredLevel = chalk.red.bold(levelUpper);
      break;
    case 'warn':
      coloredLevel = chalk.yellow.bold(levelUpper);
      break;
    case 'info':
      coloredLevel = chalk.cyan.bold(levelUpper);
      break;
    case 'debug':
      coloredLevel = chalk.gray.bold(levelUpper);
      break;
    default:
      coloredLevel = chalk.white(levelUpper);
  }

  // Format timestamp as HH:MM:SS
  let time: string;
  if (typeof timestamp === 'string') {
    time = new Date(timestamp).toLocaleTimeString('en-US', { hour12: false });
  } else if (timestamp instanceof Date) {
    time = timestamp.toLocaleTimeString('en-US', { hour12: false });
  } else {
    time = new Date().toLocaleTimeString('en-US', { hour12: false });
  }
  let msg = `${chalk.gray(time)} ${coloredLevel}: ${message}`;

  if (Object.keys(meta).length > 0 && meta.constructor !== Object) {
    if (meta.stack) {
      msg += `\n${chalk.gray(meta.stack)}`;
    } else if (Object.keys(meta).some(k => k !== 'level' && k !== 'message')) {
      msg += ` ${chalk.gray(JSON.stringify(meta, null, 2))}`;
    }
  }

  return msg;
});

// ============================================================================
// File Format
// ============================================================================

const fileFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const time = timestamp || new Date().toISOString();
  let msg = `${time} [${level.toUpperCase()}]: ${message}`;

  if (Object.keys(meta).length > 0) {
    if (meta.stack) {
      msg += `\n${meta.stack}`;
    } else {
      msg += ` ${JSON.stringify(meta)}`;
    }
  }

  return msg;
});

// ============================================================================
// Logger Factory
// ============================================================================

export function createLogger(options?: { silent?: boolean; level?: string }): winston.Logger {
  const logDir = join(process.cwd(), 'logs');

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  return winston.createLogger({
    level: options?.level || process.env.LOG_LEVEL || 'info',
    transports: [
      // Console output
      new winston.transports.Console({
        silent: options?.silent,
        format: winston.format.combine(
          winston.format.timestamp(),
          consoleFormat
        ),
      }),
      // File output
      new winston.transports.File({
        filename: join(logDir, 'encorr-node.log'),
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.errors({ stack: true }),
          fileFormat
        ),
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
      }),
      // Error file
      new winston.transports.File({
        filename: join(logDir, 'error.log'),
        level: 'error',
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.errors({ stack: true }),
          fileFormat
        ),
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
      }),
    ],
  });
}
