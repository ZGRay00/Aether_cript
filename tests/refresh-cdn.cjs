const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceUrls, sha256, validatePurge, purge, verify, releasePath } = require('../scripts/refresh-cdn.cjs');
const urls = sourceUrls(fs.readFileSync(path.join(__dirname, '../aether-auto-helper.user.js'), 'utf8'));
const response = body => new Response(body);
const valid = () => ({ status: 'finished', paths: { [releasePath]: { throttled: false, providers: { CF: true, FY: true } } } });

test('all active sources, including Raw, are checked; retired mirror is rejected', () => {
    assert.equal(urls.length, 3);
    assert.ok(urls.some(url => url.includes('fastly.')));
    assert.ok(urls.some(url => url.includes('raw.githubusercontent.com')));
    assert.throws(() => sourceUrls("const UPDATE_SOURCES = [{url: 'https://gcore.jsdelivr.net" + releasePath + "'}];"));
    assert.throws(() => sourceUrls('missing'));
});
test('HTTP success cannot hide throttling, unfinished purge or failed providers', () => {
    assert.doesNotThrow(() => validatePurge(valid()));
    for (const change of [r => r.status = 'pending', r => r.paths[releasePath].throttled = true,
        r => r.paths[releasePath].providers.FY = false, r => r.paths[releasePath].providers = {}, r => r.paths = {}]) {
        const result = valid(); change(result); assert.throws(() => validatePurge(result));
    }
});
test('canonical purge failure still attempts the Fastly alias purge', async () => {
    const calls = [];
    await purge(async (url, options) => {
        calls.push([url, options.method]);
        if (url.includes('purge.jsdelivr')) throw new Error('offline');
        return response('{"status":"ok"}');
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.find(([url]) => url.includes('fastly.')), [`https://fastly.jsdelivr.net${releasePath}`, 'PURGE']);
});
test('all sources must match full bytes, even if their version metadata matches', async () => {
    const body = '// @version 2.4.2\nnew content', expected = sha256(body);
    assert.equal(await verify(urls, expected, async () => response(body)), true);
    assert.equal(await verify(urls, expected, async url => response(url.includes('fastly.') ? '// @version 2.4.2\nold content' : body)), false);
});
test('both bare and query URLs are verified; network and HTTP failures fail the check', async () => {
    const calls = [], body = 'release', expected = sha256(body);
    assert.equal(await verify(urls, expected, async url => { calls.push(url); return response(body); }), true);
    assert.equal(calls.length, urls.length * 2);
    for (const url of urls) assert.ok(calls.includes(url) && calls.some(call => call.startsWith(url + '?_aether_check=')));
    assert.equal(await verify(urls, expected, async url => response(url.includes('?') ? 'stale' : body)), false);
    assert.equal(await verify(urls, expected, async () => new Response('error', { status: 503 })), false);
    assert.equal(await verify(urls, expected, async () => { throw new Error('offline'); }), false);
});
