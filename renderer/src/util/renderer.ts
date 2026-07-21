/**
 * @module renderer
 *
 * Defines the default {@link Renderer} implementation used by {@link RenderWorker}.
 *
 * Responsibilities:
 * - Configure Puppeteer page state for consistent prerendering:
 *   - Emulate device type (desktop, mobile, tablet).
 *   - Apply Accept-Language headers.
 *   - Force polyfills for Web Components and CSS shims.
 *   - Normalize CSS media and color scheme.
 * - Intercept requests to:
 *   - Add SEO-specific headers (`x-seo-prerender-request`).
 *   - Merge custom headers provided in the job.
 *   - Block heavy resources (images, media, fonts).
 * - Intercept responses to:
 *   - Capture HTTP response metadata (status, headers).
 *   - Abort navigation on errors (>=400).
 *   - Handle redirects (>=300).
 * - Post-process final DOM:
 *   - Ensure proper `<base>` element.
 *   - Strip JavaScript for static snapshotting.
 *   - Serialize full document content.
 *
 * Integrates with:
 * - {@link RenderJob} for request headers, device type, language, and response metadata.
 * - {@link Worker.Renderer} interface as the render pipeline function.
 * - Puppeteer {@link Page} APIs for navigation and interception.
 */

import path from 'path';
import { KnownDevices, Page, PuppeteerLifeCycleEvent } from 'puppeteer';
import RenderJob from '../RenderJob.js';
import { Renderer } from '../Worker.js';
import { GOTO_TIMEOUT, WAIT_FOR_EVENT, USER_AGENT, SETTLE_TIMEOUT_MS, NETWORK_IDLE_MS } from './env.js';
import logger from './Logger.js';

/**
 * Default rendering pipeline function.
 *
 * Sets up page state, intercepts requests/responses, navigates to the target URL,
 * and extracts sanitized HTML content suitable for caching or serving to bots.
 *
 * @param {Page} page - Puppeteer page instance.
 * @param {RenderJob} job - The render job configuration.
 * @returns {Promise<string|undefined>} Serialized static HTML content, or `undefined` if request failed.
 */
