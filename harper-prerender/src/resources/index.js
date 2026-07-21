/**
 * @module index
 *
 * Entry point for prerendering server features.
 *
 * This module wires up endpoints for:
 * - `/page_cache` (see {@link PageCache})
 * - `/render_jobs` (see {@link JobQueue})
 * - `/sitemaps` (see {@link Sitemap})
 *
 * It also provides custom handling for bot-driven `/page` requests,
 * performing cache lookups, validation, and content encoding negotiation.
 */

import { Readable } from 'stream';
import zlib from 'node:zlib';
import JobQueue from './JobQueue.js';
import Sitemap from './Sitemap.js';
import PageCache from './PageCache.js';
import CacheKey from '../util/CacheKey.js';
import { getAcceptedEncodings, getBestEncoding, reencode } from '../util/contentEncoding.js';
import { sanitizeDeviceType } from '../util/deviceType.js';
import { BOT_PATH_PREFIX, MD_PATH_PREFIX, BOT_REQUEST_KEY_NAME, BOT_REQUEST_KEY } from '../util/constants.js';
import { normalizeUrl } from '../util/url.js';
import { render } from '../util/render.js';
import { deriveMarkdownFromGzippedHtml } from '../util/markdown.js';

// Exports /page_cache, /render_jobs, /sitemaps endpoints
/** @type {object} */
export { PageCache as page_cache, JobQueue as render_jobs, Sitemap as sitemaps };

/**
 * HTTP middleware to handle bot-driven `/page` requests.
 *
 * Validates bot requests using a shared secret, normalizes query parameters,
 * generates cache keys, and serves prerendered content from the page cache.
 *
 * Responses are adapted to the client’s preferred content encoding and
 * include appropriate HTTP headers for caching and analytics.
 *
 * @param {Request} request - Incoming HTTP request.
 * @param {Function} nextHandler - Function to call if the request should fall through.
 * @returns {Promise<Response|*>} A response object if handled, or the next handler’s result.
 */
server.http(
	async (request, nextHandler) => {
		if (request.method === 'GET' && request.url.startsWith(BOT_PATH_PREFIX)) {
			request.handlerPath = 'p';
			const requestHeaders = request.headers;
			const acceptLanguage = requestHeaders.get('accept-language');

			// Validate bot request secret key
			if (BOT_REQUEST_KEY_NAME && requestHeaders.get(BOT_REQUEST_KEY_NAME) !== BOT_REQUEST_KEY) {
				return {
					headers: new Headers(),
					status: 401,
				};
			}

			// Extract query parameters
			const queryString = request.url.slice(BOT_PATH_PREFIX.length);
			const params = new URLSearchParams(queryString);

			let url;
			if (params.has('url')) {
				url = normalizeUrl(params.get('url'));
			} else {
				// Get values from request body as fallback
				const hostname = requestHeaders.get('host');
				const path = requestHeaders.get('path') || '';
				url = normalizeUrl(`https://${hostname}${path}`);
			}

			let deviceType;
			if (requestHeaders.has('x-device-type')) {
				deviceType = sanitizeDeviceType(requestHeaders.get('x-device-type'));
			} else {
				deviceType = sanitizeDeviceType(params.get('deviceType'));
			}

			// Record analytics for bot request
			server.recordAnalytics(true, 'accept_language', acceptLanguage, 'GET', deviceType);

			// Generate cache key for lookup
			const cacheKey = CacheKey.serialize({ url, deviceType, acceptLanguage });

			const responseHeaders = (request.responseHeaders = new Headers());

			// Handle response asynchronously with timeout
			try {
				let timedOut = false;
				const timeout = setTimeout(() => {
					timedOut = true;
				}, 8000);

				// Lookup page in cache
				const page = await databases.prerender.PageCache.get(cacheKey, request);

				if (!timedOut) {
					clearTimeout(timeout);

					// Cache miss / unmanaged URL → 503 so the edge falls back to origin
					// (rather than throwing on `page.content` and returning a 500).
					if (!page) {
						return {
							headers: { 'retry-after': '10', 'cache-control': 'no-store' },
							status: 503,
						};
					}

					// Ensure blob content errors are logged and handled
					if (page.content instanceof Blob) {
						page.content.on('error', (error) => {
							logger.error('Blob error', error);
							page.invalidate();
						});
					}

					// Apply headers from upstream if available
					const upstreamHeaders = page.headers ? JSON.parse(page.headers) : {};

					if (page.statusCode === 200) {
						// Force HTML-specific response headers
						upstreamHeaders['content-encoding'] = 'gzip';
						upstreamHeaders['content-type'] = 'text/html; charset=utf-8';
						upstreamHeaders['x-harper-rendered'] = '1';
						upstreamHeaders['vary'] = 'Accept-Encoding, Accept-Language';
					}

					// Merge headers into response
					for (const [key, value] of Object.entries(upstreamHeaders)) {
						if (key === 'server-timing') {
							responseHeaders.append(key, value);
						} else {
							responseHeaders.set(key, value);
						}
					}

					// Handle non-200 responses directly
					if (page.statusCode !== 200) {
						return {
							headers: responseHeaders,
							status: page.statusCode,
							wasCacheMiss: page.wasLoadedFromSource(),
						};
					}

					// Retrieve body (cached or origin response)
					let body = page.content || request.originResponseData;
					if (body) {
						const contentEncoding = responseHeaders.get('content-encoding') || null;

						// Negotiate best encoding with client
						const bestEncoding = getBestEncoding(
							getAcceptedEncodings(request.headers.get('accept-encoding')),
							contentEncoding
						);

						// Re-encode response if needed
						if (bestEncoding !== contentEncoding) {
							if (bestEncoding) {
								responseHeaders.set('content-encoding', bestEncoding);
							}

							if (body instanceof Blob) {
								body = Readable.fromWeb(body.stream());
							}

							body = reencode(body, contentEncoding, bestEncoding, false);

							// Remove length header as content length may change
							responseHeaders.delete('content-length');
						}
					}

					return {
						headers: responseHeaders,
						status: page.statusCode,
						body,
						wasCacheMiss: page.wasLoadedFromSource(),
					};
				} else {
					return {
						headers: {
							'retry-after': '10',
							'cache-control': 'no-store',
						},
						status: 503,
					};
				}
			} catch (error) {
				logger.error(error);
				return {
					headers: {},
					status: 500,
				};
			}
		}
		return nextHandler(request);
	},
	{ runFirst: true }
);

