/**
 * @module Sitemap
 *
 * Provides a resource controller for managing sitemaps within the prerendering system.
 *
 * Responsibilities include:
 * - Fetching and parsing sitemaps or direct URL lists.
 * - Normalizing entries into {@link ManagedPage} objects.
 * - Scheduling prerender refresh intervals.
 * - Persisting sitemap metadata in the database.
 * - Enqueuing discovered URLs for rendering jobs.
 *
 * Integrates with utility modules like {@link parseSitemap}, {@link indexSitemap},
 * {@link CacheKey}, and {@link ManagedPage}.
 */

import { parseSitemap, indexSitemap } from '../util/sitemapper.js';
import { calculateNextRefresh } from '../util/time.js';
import { getPageNode } from '../util/replication.js';
import ManagedPage from './ManagedPage.js';
import JobQueue from './JobQueue.js';
import CacheKey from '../util/CacheKey.js';
import { normalizeUrl } from '../util/url.js';

/**
 * Class representing a sitemap resource.
 *
 * Extends Harper class {@link Resource} to handle CRUD operations on sitemaps.
 */
export default class Sitemap extends Resource {
	static directURLMapping = true;

	/**
	 * Parse a path parameter from the query or request context.
	 *
	 * @param {string} _path - Path segment (unused here).
	 * @param {object} context - Request context containing headers.
	 * @param {URLSearchParams} query - Query parameters.
	 * @returns {string|null} Path value from query or headers.
	 */
	static parsePath(_path, context, query) {
		return query.get('path') ?? context?.headers?.get('path');
	}

	/**
	 * Retrieve sitemap metadata from the database.
	 *
	 * @param {string} query - Sitemap identifier (usually the URL).
	 * @returns {Promise<object>} Sitemap metadata.
	 */
	async get(query) {
		logger.info('Sitemap.get', query);
		return databases.prerender.Sitemap.get(query);
	}

	/**
	 * Fetch and return raw sitemap XML from a given URL.
	 *
	 * @param {string} url - Sitemap URL.
	 * @returns {Promise<string>} Raw XML string.
	 */
	static async fromURL(url) {
		const res = await fetch(url, {
			method: 'GET',
			redirect: 'follow',
			headers: { 'User-Agent': 'harper-bot/1.0' },
		});
		return res.text();
	}

	/**
	 * Add or update a sitemap resource.
	 *
	 * Supports two modes:
	 * - **Sitemap XML**: Fetch, parse, and normalize `<url>` entries.
	 * - **Direct URL list**: Accept raw URLs when `isSitemap = false`.
	 *
	 * Creates or updates {@link ManagedPage} entries for each discovered URL,
	 * schedules them for prerendering, and persists metadata in `PageMeta`.
	 *
	 * @param {object} options
	 * @param {string} options.sitemapURL - Source sitemap URL (or unique string identifier for urlList).
	 * @param {number} options.refreshInterval - Refresh interval (ms).
	 * @param {boolean} options.isSitemap - Whether input is a sitemap XML, default is true.
	 * @param {string[]} options.urlList - Direct list of URLs if not a sitemap, default is empty array.
	 * @param {string[]} options.deviceTypes - Device types to generate cache keys for, default is ['desktop', 'mobile'].
	 * @returns {Promise<{ added: number, errors: number }>}
	 */
	async post({ sitemapURL, refreshInterval, isSitemap = true, urlList = [], deviceTypes = ['desktop', 'mobile'] }) {
		const context = this.getContext();
		logger.info({ sitemapURL, refreshInterval });

		let sites = [];
		let errors = [];
		if (!isSitemap && urlList.length > 0) {
			// Normalize direct URL list to sitemap-like format
			sites = urlList.map((url) => ({ loc: url }));
		} else {
			// Fetch and parse sitemap XML
			const xml = await Sitemap.fromURL(sitemapURL);
			({ sites, errors } = await parseSitemap(xml));
		}

		// Canonicalize URLs the same way the delivery handlers do, so the cache
		// key written at render time matches the one looked up at request time.
		sites = sites
			.map((s) => {
				try {
					return { ...s, loc: normalizeUrl(s.loc) };
				} catch {
					return null;
				}
			})
			.filter(Boolean);

		await Promise.all(
			deviceTypes.map(async (deviceType) => {
				if (sites) {
					const newCacheKeyMap = new Map(sites.map((s) => [CacheKey.serialize({ url: s.loc, deviceType }), s]));

					// Load existing managed pages for this sitemap
					const pageIt = await ManagedPage.search(
						{ conditions: [{ attribute: 'sitemapURL', operator: 'equals', value: sitemapURL }] },
						context
					);

					const existingPages = [];
					for await (const existingPage of pageIt) {
						if (!newCacheKeyMap.has(existingPage.cacheKey)) {
							ManagedPage.delete(existingPage.cacheKey, context);
						} else {
							existingPages.push(existingPage);
							newCacheKeyMap.delete(existingPage.cacheKey);
						}
					}

					// Create new page entries for missing URLs
					const newPages = [...newCacheKeyMap.keys()].map((cacheKey) => ({
						cacheKey,
						deviceType,
						url: CacheKey.deserialize(cacheKey).url,
						lastRefresh: -1,
						refreshInterval,
						nextRefresh: calculateNextRefresh(refreshInterval),
						sitemapURL,
						status: 'scheduled',
						node: getPageNode(),
					}));

					// Persist updates in PageMeta
					await Promise.all(
						[...newPages, ...existingPages].map((page) => {
							return databases.prerender.PageMeta.put(page.cacheKey, {
								...page,
								refreshInterval,
								status: 'scheduled',
								nextRefresh: calculateNextRefresh(refreshInterval, page.lastRefresh),
							});
						})
					);
				}
			})
		);

		return { added: sites.length, errors: errors.length };
	}

	/**
	 * Index a sitemap and enqueue discovered URLs for rendering.
	 *
	 * Persists the sitemap in `databases.prerender.Sitemap` and uses
	 * {@link indexSitemap} to parse its contents. Each discovered URL
	 * is added as a render job in `databases.local.RenderJob`.
	 *
	 * @param {object} query - Query object containing the sitemap URL.
	 * @param {string} query.url - Sitemap URL to index.
	 * @returns {Promise<{ added: number, errors: number }>}
	 */
	async put(query) {
		let url = query.url;

		await databases.prerender.Sitemap.put({ url });

		const { sites, errors } = await indexSitemap(url);

		// Enqueue discovered URLs for rendering
		for (const site of sites) {
			databases.local.RenderJob.put({
				id: crypto.randomUUID(),
				url: site.loc,
				status: JobQueue.STATUS_TYPES.pending,
				attempts: 0,
			});
		}

		return { added: sites.length, errors: errors.length };
	}

	/**
	 * Delete a sitemap and its metadata from the database.
	 *
	 * @returns {Promise<object>} Result of the database deletion.
	 */
	async delete() {
		const url = this.getId();
		logger.info('Sitemap.delete', url);
		return await databases.prerender.Sitemap.delete(url);
	}
}
