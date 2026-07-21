/**
 * @module JobQueue
 *
 * Provides the logic for managing render jobs across workers.
 *
 * Responsibilities include:
 * - Claiming and leasing jobs to workers.
 * - Releasing expired or disconnected jobs.
 * - Submitting jobs to available workers or queueing them for later.
 * - Handling job results and storing prerendered content.
 * - Scheduling background maintenance tasks (worker 0 only).
 *
 * This module coordinates with:
 * - {@link Mutex} for atomic operations.
 * - {@link ManagedPage} for scheduled page refreshes.
 * - {@link RenderWorkers} to select available workers.
 * - {@link CacheKey} for cache storage keys.
 */

import { parentPort } from 'node:worker_threads';
import { handleContent, registerJobCompletionCallback } from 'orchestrator';
import ManagedPage from './ManagedPage.js';
import CacheKey from '../util/CacheKey.js';
import RenderWorkers from '../util/RenderWorkers.js';
import Mutex from '../util/Mutex.js';
import { currentMinuteMs } from '../util/time.js';
import { nodes } from '../util/replication.js';
import { extractUpstreamResponseHeaderName } from '../util/header.js';
import { RES_HEADERS_WHITELIST } from '../util/constants.js';

const mutex = await Mutex.init();

// Lease settings for jobs
const JOB_RECLAMATION_CHECK_INTERVAL = 10 * 60 * 1000;
const JOB_LEASE_EXPIRATION_CHECK_INTERVAL = 60 * 1000; // 1 minute
const JOB_LEASE_TTL = 2 * 60 * 1000; // 2 minutes
const COMPLETED_JOB_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Content type registration for job results
contentTypes.set('text/html', {
	compressible: false,
	serializeStream: (data) => {
		return data;
	},
	deserialize(data) {
		return {
			data,
			contentType: 'text/html',
		};
	},
	serialize(data) {
		return data;
	},
});

/**
 * Claim pending jobs and assign them to a worker.
 * Uses a mutex lock to avoid race conditions.
 *
 * @param {string} workerId - ID of the worker claiming jobs.
 * @param {object} options
 * @param {number} options.limit - Maximum number of jobs to claim.
 * @returns {Promise<object[]>} Array of claimed job objects.
 */
const claimJobs = mutex.withLock(async (workerId, { limit }) => {
	logger.info('Claiming jobs for worker:', workerId);
	const jobs = await transaction(async () => {
		const jobs = [];
		// Search for pending jobs ordered by priority then ID
		for await (const job of JobQueue.search({
			conditions: [{ attribute: 'status', value: JobQueue.STATUS_TYPE.pending }],
			limit,
			sort: {
				attribute: 'priority',
			},
		})) {
			// Mark each job as claimed by this worker
			databases.local.RenderJob.patch(job.id, {
				status: JobQueue.STATUS_TYPE.claimed,
				claimedBy: workerId,
				claimedAt: Date.now(),
			});
			jobs.push(job);
		}
		return jobs;
	});

	// Notify if there were no jobs to claim
	if (jobs.length === 0) {
		logger.info('No jobs available to claim');
		parentPort.postMessage({ type: 'job_queue/status', status: 'empty' });
	}
	return jobs;
});

/**
 * Assign a node host to a worker for job processing.
 * Ensures workers are distributed evenly across available nodes.
 *
 * @param {string} workerId - Worker ID.
 * @returns {Promise<{ host: string }>} Node assignment for the worker.
 */
export const assignNodeToWorker = mutex.withLock(async (workerId) => {
	logger.info(`Assigning Node to ${workerId}`);
	let result = await databases.prerender.WorkerAssignments.get(0);
	if (!result) {
		await databases.prerender.WorkerAssignments.put(0, { id: 0, assignments: [] });
		result = await databases.prerender.WorkerAssignments.get(0);
	}

	const assignments = { ...result.assignments.toJSON() };

	nodes.forEach((node) => {
		if (!assignments[node]) {
			assignments[node] = [];
		}
	});

	Object.keys(assignments).forEach((node) => {
		if (!nodes.includes(node)) {
			delete assignments[node];
		}
	});

	let workerNode;
	for (const node of Object.keys(assignments)) {
		const nodeAssignments = assignments[node];

		if (nodeAssignments.includes(workerId)) {
			workerNode = node;
			break;
		}
	}

	if (!workerNode) {
		// assign to node with fewest workers
		let best;
		let bestNode;
		for (const node of Object.keys(assignments)) {
			const nodeAssignments = assignments[node];

			if (!best || nodeAssignments.length <= best.length) {
				best = nodeAssignments;
				bestNode = node;
			}
		}

		assignments[bestNode] = [...best, workerId];
		workerNode = bestNode;
	}

	result.assignments = assignments;

	await result.update();

	return { host: workerNode };
});

