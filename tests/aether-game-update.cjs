const assert = require('node:assert/strict');
const { prepare, connect } = require('./aether-v2-ui.cjs');

async function main() {
    prepare();
    const c = await connect();
    let passed = 0;
    async function test(name, code) {
        await c.reset();
        assert.equal(await c.evaluate(`(async()=>{${code}})()`), true, name);
        passed++; console.log('PASS ' + name);
    }
    try {
        await test('同步保留暂时不可用的探索与扫荡计划，并展示不可用选项', `
            h.setSetting('dungeonPreset','snow');h.setSetting('sweepPreset','mine');
            await h.refreshAll();fixture.presets=[];await h.refreshAll();
            const a=document.querySelector('[data-setting=dungeonPreset]'),b=document.querySelector('[data-setting=sweepPreset]');
            return h.settings.dungeonPreset==='snow'&&h.settings.sweepPreset==='mine'&&a.value==='snow'&&b.value==='mine'
                &&a.selectedOptions[0].disabled&&b.selectedOptions[0].disabled&&/不可用/.test(a.selectedOptions[0].textContent);
        `);
        await test('副本恢复后沿用原选择，且同步不会写入新的角色配置', `
            h.setSetting('dungeonPreset','snow');h.setSetting('sweepPreset','mine');
            const before=localStorage.getItem('aether-helper-v2:观星者');const saved=fixture.presets;
            fixture.presets=[];await h.refreshAll();fixture.presets=saved;await h.refreshAll();
            return document.querySelector('[data-setting=dungeonPreset]').value==='snow'
                &&!document.querySelector('[data-setting=dungeonPreset]').selectedOptions[0].disabled
                &&localStorage.getItem('aether-helper-v2:观星者')===before;
        `);
        await test('解锁状态变化后保留已选副本但不创建新探索', `
            h.setSetting('dungeonPreset','snow');fixture.presets.find(p=>p.id==='snow').locked=true;
            await h.refreshAll();fixture.calls=[];await h.runTask('不可用副本',()=>h.createDungeon('snow','private','普通'));
            return h.runtime.outcome==='error'&&h.settings.dungeonPreset==='snow'&&fixture.calls.every(r=>r.method==='GET');
        `);
        for (const data of [null, {}, [null], [{ id:'same' },{ id:'same' }]]) {
            await test('异常副本列表不覆盖已验证目录或已保存选择: '+JSON.stringify(data), `
                h.setSetting('dungeonPreset','snow');await h.refreshAll();const before=JSON.stringify(h.runtime.presets);
                fixture.handler=r=>r.path==='/dungeon/presets'?{code:0,data:${JSON.stringify(data)}}:undefined;
                await h.refreshAll();return h.settings.dungeonPreset==='snow'&&JSON.stringify(h.runtime.presets)===before;
            `);
        }
        await test('切换角色后显示新角色的保留选择，不沿用上一角色控件', `
            h.setSetting('dungeonPreset','mine');await h.refreshAll();
            localStorage.setItem('aether-helper-v2:new-role',JSON.stringify({dungeonPreset:'hidden'}));
            sessionStorage.setItem('aether_active_character','new-role');h.reconcileCharacter();
            return h.settings.dungeonPreset==='hidden'&&document.querySelector('[data-setting=dungeonPreset]').value==='hidden';
        `);
        await test('查询扫荡额度显示门票种类、单次数量和计划总数', `
            h.setSetting('sweepPreset','mine');h.setSetting('sweepTimes',3);
            fixture.handler=r=>r.path==='/dungeon/sweep/info'?{code:0,data:{unlocked:true,max_times:5,daily_remaining:10,ticket_owned:20,ticket_cost:1,entry_item_cost:{id:'ice_key',name:'冰钥',amount:2}}}:undefined;
            await fixture.clickTask('查询额度');
            const text=document.querySelector('.ah-quote').textContent;
            return text.includes('冰钥')&&/每次.*2/.test(text)&&/门票.*6|6.*门票/.test(text);
        `);
        for (const changed of [{ id:'ice_key',amount:3 },{ id:'another_key',amount:2 }]) {
            await test('后续批次门票涨价或变更时停止追加: '+JSON.stringify(changed), `
                let quoted=0;fixture.handler=r=>{
                    if(r.path==='/dungeon/sweep/info')return{code:0,data:{unlocked:true,max_times:1,daily_remaining:10,ticket_owned:20,ticket_cost:1,
                        entry_item_cost:quoted++?${JSON.stringify(changed)}:{id:'ice_key',amount:2}}};
                    if(r.path==='/dungeon/sweep')return{code:0,data:{times:1,cost:{ticket_cost:1}}};
                };
                await h.runTask('门票变化',()=>h.doSweep('mine',3));
                return fixture.calls.filter(r=>r.path==='/dungeon/sweep').length===1&&h.runtime.sweepDone===1&&h.runtime.outcome==='partial';
            `);
        }
        await test('原本免门票的扫荡新增门票时停止追加', `
            let quoted=0;fixture.handler=r=>{
                if(r.path==='/dungeon/sweep/info')return{code:0,data:{unlocked:true,max_times:1,daily_remaining:10,ticket_owned:20,ticket_cost:1,
                    entry_item_cost:quoted++?{id:'ice_key',amount:1}:null}};
                if(r.path==='/dungeon/sweep')return{code:0,data:{times:1,cost:{ticket_cost:1}}};
            };
            await h.runTask('新增门票',()=>h.doSweep('mine',3));
            return fixture.calls.filter(r=>r.path==='/dungeon/sweep').length===1&&h.runtime.sweepDone===1;
        `);
        for (const cost of [{id:'ice_key',amount:-1},{id:'ice_key',amount:1.5},{id:'ice_key'}, {amount:2}]) {
            await test('门票报价异常时不提交扫荡: '+JSON.stringify(cost), `
                fixture.handler=r=>r.path==='/dungeon/sweep/info'?{code:0,data:{unlocked:true,max_times:5,daily_remaining:10,ticket_owned:20,ticket_cost:1,entry_item_cost:${JSON.stringify(cost)}}}:undefined;
                await h.runTask('异常门票',()=>h.doSweep('mine',3));
                return h.runtime.outcome==='error'&&fixture.calls.every(r=>r.method==='GET');
            `);
        }
        await test('门票减价或取消仍可按服务器上限完成后续批次', `
            let quoted=0;fixture.handler=r=>{
                if(r.path==='/dungeon/sweep/info')return{code:0,data:{unlocked:true,max_times:1,daily_remaining:10,ticket_owned:20,ticket_cost:1,
                    entry_item_cost:[{id:'ice_key',amount:2},{id:'ice_key',amount:1},null][quoted++]}};
                if(r.path==='/dungeon/sweep')return{code:0,data:{times:1,cost:{ticket_cost:1}}};
            };
            await h.runTask('门票减少',()=>h.doSweep('mine',3));
            return h.runtime.sweepDone===3&&h.runtime.outcome==='success';
        `);
        assert.deepEqual(c.errors, [], 'no browser exceptions');
        console.log(`Complete: ${passed} game catalogue and sweep entry-cost regressions (offline browser).`);
    } finally { c.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
