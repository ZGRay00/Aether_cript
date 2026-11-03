const assert = require('node:assert/strict');
const { prepare, connect } = require('./aether-v2-ui.cjs');

async function main() {
    prepare();
    const c = await connect();
    let count = 0;
    async function test(name, code) {
        await c.reset();
        await c.evaluate(`
            window.battleTest = { clock: Date.now(), elapsed: 0, remaining: 900, writes: 0, waits: 0, completed: false, after: null };
            Date.now = () => battleTest.clock;
            h.setDeps({
                wait: async seconds => {
                    battleTest.clock += seconds * 1000;
                    battleTest.elapsed += seconds;
                    battleTest.waits++;
                    if (battleTest.after) battleTest.after();
                },
                api: async (path, options = {}) => {
                    if (path.endsWith('/accelerate')) {
                        if (options.method !== 'POST') throw Error('Expected POST');
                        battleTest.writes++;
                        if (battleTest.failure) throw battleTest.failure;
                        battleTest.remaining = 0;
                        if (!battleTest.delayed) battleTest.completed = true;
                        return { code: 0 };
                    }
                    if (path === '/dungeon/node') return { data: { completed: false,
                        battle_status: { status: battleTest.completed ? 'completed' : 'ongoing', remaining_seconds: battleTest.remaining } } };
                    if (path.endsWith('/complete')) { battleTest.settled = true; return { data: { status: 'exploring' } }; }
                    throw Error('Unexpected path ' + path);
                }
            });
        `);
        assert.equal(await c.evaluate(`(async()=>{${code}})()`), true, name);
        console.log('PASS', name); count++;
    }
    try {
        await test('长战斗默认自动加速并继续节点结算', `
            await h.runTask('long battle', () => h.dungeonBattle({node_type:'battle',battle_status:{status:'ongoing',remaining_seconds:900}}));
            return h.runtime.outcome==='success' && battleTest.writes===1 && battleTest.settled && h.runtime.accelUsed===1;
        `);
        await test('常规预算为零及耗尽时仍触发超时加速', `
            h.setSetting('accelBudget',0);
            await h.runTask('budget', async()=>{h.ctx.accelUsed=3;await h.waitDungeonBattleReady('budget');battleTest.used=h.ctx.accelUsed});
            return h.runtime.outcome==='success' && battleTest.writes===1 && battleTest.used===4;
        `);
        await test('恰好600秒倒计时不提前用券', `
            battleTest.remaining=600; battleTest.after=()=>{battleTest.completed=true};
            await h.runTask('boundary',()=>h.waitDungeonBattleReady('boundary'));
            return h.runtime.outcome==='success' && battleTest.writes===0;
        `);
        await test('实际等待到600秒先加速并重置结算计时', `
            battleTest.remaining=0; battleTest.delayed=true;
            battleTest.after=()=>{if(battleTest.writes && battleTest.elapsed>=604)battleTest.completed=true};
            await h.runTask('elapsed',()=>h.waitDungeonBattleReady('elapsed'));
            return h.runtime.outcome==='success' && battleTest.writes===1 && battleTest.elapsed===604;
        `);
        await test('常规阈值仍按配置触发且每场只尝试一次', `
            h.setSetting('accelThreshold',50);battleTest.remaining=100; battleTest.delayed=true;
            battleTest.after=()=>{battleTest.remaining=900;if(battleTest.waits===2)battleTest.completed=true};
            await h.runTask('regular',()=>h.waitDungeonBattleReady('regular'));
            return h.runtime.outcome==='success' && battleTest.writes===1 && battleTest.waits===2;
        `);
        await test('缺券只尝试一次且等待有界', `
            battleTest.failure=Error('没有加速券');
            await h.runTask('no tickets',()=>h.waitDungeonBattleReady('no tickets'));
            return h.runtime.outcome==='error' && battleTest.writes===1 && battleTest.elapsed===600 && h.runtime.accelUsed===0;
        `);
        await test('加速响应丢失不重试且不提交结算', `
            battleTest.failure=Object.assign(Error('network'),{uncertain:true});
            await h.runTask('uncertain',()=>h.dungeonBattle({node_type:'battle',battle_status:{status:'ongoing'}}));
            return h.runtime.outcome==='error' && battleTest.writes===1 && !battleTest.settled && battleTest.waits===0;
        `);
        await test('已完成战斗即使残留超长倒计时也不用券', `
            battleTest.completed=true;
            await h.runTask('completed',()=>h.waitDungeonBattleReady('completed'));
            return h.runtime.outcome==='success' && battleTest.writes===0;
        `);
        await test('加速后服务端一直未结算仍有等待上限', `
            battleTest.delayed=true;
            await h.runTask('stuck',()=>h.waitDungeonBattleReady('stuck'));
            return h.runtime.outcome==='error' && battleTest.writes===1 && battleTest.elapsed===600;
        `);
        console.log('Complete:', count, 'battle timeout checks');
    } finally { c.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
