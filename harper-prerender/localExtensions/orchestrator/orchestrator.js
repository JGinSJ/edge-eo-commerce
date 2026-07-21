/**
 * @module orchestrator
 *
 * This module coordinates render job processing across worker threads.
 * It handles job status tracking, stream routing between threads,
 * caching prerendered content, and scheduling refreshes.
 *
 * Functions exposed here are intended for use in multi-threaded
 * rendering environments where job results may need to be passed back
 * to the originating thread.
 */

import { isMainThread, threadId } from 'worker_threads';
import { parentPort } from 'node:worker_threads';
import CacheKey from '../../src/util/CacheKey.js';
import ExpiringMap from '../../src/util/ExpiringMap.js';
import { calculateNextRefresh } from '../../src/util/time.js';
import { toBuffer, deriveMarkdownFromGzippedHtml } from '../../src/util/markdown.js';

const NAMESPACE = 'render_jobs';

/**
 * Defines logical process communication (LPC) message types
 * used between worker and main threads for render job handling.
 * @enum {object}
 */
const LpcType = {
	registerCallbackThread: {
		req: `${NAMESPACE}/register_callback_thread/req`,
	},
	getCallbackThread: {
		req: `${NAMESPACE}/get_callback_thread/req`,
		res: `${NAMESPACE}/get_callback_thread/res`,
	},
	transferContentToCallbackThread: {
		req: `${NAMESPACE}/transfer_content_to_callback_thread/req`,
	},
};

const TEN_MINUTES = 10 * 1000 * 60;
const jobCompletionCallbacks = new ExpiringMap(TEN_MINUTES);
const threadCallbacks = new ExpiringMap(TEN_MINUTES);

/**
 * @typedef {object} Job
 * @property {string} id - Unique identifier for the job.
 * @property {string} url - Target URL for prerendering.
 * @property {string} source - Source of the job (`request` or `scheduled`).
 * @property {string} deviceType - Device type (e.g., `mobile`, `desktop`, `tablet`).
 * @property {string} acceptLanguage - Language for rendering.
 * @property {object} headers - Optional request headers.
 */

/**
 * @typedef {object} Result
 * @property {string} jobId - ID of the job this result belongs to.
 * @property {string} url - The processed URL.
 * @property {ReadableStream} stream - Content stream.
 * @property {number} statusCode - HTTP response code.
 * @property {string} deviceType - Device type (e.g., `mobile`, `desktop`, `tablet`).
 * @property {string} acceptLanguage - Language for rendering.
 */

/**
 * Initializes a worker thread and logs its start.
 * @returns {Promise<object>} A promise resolving to an empty object once started.
 */
export const start = async () => {
	logger.info('Worker started', threadId);
	return {};
};

// ---------------- Main Thread vs Worker Thread Setup ----------------
if (isMainThread) {
	const sharedBuffer = new SharedArrayBuffer(4);

	// Responds to mutex requests with a shared buffer for synchronization
	threads.onMessageByType('render_jobs/worker/mutex-req', (_msg, port) => {
		port?.postMessage({
			type: 'render_jobs/worker/mutex-res',
			sharedBuffer,
		});
	});

	let currentStatus = null;

	// Track and persist job queue status updates
	threads.onMessageByType('job_queue/status', ({ status }) => {
		if (status !== currentStatus) {
			currentStatus = status;
			databases.local.QueueStatus.put('producer', { status });
		}
	});

	const callbackPortMap = new ExpiringMap(TEN_MINUTES);

	// Registers callback communication ports per job
	threads.onMessageByType(LpcType.registerCallbackThread.req, ({ jobId }, port) => {
		logger.info(LpcType.registerCallbackThread.req, { jobId, thread: port.threadId });
		callbackPortMap.set(jobId, port);
	});

	// Resolves requests for callback threads
	threads.onMessageByType(LpcType.getCallbackThread.req, (msg, origin) => {
		const port = callbackPortMap.get(msg.jobId);
		origin?.postMessage({ type: LpcType.getCallbackThread.res, threadId: port?.threadId, jobId: msg.jobId });
	});

	let connectedRenderWorkerIds = [];
	connectedRenderWorkerIds.version = 0;

	// Tracks connected worker threads and notifies HTTP workers
	threads.onMessageByType('worker/status', (msg) => {
		if (msg.status === 'connected') {
			if (!connectedRenderWorkerIds.includes(msg.workerId)) {
				connectedRenderWorkerIds.push(msg.workerId);
			}
		} else {
			const version = connectedRenderWorkerIds.version;
			connectedRenderWorkerIds = connectedRenderWorkerIds.filter((id) => id !== msg.workerId);
			connectedRenderWorkerIds.version = version;
		}

		connectedRenderWorkerIds.version++;
		for (const worker of threads) {
			if (worker.name === 'http') {
				worker.postMessage({ type: 'connected_render_worker_ids', connectedRenderWorkerIds });
			}
		}
	});

	// Respond to requests for list of connected render workers
	threads.onMessageByType('request_connected_render_worker_ids', (_, origin) => {
		origin?.postMessage({ type: 'connected_render_worker_ids', connectedRenderWorkerIds });
	});
} else {
	//----- Worker thread -----//

	// Listens for content transfers to the callback thread
	threads.onMessageByType(LpcType.transferContentToCallbackThread.req, savePageContent);

	// Handles responses for callback thread requests
	threads.onMessageByType(LpcType.getCallbackThread.res, (msg) => {
		const cb = threadCallbacks.get(msg.jobId);
		if (cb) {
			cb(msg.threadId);
		}
	});
}

