/**
 * @module sitemapper
 *
 * Utilities for indexing and parsing XML sitemaps.
 *
 * This module provides two main functions:
 * - {@link indexSitemap} for crawling a sitemap URL and extracting entries using the `sitemapper` package.
 * - {@link parseSitemap} for directly parsing raw XML sitemap strings into a simplified structure.
 *
 * Both functions are useful for prerendering, crawling, or caching pipelines that need to
 * work with large sets of URLs provided by websites.
 */

import Sitemapper from 'sitemapper';
import { XMLParser } from 'fast-xml-parser';

/**
 * Default User-Agent header used when fetching sitemaps.
 * This helps avoid bot-blocking by mimicking a real browser.
 * @type {string}
 */
const useragent =
	'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/**
 * @typedef {object} SitemapEntry
 * @property {string} loc - The absolute URL of the page.
 * @property {string} lastmod - The last modification date of the page (if provided).
 * @property {string} changefreq - Suggested change frequency (if provided).
 */

/**
 * Crawl and index a sitemap from the given URL.
 *
 * Uses the `sitemapper` package to download and parse sitemap XML, with
 * concurrency, retries, and request header customization.
 *
 * @param {string} url - The URL of the sitemap or sitemap index (e.g. `https://example.com/sitemap.xml`).
 * @returns {Promise<object>} Resolves with a `sitemapper` response object containing:
 * - `sites`: Array of discovered URLs (and optionally metadata).
 * - `errors`: Array of errors encountered while fetching.
 */
export async function indexSitemap(url) {
	const mapper = new Sitemapper({
		url,
		requestHeaders: {
			'User-Agent': useragent,
			'Accept': '*/*',
		},
		exclusions: [],
		fields: {
			loc: true,
			lastmod: true,
		},
		concurrency: 5,
		timeout: 15000, // Applies to each subrequest, not the entire operation
		retries: 2,
		debug: false, // Causes each sitemap file URL to be logged
	});

	return mapper.fetch();
}

/**
 * Parse a sitemap XML string into a simplified array of entries.
 *
 * Uses `fast-xml-parser` for XML parsing and extracts only a subset of fields
 * (`loc`, `lastmod`, `changefreq`) for each `<url>` entry.
 *
 * Currently supports `<urlset>` sitemaps; partial support for `<sitemapindex>`
 * can be enabled by extending the commented logic.
 *
 * @param {string} xml - Raw XML string from a sitemap file.
 * @returns {Promise<{ sites: SitemapEntry[]|null, errors?: string[], error?: string }>}
 * Returns an object with:
 * - `sites`: An array of parsed `SitemapEntry` objects or `null` if parsing failed.
 * - `errors`: An array of error messages, if any occurred.
 * - `error`: A single error message if parsing was not successful.
 */
export async function parseSitemap(xml) {
	try {
		// Fields to keep from each `<url>` entry
		const filterFields = { loc: true, lastmod: true, changefreq: true };

		// Parse XML; treat <url> and <sitemap> tags as arrays
		const parser = new XMLParser({
			isArray: (tagName) => ['sitemap', 'url'].some((value) => value === tagName),
		});

		const data = parser.parse(xml);

		// Uncomment to support <sitemapindex> handling
		//
		// if (Array.isArray(data?.urlset?.url)) {
		//     const urls = data.urlset.url;
		//     if (urls.length > 0) {
		//     }
		// } else if (Array.isArray(data?.sitemapindex?.sitemap)) {
		//     const sitemaps = data.sitemapindex.sitemap;
		// }
		// logger.info()

		if (data && data.urlset && data.urlset.url) {
			// Convert single object to array if needed
			const urlArray = Array.isArray(data.urlset.url) ? data.urlset.url : [data.urlset.url];

			// Begin filtering the urls
			const sites = urlArray
				.filter((_site) => {
					// This section will check and filter on last modified dates.  We
					// are going to grab everything
					return true;
					// if (this.lastmod === 0) return true;
					// if (site.lastmod === undefined) return false;
					// dev/  const modified = new Date(site.lastmod).getTime();

					// return modified >= this.lastmod;
				})
				.filter((_site) => {
					// Filtering excluded urls.  We are not excluding any right now
					return true;
					// return !this.isExcluded(site.loc);
				})
				.map((site) => {
					if (!filterFields) {
						return site.loc;
					} else {
						let fields = {};
						for (const [field, active] of Object.entries(filterFields)) {
							if (active && site[field]) {
								fields[field] = site[field];
							}
						}
						return fields;
					}
				});

			return {
				sites,
				errors: [],
			};
		}

		return { error: 'No data', sites: null };
	} catch (error) {
		logger.error(error);

		return {
			error: `Error occurred: ${error.name}`,
			sites: null,
		};
	}
}
