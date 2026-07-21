/**
 * @module CacheKey
 *
 * Provides utility functions for generating and parsing cache keys
 * used to uniquely identify prerendered pages in storage.
 *
 * A cache key combines:
 * - the request URL
 * - the device type (defaults to `"desktop"`)
 * - the accepted language (if provided)
 *
 * This ensures that pages rendered under different conditions are cached
 * and retrieved correctly without collisions.
 */
export default class CacheKey {
	/**
	 * Create a cache key string from an object.
	 *
	 * @param {object} obj - Object containing cache parameters.
	 * @param {string} obj.url - The full request URL.
	 * @param {string} obj.deviceType - Optional the device type (e.g., `"desktop"`, `"mobile"`, `"tablet"`), defaults to `"desktop"`.
	 * @param {string} obj.acceptLanguage - Optional `Accept-Language` header value.
	 * @returns {string} A serialized cache key string in the format:
	 *   `"url|deviceType|acceptLanguage"`.
	 */
	static serialize(obj) {
		const deviceType = obj.deviceType || 'desktop';
		const acceptLanguage = obj.acceptLanguage ? `|${obj.acceptLanguage}` : '';

		return `${obj.url}|${deviceType}${acceptLanguage}`;
	}

	/**
	 * Parse a cache key string back into its components.
	 *
	 * @static
	 * @param {string} str - Cache key string in the format:
	 *   `"url|deviceType|acceptLanguage"`.
	 * @returns {{ url: string, deviceType: string, acceptLanguage?: string }}
	 * An object containing the parsed values.
	 */
	static deserialize(str) {
		const [url, deviceType, acceptLanguage] = str.split('|');
		return {
			url,
			deviceType,
			acceptLanguage,
		};
	}
}
