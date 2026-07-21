/**
 * @module Worker
 *
 * Defines the {@link RenderWorker}, the core scheduler responsible for executing
 * rendering jobs using Puppeteer via {@link ManagedBrowser}.
 *
 * Responsibilities:
 * - Manage lifecycle of one or more browser instances.
 * - Pull jobs from a {@link JobQueue} and schedule them with concurrency limits.
 * - Track job attempts and call a user-supplied renderer function.
 * - Handle browser retirement when thresholds are exceeded or errors occur.
 * - Invoke callbacks when job results are available.
 *
 * Integrates with:
 * - {@link JobQueue} for job supply.
 * - {@link ManagedBrowser} for browser/page management.
 * - {@link RenderJob} for job metadata and attempt tracking.
 * - {@link Renderer} (user-supplied function) for page rendering.
 */

import { JobQueue } from './JobQueue.js';
import ManagedBrowser from './ManagedBrowser.js';
import { LaunchOptions, Page, ProtocolError, TimeoutError } from 'puppeteer';
import RenderJob from './RenderJob.js';
import logger from './util/Logger.js';

/**
 * Renderer function signature used by {@link RenderWorker}.
 * @callback Renderer
 * @param {Page} page - Puppeteer page to render into.
 * @param {RenderJob} job - The job being executed.
 * @returns {Promise<string|undefined>} Rendered content, if any.
 */
export type Renderer = (page: Page, job: RenderJob) => Promise<string | undefined>;

// Timestamp of last non-priority job start (used for pacing).
let lastNormalJobStartedAt = 0;

/**
 * Configuration for creating a {@link RenderWorker}.
 */
type RenderWorkerConfig = {
	/** Maximum number of concurrent page renders. Default: 5. */
	maxConcurrency?: number;

	/** Maximum total pages opened before recycling the browser. Default: 5000. */
	browserExpirationThreshold?: number;

	/** Application-provided function used to render a page. */
	renderer: Renderer;

	/** Requests per second rate limit. Default: 10. */
	rps?: number;

	/** Options forwarded to Puppeteer `launch`. */
	browserLaunchOptions?: LaunchOptions;

	/** Job source to consume. */
	jobQueue: JobQueue;

	/** Optional callback invoked after each job finishes. */
	onJobResult?: (job: RenderJob) => void;
};

/**
 * Worker responsible for scheduling and executing render jobs.
 *
 * Features:
 * - Pulls jobs from {@link JobQueue} at a controlled rate.
 * - Uses {@link ManagedBrowser} to launch and retire browsers.
 * - Supports priority jobs and concurrency throttling.
 * - Emits statistics logs periodically for observability.
 */
export default class RenderWorker {
	/** Current worker state. */
	status: 'running' | 'stopped' = 'stopped';

	/** Maximum number of concurrent jobs allowed. */
	maxConcurrency: number;

	/** Threshold for retiring a browser based on opened page count. */
	browserExpirationThreshold: number;

	/** Delay (ms) between starting new jobs, derived from RPS. */
	jobStartDelay: number;

	/** Application-supplied renderer function. */
	renderFn: Renderer;

	/** True while a new browser is launching. */
	isLaunchingBrowser = false;

	/** Active browser instance. */
	browser: ManagedBrowser | null = null;

	/** Browsers that have been retired but not yet closed. */
	retiredBrowsers: Set<ManagedBrowser> = new Set();

	/** Source of jobs to process. */
	jobQueue: JobQueue;

	/** Puppeteer launch options. */
	browserLaunchOptions?: LaunchOptions;

	/** Cleanup timer for retired browsers. */
	private browserCleanupInterval: NodeJS.Timeout | null = null;

	/** Scheduler timer for ticks. */
	private jobStartInterval: NodeJS.Timeout | null = null;

	/** Callback invoked after each job finishes. */
	onJobResult: (job: RenderJob) => void;

	/** Number of currently active render tasks. */
	activeRenders: number = 0;

	/** Periodic statistics logging timer. */
	logStatsInterval: NodeJS.Timeout;