/**
 * Release all jobs claimed by a specific worker.
 * Runs when a worker registers or disconnects.
 *
 * @param {string} workerId - ID of the worker whose jobs should be released.
 * @returns {Promise<void>}
 */
const releaseWorkerJobs = mutex.withLock((workerId) => {
	logger.info('Releasing jobs for worker:', workerId);
	return transaction(async () => {
		const jobs = await databases.local.RenderJob.search({
			conditions: [
				{ attribute: 'status', comparator: 'equals', value: JobQueue.STATUS_TYPE.claimed },
				{ attribute: 'claimedBy', comparator: 'equals', value: workerId },
			],
		});

		let releasedJobs = false;
		for await (const job of jobs) {
			releasedJobs = true;
			databases.local.RenderJob.patch(job.id, { status: JobQueue.STATUS_TYPE.pending, claimedBy: null });
		}

		// Notify queue watchers if jobs were released
		if (releasedJobs) {
			logger.info('Released jobs back to pending');
			parentPort.postMessage({ type: 'job_queue/status', status: 'queued' });
		}
	});
});

/**
 * Release jobs that have been claimed but not completed within the lease TTL.
 * Runs periodically to ensure jobs are not stuck indefinitely.
 *
 * @returns {Promise<void>}
 */
const releaseExpiredJobs = mutex.withLock(() => {
	logger.info('Checking for expired jobs to release from workers');
	return transaction(async () => {
		const expirationCutoff = Date.now() - JOB_LEASE_TTL;

		// Find claimed jobs older than the cutoff
		const staleJobs = await databases.local.RenderJob.search({
			conditions: [
				{ attribute: 'status', comparator: 'equals', value: JobQueue.STATUS_TYPE.claimed },
				{ attribute: 'claimedAt', comparator: 'less_than', value: expirationCutoff },
			],
		});

		let releasedJobs = false;
		for await (const job of staleJobs) {
			releasedJobs = true;
			databases.local.RenderJob.patch(job.id, { status: JobQueue.STATUS_TYPE.pending, claimedBy: null });
		}

		// Notify if stale jobs were put back into queue
		if (releasedJobs) {
			logger.info('Released expired jobs back to pending');
			parentPort.postMessage({ type: 'job_queue/status', status: 'queued' });
		}
	});
});

/**
 * Delete completed jobs that are older than the TTL.
 * Runs periodically to clean up old job records.
 *
 * @returns {Promise<void>}
 */
async function deleteCompletedAndExpiredJobs() {
	const expirationCutoff = Date.now() - COMPLETED_JOB_TTL;
	await databases.local.RenderJob.delete({
		conditions: [{ attribute: 'completedTime', comparator: 'less_than', value: expirationCutoff }],
	});
}

/**
 * Class representing the render job queue.
 *
 * Extends the database-backed `databases.local.RenderJob` resource.
 */
export default class JobQueue extends databases.local.RenderJob {
	static STATUS_TYPE = {
		pending: 'pending',
		claimed: 'claimed',
		completed: 'completed',
		failed: 'failed',
	};

	static JOB_SCHEDULE_INTERVAL = 30 * 1000; // 30 seconds

