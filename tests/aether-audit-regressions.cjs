const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Offline source-level regressions: no browser, CDP port, or game network access.
const source = fs.readFileSync(path.join(__dirname, '..', 'Aether自动助手.user.js'), 'utf8');
function section(start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `Source section not found: ${start}`);
    return source.slice(first, last);
}

function harness() {
    const stored = new Map(), requests = [], messages = [], steps = [];
    const fixture = { response: () => ({ code: 0, data: null }), runCount: 0 };
    class FakeXHR {
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader() {}
        abort() { this.onabort?.(); }
        send(body) {
            const url = new URL(this.url, 'https://offline.invalid');
            const request = { method: this.method, path: url.pathname.replace('/api/aether', ''),
                character: url.searchParams.get('_aether_character'), body: body == null ? null : JSON.parse(body) };
            requests.push(request);
            const response = fixture.response(request);
            this.status = response.http ?? 200;
            this.responseText = Object.hasOwn(response, 'raw') ? response.raw : JSON.stringify(response);
            this.onload();
        }
    }
    function inputNode() {
        let value = '';
        return { dataset: {}, setAttribute() {}, append() {},
            get value() { return value; }, set value(next) { value = String(next); } };
    }
    const context = vm.createContext({
        AbortController, setTimeout, clearTimeout, XMLHttpRequest: FakeXHR,
        localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) },
        sessionStorage: { getItem: () => 'role-a' },
        log: (message, type) => messages.push({ message, type }),
        renderDashboard() {}, renderPolicySummary() {}, renderCharacterBatch() {}, renderDailyShopList() {}, renderDonationSettings() {},
        el: inputNode, field: (_parent, _label, input) => input, ui: { controls: {} },
        dungeonPreset: () => null, fmtRewards: () => '',
        loadPresets: async () => [], withCharacterLock: async (_character, action) => action(),
        dailyShopCatalog: [], donationBuildings: [], donationStatus: null,
        doDaily: async () => steps.push('daily'), doEvents: async () => steps.push('events'),
        doDailyShop: async () => steps.push('shop'), doDonation: async () => steps.push('donation'),
        doDungeonRun: async () => { fixture.runCount++; return { status: 'completed', completion_reason: 'safe_exit' }; },
    });
    const parts = [
        section('    const CONFIG = {', '    function exportSettings('),
        section('    function natural(', '    // ---------- API 请求层'),
        section('    function getCharacter(', '    // 奖励数组转可读文本'),
        section('    async function doMail(', '    // ---------- 战斗自动编队'),
        section('    async function fetchSweepInfo(', '    // 节点推进接口只允许队长操作'),
        section('    const WXT_PRESET_RE', '    let shopItemKindMap'),
        section('    function dungeonSucceeded(', '    async function doAllFreeDungeons('),
        section('    async function doDailyAll(', '    /******************** 控制台页面'),
        section('    function numberSetting(', '    function selectSetting('),
        `jitter = async () => {}; sleep = async () => {};
        globalThis.h = {
            api, doDailyAll, doSweep, chooseEventOption, chooseWxtEventOption,
            numberSetting, setSetting, loadSettings, readCharacterSettings,
            doDungeonRuns, executeCharacterBatch, characterBatch, runtime,
            get settings() { return settings; },
            context(character = 'role-a') {
                activeTaskContext = { character, settings: { ...settings }, controller: new AbortController(), stopError: new StopError(), ticketsUsed: 0 };
                return activeTaskContext;
            },
        };
        loadSettings('role-a');`,
    ];
    vm.runInContext(parts.join('\n'), context, { filename: 'aether-audit-extracted.js' });
    return { h: context.h, stored, requests, messages, steps, fixture };
}

let count = 0;
async function test(name, action) {
    await action(harness());
    count++;
    console.log(`PASS ${name}`);
}

