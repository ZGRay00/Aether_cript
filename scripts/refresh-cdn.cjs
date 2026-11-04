// Purge only this repository's mutable release URL, then verify every active source.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const releasePath = '/gh/ZGRay00/Aether_cript@main/aether-auto-helper.user.js';
const sha256 = body => createHash('sha256').update(body).digest('hex');
function sourceUrls(source) {
    const block = source.match(/const UPDATE_SOURCES = \[([\s\S]*?)\];/)?.[1];
    const urls = [...(block || '').matchAll(/url: '([^']+)'/g)].map(m => m[1]);
    if (!urls.length) throw new Error('No update sources found');
    const allowed = new Set(['cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'raw.githubusercontent.com']);
    for (const value of urls) {
        const url = new URL(value);
        const expected = url.hostname === 'raw.githubusercontent.com'
            ? '/ZGRay00/Aether_cript/main/aether-auto-helper.user.js' : releasePath;
        if (url.protocol !== 'https:' || !allowed.has(url.hostname) || url.pathname !== expected || url.search) {
            throw new Error(`Unexpected update source: ${value}`);
        }
    }
    return urls;
}
async function read(url, options = {}, request = fetch) {
    const response = await request(url, { ...options, signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return Buffer.from(await response.arrayBuffer());
}
function validatePurge(result) {
    const entry = result.paths?.[releasePath];
    if (result.status !== 'finished' || !entry || entry.throttled || !entry.providers ||
        !Object.keys(entry.providers).length || Object.values(entry.providers).some(ok => ok !== true)) {
        throw new Error(`Purge incomplete, throttled or provider failed: ${JSON.stringify(result)}`);
    }
}
async function purge(request = fetch) {
    // The official endpoint covers the canonical hostname. The Fastly alias kept
    // its old cache after that purge, so invalidate its exact URL as well.
    const actions = [
        async () => validatePurge(JSON.parse(await read(`https://purge.jsdelivr.net${releasePath}`, {}, request))),
        async () => {
            const result = JSON.parse(await read(`https://fastly.jsdelivr.net${releasePath}`, { method: 'PURGE' }, request));
            if (result.status !== 'ok') throw new Error(`Fastly purge failed: ${JSON.stringify(result)}`);
        },
    ];
    const results = await Promise.allSettled(actions.map(action => action()));
    for (const [i, result] of results.entries()) {
        console.log(`${i ? 'Fastly' : 'jsDelivr'} purge: ${result.status === 'fulfilled' ? 'accepted' : result.reason.message}`);
    }
    // A purge acknowledgement is not proof of freshness. Always verify content.
}
async function verify(urls, expected, request = fetch) {
    const results = await Promise.allSettled(urls.map(async url => {
        // Check both the normal install URL and the updater's query form.
        for (const suffix of ['', `?_aether_check=${Date.now()}`]) {
            const body = await read(url + suffix, { cache: 'no-store' }, request);
            const actual = sha256(body);
            if (actual !== expected) {
                const version = body.toString('utf8').match(/^\/\/\s*@version\s+(\S+)/m)?.[1] || 'unknown';
                throw new Error(`${url}${suffix}: stale/different content (v${version}, SHA-256 ${actual})`);
            }
        }
        return url;
    }));
    for (const [i, result] of results.entries()) {
        console.log(result.status === 'fulfilled' ? `Verified ${urls[i]}` : result.reason.message);
    }
    return results.every(result => result.status === 'fulfilled');
}
async function main() {
    const body = fs.readFileSync(path.join(__dirname, '../aether-auto-helper.user.js'));
    const urls = sourceUrls(body.toString('utf8')), expected = sha256(body);
    console.log(`Expected SHA-256: ${expected}`);
    if (process.argv.includes('--check')) {
        if (!await verify(urls, expected)) throw new Error('At least one update source is stale or unavailable');
        return;
    }
    for (let attempt = 1; attempt <= 9; attempt++) {
        console.log(`Refresh attempt ${attempt}/9`);
        await purge();
        await delay(10000);
        if (await verify(urls, expected)) {
            console.log('All configured sources match the release at this probe location.');
            return;
        }
        if (attempt < 9) await delay(300000); // Respect purge limits; no tight retries.
    }
    throw new Error('Update sources did not converge within the refresh window');
}
module.exports = { sourceUrls, sha256, validatePurge, purge, verify, releasePath };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
