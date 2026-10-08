import pino from 'pino';

const isDev = process.env.NOMUS_ENV !== 'production';

function createLogger() {
  if (isDev) {
    try {
      return pino({
        level: process.env.NOMUS_LOG_LEVEL || 'info',
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      });
    } catch {
      // pino-pretty not installed or transport failed — fall back to plain JSON logging
    }
  }
  return pino({ level: process.env.NOMUS_LOG_LEVEL || 'info' });
}

export const logger = createLogger();
