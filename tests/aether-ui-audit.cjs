const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const artifacts = path.join(__dirname, 'artifacts/aether-audit-20261109');
fs.mkdirSync(artifacts, { recursive: true });
// Reuse the offline game fixture without overwriting the shared preview or test.
const fixtureFile = path.join(__dirname, 'aether-v2-ui.cjs'), fixtureModule = { exports: {} };
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').replace(
    "const previewPath = path.join(__dirname, 'aether-v2-preview.html');",
    `const previewPath = ${JSON.stringify(path.join(artifacts, 'ui-audit-preview.html'))};`);
new Function('require', 'module', '__dirname', fixtureSource)(require('node:module').createRequire(fixtureFile), fixtureModule, __dirname);
const { prepare, connect } = fixtureModule.exports;

async function main() {
    prepare();
    const c = await connect(Number(process.env.AETHER_UI_PORT || 9249)), { send, evaluate } = c;
    let checks = 0;
    async function check(label, expression) {
        assert.equal(await evaluate(expression), true, label); checks++; console.log('PASS:', label);
    }
    async function screenshot(name) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const result = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(artifacts, name + '.png'), Buffer.from(result.data, 'base64'));
    }
    try {
        await c.reset();
        await check('initial synchronization is distinct from completing an automation task', `h.runtime.task==='同步状态'&&h.runtime.outcome==='success'&&document.querySelector('.ah-status-text').textContent==='状态已同步'&&document.querySelector('.ah-hero-title').textContent==='状态已同步'`);
        for (const [width, height] of [[1400,1050],[390,844],[320,568]]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
            await evaluate(`document.querySelector('[data-page="overview"]').click();document.querySelector('#ah-subtab-overview-status').click();document.querySelector('.ah-content').scrollTop=0;Object.assign(h.runtime,{wins:123456789012,losses:123456789012,ticketsUsed:123456789012,shopSpent:123456789012});h.renderDashboard()`);
            await check(`large counters fit cards at ${width}px`, `Array.from(document.querySelectorAll('.ah-stat')).every(card=>card.scrollWidth<=card.clientWidth+1&&card.querySelector('strong').textContent==='123456789012')`);
            if (width < 520) await check(`mobile counters form two columns at ${width}px`, `getComputedStyle(document.querySelector('.ah-stats')).gridTemplateColumns.split(' ').length===2`);
            await screenshot(`after-${width}-overview`);
            await evaluate(`document.querySelector('[data-page="daily"]').click();document.querySelector('#ah-subtab-daily-tasks').click();document.querySelector('.ah-content').scrollTop=0`);
            await check(`daily action precedes optional settings at ${width}px`, `(()=>{const action=Array.from(document.querySelectorAll('#ah-section-daily-tasks button')).find(button=>button.textContent.trim()==='开始日常'),toggle=document.querySelector('#ah-section-daily-tasks .ah-toggle'),content=document.querySelector('.ah-content').getBoundingClientRect();return action.getBoundingClientRect().bottom<toggle.getBoundingClientRect().top&&action.getBoundingClientRect().bottom<=content.bottom})()`);
            await screenshot(`after-${width}-daily`);
            await evaluate(`document.querySelector('[data-page="dungeon"]').click();document.querySelector('#ah-subtab-dungeon-plan').click();document.querySelector('.ah-content').scrollTop=0`);
            await check(`exploration action follows the chosen dungeon and precedes advanced settings at ${width}px`, `(()=>{const action=Array.from(document.querySelectorAll('#ah-section-dungeon-plan button')).find(button=>button.textContent.trim()==='开始探索'),preset=document.querySelector('[data-setting="dungeonPreset"]'),runs=document.querySelector('[data-setting="runs"]');return preset.getBoundingClientRect().bottom<=action.getBoundingClientRect().top&&action.getBoundingClientRect().bottom<runs.getBoundingClientRect().top})()`);
            await screenshot(`after-${width}-exploration`);
            await check(`panel remains within the viewport at ${width}px`, `(()=>{const panel=document.querySelector('#aether-auto-helper-panel'),r=panel.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&panel.scrollWidth<=panel.clientWidth+1})()`);
        }
        await evaluate(`(async()=>{fixture.calls=[];window.auditError='操作结果尚未确认，请先在游戏中核对背包与金币，再决定是否重新启动。'+ '完整原因会保留在这里，手机也可以滚动查看。'.repeat(12);await h.runTask('界面错误验证',async()=>{throw new Error(auditError)})})()`);
        await check('long errors are readable without a hover tooltip', `(()=>{const notice=document.querySelector('.ah-task-notice'),copy=document.querySelector('.ah-task-notice-copy');return !notice.hidden&&copy.textContent.includes(auditError)&&copy.clientHeight>30&&copy.scrollWidth<=copy.clientWidth+1&&getComputedStyle(copy).overflowY==='auto'&&copy.tabIndex===0})()`);
        await screenshot('after-320-error');
        await check('showing an error does not send game requests', `fixture.calls.length===0`);
        await evaluate(`document.querySelector('.ah-task-notice button').click()`);
        await check('the error action only opens logs', `!document.querySelector('#ah-page-logs').hidden&&fixture.calls.length===0`);
        await evaluate(`document.querySelector('[aria-label="收起助手"]').click()`);
        await check('collapsed mode hides the error notice', `document.querySelector('#aether-auto-helper-panel').getBoundingClientRect().width===52&&document.querySelector('.ah-task-notice').getClientRects().length===0`);
        await evaluate(`(async()=>{document.querySelector('.ah-launcher').click();await h.runTask('界面部分完成验证',async()=>{h.runtime.issues=1;h.runtime.logs.unshift({type:'warn',message:'指定赠送物品已不在库存，本次已跳过。',at:Date.now()})})})()`);
        await check('partial completion shows its useful reason rather than the generic completion line', `!document.querySelector('.ah-task-notice').hidden&&document.querySelector('.ah-task-notice-copy').textContent==='指定赠送物品已不在库存，本次已跳过。'`);
        await evaluate(`fixture.calls=[];fixture.delay=20000;window.auditRunning=h.runTask('界面停止验证',()=>h.api('/status'));void 0`);
        await new Promise(resolve => setTimeout(resolve, 80));
        await check('starting another task hides the previous task issue', `document.querySelector('.ah-task-notice').hidden`);
        await check('running tasks expose a labeled touch-size stop action', `(()=>{const stop=document.querySelector('[aria-label="停止当前任务"]'),r=stop.getBoundingClientRect();return !stop.disabled&&stop.textContent.trim()==='停止'&&r.width>=72&&r.height>=44&&document.querySelector('[aria-label="检查脚本更新"]').hidden})()`);
        await evaluate(`window.auditRequestCount=fixture.calls.length;document.querySelector('[data-page="daily"]').click();document.querySelector('#ah-subtab-daily-tasks').click();document.querySelector('[data-page="dungeon"]').click();document.querySelector('#ah-subtab-dungeon-plan').click();document.querySelector('.ah-content').scrollTop=0`);
        await check('navigation does not restart or duplicate the active task', `fixture.calls.length===auditRequestCount&&auditRequestCount===1&&Array.from(document.querySelectorAll('#ah-section-dungeon-plan .ah-btn')).every(button=>button.disabled)`);
        await screenshot('after-320-running');
        await evaluate(`(async()=>{document.querySelector('[aria-label="停止当前任务"]').click();await auditRunning;fixture.delay=0})()`);
        await new Promise(resolve => setTimeout(resolve, 80));
        await check('stopping from another page does not retry the request or display an error', `h.runtime.outcome==='stopped'&&!h.running&&fixture.calls.length===1&&document.querySelector('.ah-task-notice').hidden&&document.querySelector('[aria-label="停止当前任务"]').disabled&&!document.querySelector('[aria-label="检查脚本更新"]').hidden`);
        assert.deepEqual(c.errors, [], 'no browser exceptions');
        console.log(`Complete: ${checks} offline UI checks; screenshots saved to ${artifacts}`);
    } finally { c.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
