/**
 * @module render
 *
 * Provides the `render` function for submitting rendering jobs
 * to the {@link JobQueue}. Supports synchronous (wait for response)
 * and asynchronous (fire-and-forget) job submission.
 */

import JobQueue from '../resources/JobQueue.js';

/**
 * Submit a render job to the job queue.
 *
 * - If `waitForResponse` is `true`, resolves when the job completes.
 * - If `false`, resolves immediately once the job is enqueued.
 *
 * @param {object} options - Render job options.
 * @param {string} options.url - Target URL to render.
 * @param {object} options.headers - Request headers to forward.
 * @param {string} options.deviceType - Device type (`desktop`, `mobile`, etc.).
 * @param {string} options.acceptLanguage - Language header for rendering.
 * @param {boolean} options.waitForResponse - Whether to wait for job completion, defaults to false.
 * @param {number} options.priority - Job priority (lower is higher priority), defaults to 2.
 * @returns {Promise<object>} A promise resolving to the job result if `waitForResponse`,
 * otherwise a simple acknowledgment.
 */
export const render = async ({
	url,
	headers,
	deviceType,
	acceptLanguage,
	waitForResponse = false,
	priority = 2,
	renderOptions,
}) => {
	// Per-render options are persisted as a JSON string so they survive the trip
	// through the RenderJob table to the renderer.
	const renderOptionsJson = renderOptions ? JSON.stringify(renderOptions) : undefined;
	return new Promise((resolve, reject) => {
		if (waitForResponse) {
			JobQueue.submitJob(
				{ url, deviceType, source: 'request', priority, acceptLanguage, headers: JSON.stringify(headers), renderOptions: renderOptionsJson },
				(error, result) => {
					if (error) {
						reject(error);
					} else {
						resolve(result);
					}
				}
			);
		} else {
			JobQueue.submitJob({ url, deviceType, acceptLanguage, priority, headers: JSON.stringify(headers), renderOptions: renderOptionsJson })
				.then(resolve)
				.catch(reject);
		}
	});
};