	/**
	 * Handle POST requests to the job queue API.
	 *
	 * Supports:
	 * - `/result`: handle job content result.
	 * - `register-worker`: release jobs from worker.
	 * - `claim-jobs`: claim new jobs for worker.
	 *
	 * @param {object} q - Query object (contains URL).
	 * @param {Promise<object>} dataPromise - Body payload.
	 * @param {object} ctx - Request context.
	 * @returns {Promise<any>}
	 */
	static async post(q, dataPromise, ctx) {
		if (q.url === '/result') {
			return this._handleContent(ctx, dataPromise);
		}

		const workerId = ctx.headers.get('x-worker-id');
		const data = await dataPromise;
		switch (data.op) {
			case 'register-worker':
				return releaseWorkerJobs(workerId);
			case 'claim-jobs':
				return claimJobs(workerId, data);
			default:
				throw new Error('Unsupported operation', data.op);
		}
	}

	/**
	 * Submit a new render job.
	 *
	 * Adds the job to the database, optionally registers a completion callback,
	 * and assigns it to an available worker if possible.
	 *
	 * @param {object} job - Job metadata (url, deviceType, etc.).
	 * @param {(err: Error|null, result?: object) => void} [cb] - Optional callback for completion.
	 * @returns {Promise<void>}
	 */
	static async submitJob(job, cb) {
		job = this.sanitizeJob(job);
		logger.info(`Submitting job: ${job.id} for ${job.url}`);

		await databases.local.RenderJob.put(job);

		if (cb) {
			registerJobCompletionCallback(job, cb);

			// Signal the queue so a connected worker claims this job via the HTTP
			// claim path — the same reliable path scheduled renders use, and the one
			// that flips the job's status so it renders exactly once.
			//
			// We intentionally do NOT use the direct per-worker MQTT push here: it
			// bypasses the claim/status flip (so combining it with the queue signal
			// would double-render) and, on its own, was being missed across worker
			// reconnects — leaving on-demand renders (e.g. /render_preview, which has
			// no scheduler to fall back on) unclaimed and hanging.
			parentPort.postMessage({ type: 'job_queue/status', status: 'queued' });
		}
	}

	/**
	 * Handle a job result submitted by a worker.
	 *
	 * Persists prerendered content, manages redirects, and caches results.
	 *
	 * @param {object} ctx - Request context (headers contain job metadata).
	 * @param {Promise<object>} dataPromise - Body data promise.
	 * @returns {Promise<{status: number, headers: object}>}
	 */
	static async _handleContent(ctx, dataPromise) {
		const jobId = parseInt(ctx.headers.get('x-job-id'));
		const statusCode = parseInt(ctx.headers.get('x-origin-status') || '500');

		const downstreamResponseHeaders = {};
		ctx.headers.forEach((value, key) => {
			const upstreamResponseHeader = extractUpstreamResponseHeaderName(key);
			if (upstreamResponseHeader) {
				downstreamResponseHeaders[upstreamResponseHeader] = value;
			} else if (RES_HEADERS_WHITELIST.includes(key.toLowerCase())) {
				downstreamResponseHeaders[key] = value;
			}

			if (key.toLowerCase() === 'content-type') {
				downstreamResponseHeaders['content-type'] = 'text/html; charset=utf-8';
			}
		});

		const job = await databases.local.RenderJob.primaryStore.get(jobId);
		const result = { ...job };

		let data = null;
		if (dataPromise && statusCode !== 500) {
			data = await dataPromise;
			if (data?.data) {
				data = data.data;
			}
		} else {
			logger.info('No dataPromise or statusCode is 500, skipping data processing', { statusCode });
		}

		if (ctx.headers.get('x-render-time')) {
			const renderTime = parseInt(ctx.headers.get('x-render-time'));
			result.renderTime = renderTime;
			server.recordAnalytics(renderTime, 'render_time', 'renderer', undefined, job?.deviceType);
		}

		const redirectUrl = ctx.headers.get('x-redirect-to');
		if (redirectUrl) {
			const redirectStatusCode = parseInt(ctx.headers.get('x-redirect-status') || '302');
			if (job) {
				result.headers = { location: redirectUrl };

				await handleContent(result, redirectStatusCode, null);

				if (statusCode === 200) {
					// also save redirect in cache
					const cacheKey = CacheKey.serialize({
						url: redirectUrl,
						deviceType: result.deviceType,
						acceptLanguage: result.acceptLanguage,
					});

					await databases.prerender.PageCache.put({
						cacheKey,
						url: redirectUrl,
						statusCode: 200,
						deviceType: result.deviceType,
						acceptLanguage: result.acceptLanguage,
						headers: JSON.stringify(downstreamResponseHeaders),
						content: await createBlob(data),
						lastRefreshed: Date.now(),
					});
				}
			}
		} else {
			result.headers = downstreamResponseHeaders;
			await handleContent(result, statusCode, data);
		}

		return {
			status: 201,
			headers: {},
		};
	}

