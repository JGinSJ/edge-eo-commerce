/**
 * @module http
 *
 * Provides HTTP utilities for worker-to-Harper communication.
 *
 * Responsibilities:
 * - Claiming jobs from the `/render_jobs` endpoint.
 * - Registering workers with the orchestrator service.
 * - Submitting job results (with compressed content and metadata).
 *
 * Integrates with:
 * - {@link RenderJob} for job metadata.
 * - Harper environment configuration (`env.js`).
 * - {@link undici.Pool} for efficient HTTP connection pooling.
 */

import { gzip } from 'zlib';
import { Pool } from 'undici';
import { promisify } from 'node:util';
import { STATE, HDB_HTTP_PORT, HDB_PASS, HDB_USER, WORKER_ID, setHdbHost, CONCURRENCY } from '../util/env.js';
import RenderJob from '../RenderJob.js';
import logger from '../util/Logger.js';

const pGzip = promisify(gzip);

/**
 * Selected protocol based on environment.
 * Uses HTTPS in production, HTTP otherwise.
 * @type {"http"|"https"}
 */
const protocol = process.env.NODE_ENV === 'production' ? `https` : 'http';

/**
 * Shared HTTP connection pool for communicating with Harper.
 * Initially configured with one connection; resized during registration.
 * @type {Pool}
 */
let pool = new Pool(`${protocol}://${STATE.HDB_HOST}:${HDB_HTTP_PORT}`, { connections: CONCURRENCY });

/**
 * Default configuration for outbound requests to Harper.
 * Includes authorization headers and worker identification.
 */
const BASE_CONFIG = {
	method: 'POST',
	headers: {
		'x-worker-id': WORKER_ID!,
		'authorization': `Basic ${Buffer.from(`${HDB_USER}:${HDB_PASS}`).toString('base64')}`,
	},
	keepalive: true,
};

/**
 * Fetch jobs from Harper’s `/render_jobs` endpoint.
 *
 * @param {number} limit - Maximum number of jobs to claim.
 * @returns {Promise<RenderJob[]>} Array of claimed jobs.
 */
export const fetchJobs = async (limit: number): Promise<RenderJob[]> => {
	logger.info(`Worker ${WORKER_ID} fetching jobs...`);
	const res = await pool.request({
		...BASE_CONFIG,
		headers: {
			...BASE_CONFIG.headers,
			'content-type': 'application/json',
		},
		path: '/render_jobs',
		body: JSON.stringify({
			op: 'claim-jobs',
			limit,
		}),
	});

	const data: any = await res.body.json();
	return data;
};

/**
 * Register this worker with Harper.
 *
 * - Calls `/render_jobs` with `register-worker` op.
 * - Updates the active Harper host via {@link setHdbHost}.
 * - Resizes the connection pool to match configured concurrency.
 *
 * @returns {Promise<void>}
 * @throws {Error} If registration fails.
 */
export const register = async (): Promise<void> => {
	logger.info(`Worker ${WORKER_ID} registering...`);
	const res = await fetch(`${protocol}://${STATE.HDB_HOST}:${HDB_HTTP_PORT}/render_jobs`, {
		...BASE_CONFIG,
		headers: {
			...BASE_CONFIG.headers,
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			op: 'register-worker',
		}),
	});

	await res.bytes();
	if (res.status && res.status != 204) {
		throw new Error(`Failed to register worker ${WORKER_ID}: ${res.status} - ${res.statusText}`);
	} else {
		logger.info(`Worker ${WORKER_ID} registered successfully.`);
	}
};

/**
 * Send job results back to Harper.
 *
 * - Compresses job content with gzip if present.
 * - Attaches job metadata (render time, redirects, upstream headers).
 * - Posts to `/render_jobs/result`.
 *
 * @param {RenderJob} job - Job object containing metadata, content, and response details.
 * @returns {Promise<void>}
 * @throws {Error} If the server responds with a non-204 status code.
 */
export const sendJobResult = async (job: RenderJob): Promise<void> => {
	logger.info(`Worker ${WORKER_ID} sending job ${job.id} result...`);
	const headers: Record<string, string> = {
		...BASE_CONFIG.headers,
		'x-worker-id': WORKER_ID!,
		'x-job-id': job.id,
	};

	if (job.redirectTo && job.redirectStatus) {
		headers['x-redirect-to'] = job.redirectTo;
		headers['x-redirect-status'] = job.redirectStatus.toString();
	}

	if (job.latestAttempt?.renderEndTime) {
		headers['x-render-time'] = (job.latestAttempt.renderEndTime - job.latestAttempt.renderStartTime).toString();
	}

	if (job.httpResponse) {
		Object.entries(job.httpResponse.headers).forEach(([key, val]) => {
			if (key === 'link') return; // skip link headers to avoid conflicts
			if (!val || val.length === 0 || val === '' || typeof val !== 'string') return;

			headers[`x-origin-header-${key.toLowerCase()}`] = val;
		});
		headers['x-origin-status'] = job.httpResponse.statusCode.toString();
	}

	let body = undefined;

	if (job.content) {
		const compressed = await pGzip(job.content, { level: 6 });
		body = compressed;
		headers['content-type'] = 'text/html; charset=utf-8';
		headers['content-encoding'] = 'gzip';
		headers['content-length'] = compressed.length.toString();
	} else {
		logger.warn(`Job ${job.id} has no content to send.`);
		headers['content-type'] = 'application/json';
	}

	const res = await pool.request({
		...BASE_CONFIG,
		path: '/render_jobs/result',
		body,
		headers: headers,
	});

	await res.body.bytes();
	if (res.statusCode && res.statusCode != 201) {
		throw new Error(`Failed to send job result for ${job.url}: ${res.statusCode}`);
	}
};