	/** Target requests per second. */
	rps = 10;

	/** Tick frequency (subdivides `jobStartDelay`). */
	tickRate: number;

	constructor(config: RenderWorkerConfig) {
		this.browserLaunchOptions = config.browserLaunchOptions;
		this.maxConcurrency = config.maxConcurrency ?? 5;
		this.browserExpirationThreshold = config.browserExpirationThreshold ?? 5000;
		this.renderFn = config.renderer;
		this.jobQueue = config.jobQueue;
		this.onJobResult = config.onJobResult || (() => {});

		// Periodically attempt to close retired browsers with no active work.
		this.browserCleanupInterval = setInterval(() => {
			this.closeRetiredBrowsers();
		}, 10000);
		this.browserCleanupInterval.unref();

		// Periodically log worker stats.
		this.logStatsInterval = setInterval(() => {
			this.logStats();
		}, 45000);

		// Configure rate limiting.
		if (config.rps) {
			this.rps = config.rps;
		}

		this.jobStartDelay = Math.floor(1000 / this.rps);
		this.tickRate = Math.max(Math.floor(this.jobStartDelay / 5), 1);

		// Safety: exit on uncaught exceptions.
		process.on('uncaughtException', (err: any) => {
			logger.error({ err }, 'Uncaught Exception');
			this.destroy();
			process.exit(1);
		});
	}

	/**
	 * Internal scheduler tick.
	 * Starts the next job and schedules the next tick.
	 */
	tick = () => {
		if (this.status === 'stopped') return;
		this.startNextJob();
		this.jobStartInterval = setTimeout(this.tick, this.jobStartDelay);
	};

	/**
	 * Start the worker loop.
	 * Begins fetching jobs and rendering them.
	 */
	start() {
		if (this.status === 'running') return;
		this.logStats();
		this.status = 'running';
		this.tick();
	}

	/**
	 * Pause the worker loop.
	 */
	pause() {
		if (this.jobStartInterval !== null) {
			this.status = 'stopped';
			this.logStats();
			clearInterval(this.jobStartInterval);
			this.jobStartInterval = null;
		}
	}

	/**
	 * Log worker state, queue sizes, active renders, and browser stats.
	 */
	logStats() {
		const numQueued = this.jobQueue._priorityQueue.length + this.jobQueue._normalQueue.length;

		logger.info({
			status: this.status,
			totalQueued: numQueued,
			normalQueueSize: this.jobQueue._normalQueue.length,
			priorityQueueSize: this.jobQueue._priorityQueue.length,
			activeRenders: this.activeRenders,
			retiredBrowsers: this.retiredBrowsers.size,
			launchingBrowser: this.isLaunchingBrowser,
			currentBrowser: this.browser
				? {
						totalOpenedPages: this.browser.totalOpenedPages,
						activePages: this.browser.activePages,
						freeSlots: this.browser.freeSlots,
						jobRefs: this.browser.jobRefs,
					}
				: null,
		});
	}

	/**
	 * Launch a new browser via {@link ManagedBrowser}.
	 * Retires the current browser if applicable.
	 */
	async launchBrowser() {
		this.pause();
		this.isLaunchingBrowser = true;
		logger.info({
			event: 'launching browser',
			retired: this.retiredBrowsers.size,
			launching: this.isLaunchingBrowser,
		});

		try {
			const browser = await ManagedBrowser.launch({
				maxActivePages: this.maxConcurrency,
				puppeteerLaunchOptions: this.browserLaunchOptions,
			});
			this.browser = browser;
		} catch (err: any) {
			logger.error({ err }, 'Failed to launch browser');
		}

		this.isLaunchingBrowser = false;
		logger.info({
			event: 'launched browser',
			retired: this.retiredBrowsers.size,
			launching: this.isLaunchingBrowser,
		});
		if (this.status === 'stopped') {
			this.start();
		}
	}