	/**
	 * Sanitize a job object by applying defaults.
	 * Ensures job ID, attempts, priority, created time, and status are set.
	 *
	 * @param {object} job - Raw job object.
	 * @returns {object} Sanitized job object.
	 */
	static sanitizeJob(job) {
		job = { ...job };

		if (job.id === undefined) {
			job.id = databases.local.RenderJob.getNewId();
		}
		if (job.attempts === undefined) {
			job.attempts = 0;
		}
		if (job.priority === undefined) {
			job.priority = 2;
		}
		if (job.createdTime === undefined) {
			job.createdTime = Date.now();
		}
		job.status = JobQueue.STATUS_TYPE.pending;
		return job;
	}
}

/**
 * Worker 0 schedules background maintenance tasks:
 * - Release expired jobs
 * - Schedule page refreshes
 * - Delete completed/expired jobs
 * - Update queue status
 */
if (server.workerIndex === 0) {
	// Schedule background tasks
	setInterval(releaseExpiredJobs, JOB_LEASE_EXPIRATION_CHECK_INTERVAL).unref();
	setInterval(queueScheduledPageRenders, JobQueue.JOB_SCHEDULE_INTERVAL).unref();
	setInterval(deleteCompletedAndExpiredJobs, JOB_RECLAMATION_CHECK_INTERVAL).unref();

	/**
	 * Submit a page render job for a managed page.
	 * @param {object} page - Managed page object.
	 * @returns {Promise<void>}
	 */
	const submitPageRender = async (page) => {
		try {
			const { url, deviceType, acceptLanguage } = CacheKey.deserialize(page.cacheKey);
			await databases.prerender.PageMeta.patch(page.cacheKey, { status: ManagedPage.STATUS_TYPE.refreshing });
			await JobQueue.submitJob({ url, deviceType, priority: 2, acceptLanguage });
		} catch (error) {
			logger.error('Error submitting scheduled page render', error);
		}
	};

	/**
	 * Check for managed pages due for refresh and queue render jobs.
	 * Runs periodically to ensure scheduled pages are kept up to date.
	 *
	 * @returns {Promise<void>}
	 */
	async function queueScheduledPageRenders() {
		const currentMinute = currentMinuteMs();
		logger.info('Checking for scheduled page renders to queue', currentMinute);

		const it = await ManagedPage.search({
			conditions: [
				{ attribute: 'nextRefresh', comparator: 'less_than_equal', value: currentMinute },
				{ attribute: 'node', comparator: 'equals', value: server.hostname },
				{
					operator: 'or',
					conditions: [
						{ attribute: 'status', comparator: 'equals', value: ManagedPage.STATUS_TYPE.idle },
						{ attribute: 'status', comparator: 'equals', value: ManagedPage.STATUS_TYPE.scheduled },
					],
				},
			],
		});

		let hasScheduledJobs = false;
		for await (const page of it) {
			hasScheduledJobs = true;
			submitPageRender(page);
		}

		if (hasScheduledJobs) {
			parentPort.postMessage({ type: 'job_queue/status', status: 'queued' });
		}
	}

	// Check if there are pending jobs every 30 seconds and update status
	setInterval(async () => {
		const it = databases.local.RenderJob.search({
			conditions: [
				{ attribute: 'status', comparator: 'equals', value: JobQueue.STATUS_TYPE.pending },
				{ attribute: 'priority', comparator: 'equals', value: 2 },
			],
			limit: 1,
			select: 'id',
		});
		const [id] = await Array.fromAsync(it);
		parentPort.postMessage({ type: 'job_queue/status', status: id ? 'queued' : 'empty' });
	}, 30000).unref();
}
