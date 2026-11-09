const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Offline regression suite: reuse the existing VM setup in memory, without
// modifying its source, connecting a browser, or issuing game requests.
let harnessSource = fs.readFileSync(path.join(__dirname, 'aether-audit-regressions.cjs'), 'utf8').split('let count = 0;')[0];
function replaceOnce(before, after) {
    assert.ok(harnessSource.includes(before), `Harness marker missing: ${before}`);
    harnessSource = harnessSource.replace(before, after);
}
replaceOnce("dungeonPreset: () => null, fmtRewards: () => '',", `dungeonPreset: () => null, fmtRewards: () => '',
        setupBattleLineup: async () => fixture.setupState || { status: 'prepared', can_start: true },
        waitBattleResult: async () => { fixture.waits = (fixture.waits || 0) + 1; return { winner: 'allies' }; },
        dungeonPolicy: () => ({}),
        waitDungeonBattleReady: async () => { fixture.waits = (fixture.waits || 0) + 1; return { battle_status: { status: 'completed' } }; },`);
replaceOnce("        section('    async function doMail(',", `        section('    async function recoverWriteState(', '    // ---------- 3. 活动领奖'),
        section('    async function dungeonBattle(', '    // ---------- 望雪台'),
        section('    async function doMail(',`);
replaceOnce('api, doDailyAll, doSweep,', 'api, doDailyAll, doSweep, executeBattle, completeDaily, dungeonBattle,');
replaceOnce('return { h: context.h, stored, requests, messages, steps, fixture };',
    'return { h: context.h, stored, requests, messages, steps, fixture, context };');
const harness = new Function('require', '__dirname', `${harnessSource}\nreturn harness;`)(require, __dirname);

const paths = {
    battle: { write: '/battle/B/start', read: '/battle/B' },
    daily: { write: '/daily/daily/complete', read: '/daily' },
    dungeon: { write: '/dungeon/node/battle/start', read: '/dungeon/node' },
};
function invoke(h, kind) {
    if (kind === 'battle') return h.executeBattle('B', 'Offline battle');
    if (kind === 'daily') return h.completeDaily('daily');
    return h.dungeonBattle({ dungeon_battle_id: 'B', node_type: 'battle' });
}
function recoveryState(kind, status) {
    if (kind === 'daily') return { battles: [{ battle_id: 'daily', status }] };
    if (kind === 'dungeon') return { dungeon_battle_id: 'B', battle_status: { status } };
    return { status };
}
function scenario(kind, options = {}) {
    const f = harness();
    f.ctx = f.h.context();
    const target = paths[kind];
    f.fixture.response = request => {
        if (request.path === target.write) {
            if (options.stopWrite) f.ctx.controller.abort(f.ctx.stopError);
            return options.write || { http: 500, code: 500, message: 'WRITE_RESULT_UNKNOWN' };
        }
        if (request.path === target.read) {
            if (options.stopRead) f.ctx.controller.abort(f.ctx.stopError);
            return options.read || { http: 500, code: 500, message: 'RECOVERY_READ_FAILED' };
        }
        if (request.path === '/dungeon/node/battle/complete') {
            return { code: 0, data: { status: 'completed', completion_reason: 'safe_exit' } };
        }
        throw new Error(`Unexpected offline request: ${request.method} ${request.path}`);
    };
    return f;
}
const writes = f => f.requests.filter(request => request.method !== 'GET');

for (const kind of Object.keys(paths)) {
    test(`${kind}: failed recovery preserves the original uncertain write after all GET retries`, async () => {
        const f = scenario(kind);
        await assert.rejects(invoke(f.h, kind), error => error.uncertain === true &&
            error.path === paths[kind].write && error.message === 'WRITE_RESULT_UNKNOWN');
        assert.equal(writes(f).length, 1);
        assert.equal(f.requests.filter(request => request.path === paths[kind].read).length, 3);
    });
    test(`${kind}: successful GET without confirmation preserves uncertainty and never retries the write`, async () => {
        const f = scenario(kind, { read: { code: 0, data: recoveryState(kind, 'prepared') } });
        await assert.rejects(invoke(f.h, kind), error => error.uncertain === true && error.path === paths[kind].write);
        assert.equal(writes(f).length, 1);
        assert.equal(f.requests.length, 2);
    });
    test(`${kind}: missing recovery data cannot authorize subsequent actions`, async () => {
        const f = scenario(kind, { read: { code: 0, data: null } });
        await assert.rejects(invoke(f.h, kind), error => error.uncertain === true && error.path === paths[kind].write);
        assert.equal(writes(f).length, 1);
    });
    for (const status of [401, 403]) {
        test(`${kind}: recovery HTTP ${status} takes priority over the uncertain write`, async () => {
            const f = scenario(kind, { read: { http: status, code: status, message: 'AUTH_FAILED' } });
            await assert.rejects(invoke(f.h, kind), error => error.status === status && error.fatal === true &&
                error.path === paths[kind].read);
            assert.equal(f.requests.length, 2);
            assert.equal(writes(f).length, 1);
        });
        test(`${kind}: initial HTTP ${status} does not attempt recovery`, async () => {
            const f = scenario(kind, { write: { http: status, code: status, message: 'AUTH_FAILED' } });
            await assert.rejects(invoke(f.h, kind), error => error.status === status && error.fatal === true);
            assert.equal(f.requests.length, 1);
        });
    }
    test(`${kind}: stopping during recovery keeps the original StopError`, async () => {
        const f = scenario(kind, { stopRead: true });
        await assert.rejects(invoke(f.h, kind), error => error === f.ctx.stopError && error.stopped === true);
        assert.equal(f.requests.length, 2);
        assert.equal(writes(f).length, 1);
    });
    test(`${kind}: stopping the write never begins recovery`, async () => {
        const f = scenario(kind, { stopWrite: true });
        await assert.rejects(invoke(f.h, kind), error => error === f.ctx.stopError && error.stopped === true);
        assert.equal(f.requests.length, 1);
    });
    test(`${kind}: a confirmed business rejection remains an ordinary error`, async () => {
        const f = scenario(kind, {
            write: { code: 7, message: 'BUSINESS_REJECTED' },
            read: { code: 0, data: recoveryState(kind, 'prepared') },
        });
        await assert.rejects(invoke(f.h, kind), error => !error.uncertain && !error.fatal && !error.stopped);
        assert.equal(writes(f).length, 1);
    });
}

