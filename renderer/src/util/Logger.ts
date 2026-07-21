import pino from 'pino';

// Pretty-prints logs to console in development; structured JSON in production
const logger = pino({
	level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'development' ? 'info' : 'warn'),
	transport: { target: 'pino-pretty', options: { colorize: true } }, // human-readable in dev
});

export default logger;
