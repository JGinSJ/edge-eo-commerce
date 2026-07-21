import assert from 'node:assert';
import { cpus } from 'node:os';
import { PuppeteerLifeCycleEvent } from 'puppeteer';
import logger from './Logger.js';
import { ErrorHandler } from './ErrorHandler.js';
import dotenv from 'dotenv';

dotenv.config();

new ErrorHandler();

type Deserializer<T> = (str: string | undefined, defaultVal: T) => T;

const pBool: Deserializer<boolean> = (s, defaultVal) => (s ? s.toLowerCase() === 'true' : defaultVal);
const pCsv: Deserializer<string[]> = (s, defaultVal) => (s ? s.split(',') : defaultVal);
const pInt: Deserializer<number> = (s, defaultVal) => (s ? parseInt(s, 10) : defaultVal);

const { HDB_HOST, HDB_MQTT_PORT, HDB_USER, HDB_PASS, HDB_HTTP_PORT, WORKER_ID } = process.env;
if (!HDB_HOST || !HDB_MQTT_PORT || !HDB_USER || !HDB_PASS || !HDB_HTTP_PORT || !WORKER_ID) {
	logger.error('Missing required environment variables');
}

assert(HDB_HOST);
assert(WORKER_ID);
assert(HDB_USER);

export const STATE = {
	HDB_HOST,
};
export const setHdbHost = (host: string) => (STATE.HDB_HOST = host);

const DEFAULT_CHROME_ARGS = [
	'--no-sandbox', // only if your threat model allows
	'--disable-setuid-sandbox',
	'--disable-renderer-backgrounding',
	'--disable-background-timer-throttling',
	'--disable-features=BackForwardCache', // workloads that navigate a lot
	'--disable-gpu',
	'--disable-software-rasterizer',
	'--disk-cache-dir=/profiles/chrome/main/Cache',
	'--disk-cache-size=1073741824',
	'--media-cache-size=268435456',
	'--renderer-process-limit=64',
	'--no-first-run',
	'--no-default-browser-check',
	'--js-flags=--max-old-space-size=768',
];

const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

export const USER_AGENT = process.env.USER_AGENT || DEFAULT_USER_AGENT;

export const CONCURRENCY = pInt(process.env.CONCURRENCY, Math.max(cpus().length - 5, 2));
export const JOB_BUFFER_SIZE = pInt(process.env.JOB_BUFFER_SIZE, CONCURRENCY * 10);
export const CHROME_ARGS = pCsv(process.env.CHROME_ARGS, DEFAULT_CHROME_ARGS);
export const WAIT_FOR_EVENT: PuppeteerLifeCycleEvent =
	(process.env.WAIT_FOR_EVENT as PuppeteerLifeCycleEvent) || 'domcontentloaded';
export const INCOGNITO_PAGES = pBool(process.env.INCOGNITO_PAGES, true);

// Post-navigation settle for client-rendered SPAs: after WAIT_FOR_EVENT fires,
// wait for the network to be idle for NETWORK_IDLE_MS, capped at SETTLE_TIMEOUT_MS
// (0 disables). Lets hydrating apps paint without failing renders on pages that
// never go quiet. Pair with WAIT_FOR_EVENT=domcontentloaded for fastest results.
export const SETTLE_TIMEOUT_MS = pInt(process.env.SETTLE_TIMEOUT_MS, 12000);
export const NETWORK_IDLE_MS = pInt(process.env.NETWORK_IDLE_MS, 600);

export const GOTO_TIMEOUT = {
	domcontentloaded: 30000,
	load: 45000,
	networkidle2: 60000,
	networkidle0: 90000,
};

logger.info({
	event: 'init',
	HDB_HOST,
	HDB_MQTT_PORT,
	HDB_USER,
	HDB_PASS,
	HDB_HTTP_PORT,
	WORKER_ID,
	USER_AGENT,
	CONCURRENCY,
	JOB_BUFFER_SIZE,
	CHROME_ARGS,
	WAIT_FOR_EVENT,
	INCOGNITO_PAGES,
});

export { HDB_HOST, HDB_MQTT_PORT, HDB_USER, HDB_PASS, HDB_HTTP_PORT, WORKER_ID };
