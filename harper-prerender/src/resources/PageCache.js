/**
 * @module PageCache
 *
 * Provides a caching layer for prerendered pages.
 *
 * Responsibilities include:
 * - Handling cache lookups and on-demand rendering when content is missing.
 * - Whitelisting and forwarding request headers during rendering.
 * - Storing prerendered HTML and associated metadata in the database.
 * - Allowing stale-while-revalidate semantics for improved performance.
 *
 * Integrates with:
 * - {@link ManagedPage} for page registration and metadata.
 * - {@link render} for initiating prerendering jobs.
 * - {@link CacheKey} for uniquely identifying cached content.
 */

import ManagedPage from './ManagedPage.js';
import { render } from '../util/render.js';
import CacheKey from '../util/CacheKey.js';
import { toBuffer, deriveMarkdownFromGzippedHtml } from '../util/markdown.js';
import { REQ_HEADERS_WHITELIST } from '../util/constants.js';
import {
	tokenizeGzippedHtml,
	getRateSheet,
	fillGzipped,
	applyRateHeaders,
	rateMissingResponse,
} from '../util/rateInject.js';

const pageSource = {
	/**
	 * Retrieve or render a page for the given cache key.
	 *
	 * - Ensures the page is registered as a {@link ManagedPage}.
	 * - Forwards only whitelisted headers to the renderer.
	 * - Calls the render service and captures HTML output.
	 * - Returns a cache entry object with metadata.
	 *
	 * @param {string} cacheKey - Serialized cache key identifying the page.
	 * @param {object} context - Request context wrapper.
	 * @param {Request} context.requestContext - The original HTTP request.
	 * @returns {Promise<object>} Cache entry object containing:
	 * - `cacheKey`: The cache key.
	 * - `statusCode`: HTTP status code of the render.
	 * - `headers`: Serialized response headers.
	 * - `content`: Blob content (if status 200).
	 * - `lastRefreshed`: Timestamp of retrieval.
	 */
	async get(cacheKey, context) {
		const { requestContext: request } = context;
		const { url, deviceType, acceptLanguage } = CacheKey.deserialize(cacheKey);

		// Ensure the page is managed before rendering
		const pageInfo = await ManagedPage.get(url, request);

		if (pageInfo) {
			// Forward only whitelisted headers
			const incomingRequestHeaders = request.headers.asObject;
			let forwardHeaders = {};
			Object.keys(incomingRequestHeaders).forEach((h) => {
				if (REQ_HEADERS_WHITELIST.includes(h.toLowerCase())) {
					forwardHeaders[h] = incomingRequestHeaders[h];
				}
			});

			// Trigger prerender
			const result = await render({
				url,
				forwardHeaders,
				deviceType,
				acceptLanguage,
				waitForResponse: true,
				priority: 0,
			});

			let statusCode = result.statusCode;
			let responseHeaders = result.headers || {};
			let content;
			let markdownContent;
			let markdownLength;
			let hasRateTokens = false;
			let rateLeftovers = null;
			let htmlGzip = null;
			if (statusCode === 200) {
				// orchestrator.savePageContent forwards the buffered gzipped HTML on
				// result.htmlGzip; fall back to the raw stream defensively.
				htmlGzip = result.htmlGzip ?? (result.stream != null ? await toBuffer(result.stream) : null);

				// Rate pages are tokenized before storing, so the Markdown derived
				// below carries tokens too.
				const rates = tokenizeGzippedHtml(htmlGzip, await getRateSheet());
				if (rates.error) {
					// A half-tokenized rate page would freeze a rate: treat as a failed render.
					logger.error(`Rate tokenization failed for ${url}: ${rates.error}; render not cached`);
					statusCode = 502;
					htmlGzip = null;
				} else {
					htmlGzip = rates.htmlGzip;
					hasRateTokens = rates.hasRateTokens;
					rateLeftovers = rates.rateLeftovers;
				}
			}
			if (statusCode === 200) {
				content = htmlGzip ? await createBlob(htmlGzip) : undefined;

				// Derive Markdown from the SAME rendered HTML so one render yields both
				// representations under this single cache record.
				const md = htmlGzip ? deriveMarkdownFromGzippedHtml(htmlGzip) : null;
				if (md) {
					markdownContent = await createBlob(md.gzip);
					markdownLength = md.length;
				}
			} else {
				// Don’t cache failures
				context.noCacheStore = true;
				request.originResponseData = result.stream;
			}

			if (content instanceof Blob) {
				content.on('error', (err) => {
					logger.error('Blob error', err);
					page.invalidate();
				});
			}

			return {
				cacheKey,
				url,
				statusCode,
				headers: JSON.stringify(responseHeaders),
				deviceType,
				acceptLanguage,
				content,
				markdownContent,
				markdownLength,
				hasRateTokens,
				rateLeftovers,
				lastRefreshed: Date.now(),
			};
		} else {
			logger.warn(`Request for ${url}, not a managed page`);
		}
	},
};

/**
 * Page cache resource for prerendered pages.
 *
 * Extends `databases.prerender.PageCache` and overrides
 * read behavior to enforce access rules and caching strategy.
 */
export default class PageCache extends databases.prerender.PageCache {
	static directURLMapping = true;

	/**
	 * Checks if a read request is allowed based on User-Agent.
	 *
	 * @param {*} _user - Unused user parameter.
	 * @param {*} query - Unused query parameter.
	 * @param {Request} req - The incoming request.
	 * @returns {boolean} - True if allowed, otherwise false.
	 */
	allowRead(_user, _query, req) {
		const userAgent = req.headers.get('User-Agent');

		if (!userAgent) {
			logger.warn('No User-Agent header present');
			return false;
		}

		return true;
	}

	/**
	 * Whether stale cache entries may be served while revalidating.
	 *
	 * @returns {boolean} Always returns true.
	 */
	allowStaleWhileRevalidate() {
		return true;
	}

	/**
	 * Retrieves cached page content with headers and status.
	 * Sets gzip encoding by default.
	 * @returns {Promise<object>} - Response with status, data, and headers.
	 */
	async get() {
		if (!this.content) {
			return {
				status: this.statusCode || 404,
				data: {
					data: 'Page Not Found',
					contentType: 'text/plain',
				},
			};
		}

		// Check for blob errors
		if (this.content instanceof Blob) {
			this.content.on('error', (err) => {
				logger.error('Blob error', err);
				this.invalidate();
			});
		}

		let respHeaders = new Headers();
		for (const [key, value] of Object.entries(JSON.parse(this.headers))) {
			respHeaders.set(key, value);
		}

		if (!respHeaders.has('content-encoding')) {
			respHeaders.set('content-encoding', 'gzip');
		}

		if (!respHeaders.has('content-type')) {
			respHeaders.set('content-type', 'text/html; charset=utf-8');
		}

		// Rate pages are stored with tokens; never hand those out raw.
		let data = this.content;
		if (this.hasRateTokens) {
			const filled = await fillGzipped(this.content, await getRateSheet());
			if (!filled.ok) return rateMissingResponse(filled.missing);
			data = filled.gzip;
			respHeaders.set('content-encoding', 'gzip');
			applyRateHeaders(respHeaders, filled);
		}

		return {
			status: this.statusCode || 200,
			data: {
				data,
				contentType: 'text/html; charset=utf-8',
			},
			headers: respHeaders,
		};
	}
}

// Set page cache source for database
databases.prerender.PageCache.sourcedFrom(pageSource);
