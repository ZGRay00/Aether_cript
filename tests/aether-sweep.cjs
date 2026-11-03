const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'Aether自动助手.user.js'), 'utf8');
function scenario({ daily = 30, tickets = 30, cost = 1, max = 5, after, result, fail, stop } = {}) {
    const requests = [], messages = [];
    let reads = 0;
    const ctx = {
        CONFIG: { sweepMaxTimes: 16 }, runtime: { sweepDone: 0 },
        natural: (v) => Math.max(0, Math.floor(Number(v) || 0)),
        log: (s) => messages.push(s), markIssue: (s) => messages.push(s), fmtRewards: () => '',
        checkStop: () => { if (stop && requests.length) throw Error('stopped'); }, jitter: async () => {},
        ApiError: class extends Error { constructor(m) { super(m); this.uncertain = true; } },
        api: async (url, options) => {
            if (url.startsWith('/dungeon/sweep/info')) {
                reads++;
                if (reads === 2 && after) ({ daily, tickets, max } = { daily, tickets, max, ...after });
                return { data: { unlocked: true, max_times: max, daily_remaining: daily, ticket_owned: tickets, ticket_cost: cost } };
            }
            assert.equal(url, '/dungeon/sweep');
            const n = options.body.times;
            assert.ok(n <= max && n <= daily && n * cost <= tickets);
            requests.push(n);
            if (fail) throw Error('uncertain write');
            daily -= n; tickets -= n * cost;
            return { data: result || { times: n } };
        },
    };
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('    async function fetchSweepInfo('), source.indexOf('    // ---------- 5.')), ctx);
    return { ctx, requests, messages, reads: () => reads };
}
async function main() {
    let s = scenario();
    assert.equal(await s.ctx.doSweep('mine', 16), 16);
    assert.deepEqual(s.requests, [5, 5, 5, 1]); assert.equal(s.reads(), 4); assert.equal(s.ctx.runtime.sweepDone, 16);
    s = scenario({ max: 30 }); await s.ctx.doSweep('mine', 100); assert.deepEqual(s.requests, [16]);
    s = scenario({ daily: 5 }); assert.equal(await s.ctx.doSweep('mine', 16), 5); assert.deepEqual(s.requests, [5]);
    s = scenario({ tickets: 15, cost: 2 }); assert.equal(await s.ctx.doSweep('mine', 16), 7); assert.deepEqual(s.requests, [5, 2]);
    s = scenario({ cost: 0, tickets: 0 }); assert.equal(await s.ctx.doSweep('mine', 16), 16);
    s = scenario({ after: { daily: 2 } }); assert.equal(await s.ctx.doSweep('mine', 16), 7); assert.deepEqual(s.requests, [5, 2]);
    s = scenario({ result: { times: 2, stopped_reason: '额度变化' } }); assert.equal(await s.ctx.doSweep('mine', 16), 2); assert.deepEqual(s.requests, [5]);
    s = scenario({ result: { times: 0 } }); assert.equal(await s.ctx.doSweep('mine', 16), 0); assert.deepEqual(s.requests, [5]);
    s = scenario({ result: { times: 6 } }); await assert.rejects(s.ctx.doSweep('mine', 16), e => e.uncertain); assert.deepEqual(s.requests, [5]);
    s = scenario({ fail: true }); await assert.rejects(s.ctx.doSweep('mine', 16), /uncertain write/); assert.deepEqual(s.requests, [5]);
    s = scenario({ stop: true }); await assert.rejects(s.ctx.doSweep('mine', 16), /stopped/); assert.deepEqual(s.requests, [5]);
    console.log('PASS 11 sweep batching scenarios');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
