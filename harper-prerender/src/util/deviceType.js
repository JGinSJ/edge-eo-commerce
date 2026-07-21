/**
 * @module deviceType
 *
 * Utilities for normalizing and validating device types
 * (e.g., `"desktop"`, `"mobile"`) used in prerendering.
 */

import { VALID_DEVICE_TYPES } from './constants.js';

/**
 * Sanitize a provided device type string.
 *
 * - Defaults to `"desktop"` if the value is not provided or invalid.
 * - Converts input to lowercase before validation.
 *
 * @param {string} [deviceType] - Raw device type string (case-insensitive).
 * @returns {string} A normalized and validated device type (`"desktop"`, `"mobile"`, etc.).
 */
export const sanitizeDeviceType = (deviceType) => {
	if (!deviceType) {
		return 'desktop';
	}
	deviceType = deviceType?.toLowerCase();

	if (VALID_DEVICE_TYPES.includes(deviceType)) {
		return deviceType;
	}
	return 'desktop';
};