/**
 * HTTP middleware to handle AI-crawler `/page_content` requests.
 *
 * Serves the Markdown derived from the prerendered HTML (see PageCache /
 * orchestrator). Mirrors the `/page` handler but emits `text/markdown` from the
 * `markdownContent` blob. Kept compatible with the baseline Harper
 * markdown-prerender contract: `GET /page_content?path=<url>`, returning 503 on
 * a miss so the EdgeWorker falls back to Fermyon.
 *
 * @param {Request} request - Incoming HTTP request.
 * @param {Function} nextHandler - Function to call if the request should fall through.
 * @returns {Promise<Response|*>}
 */
server.http(
	async (request, nextHandler) => {
		if (request.method === 'GET' && request.url.startsWith(MD_PATH_PREFIX)) {
			request.handlerPath = 'pc';
			const requestHeaders = request.headers;
			const acceptLanguage = requestHeaders.get('accept-language');

			// Validate bot request secret key (same gate as /page)
			if (BOT_REQUEST_KEY_NAME && requestHeaders.get(BOT_REQUEST_KEY_NAME) !== BOT_REQUEST_KEY) {
				return { headers: new Headers(), status: 401 };
			}

			// Extract query parameters — accept ?path= (baseline contract) or ?url=
			const queryString = request.url.slice(MD_PATH_PREFIX.length).replace(/^\?/, '');
			const params = new URLSearchParams(queryString);

			let url;
			const target = params.get('url') ?? params.get('path');
			if (target) {
				url = normalizeUrl(target);
			} else {
				const hostname = requestHeaders.get('host');
				const path = requestHeaders.get('path') || '';
				url = normalizeUrl(`https://${hostname}${path}`);
			}

			let deviceType;
			if (requestHeaders.has('x-device-type')) {
				deviceType = sanitizeDeviceType(requestHeaders.get('x-device-type'));
			} else {
				deviceType = sanitizeDeviceType(params.get('deviceType'));
			}

			server.recordAnalytics(true, 'accept_language', acceptLanguage, 'GET', deviceType);

			const cacheKey = CacheKey.serialize({ url, deviceType, acceptLanguage });
			const responseHeaders = (request.responseHeaders = new Headers());

			try {
				let timedOut = false;
				const timeout = setTimeout(() => {
					timedOut = true;
				}, 8000);

				// Lookup (and, for managed pages, on-demand render) the page
				const page = await databases.prerender.PageCache.get(cacheKey, request);

				if (timedOut) {
					return {
						headers: { 'retry-after': '10', 'cache-control': 'no-store' },
						status: 503,
					};
				}
				clearTimeout(timeout);

				// No Markdown representation available → 503 so the edge falls back to Fermyon
				if (!page || page.statusCode !== 200 || !page.markdownContent) {
					return {
						headers: {
							'retry-after': '10',
							'cache-control': 'no-store',
							'content-type': 'text/markdown; charset=utf-8',
						},
						status: 503,
					};
				}

				if (page.markdownContent instanceof Blob) {
					page.markdownContent.on('error', (error) => {
						logger.error('Blob error', error);
						page.invalidate();
					});
				}

				responseHeaders.set('content-type', 'text/markdown; charset=utf-8');
				responseHeaders.set('content-encoding', 'gzip');
				responseHeaders.set('cache-control', 'public, max-age=3600');
				responseHeaders.set('vary', 'Accept-Encoding');
				responseHeaders.set('x-harper-rendered', '1');
				if (page.markdownLength) responseHeaders.set('x-markdown-length', String(page.markdownLength));

				// markdownContent is stored gzip-compressed; re-encode only if the
				// client cannot accept gzip.
				let body = page.markdownContent;
				const contentEncoding = 'gzip';
				const bestEncoding = getBestEncoding(getAcceptedEncodings(request.headers.get('accept-encoding')), contentEncoding);

				if (bestEncoding !== contentEncoding) {
					if (bestEncoding) {
						responseHeaders.set('content-encoding', bestEncoding);
					} else {
						responseHeaders.delete('content-encoding');
					}
					if (body instanceof Blob) {
						body = Readable.fromWeb(body.stream());
					}
					body = reencode(body, contentEncoding, bestEncoding, false);
					responseHeaders.delete('content-length');
				}

				return {
					headers: responseHeaders,
					status: 200,
					body,
					wasCacheMiss: page.wasLoadedFromSource(),
				};
			} catch (error) {
				logger.error(error);
				return { headers: {}, status: 500 };
			}
		}
		return nextHandler(request);
	},
	{ runFirst: true }
);