/**
 * Resolves the callback thread ID for a given job.
 *
 * @param {string} jobId - The job identifier.
 * @returns {Promise<number|undefined>} Resolves with the thread ID, or `undefined` if not found.
 */
function getCallbackThread(jobId) {
	return new Promise((resolve, _reject) => {
		threadCallbacks.set(jobId, resolve);
		parentPort.postMessage({
			type: LpcType.getCallbackThread.req,
			jobId,
		});
	});
}

/**
 * Registers a callback function that is invoked upon job completion.
 *
 * @param {Job} job - Job metadata including its unique ID.
 * @param {(err: Error|null, result?: Result) => void} cb - Callback function.
 */
export function registerJobCompletionCallback(job, cb) {
	jobCompletionCallbacks.set(job.id, cb);
	parentPort.postMessage({ type: LpcType.registerCallbackThread.req, jobId: job.id });
}

/**
 * Processes job content by saving it locally or routing it to the correct callback thread.
 *
 * @param {Job} job - The job metadata.
 * @param {number} statusCode - HTTP response code.
 * @param {ReadableStream} contentStream - Content stream to save or transfer.
 * @returns {Promise<void>}
 */
export async function handleContent(job, statusCode, contentStream) {
	if (job.source !== 'request' || server.config.threads.count === 1) {
		return savePageContent({ ...job, jobId: job.id, stream: contentStream, statusCode });
	}

	const callbackThread = await getCallbackThread(job.id);

	if (callbackThread === threadId || callbackThread === undefined) {
		// request was made on this thread, so just save + return
		return savePageContent({ ...job, jobId: job.id, stream: contentStream, statusCode });
	} else {
		// request was made in another thread; transfer stream there
		const callbackPort = threads.find((port) => port.threadId === callbackThread);

		if (callbackPort) {
			callbackPort.postMessage({
				type: LpcType.transferContentToCallbackThread.req,
				stream: contentStream,
				jobId: job.id,
				url: job.url,
				statusCode,
				headers: job.headers,
			});
		}
	}
}

/**
 * Saves prerendered page content, updates job metadata,
 * persists cache entries, and manages scheduling.
 *
 * @param {Result} result - Job result with content and metadata.
 * @returns {Promise<void>}
 */
async function savePageContent(result) {
	// Buffer the (gzipped HTML) render result once so we can both store the HTML
	// blob and derive Markdown from the same bytes. The buffer is forwarded on
	// `result.htmlGzip` to the on-demand completion callback (see PageCache.js),
	// which would otherwise find the stream already consumed here.
	let htmlGzip = null;
	if (result.stream != null) {
		htmlGzip = await toBuffer(result.stream);
		result.stream = null;
		result.htmlGzip = htmlGzip;
	}

	await databases.local.RenderJob.patch(result.jobId, {
		status: result.statusCode >= 400 ? 'failed' : 'completed',
		completedTime: Date.now(),
		statusCode: result.statusCode,
	});

	const cacheKey = CacheKey.serialize({
		url: result.url,
		deviceType: result.deviceType,
		acceptLanguage: result.acceptLanguage,
	});

	const cb = jobCompletionCallbacks.get(result.jobId);
	if (cb) {
		// On-demand request path: PageCache.js builds and caches the record (with
		// Markdown) from result.htmlGzip.
		cb(null, result);
	} else if (result.statusCode === 200) {
		// Scheduled/async path: derive Markdown and persist both representations.
		const md = deriveMarkdownFromGzippedHtml(htmlGzip);
		await databases.prerender.PageCache.put({
			cacheKey,
			url: result.url,
			deviceType: result.deviceType,
			acceptLanguage: result.acceptLanguage,
			headers: JSON.stringify(result.headers || {}),
			statusCode: 200,
			content: htmlGzip ? await createBlob(htmlGzip) : null,
			markdownContent: md ? await createBlob(md.gzip) : null,
			markdownLength: md ? md.length : null,
			lastRefreshed: Date.now(),
		});
	}

	// Update scheduling metadata for periodic refresh
	const pageSchedule = await databases.prerender.PageMeta.get(cacheKey);

	if (pageSchedule) {
		pageSchedule.lastRefresh = Date.now();

		if (pageSchedule.refreshInterval > -1) {
			pageSchedule.nextRefresh = calculateNextRefresh(pageSchedule.refreshInterval, pageSchedule.lastRefresh);
			pageSchedule.status = 'scheduled';
		} else {
			pageSchedule.nextRefresh = -1;
			pageSchedule.status = 'idle';
		}

		await pageSchedule.update();
	}
}
