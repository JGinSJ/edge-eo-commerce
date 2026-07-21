/**
 * @module ManagedBrowser
 *
 * Provides a wrapper around Puppeteer's {@link Browser} to manage its lifecycle
 * and control concurrency of page usage.
 *
 * Responsibilities:
 * - Track number of active and total pages.
 * - Enforce a configurable maximum number of concurrent active pages.
 * - Automatically close pages/contexts on error.
 * - Support incognito contexts (`INCOGNITO_PAGES` mode).
 * - Provide lifecycle management (close/kill browser).
 *
 * Integrates with:
 * - {@link puppeteer} for browser/page automation.
 * - {@link Logger} for error reporting.
 */

import EventEmitter from 'events';
import puppeteer, { Browser, LaunchOptions, Page } from 'puppeteer';
import logger from './util/Logger.js';
import { setTimeout } from 'timers';
import { INCOGNITO_PAGES } from './util/env.js';

/**
 * Options for managing a browser instance.
 */
type ManagedBrowserOptions = {
	/** Maximum number of concurrently active pages. Defaults to 5. */
	maxActivePages?: number;
};

/**
 * Configuration for launching a {@link ManagedBrowser}.
 * Extends {@link ManagedBrowserOptions}.
 */
type ManagedBrowserConfig = ManagedBrowserOptions & {
	/** Puppeteer launch options. */
	puppeteerLaunchOptions?: LaunchOptions;
};

/**
 * A managed wrapper around Puppeteer's {@link Browser}.
 *
 * Tracks active page count, enforces concurrency limits, and provides
 * lifecycle utilities for graceful shutdown.
 *
 * Events:
 * - `open-slot`: Emitted when a previously full browser regains an available page slot.
 */
export default class ManagedBrowser extends EventEmitter {
	/** Maximum number of concurrently active pages permitted. */
	maxActivePages: number;

	/** Underlying Puppeteer browser instance. */
	browser: Browser;

	/**
	 * Number of outstanding units of work referencing this browser.
	 * Maintained by callers (e.g., worker) to help decide when it's safe to retire.
	 */
	jobRefs: number = 0;

	/** Current number of open pages. */
	activePages: number = 0;

	/** Total number of pages opened since launch (monotonic counter). */
	totalOpenedPages: number = 0;

	protected constructor(browser: Browser, options?: ManagedBrowserOptions) {
		super();
		this.browser = browser;
		this.maxActivePages = options?.maxActivePages ?? 5;
	}

	/**
	 * Launch a new managed Puppeteer browser.
	 *
	 * - Applies Puppeteer launch options if provided.
	 * - Attaches error listeners to automatically close failing pages.
	 *
	 * @param {ManagedBrowserConfig} [config] - Launch configuration.
	 * @returns {Promise<ManagedBrowser>} Managed browser instance.
	 */
	static async launch(config?: ManagedBrowserConfig) {
		const browser = await puppeteer.launch(config?.puppeteerLaunchOptions);

		// Auto-close pages that error
		browser.on('targetcreated', async (target) => {
			try {
				const page = await target.page();
				if (page) {
					page.on('error', () => {
						page.close().catch((err: any) => {
							logger.error({ err }, 'Failed to close page after error');
						});
					});
				}
			} catch (err: any) {
				logger.error({ err }, 'Failed to launch page');
			}
		});

		const managed = new ManagedBrowser(browser, { maxActivePages: config?.maxActivePages });

		return managed;
	}

	/**
	 * Number of available page slots before hitting `maxActivePages`.
	 */
	get freeSlots() {
		return this.maxActivePages - this.activePages;
	}

	/**
	 * Acquire a new Puppeteer {@link Page}.
	 *
	 * - Increments active page counters.
	 * - Uses incognito contexts if `INCOGNITO_PAGES` is enabled.
	 * - Emits `open-slot` when a page is closed and a slot reopens.
	 *
	 * @returns {Promise<Page>} A new Puppeteer page.
	 * @throws If page creation fails.
	 */
	async getPage() {
		this.activePages++;
		this.totalOpenedPages++;

		let page;
		try {
			// Create a new browser
			const context = await (!INCOGNITO_PAGES
				? this.browser.defaultBrowserContext()
				: this.browser.createBrowserContext({ downloadBehavior: { policy: 'deny' } }));

			page = await context.newPage();
			page.once('close', async () => {
				if (INCOGNITO_PAGES) {
					try {
						await context.close();
					} catch (err: any) {
						logger.error({ err }, 'Failed to close context.');
					}
				}
				this.activePages--;
				if (this.activePages === this.maxActivePages - 1) {
					this.emit('open-slot');
				}
			});
		} catch (err: any) {
			this.activePages--;
			if (this.activePages === this.maxActivePages - 1) {
				this.emit('open-slot');
			}
			throw err;
		}

		return page;
	}

	/**
	 * Closes a Puppeteer page.
	 * Errors during close are caught and logged.
	 *
	 * @param {Page} page - The Puppeteer page to close.
	 */
	async closePage(page: Page) {
		try {
			await page.close();
		} catch (err: any) {
			logger.error({ err }, 'Failed to close page.');
		}
	}

	/**
	 * Attempts to close the browser gracefully.
	 * If not closed within 5 seconds, calls {@link kill}.
	 */
	async close() {
		try {
			await this.browser.close();
		} catch (err: any) {
			logger.error({ err }, 'Failed to close browser');
		}

		setTimeout(() => {
			this.kill().catch((err: any) => logger.error({ err }, 'Failed to kill process'));
		}, 5000);
	}

	/**
	 * Force kills the underlying browser process with `SIGKILL`.
	 * Ensures browser process exits even if `close` fails.
	 */
	async kill() {
		const process = this.browser.process();

		if (!process) {
			return;
		}

		const timeout = setTimeout(() => {
			process?.kill('SIGKILL');
		}, 5000);

		try {
			await this.browser.close();
			clearTimeout(timeout);
		} catch (err: any) {
			logger.error({ err }, 'Failed to kill browser');
		}
	}
}
