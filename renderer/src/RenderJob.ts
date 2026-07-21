/**
 * @module RenderJob
 *
 * Defines the {@link RenderJob} class, which represents a single rendering
 * request to be processed by a worker.
 *
 * Responsibilities:
 * - Store metadata about the job (URL, headers, priority, device type).
 * - Track multiple render attempts and their outcomes.
 * - Retain origin HTTP response metadata in a sanitized form.
 * - Support redirect handling (URL + status code).
 * - Provide convenience methods for retries, content, and error inspection.
 */

export type JobConfig = {
	/** Unique job identifier. */
	id: string;

	/** Absolute URL to render. */
	url: string;

	/** Job scheduling priority (lower = higher priority). */
	priority: number;

	/** Optional request headers to send to the origin. */
	headers?: Record<string, string>;

	/** Maximum number of retries allowed. Defaults to {@link RenderJob.MAX_ATTEMPTS}. */
	maxRetries?: number;

	/** Device type to emulate. */
	deviceType?: 'desktop' | 'mobile' | 'tablet';

	/** Optional Accept-Language header to use. */
	acceptLanguage?: string;

	/**
	 * Optional per-render overrides (object, or JSON string from the DB).
	 * Falls back to the renderer's env defaults when absent.
	 */
	renderOptions?: RenderOptions | string;
};

/** Per-render tuning, overriding the renderer's global env defaults. */
export type RenderOptions = {
	/** Puppeteer navigation wait (load | domcontentloaded | networkidle0 | networkidle2). */
	waitUntil?: string;
	/** Max ms to wait for network-idle after navigation (0 disables). */
	settleTimeoutMs?: number;
	/** Idle window (ms) that counts as "settled". */
	networkIdleMs?: number;
	/** Optional CSS selector to wait for before snapshotting. */
	waitForSelector?: string;
};

/**
 * Represents a single render attempt for a job.
 */
type RenderAttempt = {
	/** Start time of the render attempt (epoch ms). */
	renderStartTime: number;

	/** End time of the render attempt (epoch ms). */
	renderEndTime?: number;

	/** Error encountered during rendering, if any. */
	error?: Error;

	/** Captured content (HTML, etc.) from the render attempt, if successful. */
	content?: string;
};

/**
 * Represents the origin HTTP response associated with a render job.
 */
type OriginHttpResponse = {
	/** HTTP status code returned from the origin. */
	statusCode: number;

	/** Sanitized set of response headers. */
	headers: Record<string, string>;
};

/**
 * Response headers allowed to be persisted.
 * Other headers are discarded for safety and consistency.
 */
/** Parse a JSON string, returning undefined on failure (never throws). */
function safeParse(s: string): RenderOptions | undefined {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}

const allowedResponseHeaders = [
	'etag', // helps 304 Not Modified
	'last-modified', // helps 304 Not Modified
	'link', // canonical / hreflang if set via headers
	'x-robots-tag', // noindex/nofollow etc. via headers
	'retry-after', // for 503 responses
];

/**
 * Represents a rendering job to be executed by a worker.
 *
 * A `RenderJob`:
 * - Encapsulates job configuration (URL, headers, device type).
 * - Tracks attempts and their outcomes.
 * - Supports retry logic with a configurable maximum.
 * - Stores sanitized origin response headers for caching and revalidation.
 * - Handles redirect metadata when applicable.
 */
export default class RenderJob {
	/** Default maximum number of attempts if `maxRetries` not provided. */
	static MAX_ATTEMPTS = 3;

	/** Unique job id. */
	id: string;

	/** Absolute URL to render. */
	url: string;

	/** Scheduling priority. */
	priority: number;

	/** Maximum number of render attempts allowed for this job. */
	maxAttempts: number;

	/** Optional request headers to send to origin. */
	headers?: Record<string, string>;

	/** Device type to emulate (if any). */
	deviceType?: 'desktop' | 'mobile' | 'tablet';

	/** Accept-Language header value to use (if any). */
	acceptLanguage?: string;

	/** Per-render overrides (waitUntil, settle, selector), if provided. */
	renderOptions?: RenderOptions;

	/** Redirect target URL, if this job results in a redirect. */
	redirectTo?: string;

	/** Redirect status code, if applicable. */
	redirectStatus?: number;

	/** Origin HTTP response information (status + headers). */
	_httpResponse?: OriginHttpResponse;

	/** All render attempts (in order). */
	attempts: RenderAttempt[] = [];

	/** Convenience pointer to the most recent attempt. */
	latestAttempt: RenderAttempt | null = null;

	constructor(config: JobConfig) {
		this.id = config.id;
		this.url = config.url;
		this.headers = config.headers;
		this.maxAttempts = config.maxRetries || RenderJob.MAX_ATTEMPTS;
		this.priority = config.priority;
		this.deviceType = config.deviceType;
		this.acceptLanguage = config.acceptLanguage;
		// renderOptions arrives as a JSON string from the DB or an object via tests.
		if (config.renderOptions) {
			this.renderOptions =
				typeof config.renderOptions === 'string' ? safeParse(config.renderOptions) : config.renderOptions;
		}
	}

	/**
	 * Sanitize response headers to only include {@link allowedResponseHeaders}.
	 * @param {Record<string,string>} headers - Incoming headers.
	 * @returns {Record<string,string>} Sanitized headers.
	 */
	sanitizeHeaders(headers: Record<string, string>) {
		const sanitized: Record<string, string> = {};
		for (const header of allowedResponseHeaders) {
			if (headers[header]) {
				sanitized[header] = headers[header];
			}
		}
		return sanitized;
	}

	/**
	 * Set the origin HTTP response metadata for this job.
	 * Headers are sanitized before storage.
	 */
	set httpResponse(response: OriginHttpResponse) {
		const { statusCode, headers } = response;
		this._httpResponse = { statusCode, headers: this.sanitizeHeaders(headers) };
	}

	/**
	 * Get the origin HTTP response metadata.
	 */
	get httpResponse(): OriginHttpResponse | undefined {
		return this._httpResponse;
	}

	/**
	 * Record the start of a new render attempt.
	 * @returns {RenderAttempt} The newly created attempt object.
	 */
	attemptStarted() {
		this.latestAttempt = { renderStartTime: Date.now() };
		this.attempts.push(this.latestAttempt);
		return this.latestAttempt;
	}

	/**
	 * Record the end of the current render attempt.
	 * @param {Error} [error] - Error encountered, if any.
	 * @param {string} [content] - Captured content, if successful.
	 */
	attemptEnded(error?: Error, content?: string) {
		const attempt = this.latestAttempt!;
		attempt.renderEndTime = Date.now();
		attempt.error = error;
		attempt.content = content;
	}

	/**
	 * Get the content from the latest attempt, if any.
	 */
	get content(): string | null {
		return this.latestAttempt?.content || null;
	}

	/**
	 * Get the error from the latest attempt, if any.
	 */
	get error(): Error | null {
		return this.latestAttempt?.error || null;
	}

	/**
	 * Determine if this job can be retried.
	 * @returns {boolean} True if retries remain, otherwise false.
	 */
	canRetry(): boolean {
		return this.attempts.length < this.maxAttempts;
	}

	/**
	 * Set redirect metadata for this job.
	 * @param {string} to - Target redirect URL.
	 * @param {number} statusCode - HTTP status code for the redirect.
	 */
	onRedirect(to: string, statusCode: number) {
		this.redirectTo = to;
		this.redirectStatus = statusCode;
	}
}
