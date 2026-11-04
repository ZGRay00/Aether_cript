const assert = require('node:assert/strict');
const { prepare, connect } = require('./aether-v2-ui.cjs');

async function main() {
    prepare();
    const c = await connect(Number(process.env.AETHER_TEST_PORT) || 9247);
    let count = 0;
    async function test(name, code) {
        await c.reset();
        await c.evaluate(`
            fixture.status.username = '观星者';
            fixture.giftFriends = [
                {username:'friend-a',name:'晨雾',level:20},
                {username:'好友乙',name:'回声',level:30}
            ];
            fixture.giftStatus = {on_cooldown:false,cooldown_until:0,tradeable_items:[
                {uuid:'gift-equipment',item_id:'test_sword',name:'测试赠送剑',kind:'equipment',rarity:3,reinforce_level:0,bound:false,locked:false},
                {uuid:'gift-material',item_id:'test_ore',name:'测试赠送矿石',kind:'material',rarity:1,count:8}
            ]};
            fixture.giftWrites = [];
            fixture.handler = r => {
                if(r.path==='/social/friends') return {code:0,data:{friends:fixture.giftFriends}};
                if(r.path==='/social/gift/status') return {code:0,data:fixture.giftStatus};
                if(r.path==='/social/gift') {
                    if(r.method!=='POST') throw Error('Gift must use POST');
                    fixture.giftWrites.push(r);
                    fixture.giftStatus.tradeable_items = fixture.giftStatus.tradeable_items.filter(item=>item.uuid!==r.body.entry_uuid);
                    fixture.giftStatus.on_cooldown = true;
                    fixture.giftStatus.cooldown_until = Math.floor(Date.now()/1000)+86400;
                    return {code:0,message:'赠送成功'};
                }
            };
            window.giftSelect = (key, value) => {
                const input = document.querySelector('[data-gift="'+key+'"]');
                if(!input) throw Error('Missing gift control: '+key);
                input.value=value; input.dispatchEvent(new Event('change',{bubbles:true}));
            };
            window.giftPrepare = async (uuid='gift-equipment', target='friend-a') => {
                await h.runTask('加载赠送测试',()=>h.loadGiftData());
                if(h.runtime.outcome!=='success') throw Error('Gift load failed: '+JSON.stringify(h.runtime.logs));
                giftSelect('target',target); giftSelect('item',uuid);
                await h.runTask('预览赠送测试',()=>h.previewGift());
                if(!h.giftState.review || h.runtime.outcome!=='success') throw Error('Gift preview failed: '+JSON.stringify(h.runtime.logs));
            };
            window.giftSubmit = () => h.runTask('确认赠送测试',()=>h.commitGift());
            window.giftPosts = () => fixture.calls.filter(r=>r.path==='/social/gift'&&r.method==='POST');
        `);
        const result = await c.evaluate(`(async()=>{${code}})()`);
        const diagnostics = result === true ? '' : await c.evaluate(`JSON.stringify({outcome:h.runtime.outcome,logs:h.runtime.logs.slice(0,5),state:h.giftState,writes:giftPosts(),fixtureError:window.fixtureError})`);
        assert.equal(result, true, `${name}\n${diagnostics}`);
        assert.equal(await c.evaluate('window.fixtureError || null'), null, `${name}: fixture handler`);
        console.log('PASS', name); count++;
    }
    try {
        await test('加载后目标与物品控件可选择且具备可访问名称', `
            await h.runTask('加载赠送测试',()=>h.loadGiftData());
            const target=document.querySelector('[data-gift="target"]'), item=document.querySelector('[data-gift="item"]');
            if(!target||!item||!target.getAttribute('aria-label')||!item.getAttribute('aria-label')) return false;
            giftSelect('target','好友乙'); giftSelect('item','gift-material');
            return h.runtime.outcome==='success' && target.tagName==='SELECT' && item.tagName==='SELECT'
                && target.textContent.includes('晨雾') && item.textContent.includes('测试赠送矿石')
                && h.giftState.targetUsername==='好友乙' && h.giftState.selectedUuid==='gift-material'
                && !target.disabled && !item.disabled && giftPosts().length===0;
        `);
        await test('预览不写入，确认准确赠送选中装备一次并回查状态', `
            await giftPrepare();
            if(giftPosts().length!==0) return false;
            const before=fixture.calls.length;
            await giftSubmit();
            const writes=giftPosts(), after=fixture.calls.slice(before), writeIndex=after.findIndex(r=>r.path==='/social/gift');
            return h.runtime.outcome==='success' && writes.length===1
                && JSON.stringify(writes[0].body)===JSON.stringify({target_username:'friend-a',entry_uuid:'gift-equipment'})
                && writes[0].query._aether_character==='观星者' && !h.giftState.review
                && after.slice(writeIndex+1).some(r=>r.path==='/social/gift/status')
                && after.slice(writeIndex+1).some(r=>r.path==='/status');
        `);
        await test('堆叠道具与中文目标按条目发送，不添加数量或循环请求', `
            await giftPrepare('gift-material','好友乙');
            await giftSubmit();
            const writes=giftPosts();
            return h.runtime.outcome==='success' && writes.length===1
                && JSON.stringify(writes[0].body)===JSON.stringify({target_username:'好友乙',entry_uuid:'gift-material'});
        `);
        await test('冷却期间禁止生成可执行预览', `
            await h.runTask('加载赠送测试',()=>h.loadGiftData());
            giftSelect('target','friend-a'); giftSelect('item','gift-equipment');
            fixture.giftStatus.on_cooldown=true; fixture.giftStatus.cooldown_until=Math.floor(Date.now()/1000)+3600;
            await h.runTask('冷却预览',()=>h.previewGift());
            await giftSubmit();
            return giftPosts().length===0 && !h.giftState.review;
        `);
        await test('预览之后进入冷却，确认时不赠送', `
            await giftPrepare();
            fixture.giftStatus.on_cooldown=true; fixture.giftStatus.cooldown_until=Math.floor(Date.now()/1000)+60;
            await giftSubmit();
            return h.runtime.outcome==='error' && giftPosts().length===0 && !h.giftState.review;
        `);
        for (const [name, mutation] of [
            ['目标好友被删除', `fixture.giftFriends=fixture.giftFriends.filter(friend=>friend.username!=='friend-a');`],
            ['装备新增锁定', `fixture.giftStatus.tradeable_items[0].locked=true;`],
            ['装备强化或属性改变', `fixture.giftStatus.tradeable_items[0].reinforce_level=1;`],
            ['所选条目消失', `fixture.giftStatus.tradeable_items=fixture.giftStatus.tradeable_items.filter(item=>item.uuid!=='gift-equipment');`],
        ]) {
            await test(`预览后${name}时停止且不提交`, `
                await giftPrepare(); ${mutation}
                await giftSubmit();
                return h.runtime.outcome==='error' && giftPosts().length===0 && !h.giftState.review;
            `);
        }
        await test('预览后堆叠数量变化不发送旧预览', `
            await giftPrepare('gift-material');
            fixture.giftStatus.tradeable_items.find(item=>item.uuid==='gift-material').count=7;
            await giftSubmit();
            return h.runtime.outcome==='error' && giftPosts().length===0 && !h.giftState.review;
        `);
        await test('重新加载保留仍有效选择并使旧预览失效', `
            await giftPrepare();
            await h.runTask('刷新赠送测试',()=>h.loadGiftData());
            return h.giftState.targetUsername==='friend-a' && h.giftState.selectedUuid==='gift-equipment'
                && !h.giftState.review && giftPosts().length===0;
        `);
        await test('刷新后无效好友和物品选择清空', `
            await giftPrepare(); fixture.giftFriends=[]; fixture.giftStatus.tradeable_items=[];
            await h.runTask('刷新赠送测试',()=>h.loadGiftData());
            return !h.giftState.targetUsername && !h.giftState.selectedUuid && !h.giftState.review && giftPosts().length===0;
        `);
        for (const [field, value] of [['target','好友乙'],['item','gift-material']]) {
            await test(`更换${field==='target'?'接收玩家':'赠送条目'}立即取消旧预览`, `
                await giftPrepare(); giftSelect('${field}','${value}');
                if(h.giftState.review) return false;
                await giftSubmit();
                return giftPosts().length===0;
            `);
        }
        await test('绕过控件改变选择仍不能复用旧预览', `
            await giftPrepare(); h.giftState.targetUsername='好友乙';
            await giftSubmit();
            return giftPosts().length===0 && h.runtime.outcome==='error';
        `);
        await test('角色切换后不能发送旧角色预览', `
            await giftPrepare(); sessionStorage.setItem('aether_active_character','新角色');
            await giftSubmit();
            return giftPosts().length===0 && !h.giftState.review;
        `);
        await test('预览后服务端身份改变时阻止写入', `
            await giftPrepare(); fixture.status.username='wrong-player';
            await giftSubmit();
            return giftPosts().length===0 && h.runtime.outcome==='error';
        `);
        await test('提交准备期间手动停止中断读取并保留物品', `
            await giftPrepare(); fixture.delay=30;
            const task=giftSubmit(); setTimeout(()=>h.requestTaskStop(),5); await task;
            return h.runtime.outcome==='stopped' && giftPosts().length===0;
        `);
        await test('写请求网络结果不确定只提交一次，重复确认不能重发', `
            await giftPrepare(); const handler=fixture.handler;
            fixture.handler=r=>r.path==='/social/gift'?{networkError:true}:handler(r);
            await giftSubmit();
            const failed=h.runtime.outcome==='error' && h.runtime.logs.some(log=>log.message.includes('请求结果未确认'));
            await giftSubmit();
            return failed && giftPosts().length===1 && !h.giftState.review;
        `);
        await test('服务器拒绝赠送不重复提交', `
            await giftPrepare(); const handler=fixture.handler;
            fixture.handler=r=>r.path==='/social/gift'?{code:400,http:400,message:'当前不可赠送'}:handler(r);
            await giftSubmit(); await giftSubmit();
            return giftPosts().length===1 && !h.giftState.review;
        `);
        for (const [name, invalid] of [
            ['空响应', 'null'],
            ['缺少冷却状态', '{tradeable_items:[]}'],
            ['非布尔冷却状态', '{on_cooldown:"false",cooldown_until:0,tradeable_items:[]}'],
            ['非数组物品列表', '{on_cooldown:false,cooldown_until:0,tradeable_items:{}}'],
            ['重复物品标识', '{on_cooldown:false,cooldown_until:0,tradeable_items:[{uuid:"same",name:"甲"},{uuid:"same",name:"乙"}]}'],
            ['物品缺少标识', '{on_cooldown:false,cooldown_until:0,tradeable_items:[{name:"无标识物品"}]}'],
        ]) {
            await test(`非法赠送状态：${name}时拒绝继续`, `
                fixture.giftStatus=${invalid};
                await h.runTask('非法赠送状态',()=>h.loadGiftData());
                return h.runtime.outcome==='error' && giftPosts().length===0 && !h.giftState.review;
            `);
        }
        await test('一键日常赠送默认关闭，勾选后按角色持久化', `
            const input=document.querySelector('[data-setting="dailyGift"]');
            if(!input || input.type!=='checkbox' || input.checked || h.settings.dailyGift!==false
                || !input.getAttribute('aria-label')) return false;
            input.checked=true; input.dispatchEvent(new Event('change',{bubbles:true}));
            const saved=JSON.parse(localStorage.getItem('aether-helper-v2:观星者'));
            return h.settings.dailyGift===true && saved.dailyGift===true && giftPosts().length===0;
        `);
        await test('保存预览为日常计划只写本地配置，保留精确角色与物品指纹', `
            await giftPrepare('gift-material','好友乙');
            const review=JSON.stringify(h.giftState.review);
            const save=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='保存日常赠送计划');
            if(!save || save.disabled) return false;
            save.click();
            const saved=JSON.parse(localStorage.getItem('aether-helper-v2:观星者'));
            return JSON.stringify(h.settings.giftPlan)===review && JSON.stringify(saved.giftPlan)===review
                && !h.giftState.review && giftPosts().length===0 && h.settings.dailyGift===false;
        `);
        await test('未保存或已改变选择的预览不能保存为日常计划', `
            h.saveDailyGiftPlan();
            if(Object.keys(h.settings.giftPlan).length) return false;
            await giftPrepare(); giftSelect('target','好友乙'); h.saveDailyGiftPlan();
            return Object.keys(h.settings.giftPlan).length===0 && giftPosts().length===0;
        `);
        await test('任务运行中不能保存新的日常计划', `
            await giftPrepare();
            await h.runTask('禁止运行中保存',async()=>h.saveDailyGiftPlan());
            return Object.keys(h.settings.giftPlan).length===0 && giftPosts().length===0;
        `);
        await test('保存计划后未勾选日常赠送，不读取赠送接口或发送', `
            await giftPrepare(); h.saveDailyGiftPlan();
            h.setSetting('dailyShop',false); h.setSetting('dailyDonation',false);
            fixture.calls=[];
            await h.runTask('日常未勾选',()=>h.doDailyAll(null,1,false));
            return h.runtime.outcome==='success' && giftPosts().length===0
                && !fixture.calls.some(r=>r.path==='/social/gift/status');
        `);
        await test('日常已勾选但尚无计划时跳过且不写入', `
            h.setSetting('dailyGift',true); h.setSetting('dailyShop',false); h.setSetting('dailyDonation',false);
            await h.runTask('无计划日常',()=>h.doDailyAll(null,1,false));
            return h.runtime.outcome==='success' && giftPosts().length===0
                && h.runtime.logs.some(log=>log.message.includes('尚未保存赠送计划'));
        `);
        await test('日常按已保存计划自动赠送一次，已确认的冷却阻止下次赠送', `
            await giftPrepare('gift-material','好友乙'); h.saveDailyGiftPlan();
            h.setSetting('dailyGift',true); h.setSetting('dailyShop',false); h.setSetting('dailyDonation',false);
            await h.runTask('首次日常赠送',()=>h.doDailyAll(null,1,false));
            if(h.runtime.outcome!=='success' || giftPosts().length!==1) return false;
            await h.runTask('冷却期间日常赠送',()=>h.doDailyAll(null,1,false));
            return h.runtime.outcome==='success' && giftPosts().length===1
                && JSON.stringify(giftPosts()[0].body)===JSON.stringify({target_username:'好友乙',entry_uuid:'gift-material'})
                && h.runtime.logs.some(log=>log.message.includes('当前处于冷却'));
        `);
        await test('日常赠送冷却即跳过，不等待或提交', `
            await giftPrepare(); h.saveDailyGiftPlan();
            fixture.giftStatus.on_cooldown=true; fixture.giftStatus.cooldown_until=Math.floor(Date.now()/1000)+86400;
            let waits=0; h.setDeps({wait:async()=>{waits++}});
            await h.runTask('日常冷却',()=>h.doDailyGift());
            return h.runtime.outcome==='success' && waits===0 && giftPosts().length===0;
        `);
        await test('日常已保存条目数量变化时只记录警告，不赠送或重选物品', `
            await giftPrepare('gift-material'); h.saveDailyGiftPlan();
            h.setSetting('dailyGift',true); h.setSetting('dailyShop',false); h.setSetting('dailyDonation',false);
            fixture.giftStatus.tradeable_items.find(item=>item.uuid==='gift-material').count--;
            await h.runTask('过期日常计划',()=>h.doDailyAll(null,1,false));
            return h.runtime.outcome==='partial' && giftPosts().length===0
                && h.runtime.logs.some(log=>log.message.includes('库存已变化'));
        `);
        await test('日常任务使用启动时保存的赠送计划及开关快照', `
            await giftPrepare(); h.saveDailyGiftPlan();
            h.setSetting('dailyGift',true); h.setSetting('dailyShop',false); h.setSetting('dailyDonation',false);
            await h.runTask('日常计划快照',async()=>{
                h.setSetting('dailyGift',false); h.setSetting('giftPlan',{});
                await h.doDailyAll(null,1,false);
            });
            return h.runtime.outcome==='success' && giftPosts().length===1
                && giftPosts()[0].body.entry_uuid==='gift-equipment';
        `);
        await test('跨角色导入的赠送计划不能在新角色自动执行', `
            await giftPrepare(); h.saveDailyGiftPlan();
            const plan=structuredClone(h.settings.giftPlan);
            sessionStorage.setItem('aether_active_character','新角色'); fixture.status.username='新角色';
            localStorage.setItem('aether-helper-v2:新角色',JSON.stringify({dailyGift:true,dailyShop:false,dailyDonation:false,giftPlan:plan}));
            await h.runTask('跨角色日常',()=>h.doDailyAll(null,1,false));
            return h.runtime.outcome==='partial' && giftPosts().length===0
                && h.runtime.logs.some(log=>log.message.includes('计划属于其他角色'));
        `);
        await test('日常赠送响应不确定立即结束，单次日常只提交一次', `
            await giftPrepare(); h.saveDailyGiftPlan();
            h.setSetting('dailyGift',true); h.setSetting('dailyShop',false); h.setSetting('dailyDonation',false);
            const handler=fixture.handler; fixture.handler=r=>r.path==='/social/gift'?{networkError:true}:handler(r);
            await h.runTask('日常赠送断线',()=>h.doDailyAll(null,1,false));
            return h.runtime.outcome==='error' && giftPosts().length===1
                && h.runtime.logs.some(log=>log.message.includes('请求结果未确认'));
        `);
        await test('多角色日常赠送读取各自计划，身份校验使用正在执行的角色', `
            await giftPrepare(); h.saveDailyGiftPlan();
            const savedPlan=structuredClone(h.settings.giftPlan), roles=['role-a','角色乙'];
            const states=Object.fromEntries(roles.map(role=>[role,structuredClone(fixture.giftStatus)]));
            h.characterBatch.characters=roles.map(username=>({username,name:username}));
            h.characterBatch.selected=new Set(roles); h.characterBatch.daily=true;
            h.characterBatch.dungeon=false; h.characterBatch.donation=false;
            for(const [index,role] of roles.entries()) {
                const item=states[role].tradeable_items[index];
                localStorage.setItem('aether-helper-v2:'+role,JSON.stringify({dailyGift:true,dailyShop:false,dailyDonation:false,sync:false,
                    giftPlan:{...savedPlan,character:role,entryUuid:item.uuid,fingerprint:JSON.stringify(item)}}));
            }
            const handler=fixture.handler;
            fixture.handler=r=>{
                const role=r.query._aether_character;
                if(r.path==='/account') return {code:0,data:{characters:h.characterBatch.characters}};
                if(r.path==='/status') return {code:0,data:{...fixture.status,username:role}};
                if(r.path==='/social/gift/status') return {code:0,data:states[role]};
                if(r.path==='/social/gift') {
                    states[role].on_cooldown=true; states[role].cooldown_until=Math.floor(Date.now()/1000)+86400;
                    return {code:0,message:'赠送成功'};
                }
                return handler(r);
            };
            await h.runTask('多角色日常赠送',()=>h.executeCharacterBatch(),{batch:true});
            return h.runtime.outcome==='success' && h.characterBatch.results.every(item=>item.outcome==='success')
                && JSON.stringify(giftPosts().map(r=>[r.query._aether_character,r.body.entry_uuid]))===JSON.stringify([['role-a','gift-equipment'],['角色乙','gift-material']])
                && sessionStorage.getItem('aether_active_character')==='观星者';
        `);
        assert.deepEqual(c.errors, []);
        console.log('Complete:', count, 'player gift checks');
    } finally { c.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