const renderer: Renderer = async (page: Page, job: RenderJob): Promise<string | undefined> => {
	const { url, deviceType, acceptLanguage } = job;

	// Per-render overrides (e.g. from the Render Lab / probe CLI), falling back to
	// the renderer's global env defaults.
	const ro = job.renderOptions || {};
	const waitUntil = (ro.waitUntil as PuppeteerLifeCycleEvent) || WAIT_FOR_EVENT;
	const settleTimeoutMs = ro.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
	const networkIdleMs = ro.networkIdleMs ?? NETWORK_IDLE_MS;
	const waitForSelector = ro.waitForSelector;

	// Page setup tasks (headers, polyfills, viewport, UA).
	const setupPromises = [
		page.setRequestInterception(true),
		page.evaluateOnNewDocument(
			`customElements.forcePolyfill = true;ShadyDOM = {force: true};ShadyCSS = {shimcssproperties: true}`
		),
	];

	if (acceptLanguage) {
		setupPromises.push(
			page.setExtraHTTPHeaders({
				'Accept-Language': acceptLanguage,
			})
		);
	}

	// Device emulation (desktop, mobile, tablet).
	switch (deviceType) {
		case 'mobile':
			setupPromises.push(
				page.setUserAgent(KnownDevices['iPhone 15'].userAgent),
				page.setViewport({
					width: 390,
					height: 844,
					deviceScaleFactor: 1,
					isMobile: true,
					hasTouch: true,
				})
			);
			break;
		case 'tablet':
			setupPromises.push(
				page.setUserAgent(KnownDevices['iPad'].userAgent),
				page.setViewport({
					width: 768,
					height: 1024,
					deviceScaleFactor: 2,
					isMobile: true,
					hasTouch: false,
				})
			);
			break;
		default:
			setupPromises.push(
				page.setUserAgent(USER_AGENT),
				page.setViewport({
					width: 1920,
					height: 1080,
					deviceScaleFactor: 3,
					isMobile: false,
					hasTouch: false,
				})
			);
			break;
	}

	const abortController = new AbortController();
	let aborted = false;

	// Request/response interception.
	page
		.on('request', (req) => {
			if (aborted) {
				req.abort();
				return;
			}

			if (req.isNavigationRequest()) {
				// Add SEO prerender headers and job-provided headers.
				const headers = req.headers();
				headers['x-seo-prerender-request'] = 'true';

				if (job.headers) {
					Object.keys(job.headers).forEach((header) => {
						headers[header.toLowerCase()] = job.headers![header];
					});
				}

				req.continue({ headers });
			} else if (req.resourceType() === 'image' || req.resourceType() === 'media' || req.resourceType() === 'font') {
				// Block heavy resources, comment out to allow.
				req.abort();
			} else {
				// For all other requests, continue without modification
				req.continue();
			}
		})
		.on('response', (res) => {
			const req = res.request();
			if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
				const status = res.status();
				const headers = res.headers();
				if (status >= 400) {
					job.httpResponse = {
						statusCode: status,
						headers,
					};
					abortController.abort();
					aborted = true;
				} else if (status >= 300 && headers.location) {
					// Capture redirects.
					const baseUrl = new URL(req.url()).origin;
					job.onRedirect(new URL(headers.location, baseUrl).href, status);
				}
			}
		});

	await Promise.all(setupPromises);

	// Normalize CSS/media defaults.
	await page.emulateMediaType('screen');
	await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

	// Navigate to target URL, waiting based on the (optionally overridden) event.
	const finalRes = await page.goto(url, {
		waitUntil,
		timeout: GOTO_TIMEOUT[waitUntil] || 30000,
		signal: abortController.signal,
	});

	// Bounded, non-throwing settle for client-rendered SPAs: after navigation,
	// wait for the network to go quiet so a hydrating app has time to paint its
	// content — but cap it (and swallow the timeout) so pages that beacon forever
	// (analytics, chat widgets) still get snapshotted with whatever has rendered.
	// This is what turns a 0-byte SPA shell into the fully rendered page.
	if (!aborted && settleTimeoutMs > 0) {
		await page.waitForNetworkIdle({ idleTime: networkIdleMs, timeout: settleTimeoutMs }).catch(() => {});
	}

	// Optionally wait for a specific content selector (bounded, non-throwing) —
	// useful for SPAs where a known element marks "content ready".
	if (!aborted && waitForSelector) {
		await page.waitForSelector(waitForSelector, { timeout: Math.max(settleTimeoutMs, 5000) }).catch(() => {});
	}

	if (finalRes) {
		job.httpResponse = job.httpResponse || {
			statusCode: finalRes.status(),
			headers: finalRes.headers(),
		};
		const statusCode = job.httpResponse.statusCode;

		if (statusCode === 200 || statusCode === 202 || statusCode === 304) {
			// Close/remove modals, overlays, dialogs (e.g. language selectors, cookie banners).
			// Include classes/attributes for specific use case as needed.
			await page.evaluate(() => {
				const selectors = [
					'.modal',
					'.popup',
					'.overlay',
					'.dialog',
					'[role="dialog"]',
					'.cookie-banner',
					'.consent-overlay',
				];

				selectors.forEach((sel) => {
					document.querySelectorAll(sel).forEach((el) => {
						// Prefer to simulate closing button click if available
						// Update with button classes/attributes for specific use case as needed.
						const closeBtn = el.querySelector('button[aria-label*="Close" i], button.close, .close-button');
						if (closeBtn) {
							(closeBtn as HTMLElement).click();
						} else {
							// Otherwise, just remove from DOM
							el.remove();
						}
					});
				});
			});

			// Extract sanitized HTML snapshot.
			const { origin, pathname = '' } = URL.parse(page.url())!;
			const content = await page.evaluate(postProcess, origin, path.dirname(pathname));

			return content;
		}
	} else {
		throw new Error(`Render for ${url} aborted or failed, no response or content.`);
	}
};

export default renderer;

/**
 * In-page post-processing function.
 *
 * Injected into the DOM to normalize base URLs, strip scripts, and serialize
 * the full HTML for static prerender output.
 *
 * @param {string} origin - Origin of the current URL.
 * @param {string} directory - Directory path of the current URL.
 * @returns {string} Serialized static HTML.
 */
function postProcess(origin: string, directory: string) {
	// Ensure <base> element points to correct origin/directory.
	const bases = document.head.querySelectorAll('base');
	if (bases.length) {
		// Patch existing <base> if it is relative.
		const existingBase = bases[0].getAttribute('href') || '';
		if (existingBase.startsWith('/')) {
			// check if is only "/" if so add the origin only
			if (existingBase === '/') {
				bases[0].setAttribute('href', origin);
			} else {
				bases[0].setAttribute('href', origin + existingBase);
			}
		}
	} else {
		// Only inject <base> if it doesn't already exist.
		const base = document.createElement('base');
		// Base url is the current directory
		base.setAttribute('href', origin + directory);
		document.head.insertAdjacentElement('afterbegin', base);
	}

	// Remove JavaScript-bearing script/link tags.
	document
		.querySelectorAll('script:not([type]), script[type*="javascript"], script[type="module"], link[rel=import]')
		.forEach((el) => el.remove());

	// Serialize full document including DOCTYPE.
	let content = '';
	for (const node of document.childNodes) {
		switch (node) {
			case document.documentElement:
				content += document.documentElement.outerHTML;
				break;
			default:
				content += new XMLSerializer().serializeToString(node);
				break;
		}
	}

	return content;
}
