/**
 * @module ErrorHandler
 *
 * Provides centralized error and signal handling for the process.
 *
 * Responsibilities:
 * - Capture and log uncaught exceptions.
 * - Capture and log unhandled promise rejections.
 * - Handle termination signals (`SIGTERM`, `SIGINT`).
 * - Ensure graceful shutdown of the process with an appropriate exit code.
 *
 * Integrates with:
 * - {@link logger} for structured logging.
 */

import logger from './Logger.js';

/**
 * Global error handler for Node.js processes.
 *
 * When instantiated, this class automatically sets up handlers for:
 * - `uncaughtException`
 * - `unhandledRejection`
 * - `SIGTERM`
 * - `SIGINT`
 *
 * Each handler logs the error/signal, then initiates a graceful shutdown.
 */
export class ErrorHandler {
	constructor() {
		this.setupGlobalHandlers();
	}

	/**
	 * Attach listeners for process-level error and termination events.
	 */
	private setupGlobalHandlers() {
		process.on('uncaughtException', this.handleUncaughtException.bind(this));
		process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));
		process.on('SIGTERM', this.handleTermination.bind(this));
		process.on('SIGINT', this.handleTermination.bind(this));
	}

	/**
	 * Handle uncaught exceptions.
	 * Logs the error as `fatal` and triggers a shutdown with exit code `1`.
	 *
	 * @param {Error} error - The uncaught error.
	 */
	private handleUncaughtException(error: Error) {
		logger.fatal(
			{
				err: error,
				stack: error.stack,
				type: 'uncaughtException',
			},
			'Uncaught Exception occurred'
		);

		this.gracefulShutdown(1);
	}

	/**
	 * Handle unhandled promise rejections.
	 * Logs the rejection reason and triggers a shutdown with exit code `1`.
	 *
	 * @param {any} reason - Reason for the rejection (could be an error or value).
	 * @param {Promise<any>} promise - The rejected promise.
	 */
	private handleUnhandledRejection(reason: any, promise: Promise<any>) {
		logger.fatal(
			{
				err: reason,
				stack: reason?.stack,
				type: 'unhandledRejection',
				promise: Promise.toString(),
			},
			'Unhandled Promise Rejection occurred'
		);

		this.gracefulShutdown(1);
	}

	/**
	 * Handle termination signals (`SIGTERM`, `SIGINT`).
	 * Logs the received signal and shuts down gracefully with exit code `0`.
	 *
	 * @param {string} signal - Signal name.
	 */
	private handleTermination(signal: string) {
		logger.info({ signal }, 'Termination signal received');
		this.gracefulShutdown(0);
	}

	/**
	 * Perform a graceful shutdown of the process.
	 *
	 * - Logs are flushed before exit (due to timeout).
	 * - Exits with the provided exit code.
	 *
	 * @param {number} exitCode - Exit code for the process (0 for normal, 1 for error).
	 */
	private gracefulShutdown(exitCode: number) {
		setTimeout(() => {
			process.exit(exitCode);
		}, 1000);
	}
}
