const assert = require('node:assert/strict');
const { prepare, connect } = require('./aether-v2-ui.cjs');

async function main() {
    prepare();
    const c = await connect(); let count = 0;
    async function test(name, code) {
        await c.reset();
        await c.evaluate(`(async()=>{
            fixture.characters=[{username:'role-a',name:'甲'},{username:'角色乙',name:'乙'}];
            fixture.stock={'role-a':20,'角色乙':30};fixture.donated=[];fixture.plans=[];
            for(const [index,role] of fixture.characters.entries())localStorage.setItem('aether-helper-v2:'+role.username,JSON.stringify({
                dailyShop:false,dailyDonation:true,donationBuilding:'anchor',donationItem:'leaf',donationLevel:2,
                donationQuantity:index+2,donationType:'quest',dungeonPreset:index?'valley':'mine',runs:index+1,sync:true
            }));
            fixture.handler=r=>{
                const char=r.query._aether_character;
                if(r.path==='/account')return {code:0,data:{characters:fixture.characters}};
                if(r.path==='/status')return {code:0,data:{username:char,backpack:{materials:[{item_id:'leaf',count:fixture.stock[char]??0}]}}};
                if(r.path==='/building')return {code:0,data:[{building_id:'anchor',next_upgrade:{target_level:2,quest_items:[{item_id:'leaf',required_per_player:100,player_contributed:0}]}}]};
                if(r.path.endsWith('/contribute/quest')){
                    fixture.stock[char]-=r.body.quantity;fixture.donated.push({char,quantity:r.body.quantity});return {code:0};
                }
            };
            await fixture.clickTask('加载绑定角色');
            for(const input of document.querySelectorAll('[data-batch-character]')){input.checked=true;input.dispatchEvent(new Event('change'));}
        })()`);
        assert.equal(await c.evaluate(`(async()=>{${code}})()`), true, name);
        console.log('PASS', name); count++;
    }
    try {
        await test('真实控件加载勾选并按角色配置执行日常捐献', `await fixture.clickTask('开始多角色任务');return JSON.stringify(fixture.donated)===JSON.stringify([{char:'role-a',quantity:2},{char:'角色乙',quantity:3}])&&h.characterBatch.results.every(x=>x.outcome==='success')&&sessionStorage.getItem('aether_active_character')==='观星者'&&!h.running&&h.settings.donationBuilding===''`);
        await test('日常与额外捐献同时选择不重复扣料', `h.characterBatch.donation=true;await fixture.clickTask('开始多角色任务');return fixture.donated.length===2`);
        await test('仅捐献按选定角色执行且不请求日常', `h.characterBatch.daily=false;h.characterBatch.donation=true;h.characterBatch.selected.delete('role-a');await fixture.clickTask('开始多角色任务');return fixture.donated.length===1&&fixture.donated[0].char==='角色乙'&&!fixture.calls.some(x=>x.path==='/daily')`);
        await test('探索使用各自保存的副本和次数并汇总结果', `h.characterBatch.daily=false;h.characterBatch.dungeon=true;h.setDeps({runs:async(...args)=>{fixture.plans.push([h.ctx.character,...args]);h.runtime.wins++}});await fixture.clickTask('开始多角色任务');return fixture.plans[0][1]==='mine'&&fixture.plans[0][4]===1&&fixture.plans[1][1]==='valley'&&fixture.plans[1][4]===2&&h.runtime.wins===2&&h.characterBatch.results.every(x=>x.counters.wins===1)`);
        await test('角色配置在整批开始时快照固定', `const base=fixture.handler;fixture.handler=r=>{if(r.path.endsWith('/quest'))localStorage.setItem('aether-helper-v2:角色乙',JSON.stringify({donationQuantity:99}));return base(r)};await fixture.clickTask('开始多角色任务');return fixture.donated[1].quantity===3`);
        await test('冰龙本难度按各角色快照执行，前台设置不串入队列', `for(const [index,role] of fixture.characters.entries()){const key='aether-helper-v2:'+role.username;localStorage.setItem(key,JSON.stringify({...JSON.parse(localStorage.getItem(key)),wxtDifficulty:index?'极难':'困难'}))}h.setSetting('wxtDifficulty','简单');h.characterBatch.daily=false;h.characterBatch.dungeon=true;h.setDeps({runs:async()=>{const p=h.chooseWxtEventOption(['简单','困难','极难'].map(label=>({label})),1);fixture.plans.push(p.index)}});await fixture.clickTask('开始多角色任务');return fixture.plans.join(',')==='1,2'&&h.settings.wxtDifficulty==='简单'&&h.characterBatch.results.every(x=>x.outcome==='success')`);
        await test('双贪队友与事件目标按角色保存，批量运行不混用策略', `for(const [index,role] of fixture.characters.entries()){const key='aether-helper-v2:'+role.username;localStorage.setItem(key,JSON.stringify({...JSON.parse(localStorage.getItem(key)),wxtStrategy:index?'light':'greed',friends:[index?'friend-b':'friend-a']}))}h.characterBatch.daily=false;h.characterBatch.dungeon=true;h.setDeps({runs:async()=>{fixture.plans.push([h.taskSettings().friends[0],h.chooseWxtEventOption([{label:'晨露草'},{label:'落雪金盏'}],2).index])}});await fixture.clickTask('开始多角色任务');return JSON.stringify(fixture.plans)===JSON.stringify([['friend-a',1],['friend-b',0]])&&h.characterBatch.results.every(x=>x.outcome==='success')`);
        await test('扫荡用券预算按角色隔离并汇总实际消耗', `
            for(const [i,role] of fixture.characters.entries()){const key='aether-helper-v2:'+role.username;localStorage.setItem(key,JSON.stringify({...JSON.parse(localStorage.getItem(key)),dailySweep:true,sweepPreset:'mine',sweepTimes:20,sweepTicketBudget:i?7:3}))}
            const base=fixture.handler;fixture.handler=r=>{
                if(r.path==='/dungeon/sweep/info')return{code:0,data:{max_times:5,ticket_owned:100,ticket_cost:1,daily_remaining:100}};
                if(r.path==='/dungeon/sweep'){fixture.plans.push([r.query._aether_character,r.body.times]);return{code:0,data:{times:r.body.times,cost:{ticket_cost:r.body.times}}}}
                return base(r);
            };
            await fixture.clickTask('开始多角色任务');
            return JSON.stringify(fixture.plans)===JSON.stringify([['role-a',3],['角色乙',5],['角色乙',2]])&&h.runtime.ticketsUsed===10&&h.characterBatch.results[0].counters.ticketsUsed===3&&h.characterBatch.results[1].counters.ticketsUsed===7;
        `);
        await test('身份不匹配停止整批且不提交写请求', `const base=fixture.handler;fixture.handler=r=>r.path==='/status'?{code:0,data:{username:'wrong'}}:base(r);await fixture.clickTask('开始多角色任务');return h.runtime.outcome==='error'&&fixture.donated.length===0&&h.characterBatch.results[0].outcome==='error'&&h.characterBatch.results[1].outcome==='pending'`);
        await test('角色被解绑时停止整批', `fixture.characters=[];await fixture.clickTask('开始多角色任务');return h.runtime.outcome==='error'&&fixture.donated.length===0`);
        await test('日常普通错误记录警告后继续下一角色', `const base=fixture.handler;fixture.handler=r=>r.path.endsWith('/quest')&&r.query._aether_character==='role-a'?{code:400,http:400,message:'材料不足'}:base(r);await fixture.clickTask('开始多角色任务');return h.runtime.outcome==='partial'&&h.characterBatch.results[0].outcome==='partial'&&h.characterBatch.results[1].outcome==='success'&&fixture.donated.length===1`);
        await test('独立任务普通错误结束本角色后继续下一角色', `h.characterBatch.daily=false;h.characterBatch.donation=true;const base=fixture.handler;fixture.handler=r=>r.path.endsWith('/quest')&&r.query._aether_character==='role-a'?{code:400,http:400,message:'材料不足'}:base(r);await fixture.clickTask('开始多角色任务');return h.characterBatch.results[0].outcome==='error'&&h.characterBatch.results[1].outcome==='success'&&h.runtime.outcome==='partial'`);
        await test('写响应丢失不重试也不运行下一角色', `const base=fixture.handler;fixture.handler=r=>{const result=base(r);return r.path.endsWith('/quest')?{networkError:true}:result};await fixture.clickTask('开始多角色任务');return h.runtime.outcome==='error'&&fixture.donated.length===1&&h.characterBatch.results[1].outcome==='pending'`);
        await test('登录失效停止整批', `const base=fixture.handler;fixture.handler=r=>r.path==='/account'?{code:401,http:401,message:'登录失效'}:base(r);await fixture.clickTask('开始多角色任务');return h.runtime.outcome==='error'&&fixture.donated.length===0`);
        await test('手动停止不继续下一角色', `h.setDeps({mail:async()=>h.requestTaskStop()});await fixture.clickTask('开始多角色任务');return h.runtime.outcome==='stopped'&&fixture.donated.length===0&&h.characterBatch.results[0].outcome==='stopped'&&h.characterBatch.results[1].outcome==='pending'`);
        await test('手动切换前台角色会中止整批', `h.setDeps({mail:async()=>sessionStorage.setItem('aether_active_character','manually-switched')});await fixture.clickTask('开始多角色任务');return fixture.donated.length===0&&h.characterBatch.results[0].outcome==='stopped'&&h.characterBatch.results[1].outcome==='pending'`);
        await test('原前台角色也可以参加队列且不会重复加锁', `fixture.characters=[{username:'观星者',name:'原角色'}];localStorage.setItem('aether-helper-v2:观星者',JSON.stringify({dailyShop:false,dailyDonation:false}));await fixture.clickTask('加载绑定角色');h.characterBatch.selected.add('观星者');await fixture.clickTask('开始多角色任务');return h.runtime.outcome==='success'&&h.characterBatch.results.length===1`);
        await test('其他标签占用角色锁时跳过该角色', `let release;let acquired;const ready=new Promise(r=>acquired=r);const lock=navigator.locks.request('aether-helper:role-a',async()=>{acquired();await new Promise(r=>release=r)});await ready;try{await fixture.clickTask('开始多角色任务');return h.characterBatch.results[0].outcome==='error'&&h.characterBatch.results[1].outcome==='success'&&fixture.donated.length===1}finally{release();await lock}`);
        await test('空名单或无任务时不发送游戏写请求', `h.characterBatch.daily=false;await fixture.clickTask('开始多角色任务');return h.runtime.outcome==='error'&&fixture.donated.length===0`);
        await test('重复角色列表拒绝加载并清除可执行名单', `fixture.characters.push(fixture.characters[0]);await fixture.clickTask('加载绑定角色');return h.runtime.outcome==='error'&&h.characterBatch.characters.length===0`);
        await test('运行期间控件锁定且任务结束后结果可见', `let locked=false;h.setDeps({mail:async()=>{locked=[...document.querySelectorAll('[data-batch-character],[data-batch-mode]')].every(x=>x.disabled)}});await fixture.clickTask('开始多角色任务');return locked&&document.querySelector('#ah-page-overview').textContent.includes('角色乙')&&document.querySelector('#ah-page-overview').textContent.includes('已完成')&&[...document.querySelectorAll('[data-batch-character]')].every(x=>!x.disabled)`);
        for (const width of [320, 390, 1400]) {
            await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
            assert.equal(await c.evaluate(`(()=>{const e=document.querySelector('#aether-auto-helper-panel .ah-content');return e.scrollWidth<=e.clientWidth+1})()`), true, `no overflow at ${width}`);
        }
        assert.deepEqual(c.errors, []);
        console.log(`Complete: ${count} character batch checks + 3 viewport checks`);
    } finally { c.close(); }
}
main().catch(error => { console.error(error); process.exit(1); });