for (const status of ['ongoing', 'completed']) {
    test(`battle: confirmed ${status} recovery continues without a second start`, async () => {
        const f = scenario('battle', { read: { code: 0, data: recoveryState('battle', status) } });
        assert.equal((await invoke(f.h, 'battle')).winner, 'allies');
        assert.equal(f.fixture.waits, 1);
        assert.deepEqual(writes(f).map(request => request.path), ['/battle/B/start']);
    });
    test(`dungeon: confirmed ${status} recovery can settle the node`, async () => {
        const f = scenario('dungeon', { read: { code: 0, data: recoveryState('dungeon', status) } });
        assert.equal((await invoke(f.h, 'dungeon')).status, 'completed');
        assert.equal(f.fixture.waits || 0, status === 'ongoing' ? 1 : 0);
        assert.deepEqual(writes(f).map(request => request.path), ['/dungeon/node/battle/start', '/dungeon/node/battle/complete']);
    });
}
for (const status of ['completed', 'failed']) {
    test(`daily: confirmed ${status} completion does not submit again`, async () => {
        const f = scenario('daily', { read: { code: 0, data: recoveryState('daily', status) } });
        assert.equal((await invoke(f.h, 'daily')).data.status, status);
        assert.deepEqual(writes(f).map(request => request.path), ['/daily/daily/complete']);
    });
}

function dailyChain(kind) {
    const f = harness();
    f.h.context();
    if (kind === 'daily') f.fixture.setupState = { result: { winner: 'allies' } };
    let dailyReads = 0;
    f.fixture.response = request => {
        if (request.path === '/account') return { code: 0, data: { characters: [{ username: 'role-a' }, { username: 'role-b' }] } };
        if (request.path === '/status') return { code: 0, data: { username: request.character } };
        if (request.path === '/mail') return { code: 0, data: { mails: [] } };
        if (request.path === '/daily' && ++dailyReads === 1) return { code: 0, data: { battles: [
            { battle_id: 'daily', battle_entry_id: 'B', status: 'pending', name: 'Offline challenge' },
        ] } };
        if ([paths[kind].write, paths[kind].read].includes(request.path)) {
            return { http: 500, code: 500, message: request.method === 'GET' ? 'READ_FAILED' : 'WRITE_RESULT_UNKNOWN' };
        }
        if (request.path === '/audit/shop') return { code: 0, data: { purchased: true } };
        throw new Error(`Unexpected offline request: ${request.method} ${request.path}`);
    };
    f.context.doDailyShop = async () => f.h.api('/audit/shop', { method: 'POST' });
    return f;
}
for (const kind of ['battle', 'daily']) {
    test(`${kind}: daily chain stops before events, shop and donation when recovery is unavailable`, async () => {
        const f = dailyChain(kind);
        await assert.rejects(f.h.doDailyAll('', 1, false), error => error.uncertain === true);
        assert.deepEqual(f.steps, []);
        assert.deepEqual(writes(f).map(request => request.path), [paths[kind].write]);
    });
    test(`${kind}: character batch leaves later roles pending and never spends after unresolved write`, async () => {
        const f = dailyChain(kind);
        f.h.characterBatch.characters = [{ username: 'role-a' }, { username: 'role-b' }];
        f.h.characterBatch.selected = new Set(['role-a', 'role-b']);
        await assert.rejects(f.h.executeCharacterBatch(), error => error.uncertain === true);
        assert.deepEqual(Array.from(f.h.characterBatch.results, result => result.outcome), ['error', 'pending']);
        assert.deepEqual(writes(f).map(request => request.path), [paths[kind].write]);
        assert.ok(!f.requests.some(request => request.character === 'role-b'));
    });
}
test('dungeon: character batch stops on unresolved start rather than proceeding to the next role', async () => {
    const f = scenario('dungeon');
    const response = f.fixture.response;
    f.fixture.response = request => {
        if (request.path === '/account') return { code: 0, data: { characters: [{ username: 'role-a' }, { username: 'role-b' }] } };
        if (request.path === '/status') return { code: 0, data: { username: request.character } };
        return response(request);
    };
    for (const role of ['role-a', 'role-b']) f.stored.set(`aether-helper-v2:${role}`, JSON.stringify({ dungeonPreset: 'mine', runs: 1 }));
    f.h.characterBatch.characters = [{ username: 'role-a' }, { username: 'role-b' }];
    f.h.characterBatch.selected = new Set(['role-a', 'role-b']);
    f.h.characterBatch.daily = false;
    f.h.characterBatch.dungeon = true;
    f.context.doDungeonRun = async () => invoke(f.h, 'dungeon');
    await assert.rejects(f.h.executeCharacterBatch(), error => error.uncertain === true);
    assert.deepEqual(Array.from(f.h.characterBatch.results, result => result.outcome), ['error', 'pending']);
    assert.deepEqual(writes(f).map(request => request.path), ['/dungeon/node/battle/start']);
    assert.ok(!f.requests.some(request => request.character === 'role-b'));
});
