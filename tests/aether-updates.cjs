const assert = require('node:assert/strict');
const { prepare, connect } = require('./aether-v2-ui.cjs');

async function main() {
    prepare();
    const c = await connect();
    let count = 0;
    async function test(name, code) {
        await c.reset();
        await c.evaluate(`
            window.updateTest = { requests: [], opened: [], closed: 0, blocked: false, versions: ['2.6.2','2.6.2','2.6.2'], pinnedVersion:'2.6.2', sha:'a'.repeat(40) };
            window.updateButton = [...document.querySelectorAll('button')].find(b=>b.textContent==='检查更新');
            window.open = () => updateTest.blocked ? null : {
                document: {title:'',body:{textContent:''}}, close:()=>updateTest.closed++,
                location:{replace:url=>updateTest.opened.push(url)}
            };
            window.fetch = async (url, options) => {
                const requestIndex=updateTest.requests.length;
                updateTest.requests.push({url,credentials:options.credentials,cache:options.cache});
                if(updateTest.failAll || updateTest.failFirst && requestIndex===0)throw Error('offline');
                if(updateTest.gate)await updateTest.gate;
                if(url.startsWith('https://api.github.com/')){
                    if(updateTest.apiFail)throw Error('API unavailable');
                    return{ok:!updateTest.rateLimited,status:403,json:async()=>({ref:'refs/heads/main',object:{type:'commit',sha:updateTest.sha}})};
                }
                const pinned=url.includes(updateTest.sha),index=url.includes('raw.githubusercontent')?2:url.includes('fastly.')?1:0;
                if(updateTest.failPinned&&pinned||updateTest.failPinnedCdn&&pinned&&index<2)throw Error('fixed CDN unavailable');
                const version=pinned?(updateTest.pinnedVersions?.[index]||updateTest.pinnedVersion):updateTest.versions[index];
                const name=updateTest.wrongIdentity ? 'Other script' : 'Aether Console · 自动助手';
                return {ok:true,text:async()=>updateTest.html ? '<html>error</html>' :
                    '// ==UserScript==\\n// @name '+name+'\\n// @namespace https://github.com/aether-auto-helper\\n// @version '+version+'\\n// ==/UserScript=='};
            };
        `);
        assert.equal(await c.evaluate(`(async()=>{${code}})()`), true, name);
        console.log('PASS', name); count++;
    }
    try {
        await test('当前版本仅检查可信源，不携带凭据或写游戏接口', `
            await updateButton.onclick();
            return updateButton.textContent==='已是最新' && updateTest.closed===1 && !updateTest.opened.length && !fixture.calls.length &&
                updateTest.requests.length===7 && updateTest.requests.every(r=>r.credentials==='omit' && r.cache==='no-store' && r.url.includes('ZGRay00/Aether_cript') && (r.url.includes('aether-auto-helper.user.js')||r.url.includes('/git/ref/heads/main')));
        `);
        await test('并行比较所有源并选数字版本最高者', `
            updateTest.versions=['2.6.0','2.6.9','2.6.20'];await updateButton.onclick();
            return updateTest.opened.length===1 && updateTest.opened[0].startsWith('https://raw.githubusercontent.com/') && updateTest.requests.length===7;
        `);
        await test('单源失败仍能通过可用源更新', `
            updateTest.failFirst=true;updateTest.versions=['2.6.2','2.6.3','2.6.2'];await updateButton.onclick();
            return updateTest.opened.length===1 && updateTest.opened[0].startsWith('https://fastly.jsdelivr.net/');
        `);
        await test('旧版本和预发布版本不覆盖正式版', `
            updateTest.versions=['2.0.18','2.6.0-beta.1','2.6.0'];await updateButton.onclick();
            return updateButton.textContent==='已是最新' && !updateTest.opened.length;
        `);
        await test('身份不匹配拒绝安装', `
            updateTest.wrongIdentity=true;await updateButton.onclick();return updateButton.textContent==='检查失败' && !updateTest.opened.length && !updateButton.disabled;
        `);
        await test('HTML错误页拒绝安装', `
            updateTest.html=true;await updateButton.onclick();return updateButton.textContent==='检查失败' && !updateTest.opened.length;
        `);
        await test('全部网络失败可再次检查', `
            updateTest.failAll=true;await updateButton.onclick();if(updateButton.disabled || updateButton.textContent!=='检查失败')return false;
            updateTest.failAll=false;updateTest.requests=[];await updateButton.onclick();return updateButton.textContent==='已是最新';
        `);
        await test('弹窗拦截保留安装按钮并可再次打开', `
            updateTest.blocked=true;updateTest.versions.fill('2.6.3');await updateButton.onclick();
            if(updateButton.textContent!=='安装 v2.6.3')return false;
            updateTest.blocked=false;await updateButton.onclick();return updateTest.opened.length===1 && updateTest.requests.length===7;
        `);
        await test('检查期间按钮禁用，完成后恢复且保留角色配置', `
            h.setSetting('runs',7);const before=JSON.stringify(h.settings);
            updateTest.gate=new Promise(resolve=>updateTest.release=resolve);const pending=updateButton.onclick();
            const disabled=updateButton.disabled;updateTest.release();await pending;
            return disabled && !updateButton.disabled && JSON.stringify(h.settings)===before;
        `);
        await test('分支CDN全部陈旧仍通过最新提交固定地址升级', `
            updateTest.versions.fill('2.1.2');updateTest.pinnedVersion='2.6.3';await updateButton.onclick();
            return updateTest.opened.length===1&&updateTest.opened[0].includes('@'+updateTest.sha+'/')&&updateButton.textContent==='安装 v2.6.3';
        `);
        await test('同版本优先固定提交安装地址', `
            updateTest.versions.fill('2.6.3');updateTest.pinnedVersion='2.6.3';await updateButton.onclick();return updateTest.opened[0].includes('@'+updateTest.sha+'/');
        `);
        await test('API不可用且分支缓存陈旧时不声称最新', `
            updateTest.apiFail=true;updateTest.versions.fill('2.1.2');await updateButton.onclick();
            return updateButton.textContent==='暂未发现更新'&&!updateTest.opened.length&&h.runtime.logs.some(x=>x.message.includes('GitHub 最新提交 检查失败'));
        `);
        await test('API限流时明确提示无法确认最新', `
            updateTest.rateLimited=true;await updateButton.onclick();return updateButton.textContent==='暂未发现更新'&&h.runtime.logs.some(x=>x.message.includes('HTTP 403'));
        `);
        await test('非法提交标识不生成任意下载地址', `
            updateTest.sha='invalid';await updateButton.onclick();return updateTest.requests.length===4&&updateButton.textContent==='暂未发现更新'&&!updateTest.opened.length;
        `);
        await test('固定CDN不可用时使用同提交Raw', `
            updateTest.failPinnedCdn=true;updateTest.pinnedVersion='2.6.3';await updateButton.onclick();return updateTest.opened[0].startsWith('https://raw.githubusercontent.com/')&&updateTest.opened[0].includes('/'+updateTest.sha+'/');
        `);
        await test('固定文件全失败仍可通过分支Raw发现新版', `
            updateTest.failPinned=true;updateTest.versions[2]='2.6.3';await updateButton.onclick();return updateTest.opened[0].startsWith('https://raw.githubusercontent.com/')&&h.runtime.logs.some(x=>x.message.includes('固定版本文件均不可访问'));
        `);
        await test('固定提交返回版本冲突时不据此确认最新', `
            updateTest.pinnedVersions=['2.1.2','2.6.2','2.6.2'];await updateButton.onclick();return updateButton.textContent==='暂未发现更新'&&h.runtime.logs.some(x=>x.message.includes('版本不一致'));
        `);
        console.log('Complete:', count, 'update checks');
    } finally { c.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
