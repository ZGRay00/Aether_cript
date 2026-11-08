const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'Aether自动助手.user.js'), 'utf8');
function scenario({ daily = 30, tickets = 30, cost = 1, max = 5, budget = 20, after, result, fail, stop } = {}) {
    const requests = [], messages = [];
    let reads = 0;
    const ctx = {
        CONFIG: { sweepMaxTimes: Number(source.match(/sweepMaxTimes:\s*(\d+)/)[1]) }, runtime: { sweepDone: 0, ticketsUsed: 0 }, taskSettings: () => ({sweepTicketBudget: budget}), setProgress() {},
        natural: (v) => Math.max(0, Math.floor(Number(v) || 0)),
        log: (s) => messages.push(s), markIssue: (s) => messages.push(s), fmtRewards: () => '',
        checkStop: () => { if (stop && requests.length) throw Error('stopped'); }, jitter: async () => {},
        ApiError: class extends Error { constructor(m) { super(m); this.uncertain = true; } },
        api: async (url, options) => {
            if (url.startsWith('/dungeon/sweep/info')) {
                reads++;
                if (reads === 2 && after) ({ daily, tickets, max, cost } = { daily, tickets, max, cost, ...after });
                return { data: { unlocked: true, max_times: max, daily_remaining: daily, ticket_owned: tickets, ticket_cost: cost } };
            }
            assert.equal(url, '/dungeon/sweep');
            const n = options.body.times;
            assert.ok(n <= max && n <= daily && n * cost <= tickets);
            requests.push(n);
            if (fail) throw Error('uncertain write');
            daily -= n; tickets -= n * cost;
            return { data: result || { times: n, cost: {ticket_cost:n*cost} } };
        },
    };
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('    async function fetchSweepInfo('), source.indexOf('    // ---------- 5.')), ctx);
    return { ctx, requests, messages, reads: () => reads };
}
async function main() {
    let s = scenario();
    assert.equal(await s.ctx.doSweep('mine', 20), 20);
    assert.deepEqual(s.requests, [5, 5, 5, 5]); assert.equal(s.reads(), 4); assert.equal(s.ctx.runtime.sweepDone, 20);
    s = scenario({ max: 30 }); await s.ctx.doSweep('mine', 100); assert.deepEqual(s.requests, [20]);
    s = scenario({ daily: 5 }); assert.equal(await s.ctx.doSweep('mine', 20), 5); assert.deepEqual(s.requests, [5]);
    s = scenario({ tickets: 15, cost: 2 }); assert.equal(await s.ctx.doSweep('mine', 20), 7); assert.deepEqual(s.requests, [5, 2]);
    s = scenario({ cost: 0, tickets: 0 }); assert.equal(await s.ctx.doSweep('mine', 20), 20);
    s = scenario({ after: { daily: 2 } }); assert.equal(await s.ctx.doSweep('mine', 20), 7); assert.deepEqual(s.requests, [5, 2]);
    s = scenario({ result: { times: 2, cost:{ticket_cost:2}, stopped_reason: '额度变化' } }); assert.equal(await s.ctx.doSweep('mine', 20), 2); assert.deepEqual(s.requests, [5]);
    s = scenario({ result: { times: 0, cost:{ticket_cost:0} } }); assert.equal(await s.ctx.doSweep('mine', 20), 0); assert.deepEqual(s.requests, [5]);
    s = scenario({ result: { times: 6 } }); await assert.rejects(s.ctx.doSweep('mine', 20), e => e.uncertain); assert.deepEqual(s.requests, [5]);
    s = scenario({ fail: true }); await assert.rejects(s.ctx.doSweep('mine', 20), /uncertain write/); assert.deepEqual(s.requests, [5]);
    s = scenario({ stop: true }); await assert.rejects(s.ctx.doSweep('mine', 20), /stopped/); assert.deepEqual(s.requests, [5]);
    s = scenario({budget:0}); await assert.rejects(s.ctx.doSweep('mine', 5), /预算/); assert.deepEqual(s.requests, []);
    s = scenario({budget:0,cost:0}); await s.ctx.doSweep('mine', 5); assert.equal(s.ctx.runtime.ticketsUsed,0);
    s = scenario({budget:7,cost:2}); assert.equal(await s.ctx.doSweep('mine',20),3); assert.equal(s.ctx.runtime.ticketsUsed,6);
    s = scenario({budget:7}); await s.ctx.doSweep('mine',20); assert.deepEqual(s.requests,[5,2]); assert.equal(s.ctx.runtime.ticketsUsed,7);
    s = scenario({budget:999}); await s.ctx.doSweep('mine',20); assert.equal(s.ctx.runtime.ticketsUsed,20);
    s = scenario(); await s.ctx.doSweep('mine',12); await s.ctx.doSweep('mine',12); assert.equal(s.ctx.runtime.ticketsUsed,20); assert.equal(s.ctx.runtime.sweepDone,20);
    s = scenario({after:{cost:2}}); await s.ctx.doSweep('mine',20); assert.deepEqual(s.requests,[5]); assert.ok(s.messages.some(x=>x.includes('上涨')));
    for (const spent of [undefined,-1,1.5,10,'5']) {
        s = scenario({result:{times:5,cost:{ticket_cost:spent}}});
        await assert.rejects(s.ctx.doSweep('mine',20),e=>e.uncertain); assert.deepEqual(s.requests,[5]); assert.equal(s.ctx.runtime.ticketsUsed,0);
    }
    s = scenario({budget:NaN}); await assert.rejects(s.ctx.doSweep('mine',5),/预算/); assert.deepEqual(s.requests,[]);
    console.log('PASS 24 sweep batching and ticket-budget scenarios');

}
main().catch(e => { console.error(e); process.exitCode = 1; });
