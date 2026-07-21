/**
 * @module ExpiringMap
 *
 * Provides a simple in-memory key/value store where entries automatically
 * expire after a given time-to-live (TTL). Useful for caching transient data
 * such as callbacks, tokens, or job references.
 *
 * Expiration is handled via a periodic cleanup interval that removes entries
 * older than the configured TTL.
 */
export default class ExpiringMap {
	/**
	 * Create an expiring map.
	 *
	 * @param {number} ttl - Time-to-live in milliseconds for each entry.
	 */
	constructor(ttl) {
		/**
		 * Internal map storing values with timestamps.
		 * @type {Map<any, {value: any, timestamp: number}>}
		 * @private
		 */
		this.map = new Map();

		// Periodically remove expired entries
		setInterval(() => {
			const now = Date.now();
			for (const [key, entry] of this.map.entries()) {
				if (now - entry.timestamp > ttl) {
					this.delete(key);
				}
			}
		}, ttl);
	}

	/**
	 * Store a value in the map, resetting its expiration timer.
	 *
	 * @param {any} key - The key to associate with the value.
	 * @param {any} value - The value to store.
	 * @returns {void}
	 */
	set(key, value) {
		const now = Date.now();
		this.map.set(key, { value, timestamp: now });
	}

	/**
	 * Retrieve a value from the map.
	 *
	 * If the entry exists, it is returned and simultaneously removed
	 * from the map to prevent reuse. If the entry does not exist or has
	 * already expired, `null` is returned.
	 *
	 * @param {any} key - The key to look up.
	 * @returns {any|null} The stored value, or `null` if not found/expired.
	 */
	get(key) {
		const entry = this.map.get(key);
		if (!entry) return null;
		this.map.delete(key);
		return entry.value;
	}

	/**
	 * Delete an entry from the map.
	 *
	 * @param {any} key - The key to delete.
	 * @returns {boolean} `true` if the entry was deleted, `false` if not found.
	 */
	delete(key) {
		return this.map.delete(key);
	}

	/**
	 * Clear all entries from the map immediately.
	 *
	 * @returns {void}
	 */
	clear() {
		this.map.clear();
	}
}