/**
 * HTTP middleware for `/render_preview` — the render-tuning "knob".
 *
 * Renders a URL on demand with caller-supplied options and returns the rendered
 * HTML + derived Markdown + stats as JSON. Ephemeral: it does NOT require the URL
 * to be a managed page and does NOT write the cache, so it's safe for rapid
 * experimentation from the CLI (scripts/harper-render-probe.js) or the demo UI.
 *
 *   GET /render_preview?url=<url>&deviceType=desktop
 *       &waitUntil=domcontentloaded&settleMs=12000&idleMs=600&selector=<css>
 */
server.http(
	async (request, nextHandler) => {
		if (request.method === 'GET' && request.url.startsWith('/render_preview')) {
			request.handlerPath = 'rp';

			if (BOT_REQUEST_KEY_NAME && request.headers.get(BOT_REQUEST_KEY_NAME) !== BOT_REQUEST_KEY) {
				return { headers: new Headers(), status: 401 };
			}

			const json = (status, obj) => ({
				status,
				headers: { 'content-type': ['application/json; charset=utf-8'], 'cache-control': ['no-store'] },
				body: JSON.stringify(obj),
			});

			const params = new URLSearchParams(request.url.slice('/render_preview'.length).replace(/^\?/, ''));
			const target = params.get('url');
			if (!target) return json(400, { ok: false, error: 'missing url parameter' });

			let url;
			try {
				url = normalizeUrl(target);
			} catch {
				return json(400, { ok: false, error: 'invalid url' });
			}

			const deviceType = sanitizeDeviceType(params.get('deviceType'));

			// Assemble per-render options from the query (only what's provided).
			const renderOptions = {};
			if (params.get('waitUntil')) renderOptions.waitUntil = params.get('waitUntil');
			if (params.get('settleMs') != null && params.get('settleMs') !== '')
				renderOptions.settleTimeoutMs = parseInt(params.get('settleMs'), 10);
			if (params.get('idleMs')) renderOptions.networkIdleMs = parseInt(params.get('idleMs'), 10);
			if (params.get('selector')) renderOptions.waitForSelector = params.get('selector');

			const t0 = Date.now();
			let result;
			try {
				result = await render({ url, deviceType, renderOptions, waitForResponse: true, priority: 0 });
			} catch (error) {
				logger.error('render_preview failed', error);
				return json(502, { ok: false, url, error: String((error && error.message) || error) });
			}
			const elapsedMs = Date.now() - t0;

			const statusCode = result?.statusCode ?? 0;
			const htmlGzip = result?.htmlGzip || null;

			let html = '';
			let markdown = '';
			let markdownBytes = 0;
			if (htmlGzip) {
				try {
					html = zlib.gunzipSync(htmlGzip).toString('utf8');
				} catch (_) {}
				const md = deriveMarkdownFromGzippedHtml(htmlGzip);
				if (md) {
					markdown = zlib.gunzipSync(md.gzip).toString('utf8');
					markdownBytes = md.length;
				}
			}

			return json(200, {
				ok: statusCode === 200,
				url,
				deviceType,
				statusCode,
				renderTimeMs: result?.renderTime ?? null,
				elapsedMs,
				htmlBytes: Buffer.byteLength(html, 'utf8'),
				markdownBytes,
				effectiveOptions: {
					waitUntil: renderOptions.waitUntil ?? '(env default)',
					settleTimeoutMs: renderOptions.settleTimeoutMs ?? '(env default)',
					networkIdleMs: renderOptions.networkIdleMs ?? '(env default)',
					waitForSelector: renderOptions.waitForSelector ?? null,
				},
				html,
				markdown,
			});
		}
		return nextHandler(request);
	},
	{ runFirst: true }
);

