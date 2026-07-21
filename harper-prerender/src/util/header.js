/**
 * @module headers
 *
 * Utility functions for sanitizing request/response headers.
 *
 * Responsibilities:
 * - Restricting forwarded headers to allowlists.
 * - Enforcing standard request headers for bot requests.
 * - Extracting original response headers from upstream-prefixed headers.
 */

/**
 * Sanitize headers by applying a whitelist filter.
 *
 * @param {object} headers - Source headers as key/value pairs.
 * @param {object} config - Optional configuration.
 * @param {string[]} config.whitelist - List of allowed header names.
 * @returns {object} Sanitized headers containing only whitelisted entries.
 */
export const sanitizeHeaders = (headers, config = {}) => {
	const { whitelist } = config;

	const sanitizedHeaders = {};

	for (const h of whitelist) {
		const value = headers[h];
		if (value) {
			sanitizedHeaders[h] = value;
		}
	}

	return sanitizedHeaders;
};

/**
 * Sanitize request headers for bot requests.
 * Always enforces content encoding.
 *
 * @param {Headers} headers - A `Headers` object to mutate.
 */
export const sanitizeRequestHeaders = (headers) => {
	headers.set('accept-encoding', 'gzip, br');
};

const UPSTREAM_HEADER_PREFIX = 'x-origin-header-';

/**
 * Extract the original upstream header name from a prefixed header.
 *
 * Upstream response headers are prefixed with `"x-origin-header-"`.
 * This function removes the prefix if present.
 *
 * @param {string} headerName - Header name from the response.
 * @returns {string|null} The unprefixed upstream header name, or `null` if not prefixed.
 */
export const extractUpstreamResponseHeaderName = (headerName) => {
	if (headerName.startsWith(UPSTREAM_HEADER_PREFIX)) {
		return headerName.substring(UPSTREAM_HEADER_PREFIX.length);
	}
	return null;
};