async function main() {
    for (const unavailable of [{ disabled: true }, { locked: true }, { available: false }]) {
        const flag = Object.keys(unavailable)[0];
        await test(`普通事件 ${flag} 首选不会提交`, ({ h }) => {
            assert.equal(h.chooseEventOption([{ label: '取出根须', ...unavailable }, { label: '离开' }],
                '尚有余温的灰烬', { sanity: 20 }).index, 1);
            assert.equal(h.chooseEventOption([{ label: '收集剥落外壳', ...unavailable }, { label: '避开薄壳前进' }],
                '活石剥落层', { sanity: 20 }).index, 1);
        });
        await test(`未知事件 ${flag} 安全项及评分项均排除`, ({ h }) => {
            assert.equal(h.chooseEventOption([{ label: '离开', ...unavailable }, { label: '获得材料' }], '未知事件').index, 1);
            h.setSetting('eventMode', 'score');
            h.setSetting('eventGoal', 'collect');
            assert.equal(h.chooseEventOption([{ label: '获得碎片装备技能', ...unavailable }, { label: '普通调查' }], '未知事件').index, 1);
            assert.throws(() => h.chooseEventOption([{ label: '获得材料', ...unavailable }], '未知事件'), /不可选|不可用|理智/);
        });
        for (const [strategy, opening] of [['fire', '烬蓟'], ['light', '晨露草'], ['greed', '落雪金盏']]) {
            await test(`望雪台 ${strategy} ${flag} 目标暂停`, ({ h }) => {
                const policy = { wxtStrategy: strategy, difficulty: '普通', rerollWxt: true };
                assert.throws(() => h.chooseWxtEventOption([{ label: opening, ...unavailable }, { label: '其他' }], 2, policy), /不可选/);
                assert.throws(() => h.chooseWxtEventOption([{ label: '其他' }, { label: '霜藏', ...unavailable }], 3, policy), /不可选/);
                assert.equal(h.chooseWxtEventOption([{ label: '其他' }, { label: opening }], 2, policy).index, 1);
            });
        }
    }
    await test('全部普通事件选项不可用时暂停', ({ h }) => {
        assert.throws(() => h.chooseEventOption([{ label: '取出根须', locked: true }, { label: '离开', disabled: true }],
            '尚有余温的灰烬', { sanity: 20 }), /不可选|不可用|理智/);
        assert.equal(h.chooseEventOption([], '无选项事件').index, 0);
    });

    for (const ticketCost of [undefined, null, '', ' ', -1, 1.5, NaN, Infinity, 'invalid', Number.MAX_SAFE_INTEGER + 1]) {
        await test(`非法扫荡费用 ${String(ticketCost)} 不发送写请求`, async ({ h, fixture, requests }) => {
            fixture.response = () => ({ code: 0, data: { unlocked: true, max_times: 5, daily_remaining: 10,
                ticket_owned: 99, ticket_cost: ticketCost } });
            await assert.rejects(h.doSweep('mine', 5), /报价|库存/);
            assert.equal(requests.filter(request => request.method !== 'GET').length, 0);
        });
    }
    for (const owned of [undefined, null, '', -1, 1.5, 'bad', Number.MAX_SAFE_INTEGER + 1]) {
        await test(`付费扫荡库存 ${String(owned)} 异常不发送写请求`, async ({ h, fixture, requests }) => {
            fixture.response = () => ({ code: 0, data: { unlocked: true, max_times: 5, daily_remaining: 10,
                ticket_owned: owned, ticket_cost: 1 } });
            await assert.rejects(h.doSweep('mine', 5), /报价|库存/);
            assert.equal(requests.filter(request => request.method !== 'GET').length, 0);
        });
    }
    for (const cost of [0, '0', 2, '2']) {
        await test(`有效扫荡报价 ${JSON.stringify(cost)} 保持正常执行`, async ({ h, fixture, requests }) => {
            fixture.response = request => request.method === 'GET'
                ? { code: 0, data: { unlocked: true, max_times: 5, daily_remaining: 10, ticket_owned: cost == 0 ? 0 : 10, ticket_cost: cost } }
                : { code: 0, data: { times: request.body.times, cost: { ticket_cost: request.body.times * Number(cost) } } };
            assert.equal(await h.doSweep('mine', 5), 5);
            assert.equal(requests.filter(request => request.method === 'POST').length, 1);
        });
    }

    for (const malformed of [{ message: 'ok', data: { done: true } }, [], null, { code: '0' }, { code: 1.5 }]) {
        await test(`畸形写包络 ${JSON.stringify(malformed)} 停止日常且不重试`, async ({ h, fixture, requests, steps }) => {
            fixture.response = request => request.path === '/mail'
                ? { code: 0, data: { mails: [{ mail_id: 'first', has_items: true }, { mail_id: 'second', has_items: true }] } }
                : { raw: JSON.stringify(malformed) };
            await assert.rejects(h.doDailyAll('', 1, false), error => error.uncertain === true);
            assert.deepEqual(requests.filter(request => request.method === 'POST').map(request => request.path), ['/mail/first/claim']);
            assert.deepEqual(steps, []);
        });
    }
    await test('明确业务拒绝仍允许日常继续后续步骤', async ({ h, fixture, requests, steps }) => {
        fixture.response = request => request.path === '/mail'
            ? { code: 0, data: { mails: [{ mail_id: 'first', has_items: true }] } }
            : { code: 7, message: '已经领取' };
        await h.doDailyAll('', 1, false);
        assert.equal(requests.filter(request => request.method === 'POST').length, 1);
        assert.deepEqual(steps, ['daily', 'events', 'events', 'shop']);
    });

    await test('连续局数控件保存 999 并拒绝 1000，角色读取保留 999', ({ h, stored }) => {
        const input = h.numberSetting({}, 'runs', '连续局数');
        assert.equal(input.min, '1'); assert.equal(input.max, '999');
        input.value = '999'; input.onchange();
        assert.equal(h.settings.runs, 999);
        assert.equal(JSON.parse(stored.get('aether-helper-v2:role-a')).runs, 999);
        input.value = '1000'; input.onchange();
        assert.equal(input.value, '999'); assert.equal(h.settings.runs, 999);
        h.loadSettings('role-a');
        assert.equal(h.readCharacterSettings('role-a').runs, 999);
        assert.equal(h.settings.runs, 999);
    });
    await test('连续探索实际执行 999 局且进度完整', async ({ h, fixture, requests }) => {
        h.setSetting('runs', 999); h.context();
        fixture.response = request => {
            assert.equal(request.path, '/dungeon/current');
            return { code: 0, data: null };
        };
        const result = await h.doDungeonRuns('mine', 'private', '普通', h.settings.runs);
        assert.equal(fixture.runCount, 999); assert.equal(result.finished, 999); assert.equal(result.wins, 999);
        assert.equal(h.runtime.wins, 999); assert.equal(h.runtime.progress, 999); assert.equal(h.runtime.total, 999);
        assert.equal(requests.length, 998);
    });
    await test('多角色队列按各角色配置执行 999 局', async ({ h, fixture, stored }) => {
        stored.set('aether-helper-v2:role-b', JSON.stringify({ runs: 999, dungeonPreset: 'mine' }));
        h.characterBatch.characters = [{ username: 'role-b', name: '角色乙' }];
        h.characterBatch.selected.add('role-b');
        h.characterBatch.daily = false; h.characterBatch.dungeon = true; h.context();
        fixture.response = request => {
            if (request.path === '/account') return { code: 0, data: { characters: [{ username: 'role-b', name: '角色乙' }] } };
            if (request.path === '/status') return { code: 0, data: { username: request.character } };
            if (request.path === '/dungeon/current') return { code: 0, data: null };
            throw Error(`Unexpected request: ${request.path}`);
        };
        await h.executeCharacterBatch();
        assert.equal(fixture.runCount, 999);
        assert.equal(h.characterBatch.results[0].policy.runs, 999);
        assert.equal(h.characterBatch.results[0].outcome, 'success');
        assert.equal(h.characterBatch.results[0].counters.wins, 999);
    });
    console.log(`Complete: ${count} audit regression checks (Node VM; no browser/network)`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
