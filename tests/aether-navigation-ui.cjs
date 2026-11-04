const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { prepare, connect } = require('./aether-v2-ui.cjs');

async function main() {
    const preview = path.join(__dirname, 'aether-navigation-preview.html');
    fs.writeFileSync(preview, fs.readFileSync(prepare(), 'utf8').replace('localStorage.clear();',
        "if (!sessionStorage.getItem('aether-navigation-preserve')) localStorage.clear();"));
    const c = await connect(Number(process.env.AETHER_UI_PORT || 9248));
    const { send, evaluate } = c;
    try {
        await evaluate("sessionStorage.removeItem('aether-navigation-preserve')");
        await send('Page.navigate', { url: pathToFileURL(preview).href + '?t=' + Date.now() });
        async function ready() {
            for (let i = 0; i < 100; i++) {
                if (await evaluate('!!window.h && !h.running')) return;
                await new Promise(resolve => setTimeout(resolve, 40));
            }
            throw new Error('Navigation fixture did not initialize: ' + c.errors.join('\n'));
        }
        await ready();
        await evaluate("h.setSetting('sync',false);window.originalSettings=JSON.stringify(h.settings)");
        assert.equal(await evaluate('document.querySelectorAll(".ah-tabs > [role=tab]").length'), 6);
        for (const page of ['overview', 'daily', 'dungeon', 'bag', 'settings']) {
            await evaluate(`document.querySelector('[data-page="${page}"]').click()`);
            assert.equal(await evaluate(`(()=>{const page=document.querySelector('#ah-page-${page}');return page.querySelectorAll('.ah-subpage:not([hidden])').length===1&&[...page.querySelectorAll('.ah-subtab')].every(tab=>document.getElementById(tab.getAttribute('aria-controls'))?.getAttribute('aria-labelledby')===tab.id)})()`), true, page + ' has one accessible selected group');
        }
        await evaluate(`document.querySelector('[data-page="daily"]').click();document.querySelector('#ah-subtab-daily-donation').click()`);
        assert.equal(await evaluate(`document.querySelector('[data-setting="donationBuilding"]').getClientRects().length>0&&document.querySelector('[data-setting="dailySweep"]').getClientRects().length===0`), true, 'only selected daily controls are visible');
        await evaluate(`const tab=document.querySelector('#ah-subtab-daily-donation');tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
        assert.equal(await evaluate(`document.activeElement===document.querySelector('#ah-page-daily .ah-subtab:last-child')&&document.activeElement.getAttribute('aria-selected')==='true'`), true, 'End activates and focuses final group');
        await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
        assert.equal(await evaluate(`document.activeElement.id==='ah-subtab-daily-tasks'`), true, 'arrow keys wrap');
        await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
        assert.equal(await evaluate(`document.activeElement.id==='ah-subtab-daily-tasks'&&document.activeElement.tabIndex===0`), true, 'Home restores first group');
        assert.equal(await evaluate('JSON.stringify(h.settings)===originalSettings'), true, 'navigation leaves game settings unchanged');

        await evaluate(`document.querySelector('#ah-subtab-daily-donation').click();sessionStorage.setItem('aether-navigation-preserve','1')`);
        await send('Page.reload');
        await new Promise(resolve => setTimeout(resolve, 200));
        await ready();
        assert.equal(await evaluate(`!document.querySelector('#ah-page-daily').hidden&&!document.querySelector('#ah-section-daily-donation').hidden`), true, 'main and secondary navigation survive reload');

        await evaluate(`h.setSetting('sync',false);fixture.delay=10000;window.navigationTask=h.runTask('导航取消测试',()=>h.api('/status'));void 0`);
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(await evaluate(`document.querySelector('[data-setting="donationQuantity"]').disabled&&[...document.querySelectorAll('.ah-subtab')].every(tab=>!tab.disabled)`), true, 'navigation remains available during a task');
        await evaluate(`(async()=>{document.querySelector('#ah-subtab-daily-tasks').click();document.querySelector('[aria-label="停止当前任务"]').click();await navigationTask})()`);
        assert.equal(await evaluate(`h.runtime.outcome==='stopped'&&!h.running`), true, 'stop remains usable after switching groups');

        for (const [width, height] of [[1400, 1050], [390, 844], [320, 568], [844, 390]]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
            for (const page of ['overview', 'daily', 'dungeon', 'bag', 'settings']) {
                await evaluate(`document.querySelector('[data-page="${page}"]').click()`);
                const groups = await evaluate(`Array.from(document.querySelectorAll('#ah-page-${page} .ah-subtab'),tab=>tab.id)`);
                for (const group of groups) {
                    await evaluate(`document.getElementById(${JSON.stringify(group)}).click()`);
                    assert.equal(await evaluate(`(()=>{const panel=document.querySelector('#aether-auto-helper-panel'),page=document.querySelector('#ah-page-${page}'),r=panel.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&panel.scrollWidth<=panel.clientWidth+1&&page.scrollWidth<=page.clientWidth+1})()`), true, `${group} fits ${width}x${height}`);
                }
            }
        }
        assert.deepEqual(c.errors, [], 'zero browser exceptions');
        console.log('PASS: secondary menu visibility, keyboard, persistence, unchanged settings, task cancellation and every group at four viewport sizes.');
    } finally { c.close(); }
}

main().catch(error => { console.error(error); process.exit(1); });
