/**
 * @module index
 *
 * Entry point for the render worker service.
 *
 * Responsibilities:
 * - Register the worker with Harper via HTTP.
 * - Initialize the local job queue buffer.
 * - Launch and configure the {@link RenderWorker}.
 * - Forward job results back to Harper.
 *
 * Integrates with:
 * - {@link JobQueue} for managing job fetching and buffering.
 * - {@link RenderWorker} for executing render jobs with Chrome.
 * - External HTTP utilities (`fetchJobs`, `register`, `sendJobResult`).
 * - Environment configuration via {@link env}.
 */

import { JobQueue } from './JobQueue.js';
import RenderWorker from './Worker.js';
import { CHROME_ARGS, CONCURRENCY, JOB_BUFFER_SIZE } from './util/env.js';
import { fetchJobs, register, sendJobResult } from './external/http.js';
import renderer from './util/renderer.js';
import logger from './util/Logger.js';

/**
 * Register this worker with Harper.
 * Ensures the worker is known to the orchestrator before processing jobs.
 */
await register();

/**
 * Initialize the job queue.
 *
 * The job queue:
 * - Buffers up to `JOB_BUFFER_SIZE` jobs.
 * - Uses {@link fetchJobs} to pull jobs from Harper.
 *
 * @type {JobQueue}
 */
const jobQueue = await JobQueue.init({
	capacity: JOB_BUFFER_SIZE,
	fetchJobs,
});

/**
 * Configure the render worker.
 *
 * Settings:
 * - `maxConcurrency`: Maximum number of parallel rendering tasks.
 * - `browserExpirationThreshold`: When to recycle browser instances.
 * - `rps`: Requests per second limit (rate limiter).
 * - `jobQueue`: Job buffer connected to Harper.
 * - `browserLaunchOptions`: Chrome launch configuration.
 * - `renderer`: Rendering logic abstraction.
 * - `onJobResult`: Callback to send job results back to Harper.
 *
 * @type {RenderWorker}
 */
const worker = new RenderWorker({
	maxConcurrency: CONCURRENCY,
	browserExpirationThreshold: 200,
	rps: 8,
	jobQueue,
	browserLaunchOptions: {
		timeout: 20000,
		headless: 'shell',
		ignoreDefaultArgs: ['--disable-dev-shm-usage'],
		args: CHROME_ARGS,
	},
	renderer,
	onJobResult(job) {
		sendJobResult(job).catch((err: any) => {
			logger.error(err);
		});
	},
});

/**
 * Start the worker loop.
 *
 * Begins fetching jobs, launching browser instances, and processing
 * render tasks in parallel. Results are reported via `onJobResult`.
 */
worker.start();
