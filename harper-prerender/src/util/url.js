/**
 * @module url
 *
 * Canonical URL normalization shared by the submission side (Sitemap.post) and
 * the delivery side (/page, /page_content). Both MUST normalize identically, or
 * the cache key written at render time won't match the one looked up at request
 * time (e.g. a trailing slash difference → "not a managed page" + cache miss).
 */

/**
 * Normalize a URL: sort query params and drop a trailing slash / empty query.
 *
 * @param {string} url
 * @returns {string}
 */
export const normalizeUrl = (url) => {
	const parsedUrl = new URL(url);
	parsedUrl.searchParams.sort();
	let finalUrl = parsedUrl.href;
	// Keep a trailing path slash — stripping it makes the renderer fetch a URL the
	// origin 301-redirects back to (e.g. apple.com/iphone-17-pro/), so the redirect
	// gets cached under a different key and the requested key 503s. Only drop a
	// dangling empty query.
	if (finalUrl.endsWith('?')) finalUrl = finalUrl.slice(0, -1);
	return finalUrl;
};
