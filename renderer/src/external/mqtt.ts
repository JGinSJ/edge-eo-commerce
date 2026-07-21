/**
 * @module mqtt
 *
 * Provides MQTT connectivity for the render job system.
 *
 * Responsibilities:
 * - Establishing an MQTT connection to Harper.
 * - Publishing and subscribing to known topics for job scheduling and worker queues.
 *
 * Integrates with:
 * - Harper’s job scheduler via `queue_status/producer`.
 * - Individual render workers via `render_worker/{WORKER_ID}/queue`.
 */

import mqtt from 'mqtt';
import { STATE, HDB_PASS, HDB_USER, WORKER_ID, HDB_HTTP_PORT } from '../util/env.js';

/**
 * Selected protocol for MQTT connections.
 * Uses secure WebSocket (`wss`) in production, plain WebSocket (`ws`) otherwise.
 * @type {"ws" | "wss"}
 */
const protocol = process.env.NODE_ENV === 'production' ? `wss` : 'ws';

/**
 * Known MQTT topics used by the render job system.
 *
 * - `jobSchedulerStatus`: Queue status updates from the producer.
 * - `workerQueue`: Per-worker queue where jobs are published for this worker.
 */
export const Topic = {
	jobSchedulerStatus: 'queue_status/producer',
	workerQueue: `render_worker/${WORKER_ID}/queue`,
};

/**
 * Possible statuses for the job producer queue.
 *
 * - `"empty"`: No jobs available.
 * - `"queued"`: Jobs are waiting to be claimed.
 *
 * @typedef {"empty" | "queued"} JobProducerStatus
 */
export type JobProducerStatus = 'empty' | 'queued';

/**
 * Connected MQTT client instance for Harper job coordination.
 *
 * Configured with:
 * - `clientId`: The worker ID.
 * - `username` / `password`: Harper credentials.
 * - Clean session and WebSocket transport.
 *
 * @type {mqtt.MqttClient}
 */
export const mqttClient = await mqtt.connectAsync(`${protocol}://${STATE.HDB_HOST}:${HDB_HTTP_PORT}`, {
	clean: true,
	clientId: WORKER_ID,
	username: HDB_USER,
	password: HDB_PASS,
	wsOptions: {
		protocol: 'mqtt',
	},
});
