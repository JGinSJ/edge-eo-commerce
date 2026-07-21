/**
 * @module RenderWorker
 *
 * Manages connected render workers and provides utility functions
 * to retrieve worker availability within a multi-threaded environment.
 *
 * This module tracks the set of connected worker IDs reported from
 * other threads and exposes methods for querying available workers.
 *
 * It also integrates with MQTT server session events to update the
 * connected/disconnected status of workers in the local database and
 * notify other threads.
 */

import { parentPort } from 'worker_threads';

/**
 * Class representing a registry of render worker threads.
 *
 * The class maintains a synchronized list of connected worker IDs
 * and provides methods for retrieving available workers. The list
 * is updated in response to inter-thread messages.
 */
export default class RenderWorkers {
	/**
	 * List of currently connected worker IDs.
	 * @type {string[] & {version?: number}}
	 */
	static connectedWorkerIds = [];

	static {
		// Initialize versioning for connected worker list
		this.connectedWorkerIds.version = 0;

		// Listen for updates to the set of connected worker IDs
		threads.onMessageByType('connected_render_worker_ids', (msg) => {
			if (msg.connectedRenderWorkerIds.version > this.connectedWorkerIds.version) {
				this.connectedWorkerIds = msg.connectedRenderWorkerIds;
			}
		});

		// Request the initial list of connected workers
		parentPort.postMessage({ type: 'request_connected_render_worker_ids' });
	}

	/**
	 * Get a random available worker ID from the connected list.
	 *
	 * @returns {string|null} A randomly selected worker ID, or `null` if none are connected.
	 */
	static getAvailableWorkerId() {
		if (this.connectedWorkerIds.length === 0) {
			return null;
		}

		const randomIndex = Math.floor(Math.random() * this.connectedWorkerIds.length);
		return this.connectedWorkerIds[randomIndex];
	}
}

/**
 * Handles MQTT "connected" events for workers.
 *
 * Persists the worker's status in the local database and notifies
 * other threads that the worker is now connected.
 *
 * @event server.mqtt.events#connected
 * @param {object} session - MQTT session object.
 * @param {string} session.sessionId - Unique worker identifier.
 */
server.mqtt.events.on('connected', (session) => {
	const workerId = session?.sessionId;
	if (workerId) {
		logger.info(`Worker connected: ${workerId}`);
		databases.local.RenderWorker.put(workerId, { id: workerId, status: 'connected' });
		parentPort.postMessage({ type: 'worker/status', workerId, status: 'connected' });
	}
});

/**
 * Handles MQTT "disconnected" events for workers.
 *
 * Persists the worker's status in the local database and notifies
 * other threads that the worker is now disconnected.
 *
 * @event server.mqtt.events#disconnected
 * @param {object} session - MQTT session object.
 * @param {string} session.sessionId - Unique worker identifier.
 */
server.mqtt.events.on('disconnected', (session) => {
	const workerId = session?.sessionId;
	if (workerId) {
		logger.info(`Worker disconnected: ${workerId}`);
		databases.local.RenderWorker.put(workerId, { id: workerId, status: 'disconnected' });
		parentPort.postMessage({ type: 'worker/status', workerId, status: 'disconnected' });
	}
});