	/**
	 * Destroy the worker.
	 * Clears timers and closes all browsers (ignores close errors).
	 */
	destroy() {
		if (this.browserCleanupInterval !== null) {
			clearInterval(this.browserCleanupInterval);
			this.browserCleanupInterval = null;
		}

		if (this.jobStartInterval !== null) {
			this.jobStartInterval.unref();
			clearInterval(this.jobStartInterval);
			this.jobStartInterval = null;
		}

		if (this.browser) {
			this.browser.close().catch(() => {});
		}

		this.retiredBrowsers.forEach((browser) => {
			browser.close().catch(() => {});
		});
		this.browser = null;
		this.retiredBrowsers.clear();
	}

	/**
	 * Close retired browsers that no longer have active work.
	 */
	closeRetiredBrowsers() {
		for (const browser of this.retiredBrowsers) {
			if (browser.activePages === 0 || browser.jobRefs === 0) {
				browser.close().then(() => {
					this.retiredBrowsers.delete(browser);
				});
			}
		}
	}

	/**
	 * Mark a browser as retired and schedule replacement.
	 * @param {ManagedBrowser} browser - Browser to retire.
	 */
	retireBrowser(browser: ManagedBrowser) {
		if (this.retiredBrowsers.has(browser)) {
			return;
		}

		this.retiredBrowsers.add(browser);
		this.browser = null;
		if (!this.isLaunchingBrowser) {
			this.launchBrowser();
		}
	}

	/**
	 * Render a single job using the provided browser and renderer.
	 * Handles errors, retires browsers on fatal errors, and records results.
	 *
	 * @param {ManagedBrowser} browser - Browser to use.
	 * @param {RenderJob} job - Job to render.
	 */
	async render(browser: ManagedBrowser, job: RenderJob) {
		this.activeRenders++;
		browser.jobRefs++;

		if (job.priority > 0) {
			lastNormalJobStartedAt = Date.now();
		}
		job.attemptStarted();

		let page: Page | undefined;
		let error: Error | undefined;
		let content: string | undefined;

		try {
			page = await browser.getPage();
		} catch (e: any) {
			this.retireBrowser(browser);
			error = e as Error;
			logger.error({ error }, 'Failed to get page');
		}

		if (page && !page.isClosed()) {
			try {
				content = await this.renderFn(page, job);
			} catch (e: any) {
				if (e instanceof TimeoutError || e instanceof ProtocolError) {
					this.retireBrowser(browser);
				}

				error = e as Error;
				logger.error({ url: job.url, error }, 'Failed to render page');
			}
		}

		job.attemptEnded(error, content);
		browser.jobRefs--;
		this.onJobResult(job);

		if (page) {
			await browser.closePage(page);
		}
		this.activeRenders--;
	}

	/**
	 * Retrieve a browser suitable for new jobs.
	 * - Launches a new one if none exist.
	 * - Returns `null` if no free slots are available.
	 */
	getBrowser() {
		if (this.browser === null) {
			if (!this.isLaunchingBrowser) {
				this.launchBrowser();
			}
			return null;
		}
		if (this.browser.freeSlots > 0) {
			return this.browser;
		}
		return null;
	}

	/**
	 * Attempt to start the next job.
	 * Respects concurrency limits, priorities, and available browsers.
	 */
	startNextJob() {
		if (this.activeRenders >= this.maxConcurrency) {
			return;
		}

		const browser = this.getBrowser();

		if (browser) {
			const peekedJob = this.jobQueue.peek();

			// Throttle normal jobs if one just started.
			if (peekedJob && peekedJob.priority > 0 && Date.now() - lastNormalJobStartedAt < this.jobStartDelay) {
				return;
			}

			const job = this.jobQueue.next();

			if (job) {
				if (browser.totalOpenedPages >= this.browserExpirationThreshold) {
					this.retireBrowser(browser);
				}
				this.render(browser, job);
			} else {
				this.pause();
				this.jobQueue.once('jobs', () => {
					this.start();
				});
			}
		} else {
			this.pause();

			if (this.browser && this.browser.freeSlots === 0) {
				this.browser.once('open-slot', () => {
					this.start();
				});
			}
		}
	}
}
