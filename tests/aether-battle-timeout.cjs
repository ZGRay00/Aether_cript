const assert = require('node:assert/strict');
const { prepare, connect } = require('./aether-v2-ui.cjs');

async function main() {
    prepare(); const c = await connect(); let count = 0;
    async function test(name, code) {
        await c.reset();
        await c.evaluate(`
            window.battleTest = { clock: Date.now(), elapsed: 0, remaining: 0, writes: [], waits: 0, completed: false };
            Date.now = () => battleTest.clock;
            h.setDeps({wait:async seconds=>{
                battleTest.clock+=seconds*1000; battleTest.elapsed+=seconds; battleTest.waits++;
                battleTest.after?.();
            },api:async(path,options={})=>{
                if(options.method==='POST')battleTest.writes.push(path);
                if(path==='/dungeon/node') {
                    if(battleTest.failure)throw battleTest.failure;
                    return {data:{completed:!!battleTest.nodeDone,battle_status:{status:battleTest.badStatus|| (battleTest.completed?'completed':'ongoing'),remaining_seconds:battleTest.remaining}}};
                }
                if(path.endsWith('/complete')){battleTest.settled=true;return{data:{status:'exploring'}}}
                throw Error('Unexpected write or request '+path);
            }});
        `);
        assert.equal(await c.evaluate(`(async()=>{${code}})()`),true,name);
        assert.equal(await c.evaluate(`battleTest.writes.some(x=>x.endsWith('/accelerate'))`),false,'never call legacy accelerate');
        console.log('PASS',name);count++;
    }
    try {
        await test('已生成结果直接结算不等待不用券', `battleTest.completed=true;await h.runTask('done',()=>h.dungeonBattle({node_type:'battle',battle_status:{status:'completed'}}));return h.runtime.outcome==='success'&&battleTest.settled&&battleTest.waits===0&&h.runtime.ticketsUsed===0`);
        await test('无倒计时的新版战斗短轮询后结算', `battleTest.after=()=>battleTest.completed=true;await h.runTask('new',()=>h.dungeonBattle({node_type:'battle',battle_status:{status:'ongoing'}}));return h.runtime.outcome==='success'&&battleTest.settled&&battleTest.elapsed===2`);
        await test('旧超长倒计时只等待不触发加速', `battleTest.remaining=900;battleTest.after=()=>battleTest.completed=true;await h.runTask('long',()=>h.waitDungeonBattleReady('long'));return h.runtime.outcome==='success'&&battleTest.elapsed===30&&battleTest.writes.length===0`);
        await test('持续未结算600秒暂停保留探索', `await h.runTask('timeout',()=>h.dungeonBattle({node_type:'battle',battle_status:{status:'ongoing'}}));return h.runtime.outcome==='error'&&battleTest.elapsed===600&&!battleTest.settled&&h.runtime.ticketsUsed===0`);
        await test('600秒边界先读取已完成结果', `battleTest.remaining=600;battleTest.after=()=>{if(battleTest.elapsed>=600)battleTest.completed=true};await h.runTask('boundary',()=>h.waitDungeonBattleReady('boundary'));return h.runtime.outcome==='success'&&battleTest.elapsed===600`);
        await test('后台休眠按墙上时钟超时', `battleTest.after=()=>battleTest.clock+=900000;await h.runTask('suspended',()=>h.waitDungeonBattleReady('suspended'));return h.runtime.outcome==='error'&&battleTest.waits===1`);
        await test('等待中手动停止不会提交结算', `battleTest.after=()=>h.requestTaskStop();await h.runTask('stop',()=>h.dungeonBattle({node_type:'battle',battle_status:{status:'ongoing'}}));return h.runtime.outcome==='stopped'&&!battleTest.settled`);
        await test('缺失或异常倒计时仍短轮询', `battleTest.remaining='bad';battleTest.after=()=>battleTest.completed=true;await h.runTask('invalid time',()=>h.waitDungeonBattleReady('invalid'));return h.runtime.outcome==='success'&&battleTest.elapsed===2`);
        await test('已完成节点不重复提交结算', `battleTest.nodeDone=true;h.setDeps({api:async path=>path==='/dungeon/current'?{data:{status:'exploring'}}:{data:{completed:true}}});await h.runTask('node done',()=>h.dungeonBattle({node_type:'battle',battle_status:{status:'ongoing'}}));return h.runtime.outcome==='success'&&!battleTest.settled`);
        await test('异常战斗状态暂停不用券', `battleTest.badStatus='prepared';await h.runTask('invalid state',()=>h.waitDungeonBattleReady('invalid'));return h.runtime.outcome==='error'&&battleTest.waits===0`);
        await test('读取失败不会消费加速券', `battleTest.failure=Error('offline');await h.runTask('read failed',()=>h.waitDungeonBattleReady('read'));return h.runtime.outcome==='error'&&battleTest.waits===0`);
        await test('旧加速配置不再启用自动扣券', `localStorage.setItem('aether-helper-v2:观星者',JSON.stringify({accelThreshold:1,accelBudget:999}));h.loadSettings();h.setSetting('sync',false);battleTest.remaining=900;battleTest.after=()=>battleTest.completed=true;await h.runTask('migrated',()=>h.waitDungeonBattleReady('migrated'));return h.runtime.outcome==='success'&&!('accelThreshold' in h.settings)&&h.settings.sweepTicketBudget===20`);
        console.log('Complete:',count,'battle result checks (zero legacy acceleration requests)');
    } finally {c.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
