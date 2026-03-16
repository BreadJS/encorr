import winston from 'winston';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

// ============================================================================
// Logger Configuration
// ============================================================================

export function createLogger(options?: { silent?: boolean }): winston.Logger {
  const logDir = join(process.cwd(), 'logs');

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const formats = [
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
      if (Object.keys(meta).length > 0) {
        if (meta.stack) {
          msg += `\n${meta.stack}`;
        } else {
          msg += ` ${JSON.stringify(meta)}`;
        }
      }
      return msg;
    }),
  ];

  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(...formats),
    transports: [
      // Console output
      new winston.transports.Console({
        silent: options?.silent,
      }),
      // File output - all logs
      new winston.transports.File({
        filename: join(logDir, 'encorr.log'),
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
      }),
      // File output - errors only
      new winston.transports.File({
        filename: join(logDir, 'error.log'),
        level: 'error',
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
      }),
    ],
  });
}

// ============================================================================
// Default Logger Instance
// ============================================================================

export const logger = createLogger();
