// Time constants (in milliseconds)
const SECOND = 1000;
const MINUTE = 60 * SECOND;
// const HOUR = 60 * MINUTE;
// const DAY = 24 * HOUR;

/**
 * Calculate the next refresh timestamp (aligned to the current minute).
 *
 * @param {number} refreshInterval - Interval between refreshes in milliseconds.
 *                                    Use `-1` to disable refreshing.
 * @param {number} [lastRefresh = -1] - Timestamp of the last refresh in milliseconds since epoch.
 *                                    Use `-1` if the page has never been refreshed.
 * @returns {number} Timestamp (ms) of the next refresh, aligned to the nearest minute.
 *                   Returns `-1` if refreshInterval is `-1`.
 */
export const calculateNextRefresh = (refreshInterval, lastRefresh = -1) => {
	if (refreshInterval === -1) {
		return -1;
	}
	if (lastRefresh === -1) {
		return currentMinuteMs(Date.now());
	}

	return currentMinuteMs(lastRefresh + refreshInterval);
};

export const currentMinuteMs = (ts = Date.now()) => Math.floor(ts / MINUTE) * MINUTE;
