/**
 * @module JobQueue
 *
 * Provides a buffered job queue for workers that integrates with HarperDB
 * via MQTT and on-demand HTTP fetches.
 *
 * Responsibilities:
 * - Maintain a local buffer of render jobs for workers.
 * - Listen to upstream job producer status via MQTT (`empty` / `queued`).
 * - Fetch new jobs when the buffer falls below a threshold.
 * - Prioritize jobs pushed directly into the worker queue.
 * - Emit events (`jobs`, `fetching`) for consumers to react to new jobs.
 *
 * Integrates with:
 * - {@link RenderJob} for job metadata and handling.
 * - MQTT client for job status updates and job pushes.
 * - External HTTP `fetchJobs` function for on-demand retrieval.
 */

import { EventEmitter } from 'node:events';
import RenderJob from './RenderJob.js';
import { JobProducerStatus, mqttClient, Topic } from './external/mqtt.js';
import logger from './util/Logger.js';
import Denque from 'denque';

/**
 * Function type for fetching jobs from upstream.
 * @typedef {function} JobFetchFn
 * @param {number} count - Number of jobs to fetch.
 * @returns {Promise<RenderJob[]>} A promise resolving to an array of jobs.
 */
export type JobFetchFn = (count: number) => Promise<RenderJob[]>;

/**
 * Configuration object for initializing a {@link JobQueue}.
 */
export type JobQueueConfig = {
	/** Maximum number of jobs to buffer. */
	capacity: number;

	/** Function to fetch jobs from upstream (HTTP). */
	fetchJobs: JobFetchFn;

	/**
	 * Optional threshold for auto-fetching.
	 * Defaults to half of capacity if not specified.
	 */
	fetchThreshold?: number;
};

/**
 * Local job queue for workers.
 *
 * Buffers jobs pulled from HarperDB, either via MQTT (`workerQueue` topic)
 * or via HTTP fetch when the buffer is low and upstream has jobs available.
 *
 * Extends {@link EventEmitter} to notify consumers:
 * - `jobs`: Fired when new jobs become available.
 * - `fetching`: Fired when a background fetch is attempted.
 */
export class JobQueue extends EventEmitter {
	/**
	 * Queue status for diagnostics (not used for flow control).
	 * @type {"idle"|"fetching"|"paused"}
	 */
	status: 'idle' | 'fetching' | 'paused' = 'idle';

	/** Threshold at which to auto-fetch new jobs. */
	_autoFetchThreshold: number;

	/** Queue for high-priority jobs pushed directly to this worker. */
	_priorityQueue: Denque<RenderJob>;

	/** Queue for normal jobs fetched from upstream. */
	_normalQueue: Denque<RenderJob>;

	/** Application-provided function to fetch new jobs. */
	_fetchJobs: JobFetchFn;

	/** Whether a fetch operation is currently in progress. */
	isFetching = false;

	/** Maximum number of jobs to buffer. */
	capacity: number;

	/** Latest known upstream producer status from MQTT. */
	jobProducerStatus: JobProducerStatus = 'empty';

	/**
	 * Initialize a new job queue and subscribe to MQTT topics.
	 *
	 * Subscribes to:
	 * - `Topic.jobSchedulerStatus`: Producer status updates.
	 * - `Topic.workerQueue`: Direct job pushes for this worker.
	 *
	 * @param {JobQueueConfig} config - Queue configuration.
	 * @returns {Promise<JobQueue>} Initialized job queue instance.
	 */
	static async init(config: JobQueueConfig) {
		const jobQueue = new JobQueue(config);

		mqttClient.on('message', (topic: string, msg: Buffer) => jobQueue.handleMessage(topic, msg));
		await mqttClient.subscribeAsync({
			[Topic.jobSchedulerStatus]: { qos: 1 },
			[Topic.workerQueue]: { qos: 1 },
		});

		return jobQueue;
	}

	constructor({ capacity, fetchJobs, fetchThreshold }: JobQueueConfig) {
		super();
		this.capacity = capacity;
		this._normalQueue = new Denque<RenderJob>([], { capacity });
		this._priorityQueue = new Denque<RenderJob>([], { capacity });
		this._fetchJobs = fetchJobs;
		this._autoFetchThreshold = fetchThreshold ?? capacity / 2;

		// Initial hydration attempt; will be a no-op if producer is `empty` or buffer above threshold.
		this._tryHydrateBuffer();
	}

	/**
	 * Handle incoming MQTT messages.
	 *
	 * - `queue_status/producer`: Updates upstream job producer status.
	 * - `render_worker/{WORKER_ID}/queue`: Pushes high-priority job.
	 *
	 * @param {string} topic - MQTT topic name.
	 * @param {Buffer} payload - Raw payload.
	 */
	handleMessage(topic: string, payload: Buffer) {
		if (topic === Topic.jobSchedulerStatus) {
			const d = JSON.parse(payload.toString());
			this.jobProducerStatus = d.status as JobProducerStatus;
			this._tryHydrateBuffer();
		} else if (topic === Topic.workerQueue) {
			const jobData = JSON.parse(payload.toString());
			const job = new RenderJob(jobData);
			this._priorityQueue.push(job);
			this.emit('jobs');
		}
	}

	/**
	 * Peek at the next job in the queue without removing it.
	 *
	 * @returns {RenderJob|null} The next job, or null if none.
	 */
	peek(): RenderJob | null {
		return this._priorityQueue.peekFront() || this._normalQueue.peekFront() || null;
	}

	/**
	 * Retrieve the next job from the queue.
	 *
	 * - Priority jobs are returned first.
	 * - Triggers background fetch if buffer is low.
	 *
	 * @returns {RenderJob|null} The next job, or null if none.
	 */
	next(): RenderJob | null {
		const job = this._priorityQueue.shift() || this._normalQueue.shift();
		this._tryHydrateBuffer();
		return job || null;
	}

	/**
	 * Attempt to hydrate the buffer by fetching new jobs.
	 *
	 * Conditions:
	 * - Skips if already fetching.
	 * - Skips if buffer above threshold.
	 * - Skips if producer status is `empty`.
	 *
	 * Emits:
	 * - `jobs` if the buffer was previously empty but jobs were fetched.
	 * - `fetching` when a fetch attempt occurs.e
	 */
	async _tryHydrateBuffer() {
		if (this.isFetching) return;
		if (this._normalQueue.length > this._autoFetchThreshold) return;
		if (this.jobProducerStatus === 'empty') return;

		this.isFetching = true;

		try {
			const emptySlots = this.capacity - this._normalQueue.length;
			const jobs = await this._fetchJobs(emptySlots);

			jobs.forEach((job) => this._normalQueue.push(new RenderJob(job)));

			if (jobs.length > 0) {
				this.emit('jobs');
			}
		} catch (err: any) {
			logger.error({ err }, 'Failed to fetch jobs');
		}

		this.isFetching = false;

		if (this.listenerCount('fetching') > 0) {
			this.emit('fetching');
		}
	}
}
