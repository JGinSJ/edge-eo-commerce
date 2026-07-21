#!/usr/bin/env node
'use strict';

/**
 * Harper unified prerender — bulk cache pre-population script.
 *
 * Submits URLs (or a sitemap) to the component's Sitemap resource so the
 * renderer prerenders them with headless Chrome. Each render caches BOTH the
 * full HTML and the Markdown derived from it, keyed per device type.
 *
 * Endpoint: POST {HARPER_OPS_URL}/sitemaps  (Basic auth — HarperDB admin)
 * Body (see harper-prerender/src/resources/Sitemap.js → post):
 *   { sitemapURL, refreshInterval, isSitemap, urlList, deviceTypes }
 *
 * Usage:
 *   # Sitemap mode
 *   HARPER_OPS_URL=https://... HARPER_ADMIN_USER=... HARPER_ADMIN_PASS=... \
 *     node scripts/harper-bulk-upload.js --sitemap https://example.com/sitemap.xml
 *
 *   # URL list mode
 *   HARPER_OPS_URL=https://... HARPER_ADMIN_USER=... HARPER_ADMIN_PASS=... \
 *     node scripts/harper-bulk-upload.js --urls https://example.com/a https://example.com/b
 *
 * Optional flags:
 *   --refresh-interval <ms>   Page refresh cadence (default: 864000000 = 10 days)
 *   --device-types <list>     Comma-separated device types (default: desktop,mobile)
 *   --dry-run                 Print the request body without sending
 *
 * HARPER_OPS_URL    — Harper node URL (HTTP app port, e.g. https://host:9926) for /sitemaps
 * HARPER_ADMIN_USER — HarperDB username (Basic auth)
 * HARPER_ADMIN_PASS — HarperDB password (Basic auth)
 */

import https from 'https';
import http from 'http';

const HARPER_OPS_URL = process.env.HARPER_OPS_URL;
const HARPER_ADMIN_USER = process.env.HARPER_ADMIN_USER;
const HARPER_ADMIN_PASS = process.env.HARPER_ADMIN_PASS;

if (!HARPER_OPS_URL || !HARPER_ADMIN_USER || !HARPER_ADMIN_PASS) {
	console.error('Error: HARPER_OPS_URL, HARPER_ADMIN_USER, and HARPER_ADMIN_PASS environment variables are required.');
	process.exit(1);
}

const args = process.argv.slice(2);
const flagIndex = (name) => args.indexOf(name);
const flagValue = (name) => { const i = flagIndex(name); return i >= 0 ? args[i + 1] : null; };
const flagPresent = (name) => flagIndex(name) >= 0;

const sitemapUrl = flagValue('--sitemap');
const dryRun = flagPresent('--dry-run');
const refreshInterval = parseInt(flagValue('--refresh-interval') ?? '864000000', 10);
const deviceTypes = (flagValue('--device-types') ?? 'desktop,mobile').split(',').map((s) => s.trim()).filter(Boolean);

const urlsFlag = flagIndex('--urls');
const urlList = urlsFlag >= 0 ? args.slice(urlsFlag + 1).filter((a) => !a.startsWith('--')) : [];

if (!sitemapUrl && urlList.length === 0) {
	console.error('Error: provide --sitemap <url> or --urls <url> [<url> ...]');
	process.exit(1);
}

// Build request body matching Sitemap.post()
let body;
if (sitemapUrl) {
	body = { sitemapURL: sitemapUrl, refreshInterval, isSitemap: true, deviceTypes };
} else {
	// URL-list mode: sitemapURL is used purely as a grouping key for these pages.
	body = { sitemapURL: 'urllist:' + urlList[0], refreshInterval, isSitemap: false, urlList, deviceTypes };
}

const bodyJson = JSON.stringify(body, null, 2);
const endpoint = '/sitemaps';
const parsed = new URL(HARPER_OPS_URL);

if (dryRun) {
	console.log('Dry run — would POST to:', HARPER_OPS_URL + endpoint);
	console.log('Body:', bodyJson);
	process.exit(0);
}

const options = {
	hostname: parsed.hostname,
	port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
	path: endpoint,
	method: 'POST',
	headers: {
		'Authorization': 'Basic ' + Buffer.from(HARPER_ADMIN_USER + ':' + HARPER_ADMIN_PASS).toString('base64'),
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(bodyJson),
	},
};

const transport = parsed.protocol === 'https:' ? https : http;

console.log('POSTing to', HARPER_OPS_URL + endpoint);
console.log('Mode:', sitemapUrl ? 'sitemap' : 'url-list');
console.log('Device types:', deviceTypes.join(', '));
console.log('Refresh interval:', refreshInterval, 'ms');
if (sitemapUrl) console.log('Sitemap:', sitemapUrl);
else console.log('URLs:', urlList.length);

const req = transport.request(options, (res) => {
	let data = '';
	res.on('data', (chunk) => { data += chunk; });
	res.on('end', () => {
		const status = res.statusCode;
		if (status >= 200 && status < 300) {
			console.log(`${status} — submitted.`, data || '');
		} else if (status === 400) {
			console.error('400 — invalid or missing parameters.');
			console.error('Response:', data);
			process.exit(1);
		} else {
			console.error(`${status} — unexpected response.`);
			console.error('Response:', data);
			process.exit(1);
		}
	});
});

req.on('error', (err) => {
	console.error('Network error:', err.message);
	process.exit(1);
});

req.write(bodyJson);
req.end();