/**
 * HTTP middleware for `/cache_clear` — purge cached renders without a DB restart.
 *
 *   GET|POST /cache_clear?all=true        → clear every cached page (+ managed-page
 *                                            schedules + the render-job queue)
 *   GET|POST /cache_clear?url=<url>        → clear all device variants of one URL
 *
 * Deletes by primary key (the composite cacheKey), which is why a plain
 * DELETE /page_cache/<key> over REST doesn't work — the key contains `/` and `|`.
 */
server.http(
	async (request, nextHandler) => {
		if ((request.method === 'GET' || request.method === 'POST') && request.url.startsWith('/cache_clear')) {
			request.handlerPath = 'cc';

			if (BOT_REQUEST_KEY_NAME && request.headers.get(BOT_REQUEST_KEY_NAME) !== BOT_REQUEST_KEY) {
				return { headers: new Headers(), status: 401 };
			}

			const json = (status, obj) => ({
				status,
				headers: { 'content-type': ['application/json; charset=utf-8'], 'cache-control': ['no-store'] },
				body: JSON.stringify(obj),
			});

			const params = new URLSearchParams(request.url.slice('/cache_clear'.length).replace(/^\?/, ''));
			const all = params.get('all') === 'true';
			const target = params.get('url');

			// Collect the cacheKeys to remove (PageCache.url is @indexed).
			let conditions;
			if (all) {
				conditions = [{ attribute: 'url', comparator: 'greater_than_equal', value: '' }];
			} else if (target) {
				let norm;
				try {
					norm = normalizeUrl(target);
				} catch {
					return json(400, { ok: false, error: 'invalid url' });
				}
				conditions = [{ attribute: 'url', comparator: 'equals', value: norm }];
			} else {
				return json(400, { ok: false, error: 'provide ?all=true or ?url=<url>' });
			}

			try {
				const keys = [];
				for await (const rec of databases.prerender.PageCache.search({ conditions, select: ['cacheKey'] })) {
					if (rec.cacheKey) keys.push(rec.cacheKey);
				}

				for (const key of keys) {
					await databases.prerender.PageCache.delete(key);
					await databases.prerender.PageMeta.delete(key).catch(() => {});
				}

				// On a full clear, also drop any leftover render jobs so a stale queue
				// can't replay work after the cache is emptied.
				let jobsCleared = 0;
				if (all) {
					for await (const job of databases.local.RenderJob.search({
						conditions: [{ attribute: 'createdTime', comparator: 'greater_than', value: 0 }],
						select: ['id'],
					})) {
						await databases.local.RenderJob.delete(job.id).catch(() => {});
						jobsCleared++;
					}
				}

				return json(200, { ok: true, scope: all ? 'all' : target, cleared: keys.length, jobsCleared });
			} catch (error) {
				logger.error('cache_clear failed', error);
				return json(500, { ok: false, error: String((error && error.message) || error) });
			}
		}
		return nextHandler(request);
	},
	{ runFirst: true }
);
