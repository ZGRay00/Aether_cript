const assert = require('node:assert/strict');
const { prepare, connect } = require('./aether-v2-ui.cjs');

async function main() {
    prepare();
    const c = await connect();
    let count = 0;
    async function test(name, code) {
        await c.reset();
        await c.evaluate(`
            window.configButton = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
            window.configInput = document.querySelector('input[type=file]');
            configInput.click = () => {};
            window.configFile = values => ({format:'aether-helper-settings',schemaVersion:1,scriptVersion:'2.0.16',character:'观星者',settings:values});
            window.selectConfig = async data => {
                configButton('导入配置文件').click();
                const transfer = new DataTransfer();
                transfer.items.add(new File([typeof data === 'string' ? data : JSON.stringify(data)], 'config.json', {type:'application/json'}));
                configInput.files = transfer.files;
                await configInput.onchange();
            };
        `);
        assert.equal(await c.evaluate(`(async()=>{${code}})()`), true, name);
        console.log('PASS', name); count++;
    }
    try {
        await test('导出后完整恢复、持久化和面板同步，无游戏请求', `
            h.setSetting('friends',['ldya','Guqii0812']); h.setSetting('front','custom');
            h.setSetting('characterOrder',['key:ldya','key:Guqii0812','self']);
            h.setSetting('dailyShopOverrides',{'["daily","gem"]':false});
            h.setSetting('runs',999); h.setSetting('sweepTicketBudget',999); h.setSetting('hermitDefaults',false); h.setSetting('wxtDifficulty','极难'); h.setSetting('sweepTimes',20); h.setSetting('wxtStrategy','greed');
            h.setSetting('dailyFreeDungeons',true); h.setSetting('dailyGift',true); h.setSetting('giftPlan',{character:'观星者',targetUsername:'friend-a',entryUuid:'gift-1',targetName:'好友',itemLabel:'测试装备',fingerprint:JSON.stringify({uuid:'gift-1',name:'测试装备'})});
            h.setSetting('dungeonPreset','valley'); h.setSetting('donationBuilding','saved-building');
            h.setSetting('donationItem','saved-item'); h.setSetting('donationLevel',8);
            h.setSetting('donationType','shared'); h.setSetting('bossCampAction','search');
            let blob; URL.createObjectURL = value => {blob=value;return 'blob:test';};
            HTMLAnchorElement.prototype.click = () => {};
            configButton('导出当前角色配置').click();
            const file=await blob.text(), expected=JSON.stringify(h.settings);
            h.setSetting('runs',1); h.setSetting('friends',[]); h.setSetting('front','keep'); h.setSetting('wxtDifficulty',''); h.setSetting('sweepTimes',1); h.setSetting('wxtStrategy','fire');
            h.setSetting('characterOrder',[]); h.setSetting('hermitDefaults',true); h.setSetting('dungeonPreset','mine');
            h.setSetting('dailyFreeDungeons',false); h.setSetting('dailyGift',false); h.setSetting('giftPlan',{});
            const before=JSON.stringify(h.settings);
            await selectConfig(file);
            if(JSON.stringify(h.settings)!==before) return false;
            configButton('应用到当前角色').click();
            const input=key=>document.querySelector('[data-setting="'+key+'"]');
            return JSON.stringify(h.settings)===expected && localStorage.getItem('aether-helper-v2:观星者')===expected
                && input('runs').value==='999' && input('runs').max==='999' && input('front').value==='custom' && !input('hermitDefaults').checked && input('wxtDifficulty').value==='极难'
                && input('dailyFreeDungeons').checked && input('dailyGift').checked && h.settings.giftPlan.entryUuid==='gift-1'
                && input('sweepTimes').value==='20' && input('sweepTimes').max==='20' && input('wxtStrategy').value==='greed'
                && input('dungeonPreset').value==='valley' && input('donationBuilding').value==='saved-building'
                && input('donationItem').value==='saved-item' && input('bossCampAction').value==='search'
                && document.querySelectorAll('[data-order-key]').length===3 && fixture.calls.length===0;
        `);
        await test('2.0.16 文件可跨角色导入；缺项保留、未知字段不保存', `
            h.setSetting('runs',9);
            const file=configFile({hermitDefaults:false,futureField:123}); file.character='其他角色';
            await selectConfig(file);
            if(!document.body.textContent.includes('来源与当前角色不同')) return false;
            configButton('应用到当前角色').click();
            return h.settings.runs===9 && h.settings.hermitDefaults===false && !Object.hasOwn(h.settings,'futureField')
                && localStorage.getItem('aether-helper-v2:其他角色')===null;
        `);
        await test('旧营地备份忽略计时字段，保留当前新动作', `
            h.setSetting('campAction','rest'); h.setSetting('bossCampAction','search');
            await selectConfig(configFile({runs:2,campMode:'fixed',campSeconds:100,bossCampMode:'off',bossCampTarget:90}));
            configButton('应用到当前角色').click();
            return h.settings.runs===2&&h.settings.campAction==='rest'&&h.settings.bossCampAction==='search'&&!Object.hasOwn(h.settings,'campMode');
        `);
        await test('旧加速备份不会恢复战斗扣券，新预算可设零', `
            await selectConfig(configFile({accelThreshold:1,accelBudget:999,sweepTicketBudget:0}));configButton('应用到当前角色').click();
            return h.settings.sweepTicketBudget===0&&!('accelThreshold' in h.settings)&&document.querySelector('[data-setting=sweepTicketBudget]').value==='0';
        `);
        await test('无效 JSON、版本、字段类型、数值越界均不修改配置', `
            const before=JSON.stringify(h.settings), saved=localStorage.getItem('aether-helper-v2:观星者');
            for(const file of ['{',null,[],{...configFile({runs:2}),schemaVersion:2},configFile({}),
                configFile({sweepTicketBudget:1000}),configFile({sweepTicketBudget:-1}),configFile({campAction:'auto'}),configFile({bossCampAction:'off'}),configFile({runs:1000}),configFile({sweepTimes:21}),configFile({dailyFreeDungeons:'true'}),configFile({dailySweep:'false'}),configFile({friends:['a','b','c']}),configFile({wxtDifficulty:'invalid'}),configFile({giftPlan:{targetUsername:'incomplete'}}),
                configFile({characterOrder:['invalid']}),configFile({dailyShopOverrides:{bad:1}}),configFile({protectRarity:6})]) {
                await selectConfig(JSON.stringify(file));
                if(configButton('应用到当前角色') || JSON.stringify(h.settings)!==before) return false;
            }
            return localStorage.getItem('aether-helper-v2:观星者')===saved;
        `);
        await test('取消预览和预览后修改设置不会覆盖现值', `
            await selectConfig(configFile({runs:3})); configButton('取消导入').click();
            if(h.settings.runs!==1) return false;
            await selectConfig(configFile({runs:3})); h.setSetting('runs',8);
            configButton('应用到当前角色').click(); return h.settings.runs===8;
        `);
        await test('角色切换后不能应用旧预览', `
            await selectConfig(configFile({runs:3}));
            sessionStorage.setItem('aether_active_character','新角色');
            configButton('应用到当前角色').click();
            return h.settings.runs===1 && localStorage.getItem('aether-helper-v2:新角色')===null;
        `);
        await test('读取文件途中切换角色不会覆盖任何角色配置', `
            configButton('导入配置文件').click();
            let finish; Object.defineProperty(configInput,'files',{configurable:true,value:[{size:100,text:()=>new Promise(resolve=>finish=resolve)}]});
            const reading=configInput.onchange();
            sessionStorage.setItem('aether_active_character','新角色');
            finish(JSON.stringify(configFile({runs:3}))); await reading;
            return !configButton('应用到当前角色') && localStorage.getItem('aether-helper-v2:新角色')===null;
        `);
        await test('读取途中启动并结束任务，旧文件仍失效', `
            configButton('导入配置文件').click();
            let finish; Object.defineProperty(configInput,'files',{configurable:true,value:[{size:100,text:()=>new Promise(resolve=>finish=resolve)}]});
            const reading=configInput.onchange();
            await h.runTask('测试任务',async()=>{});
            finish(JSON.stringify(configFile({runs:3}))); await reading;
            return !configButton('应用到当前角色') && h.settings.runs===1;
        `);
        await test('存储失败保留原内存和原配置', `
            await selectConfig(configFile({runs:3}));
            const before=JSON.stringify(h.settings), saved=localStorage.getItem('aether-helper-v2:观星者');
            const original=Storage.prototype.setItem;
            Storage.prototype.setItem=function(){throw Error('模拟存储已满');};
            try { configButton('应用到当前角色').click(); }
            finally {Storage.prototype.setItem=original;}
            return JSON.stringify(h.settings)===before && localStorage.getItem('aether-helper-v2:观星者')===saved;
        `);
        await test('未加载的副本编号显示且保留，UTF-8 BOM 兼容', `
            await selectConfig('\uFEFF'+JSON.stringify(configFile({dungeonPreset:'unloaded',sweepPreset:'unloaded-sweep'})));
            configButton('应用到当前角色').click();
            return h.settings.dungeonPreset==='unloaded' && document.querySelector('[data-setting=dungeonPreset]').value==='unloaded'
                && document.querySelector('[data-setting=sweepPreset]').value==='unloaded-sweep';
        `);
        assert.deepEqual(c.errors, []);
        console.log('Configuration import checks passed:', count);
    } finally { c.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
