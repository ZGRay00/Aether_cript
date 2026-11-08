// Purge only this repository's mutable release URL, then verify every active source.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
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
function immutableUrls(urls, commit) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release commit');
    return urls.map(url => url.replace('@main/', `@${commit}/`).replace('/main/', `/${commit}/`));
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
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
    const pinned = immutableUrls(urls, commit);
    let immutableReady = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`Verify immutable release ${commit}, attempt ${attempt}/3`);
        immutableReady = await verify(pinned, expected);
        if (immutableReady) break;
        if (attempt < 3) await delay(10000);
    }
    if (!immutableReady) throw new Error('At least one immutable update source failed byte verification');
    // Purge at most once per release. Repeating a throttled purge cannot force edge convergence.
    await purge();
    await delay(10000);
    const mutableReady = await verify(urls, expected);
    if (!mutableReady) console.warn('::warning::Branch CDN aliases are stale or unavailable; all immutable update sources are verified. The latest-commit updater bypasses branch caches.');
    const summary = `## Update channel verification\n\nRelease commit: ${commit}\n\n- Immutable CDN / Fastly / Raw: full SHA-256 verified (normal and updater URLs).\n- Branch aliases: ${mutableReady ? 'all verified' : 'stale or unavailable; see per-source logs. Purge acceptance does not prove freshness'}.\n- These results apply to this probe location, not every CDN edge.\n\n[Install this release](${pinned[0]})\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
module.exports = { sourceUrls, immutableUrls, sha256, validatePurge, purge, verify, releasePath };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
