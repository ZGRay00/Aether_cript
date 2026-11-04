// ==UserScript==
// @name         Aether Console · 自动助手
// @namespace    https://github.com/aether-auto-helper
// @version      2.3.1
// @description  Aether 图形控制台：高收益日常、地下城接管与探索、背包分解预览与有限强化；角色独立配置、任务取消和多标签互斥。
// @author       -
// @match        https://game.diving-fish.com/aether/*
// @downloadURL  none
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '2.3.1';
    const SCRIPT_IDENTITY = { name: 'Aether Console · 自动助手', namespace: 'https://github.com/aether-auto-helper' };
    // 与红叶镇相同：手动并行检查可信源，选最高版本，由脚本管理器确认安装。
    const UPDATE_SOURCES = [
        { name: 'jsDelivr', url: 'https://cdn.jsdelivr.net/gh/ZGRay00/Aether_cript@main/aether-auto-helper.user.js' },
        { name: 'jsDelivr GCore', url: 'https://gcore.jsdelivr.net/gh/ZGRay00/Aether_cript@main/aether-auto-helper.user.js' },
        { name: 'jsDelivr Fastly', url: 'https://fastly.jsdelivr.net/gh/ZGRay00/Aether_cript@main/aether-auto-helper.user.js' },
        { name: 'GitHub Raw', url: 'https://raw.githubusercontent.com/ZGRay00/Aether_cript/main/aether-auto-helper.user.js' },
    ];
    const INSTANCE_KEY = '__aetherAutoHelper__';
    if (window[INSTANCE_KEY]) return; // 防止重复注入两套面板
    window[INSTANCE_KEY] = { version: VERSION };

    /******************** 配置区 ********************/
    const CONFIG = {
        minDelay: 300,          // 请求间随机延迟下限（毫秒）
        maxDelay: 800,          // 请求间随机延迟上限（毫秒）
        dungeonMaxSteps: 200,   // 地下城挂机单局最大节点步数，防死循环
        sweepMaxTimes: 16,      // 一次扫荡任务的总次数上限；按服务器单次上限分批
        battleMaxWait: 600,     // 战斗等待上限；地下城到期先尝试加速，成功后重新等待结算（秒）
        publicLobbyPollSeconds: 5, // 公开大厅等待满员时的查询间隔，可随时停止
        dungeonMaxRestarts: 30, // 望雪台未刷到策略目标时撤离重开的单批次数上限
        donationMaxWait: 600,   // 单独共享捐献每次冷却最多等待 10 分钟；日常不等待
    };
    /****************** 配置区结束 ******************/

    const API_PREFIX = '/api/aether';
    const CHAR_KEY = 'aether_active_character';

    // ---------- 运行状态 ----------
    let runningTask = null;       // 当前执行中的任务名
    let activeTaskContext = null; // 当前任务独立的取消上下文
    const preferredFriends = new Set(); // 「选助战好友」勾选的好友 username；空 = 招募时全自动按等级选

    const DEFAULT_SETTINGS = Object.freeze({
        dailySweep: false, dailyShop: true, dailyDonation: true, dailyShopOverrides: {}, sweepTimes: 1, sweepPreset: '', dungeonPreset: '', runs: 1,
        visibility: 'private', difficulty: '普通', accelThreshold: 0, accelBudget: 3,
        lossLimit: 1, restartLimit: 10, rerollWxt: false, wxtStrategy: 'fire', wxtDifficulty: '', campMode: 'auto', campSeconds: 60,
        campTarget: 90, shop: 'equip_skill', shopMaxEach: 1,
        bossCampMode: 'auto', bossCampSeconds: 60, bossCampTarget: 100,
        eventMode: 'safe', eventGoal: 'clear', sanityFloor: 10, route: 'first', front: 'keep', characterOrder: [],
        protectRarity: 4, protectReinforced: true, reinforceAttempts: 5, friends: [], sync: true,
        donationBuilding: '', donationType: 'quest', donationItem: '', donationLevel: 0,
        donationQuantity: 1, donationTimes: 1,
        hermitDefaults: true,
    });
    const NUMBER_LIMITS = {
        sweepTimes: [1, 16], runs: [1, 50], accelThreshold: [0, 3600], accelBudget: [0, 100],
        lossLimit: [1, 10], restartLimit: [0, 30], campSeconds: [0, 300], campTarget: [1, 100],
        bossCampSeconds: [0, 300], bossCampTarget: [1, 100],
        shopMaxEach: [1, 10], sanityFloor: [0, 20], protectRarity: [3, 5], reinforceAttempts: [1, 50],
        donationLevel: [0, 1000000], donationQuantity: [1, 1000000], donationTimes: [1, 100],
    };
    const SETTING_CHOICES = {
        visibility: ['private', 'friends', 'public'], difficulty: ['简单', '普通', '困难', '极难'],
        campMode: ['auto', 'fixed', 'off'], bossCampMode: ['auto', 'fixed', 'off'], shop: ['equip_skill', 'all', 'off'],
        eventMode: ['safe', 'score', 'pause'], eventGoal: ['clear', 'collect'],
        route: ['first', 'camp', 'treasure', 'boss'], front: ['keep', 'hp', 'custom'],
        wxtStrategy: ['fire', 'light'],
        wxtDifficulty: ['', '简单', '普通', '困难', '极难'],
        donationType: ['quest', 'shared'],
    };
    function normalizeSetting(key, value) {
        const fallback = DEFAULT_SETTINGS[key];
        if (key === 'characterOrder') return Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string')
            .map(v => v.trim()).filter(v => v === 'self' || /^key:\S.*$/.test(v)))].slice(0, 50) : [];
        if (key === 'dailyShopOverrides') return value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === 'boolean')) : {};
        if (key === 'protectRarity' && Number(value) === 6) value = 5; // 旧配置也不能放开五星保护。
        if (key === 'friends') return Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))].slice(0, 2) : [];
        if (NUMBER_LIMITS[key]) {
            const [min, max] = NUMBER_LIMITS[key], n = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
            return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
        }
        if (SETTING_CHOICES[key]) return SETTING_CHOICES[key].includes(value) ? value : fallback;
        return typeof value === typeof fallback ? value : fallback;
    }
    let settings = { ...DEFAULT_SETTINGS };
    let settingsCharacter = '';
    let settingsImport = null, settingsImportEpoch = 0;
    function newCounters() { return { wins: 0, losses: 0, accelUsed: 0, restarts: 0, shopSpent: 0, searchSpent: 0, sweepDone: 0, issues: 0 }; }
    const runtime = {
        ...newCounters(), status: null, dungeon: null, presets: [], explorationAllowance: null,
        phase: '就绪', task: '', progress: 0, total: 0, waitUntil: 0,
        startedAt: 0, endedAt: 0, logs: [], outcome: 'idle',
    };
    function readStorage(key, fallback) {
        try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); }
        catch (_) { return fallback; }
    }
    function writeStorage(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 存储不可用时保留本次配置 */ }
    }
    function readCharacterSettings(character) {
        const saved = readStorage(`aether-helper-v2:${character}`, {});
        const values = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) =>
            [key, normalizeSetting(key, saved && typeof saved === 'object' && Object.hasOwn(saved, key) ? saved[key] : value)]));
        // 旧版只有一组营地设置：未单独配置 Boss 营地的项继承旧值，之后独立保存。
        for (const [next, previous] of [['bossCampMode', 'campMode'], ['bossCampSeconds', 'campSeconds'], ['bossCampTarget', 'campTarget']]) {
            if (saved && typeof saved === 'object' && !Object.hasOwn(saved, next) && Object.hasOwn(saved, previous)) values[next] = values[previous];
        }
        return values;
    }
    function loadSettings(character = getCharacter()) {
        settings = readCharacterSettings(character);
        settingsCharacter = character;
        preferredFriends.clear();
        if (Array.isArray(settings.friends)) settings.friends.slice(0, 2).forEach((x) => preferredFriends.add(String(x)));
    }
    function setSetting(key, value) {
        if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return;
        settings[key] = normalizeSetting(key, value);
        if (key === 'friends') {
            preferredFriends.clear();
            settings.friends.forEach((name) => preferredFriends.add(name));
        }
        writeStorage(`aether-helper-v2:${settingsCharacter}`, settings);
    }
    function exportSettings() {
        if (runningTask) return;
        let url = null, anchor = null;
        try {
            reconcileCharacter();
            if (!settingsCharacter) { log('请先选择游戏角色再导出配置', 'warn'); return; }
            const exportedAt = new Date().toISOString();
            const data = {
                format: 'aether-helper-settings', schemaVersion: 1, scriptVersion: VERSION,
                character: settingsCharacter, exportedAt,
                settings: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, normalizeSetting(key, settings[key])])),
            };
            const character = settingsCharacter.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60);
            const filename = `aether-config-${character}-${exportedAt.replace(/[:.]/g, '-')}.json`;
            url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }));
            anchor = el('a'); anchor.href = url; anchor.download = filename;
            document.body.appendChild(anchor); anchor.click();
            log(`已发起「${settingsCharacter}」配置下载：${filename}`, 'success');
        } catch (e) { log(`配置导出失败：${e.message}`, 'error'); }
        finally {
            anchor?.remove();
            if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }
    function clearSettingsImport() {
        settingsImport = null; settingsImportEpoch++;
        if (ui.ready) importReviewBox.replaceChildren();
    }
    function parseSettingsImport(text) {
        let data;
        try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
        catch (_) { throw new Error('文件不是有效的 JSON 配置'); }
        if (!data || data.format !== 'aether-helper-settings' || data.schemaVersion !== 1) {
            throw new Error('不支持的配置格式或版本，请选择助手导出的 JSON 文件');
        }
        if (typeof data.character !== 'string' || !data.character.trim() ||
            !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) {
            throw new Error('配置缺少角色名或设置对象');
        }
        const entries = Object.entries(data.settings).filter(([key]) => Object.hasOwn(DEFAULT_SETTINGS, key));
        if (!entries.length) throw new Error('文件中没有可导入的设置');
        const values = Object.fromEntries(entries.map(([key, value]) => {
            const normalized = normalizeSetting(key, value);
            // 导入不默默把损坏的字段替换为默认值；整份检查通过后才允许保存。
            if (JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error(`设置「${key}」的类型、范围或内容无效`);
            return [key, normalized];
        }));
        return { character: data.character, values, ignored: Object.keys(data.settings).length - entries.length };
    }
    async function readSettingsImport(file, character) {
        clearSettingsImport();
        const epoch = settingsImportEpoch;
        try {
            if (runningTask) throw new Error('请先停止当前任务再导入配置');
            if (!character || getCharacter() !== character) throw new Error('角色已变化，请重新选择配置文件');
            if (file.size > 1024 * 1024) throw new Error('配置文件超过 1 MB，请检查文件');
            const text = await file.text();
            if (epoch !== settingsImportEpoch) return;
            if (runningTask || getCharacter() !== character || settingsCharacter !== character) throw new Error('读取期间角色或任务已变化，请重新导入');
            const parsed = parseSettingsImport(text);
            settingsImport = { ...parsed, target: character, before: JSON.stringify(settings), next: { ...settings, ...parsed.values } };
            renderSettingsImport();
        } catch (e) {
            if (epoch !== settingsImportEpoch) return;
            importReviewBox.replaceChildren(el('div', 'ah-note', e.message));
            log(`配置导入失败：${e.message}`, 'error');
        }
    }
    function commitSettingsImport() {
        const review = settingsImport;
        if (!review) return;
        try {
            if (runningTask || getCharacter() !== review.target || settingsCharacter !== review.target || JSON.stringify(settings) !== review.before) {
                throw new Error('角色、任务或设置已变化，请重新选择文件并预览');
            }
            // 一次写入成功后才更新内存和界面，存储失败时保留原配置。
            localStorage.setItem(`aether-helper-v2:${review.target}`, JSON.stringify(review.next));
            settings = review.next;
            preferredFriends.clear(); settings.friends.forEach(name => preferredFriends.add(name));
            clearSettingsImport();
            refreshSettingsControls();
            log(`已将「${review.character}」的配置导入当前角色「${review.target}」`, 'success');
        } catch (e) {
            clearSettingsImport();
            importReviewBox.replaceChildren(el('div', 'ah-note', e.message));
            log(`配置导入失败：${e.message}`, 'error');
        }
    }
    function natural(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : fallback;
    }
    function taskSettings() { return activeTaskContext?.settings || settings; }
    function markIssue(message) { runtime.issues++; log(message, 'warn'); }
    function setProgress(done, total, phase) {
        runtime.progress = done; runtime.total = total;
        if (phase) runtime.phase = phase;
        renderDashboard();
    }

    class StopError extends Error {
        constructor() { super('已手动停止'); this.stopped = true; }
    }
    function isStopError(e) { return e instanceof StopError || e?.stopped === true; }
    // 望雪台刷开局：当前局已撤离、需要重新开一局（由 doDungeonRuns 捕获，不计入完成局数）
    class DungeonRestartError extends Error {
        constructor(msg) { super(msg); this.restart = true; }
    }
    function isRestartError(e) { return e?.restart === true; }
    function checkStop(ctx = activeTaskContext) {
        if (ctx?.controller.signal.aborted) throw ctx.stopError;
        if (ctx?.character && (ctx.pageCharacter ?? ctx.character) !== getCharacter()) {
            ctx.stopError.message = '角色已切换，当前任务已停止；已发送的操作需回查游戏状态';
            ctx.controller.abort(ctx.stopError);
            throw ctx.stopError;
        }
    }
    function rethrowIfStopped(e, allowUncertain = false) {
        if (isStopError(e)) throw e;
        checkStop();
        if (e?.fatal || (e?.uncertain && !allowUncertain)) throw e;
    }

    // 捕获调用时所属的任务上下文，停止时立即清除计时器并抛出同一个 StopError。
    function sleep(ms) {
        const ctx = activeTaskContext;
        const signal = ctx?.controller.signal;
        if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
        return new Promise((resolve, reject) => {
            if (signal.aborted) { reject(ctx.stopError); return; }
            let timer = null;
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                fn(value);
            };
            const onAbort = () => finish(reject, ctx.stopError);
            signal.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => finish(resolve), ms);
        });
    }
    // 请求间随机小延迟，避免请求风暴
    function jitter() {
        return sleep(CONFIG.minDelay + Math.random() * (CONFIG.maxDelay - CONFIG.minDelay));
    }
    // 可中断的长等待（停止信号会立即唤醒当前这一段的计时器）。
    // 按绝对时间等待；后台冻结或系统休眠后仍需重新读取服务端状态。
    async function waitSeconds(sec) {
        const deadline = Date.now() + sec * 1000;
        runtime.waitUntil = deadline;
        renderDashboard();
        try {
            while (true) {
                checkStop();
                const ms = deadline - Date.now();
                if (ms <= 0) return;
                await sleep(Math.min(ms, 60000));
            }
        } finally { runtime.waitUntil = 0; renderDashboard(); }
    }

    // ---------- API 请求层 ----------
    function getCharacter() {
        try { return sessionStorage.getItem(CHAR_KEY) || ''; } catch (_) { return ''; }
    }

    // 仅为可见 ASCII 角色名保留兼容头；其他名称统一走 URL 编码后的 query 参数。
    function canUseCharacterHeader(value) {
        return /^[\x21-\x7e]+$/.test(value);
    }

    // 统一请求封装：始终通过 query 参数传递角色名，并为兼容旧接口尽量附带角色头
    // 返回完整包络（部分接口在包络顶层还有 settlement/battle 等字段）
    // 中文角色名不能直接写入 HTTP header，否则 XHR 会在 send() 前同步抛错。
    class ApiError extends Error {
        constructor(message, status = 0, code = null, path = '', uncertain = false) {
            super(message); this.status = status; this.code = code; this.path = path;
            this.uncertain = uncertain; this.fatal = status === 401 || status === 403;
        }
    }
    async function api(path, options = {}) {
        checkStop();
        const method = options.method || 'GET';
        const ctx = activeTaskContext;
        const lobbyWrite = ['/dungeon/recruit', '/dungeon/enter', '/dungeon/disband'].includes(path);
        if (method !== 'GET' && ctx?.dungeonId && (lobbyWrite || /^\/dungeon\/node\//.test(path) || path === '/dungeon/retreat')) {
            const current = (await api('/dungeon/current')).data;
            if (!current || current.dungeon_id !== ctx.dungeonId || current.status !== (lobbyWrite ? 'lobby' : 'exploring')
                || (ctx.leaderId && current.leader_id !== ctx.leaderId)
                || (!lobbyWrite && ctx.nodeIndex != null && current.current_node_index !== ctx.nodeIndex)) {
                throw new Error('副本、队长或节点已被其他页面改变，已停止；请刷新状态后接管');
            }
            if (path === '/dungeon/enter' && ctx.requireFullParty) {
                if (current.visibility && current.visibility !== 'public') throw new Error('公开大厅可见性已改变，已停止等待');
                if ((current.members?.length || 0) < 3) {
                    const error = new Error('公开大厅尚未满员，继续等待');
                    error.lobbyNotFull = true;
                    throw error; // 尚未发送进入请求，可以安全地回到等待流程。
                }
            }
            if (path === '/dungeon/node/event/choice' && options.expectedEvent) {
                const latest = (await api('/dungeon/node')).data;
                if (!latest || latest.node_type !== 'event' || latest.index != null && latest.index !== ctx.nodeIndex) throw new Error('提交前事件节点已变化，请重新接管');
                if (nodeResolved(latest)) return { code: 0, data: current }; // 其他页面已选，不重复提交。
                if (JSON.stringify(latest.event) !== JSON.stringify(options.expectedEvent)) throw new Error('提交前事件选项已变化，请重新接管');
            }
        }
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await rawApi(path, options);
                checkStop(ctx);
                observeResponse(path, response);
                return response;
            } catch (e) {
                rethrowIfStopped(e);
                if (method !== 'GET' || attempt >= 2 || !(e instanceof ApiError)
                    || !(e.status === 0 || e.status === 429 || e.status >= 500)) throw e;
                log(`读取暂时失败，重试 ${attempt + 1}/2：${e.message}`, 'warn');
                await sleep(e.status === 429 ? 3000 * (attempt + 1) : 600 * (attempt + 1));
            }
        }
    }
    function observeResponse(path, response) {
        const base = path.split('?')[0];
        if (base === '/status' && activeTaskContext?.batchCharacter && response.data?.username !== activeTaskContext.character) {
            const error = new Error('返回的角色身份与队列目标不一致，已停止整批任务');
            error.fatal = true; throw error;
        }
        if (base === '/status') runtime.status = response.data;
        if (base === '/dungeon/current') runtime.dungeon = response.data || null;
        if (base === '/dungeon/node') {
            if (runtime.dungeon && Number.isFinite(response.sanity)) runtime.dungeon.sanity = response.sanity;
        }
        if (base === '/dungeon/presets' && Array.isArray(response.data)) runtime.presets = response.data;
        if (base.startsWith('/dungeon/') && response.data?.dungeon_id && response.data?.status) runtime.dungeon = response.data;
        renderDashboard();
    }
    function rawApi(path, { method = 'GET', body } = {}) {
        const ctx = activeTaskContext;
        const signal = ctx?.controller.signal;
        if (signal?.aborted) return Promise.reject(ctx.stopError);
        try { checkStop(ctx); } catch (e) { return Promise.reject(e); }
        const char = ctx?.character || getCharacter();
        if (!char) return Promise.reject(new Error('未获取到当前角色名，请先登录游戏并选择角色'));
        const sep = path.includes('?') ? '&' : '?';
        const url = `${API_PREFIX}${path}${sep}_aether_character=${encodeURIComponent(char)}`;
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            let settled = false;
            let stoppedByTask = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbortTask);
                xhr.onload = null;
                xhr.onerror = null;
                xhr.ontimeout = null;
                xhr.onabort = null;
                fn(value);
            };
            const onAbortTask = () => {
                if (settled) return;
                stoppedByTask = true;
                try { xhr.abort(); } catch (_) { /* 仍由下面的 finish 结束 Promise */ }
                finish(reject, ctx.stopError);
            };
            xhr.onload = () => {
                let json = null;
                try { json = JSON.parse(xhr.responseText); } catch (_) { /* 非 JSON 响应 */ }
                if (xhr.status < 200 || xhr.status >= 300) {
                    finish(reject, new ApiError(json?.message || `HTTP ${xhr.status}`, xhr.status, json?.code, path, method !== 'GET' && xhr.status >= 500));
                } else if (!json || json.code !== 0) {
                    finish(reject, new ApiError(json?.message || '服务器返回异常', xhr.status, json?.code, path, method !== 'GET' && !json));
                } else {
                    finish(resolve, json);
                }
            };
            xhr.onerror = () => finish(reject, new ApiError('网络请求失败', 0, null, path, method !== 'GET'));
            xhr.ontimeout = () => finish(reject, new ApiError('请求超时', 0, null, path, method !== 'GET'));
            xhr.onabort = () => finish(reject, stoppedByTask ? ctx.stopError : new Error('请求已取消'));
            try {
                xhr.open(method, url, true);
                xhr.withCredentials = true;
                if (canUseCharacterHeader(char)) xhr.setRequestHeader('X-Aether-Character', char);
                if (body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.timeout = 30000;
                signal?.addEventListener('abort', onAbortTask, { once: true });
                if (signal?.aborted) { onAbortTask(); return; }
                xhr.send(body !== undefined ? JSON.stringify(body) : null);
            } catch (e) {
                finish(reject, e);
            }
        });
    }

    // 奖励数组转可读文本
    function fmtRewards(rewards) {
        if (!Array.isArray(rewards) || !rewards.length) return '';
        return rewards.map((r) => `${r.name || r.item_id || '?'}×${r.quantity ?? r.count ?? 1}`).join('、');
    }

    // ---------- 图形控制台：所有样式均限定在助手面板 ----------
    const NODE_NAMES = { battle: '战斗', elite: '精英', boss: '首领', event: '事件', camp: '营地', shop: '商店', treasure: '宝箱', boss_treasure: '终点宝箱', branch: '分支' };
    const ICONS = {
        logo: 'M12 2 3 20h18L12 2Zm0 6 5 10H7l5-10Z',
        grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
        bolt: 'm13 2-9 12h7l-1 8 10-13h-7l1-7Z',
        compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM16 8l-3 5-5 3 3-5 5-3Z',
        bag: 'M4 7h16v14H4V7Zm4 0V5a4 4 0 0 1 8 0v2',
        settings: 'M4 4v16M12 4v16M20 4v16M1 8h6M9 16h6M17 10h6',
        log: 'M6 3h12v18H6zM9 7h6M9 11h6M9 15h4',
        stop: 'M6 6h12v12H6z', play: 'm8 4 12 8-12 8V4Z',
        refresh: 'M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6',
        minus: 'M5 12h14', chevron: 'm8 5 7 7-7 7', heart: 'M12 21 3 12C-2 5 6 0 12 7c6-7 14-2 9 5l-9 9Z',
        check: 'm4 12 5 5L20 6', clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-16v6l4 3',
        shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z',
    };
    function el(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== '') node.textContent = text;
        return node;
    }
    function icon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', ICONS[name] || ICONS.bolt); svg.appendChild(path); return svg;
    }
    const style = el('style');
    style.textContent = `
#aether-auto-helper-panel{box-sizing:border-box;--bg:#0d1522;--card:#142031;--line:#26374c;--muted:#9aadbf;--text:#e7f0f9;--cyan:#62e0d1;--blue:#7cb7fa;--orange:#f7bd77;--red:#fa929c;position:fixed;right:18px;bottom:18px;width:440px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 36px);display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;z-index:99999;border:1px solid #36495f;border-radius:20px;box-shadow:0 24px 72px #0007;overflow:hidden;color-scheme:dark;text-align:left;letter-spacing:normal}
#aether-auto-helper-panel *{box-sizing:border-box}#aether-auto-helper-panel [hidden]{display:none!important}
#aether-auto-helper-panel button,#aether-auto-helper-panel input,#aether-auto-helper-panel select{font:inherit;color:inherit;letter-spacing:normal}#aether-auto-helper-panel button{cursor:pointer;line-height:1.35;transition:background .15s,border-color .15s}#aether-auto-helper-panel button:disabled{opacity:.42;cursor:not-allowed}#aether-auto-helper-panel button:focus-visible,#aether-auto-helper-panel input:focus-visible,#aether-auto-helper-panel select:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
#aether-auto-helper-panel svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}#aether-auto-helper-panel .ah-head{display:flex;align-items:center;gap:10px;padding:17px 18px 13px;flex:none;touch-action:none;user-select:none;cursor:move}#aether-auto-helper-panel .ah-emblem{display:grid;place-items:center;width:37px;height:37px;border:1px solid #62e0d144;background:#62e0d10e;border-radius:11px;color:var(--cyan)}#aether-auto-helper-panel .ah-emblem svg{width:24px;height:24px}#aether-auto-helper-panel .ah-brand{flex:1;min-width:0}#aether-auto-helper-panel .ah-brand strong{font-size:16px;letter-spacing:3px;font-weight:700}#aether-auto-helper-panel .ah-brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:1.1px}#aether-auto-helper-panel .ah-version{font-size:10px;color:var(--muted);padding:2px 6px;border:1px solid var(--line);border-radius:6px;margin-left:8px;vertical-align:2px}
#aether-auto-helper-panel .ah-icon-btn{background:transparent;border:1px solid var(--line);border-radius:9px;padding:7px;display:grid;place-items:center;min-width:32px;min-height:32px}#aether-auto-helper-panel .ah-icon-btn:hover{background:var(--card)}#aether-auto-helper-panel .ah-stop{color:var(--red);border-color:#fa929c40}#aether-auto-helper-panel .ah-status{padding:0 18px 13px;display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px}#aether-auto-helper-panel .ah-dot{width:6px;height:6px;background:var(--cyan);border-radius:50%;flex:none}#aether-auto-helper-panel[data-outcome=error] .ah-dot{background:var(--red)}#aether-auto-helper-panel .ah-status-text{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#aether-auto-helper-panel .ah-character{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
#aether-auto-helper-panel .ah-tabs{display:grid;grid-template-columns:repeat(6,1fr);padding:0 10px;border-bottom:1px solid var(--line);gap:2px;flex:none}#aether-auto-helper-panel .ah-tab{border:0;border-bottom:2px solid transparent;background:none;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 3px 11px;font-size:11px}#aether-auto-helper-panel .ah-tab[aria-selected=true]{border-bottom-color:var(--cyan);color:var(--cyan);background:linear-gradient(transparent,#62e0d109)}
#aether-auto-helper-panel .ah-content{overflow:auto;min-height:0;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#3b526b transparent;padding:16px;flex:1}#aether-auto-helper-panel .ah-page{display:flex;flex-direction:column;gap:12px}#aether-auto-helper-panel .ah-card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:14px;min-width:0}#aether-auto-helper-panel .ah-card-head{display:flex;align-items:center;gap:7px;margin-bottom:11px;font-weight:600;color:var(--text)}#aether-auto-helper-panel .ah-card-head svg{color:var(--cyan);width:16px;height:16px}#aether-auto-helper-panel .ah-sub{color:var(--muted);font-size:11px;line-height:1.65;margin:5px 0 10px}#aether-auto-helper-panel .ah-eyebrow{font-size:10px;letter-spacing:1.8px;color:var(--cyan);margin-bottom:6px}#aether-auto-helper-panel .ah-hero{background:radial-gradient(ellipse at 100% 0,#23506460,transparent 65%),var(--card)}#aether-auto-helper-panel .ah-hero-row{display:flex;align-items:center;gap:14px}#aether-auto-helper-panel .ah-hero-copy{min-width:0;flex:1}#aether-auto-helper-panel .ah-hero-title{font-size:20px;font-weight:650;margin:3px 0 6px;overflow-wrap:anywhere;letter-spacing:-.5px}#aether-auto-helper-panel .ah-hero-meta{color:var(--muted);font-size:11px}#aether-auto-helper-panel .ah-ring{--value:0;flex:none;width:78px;height:78px;border-radius:50%;padding:5px;background:conic-gradient(var(--cyan) calc(var(--value)*1%),#26394c 0);display:grid;place-items:center}#aether-auto-helper-panel .ah-ring-inner{width:68px;height:68px;background:#142435;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center}#aether-auto-helper-panel .ah-ring strong{font-size:22px;line-height:1.25;font-variant-numeric:tabular-nums}#aether-auto-helper-panel .ah-ring small{font-size:10px;color:var(--muted)}
#aether-auto-helper-panel .ah-progress{height:5px;background:#28384c;border-radius:5px;overflow:hidden;margin-top:14px}#aether-auto-helper-panel .ah-progress>span{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--blue),var(--cyan));transition:width .3s}#aether-auto-helper-panel .ah-progress-label{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--muted);margin-top:7px}
#aether-auto-helper-panel .ah-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}#aether-auto-helper-panel .ah-stat{background:var(--card);border:1px solid var(--line);padding:11px 8px;border-radius:10px;min-width:0}#aether-auto-helper-panel .ah-stat strong{display:block;font-size:21px;font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums}#aether-auto-helper-panel .ah-stat small{font-size:10px;color:var(--muted)}#aether-auto-helper-panel .ah-stat:nth-child(1) strong{color:var(--cyan)}#aether-auto-helper-panel .ah-stat:nth-child(2) strong{color:var(--red)}#aether-auto-helper-panel .ah-stat:nth-child(3) strong{color:var(--blue)}#aether-auto-helper-panel .ah-stat:nth-child(4) strong{color:var(--orange)}
#aether-auto-helper-panel .ah-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}#aether-auto-helper-panel .ah-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #39506a;border-radius:9px;background:#1b2c41;padding:9px 12px;min-height:36px;font-size:12px;font-weight:550}#aether-auto-helper-panel .ah-btn:hover{background:#253c54}#aether-auto-helper-panel .ah-btn.primary{background:var(--cyan);border-color:var(--cyan);color:#092523}#aether-auto-helper-panel .ah-btn.primary:hover{background:#89eee2}#aether-auto-helper-panel .ah-btn.danger{color:var(--red);border-color:#fa929c50}#aether-auto-helper-panel .ah-grow{flex:1}#aether-auto-helper-panel .ah-divider{height:1px;background:var(--line);margin:13px 0}#aether-auto-helper-panel .ah-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:12px}#aether-auto-helper-panel .ah-field{display:flex;flex-direction:column;gap:5px;min-width:0;color:var(--muted);font-size:11px}#aether-auto-helper-panel .ah-field.full{grid-column:1/-1}#aether-auto-helper-panel input[type=number],#aether-auto-helper-panel input[type=search],#aether-auto-helper-panel select{width:100%;min-width:0;border:1px solid #32455c;border-radius:8px;padding:8px 9px;background:#0e1928;color:var(--text);min-height:35px;outline:none}#aether-auto-helper-panel input[type=checkbox]{accent-color:var(--cyan);width:15px;height:15px;flex:none;margin:0}#aether-auto-helper-panel .ah-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;font-size:12px}#aether-auto-helper-panel .ah-toggle span{flex:1}#aether-auto-helper-panel .ah-note{border-left:2px solid var(--blue);background:#7cb7fa0a;color:#b9cde1;padding:9px 11px;font-size:11px;line-height:1.65;border-radius:0 7px 7px 0;overflow-wrap:anywhere}#aether-auto-helper-panel .ah-review{border:1px solid #f7bd7760;background:#f7bd770a;border-radius:10px;padding:12px}#aether-auto-helper-panel .ah-review-title{color:var(--orange);font-weight:600;margin-bottom:6px}
#aether-auto-helper-panel .ah-route{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:5px;margin:10px 0}#aether-auto-helper-panel .ah-node{width:100%;aspect-ratio:1;display:grid;place-items:center;border:1px solid #33455c;border-radius:7px;color:var(--muted);font-size:10px}#aether-auto-helper-panel .ah-node.done{background:#62e0d117;border-color:#62e0d140;color:var(--cyan)}#aether-auto-helper-panel .ah-node.current{background:var(--cyan);color:#092523;border-color:var(--cyan);box-shadow:0 0 12px #62e0d130}#aether-auto-helper-panel .ah-node.boss{border-color:#f7bd7770}#aether-auto-helper-panel .ah-legend{display:flex;gap:12px;color:var(--muted);font-size:10px}#aether-auto-helper-panel .ah-legend b{font-weight:400;color:var(--cyan)}#aether-auto-helper-panel .ah-team{display:flex;flex-direction:column;gap:12px}#aether-auto-helper-panel .ah-member-head{display:flex;justify-content:space-between;font-size:11px;gap:8px;margin-bottom:5px}#aether-auto-helper-panel .ah-member-head small{color:var(--muted)}#aether-auto-helper-panel .ah-meter-row{display:flex;align-items:center;gap:6px;font-size:9px;color:var(--muted);margin-top:4px}#aether-auto-helper-panel .ah-meter-row>span:first-child{width:18px}#aether-auto-helper-panel .ah-meter{height:4px;background:#28384b;flex:1;border-radius:3px;overflow:hidden}#aether-auto-helper-panel .ah-meter i{display:block;height:100%;background:var(--cyan)}#aether-auto-helper-panel .ah-meter-row.ap i{background:var(--blue)}#aether-auto-helper-panel .ah-meter-value{min-width:64px;text-align:right}
#aether-auto-helper-panel .ah-list{max-height:260px;overflow:auto;scrollbar-width:thin;display:flex;flex-direction:column;gap:5px}#aether-auto-helper-panel .ah-item{display:flex;align-items:center;gap:9px;padding:9px;border:1px solid var(--line);border-radius:8px;background:#101b2a;cursor:pointer}#aether-auto-helper-panel .ah-item:has(input:checked){border-color:#62e0d180;background:#62e0d10a}#aether-auto-helper-panel .ah-item-copy{min-width:0;flex:1;overflow-wrap:anywhere;font-size:12px}#aether-auto-helper-panel .ah-item small{display:block;color:var(--muted);font-size:10px}#aether-auto-helper-panel .ah-item-badge{font-size:10px;color:var(--muted);flex:none}#aether-auto-helper-panel .ah-empty{padding:18px 10px;text-align:center;color:var(--muted);font-size:12px}#aether-auto-helper-panel .ah-empty svg{width:26px;height:26px;opacity:.6;margin-bottom:6px}
#aether-auto-helper-panel .ah-logs{display:flex;flex-direction:column;gap:7px}#aether-auto-helper-panel .ah-log-line{border-left:2px solid #39506a;padding:8px 9px;background:#142031;border-radius:0 7px 7px 0;overflow-wrap:anywhere;white-space:pre-wrap;font-size:11px;color:#c5d5e5}#aether-auto-helper-panel .ah-log-line.success{border-color:var(--cyan)}#aether-auto-helper-panel .ah-log-line.warn{border-color:var(--orange)}#aether-auto-helper-panel .ah-log-line.error{border-color:var(--red)}#aether-auto-helper-panel .ah-log-line time{color:var(--muted);font-size:10px;margin-right:8px}#aether-auto-helper-panel .ah-foot{display:flex;align-items:center;gap:8px;flex:none;padding:10px 16px;border-top:1px solid var(--line);background:#0c1420;color:var(--muted);font-size:10px}#aether-auto-helper-panel .ah-foot>span:first-child{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#aether-auto-helper-panel .ah-time{font-variant-numeric:tabular-nums}
#aether-auto-helper-panel.ah-collapsed{width:52px!important;height:52px!important;border-radius:17px;min-height:0;max-height:52px}#aether-auto-helper-panel.ah-collapsed .ah-head,#aether-auto-helper-panel.ah-collapsed .ah-status,#aether-auto-helper-panel.ah-collapsed .ah-tabs,#aether-auto-helper-panel.ah-collapsed .ah-content,#aether-auto-helper-panel.ah-collapsed .ah-foot{display:none}#aether-auto-helper-panel .ah-launcher{display:none;background:none;border:0;width:100%;height:100%;color:var(--cyan);touch-action:none}#aether-auto-helper-panel.ah-collapsed .ah-launcher{display:grid;place-items:center}#aether-auto-helper-panel .ah-launcher svg{width:27px;height:27px}
#aether-auto-helper-panel .ah-update-btn{flex:none;padding:7px 8px;min-height:32px;font-size:11px;color:var(--cyan);white-space:nowrap}
@media(max-width:520px){#aether-auto-helper-panel{right:10px;bottom:76px;width:calc(100vw - 20px);max-width:calc(100vw - 20px);max-height:calc(100dvh - 100px);border-radius:16px}#aether-auto-helper-panel .ah-head{padding:12px 14px 10px}#aether-auto-helper-panel .ah-content{padding:12px}#aether-auto-helper-panel .ah-card{padding:12px}#aether-auto-helper-panel .ah-tab{padding-top:8px;padding-bottom:9px}#aether-auto-helper-panel .ah-hero-title{font-size:18px}}
@media(max-width:520px){#aether-auto-helper-panel .ah-head{gap:6px}#aether-auto-helper-panel .ah-emblem{width:30px;height:30px}#aether-auto-helper-panel .ah-brand strong{display:block;font-size:14px;letter-spacing:2px}#aether-auto-helper-panel .ah-version{display:inline-block;margin-left:0;vertical-align:baseline}#aether-auto-helper-panel .ah-brand small{display:none}}
@media(prefers-reduced-motion:reduce){#aether-auto-helper-panel *{transition:none!important}}
`;
    document.head.appendChild(style);
    const panel = el('div'); panel.id = 'aether-auto-helper-panel'; panel.setAttribute('aria-label', 'Aether 自动助手');
    const ui = { ready: false, pages: {}, controls: {}, taskButtons: [], tab: 'overview', teamKey: '', routeKey: '' };
    const header = el('div', 'ah-head');
    const emblem = el('div', 'ah-emblem'); emblem.appendChild(icon('logo'));
    const brand = el('div', 'ah-brand'); brand.append(el('strong', '', 'AETHER'), el('span', 'ah-version', VERSION), el('small', '', '自动助手 / AUTOMATION'));
    const stopBtn = el('button', 'ah-icon-btn ah-stop'); stopBtn.appendChild(icon('stop')); stopBtn.title = '停止当前任务'; stopBtn.setAttribute('aria-label', stopBtn.title); stopBtn.disabled = true;
    const collapseBtn = el('button', 'ah-icon-btn'); collapseBtn.appendChild(icon('minus')); collapseBtn.setAttribute('aria-label', '收起助手');
    const updateBtn = el('button', 'ah-btn ah-update-btn', '检查更新');
    updateBtn.title = '检查新版本并打开油猴安装确认页';
    updateBtn.setAttribute('aria-label', '检查脚本更新');
    header.append(emblem, brand, updateBtn, stopBtn, collapseBtn);
    const statusBar = el('div', 'ah-status');
    const statusLine = el('span', 'ah-status-text', '就绪'); statusLine.setAttribute('role', 'status');
    const characterLabel = el('span', 'ah-character', '未选择角色');
    statusBar.append(el('span', 'ah-dot'), statusLine, characterLabel);
    const tabs = el('div', 'ah-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '助手功能');
    const content = el('div', 'ah-content');
    const footer = el('div', 'ah-foot');
    const footerText = el('span', '', '状态尚未同步'); const timeLabel = el('span', 'ah-time', '00:00'); footer.append(footerText, timeLabel);
    const launcher = el('button', 'ah-launcher'); launcher.appendChild(icon('logo')); launcher.setAttribute('aria-label', '展开助手');
    panel.append(header, statusBar, tabs, content, footer, launcher);
    let collapsed = readStorage('aether-helper-v2-collapsed', false) === true;
    let expandedPosition = null, launcherPosition = null;
    function constrainPanel() {
        if (!panel.style.left) return;
        const rect = panel.getBoundingClientRect();
        panel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8))}px`;
        panel.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - rect.height - 8))}px`;
    }
    function applyCollapsed() {
        panel.classList.toggle('ah-collapsed', collapsed);
        const position = collapsed ? launcherPosition : expandedPosition;
        panel.style.left = position ? `${position.x}px` : '';
        panel.style.top = position ? `${position.y}px` : '';
        panel.style.right = position ? 'auto' : '';
        panel.style.bottom = position ? 'auto' : '';
        writeStorage('aether-helper-v2-collapsed', collapsed);
        constrainPanel();
    }
    collapseBtn.onclick = () => { collapsed = true; applyCollapsed(); };
    let suppressLauncherClick = false;
    launcher.onclick = () => { if (suppressLauncherClick) return; collapsed = false; applyCollapsed(); };
    function bindDrag(target) {
        target.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || (target === header && event.target.closest('button'))) return;
            if (target === launcher) suppressLauncherClick = false;
            const rect = panel.getBoundingClientRect();
            const sx = event.clientX, sy = event.clientY; let moved = false;
            target.setPointerCapture?.(event.pointerId);
            const move = (e) => {
                if (Math.hypot(e.clientX - sx, e.clientY - sy) < 5 && !moved) return;
                moved = true; panel.style.right = 'auto'; panel.style.bottom = 'auto';
                panel.style.left = `${rect.left + e.clientX - sx}px`; panel.style.top = `${rect.top + e.clientY - sy}px`; constrainPanel();
            };
            const end = (e) => {
                target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end);
                if (moved) {
                    const r = panel.getBoundingClientRect();
                    if (collapsed) launcherPosition = { x: r.left, y: r.top }; else expandedPosition = { x: r.left, y: r.top };
                    if (target === launcher) { suppressLauncherClick = true; setTimeout(() => { suppressLauncherClick = false; }, 300); }
                }
                // 触屏拖动之后浏览器可能不合成 click；直接处理未移动的 pointerup。
                if (!moved && target === launcher && e.type === 'pointerup') { collapsed = false; applyCollapsed(); }
            };
            target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
        });
    }
    bindDrag(header); bindDrag(launcher); window.addEventListener('resize', constrainPanel);
    function log(message, type = 'info') {
        if (activeTaskContext?.batchCharacter) message = `[@${activeTaskContext.character}] ${message}`;
        const record = { message: String(message), type, at: Date.now() };
        runtime.logs.unshift(record); if (runtime.logs.length > 200) runtime.logs.length = 200;
        footerText.textContent = record.message; footerText.title = record.message;
        if (ui.ready && ui.tab === 'logs') renderLogs();
    }
    function setBusy(busy) {
        stopBtn.disabled = !busy;
        for (const button of ui.taskButtons) button.disabled = busy;
        for (const control of Object.values(ui.controls)) control.disabled = busy;
        for (const control of panel.querySelectorAll('[data-lock-task]')) control.disabled = busy || control.dataset.protected === '1';
    }
    function renderDashboard() {
        if (!ui.ready) return;
        panel.dataset.outcome = runtime.outcome;
        statusLine.textContent = runningTask ? `${runningTask} · ${runtime.phase}` : runtime.phase;
        characterLabel.textContent = activeTaskContext?.character || getCharacter() || '未选择角色';
        const elapsed = runtime.startedAt ? Math.max(0, ((runtime.endedAt || Date.now()) - runtime.startedAt) / 1000) : 0;
        timeLabel.textContent = formatDuration(elapsed);
        const waiting = Math.max(0, Math.ceil((runtime.waitUntil - Date.now()) / 1000));
        ui.heroTitle.textContent = runningTask ? runtime.phase : ({ success: '本次任务已完成', partial: '处理结束，请查看日志', stopped: '任务已停止', error: '任务暂停，等待处理' }[runtime.outcome] || '准备好下一场探索');
        ui.heroMeta.textContent = runningTask ? `${runtime.task} · 已运行 ${formatDuration(elapsed)}` : '日常、探索与装备管理，在这里安排。';
        const dungeon = runtime.dungeon;
        const sanity = Number.isFinite(dungeon?.sanity) && dungeon.status === 'exploring' ? dungeon.sanity : null;
        ui.ring.style.setProperty('--value', sanity == null ? 0 : Math.max(0, Math.min(100, sanity * 5)));
        ui.ring.style.setProperty('--cyan', sanity != null && sanity < 10 ? '#f7bd77' : '#62e0d1');
        ui.ringValue.textContent = sanity == null ? '—' : sanity;
        ui.ring.setAttribute('aria-label', sanity == null ? '当前无探索理智数据' : `理智 ${sanity}/20`);
        const ratio = runtime.total > 0 ? Math.min(1, runtime.progress / runtime.total) : 0;
        ui.progress.style.width = `${ratio * 100}%`;
        ui.progressLabel.textContent = runtime.total ? `任务进度 ${runtime.progress} / ${runtime.total}` : '等待任务开始';
        ui.waitLabel.textContent = waiting ? `等待 ${formatDuration(waiting)}` : runtime.task || '手动启动';
        [runtime.wins, runtime.losses, runtime.accelUsed, runtime.shopSpent].forEach((n, i) => { ui.stats[i].textContent = String(n); });
        renderExploration(dungeon); renderPolicySummary();
    }
    function formatDuration(value) {
        const sec = Math.max(0, Math.floor(value));
        return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    }
    function renderExploration(dungeon) {
        const active = dungeon && !isDungeonTerminal(dungeon);
        ui.dungeonTitle.textContent = active ? dungeon.preset_name || '当前探索' : '当前没有进行中的探索';
        ui.dungeonMeta.textContent = active ? `${dungeon.status === 'lobby' ? '组队大厅' : '探索中'} · 节点 ${natural(dungeon.current_node_index) + 1} / ${dungeon.nodes?.length || '—'}` : '同步状态或开始探索后显示路线与队伍';
        const routeKey = JSON.stringify([dungeon?.dungeon_id, dungeon?.current_node_index, dungeon?.status, dungeon?.nodes?.map((n) => [n.index, n.node_type, n.completed])]);
        if (routeKey !== ui.routeKey) {
            ui.routeKey = routeKey; ui.route.replaceChildren();
            if (active) for (const [i, node] of (dungeon.nodes || []).entries()) {
                const piece = el('span', `ah-node ${node.completed ? 'done' : ''} ${i === dungeon.current_node_index ? 'current' : ''} ${node.node_type === 'boss' ? 'boss' : ''}`, String(i + 1));
                const name = node.node_type === 'camp' ? campPolicy(dungeon, { ...node, index: node.index ?? i }).label : NODE_NAMES[node.node_type] || node.node_type;
                piece.title = `${i + 1} · ${name}${node.completed ? ' · 已完成' : ''}`;
                piece.setAttribute('aria-label', piece.title); ui.route.appendChild(piece);
            }
        }
        const teamKey = JSON.stringify([dungeon?.members, dungeon?.member_status, dungeon?.status]);
        if (teamKey !== ui.teamKey) {
            ui.teamKey = teamKey; ui.team.replaceChildren();
            if (!active || !dungeon.members?.length) ui.team.appendChild(el('div', 'ah-empty', '队伍数据将在同步后显示'));
            else for (const m of dungeon.members) {
                const row = el('div'); const head = el('div', 'ah-member-head');
                head.append(el('span', '', m.name || m.key), el('small', '', m.key === dungeon.leader_id ? '队长' : '队员')); row.appendChild(head);
                for (const [kind, max] of [['hp', m.max_hp], ['ap', m.max_ap]]) {
                    const value = dungeon.member_status?.[m.key]?.[kind];
                    const meterRow = el('div', `ah-meter-row ${kind}`), meter = el('span', 'ah-meter'), fill = el('i');
                    fill.style.width = `${Number.isFinite(value) && max > 0 ? Math.max(0, Math.min(100, value / max * 100)) : 0}%`;
                    meter.appendChild(fill); meterRow.append(el('span', '', kind.toUpperCase()), meter, el('span', 'ah-meter-value', `${value ?? '—'}/${max ?? '—'}`)); row.appendChild(meterRow);
                }
                ui.team.appendChild(row);
            }
        }
    }

    // 中断任务：触发当前任务自己的停止信号，立即取消它的 XHR 与计时等待。
    function requestTaskStop() {
        const ctx = activeTaskContext;
        if (!runningTask || !ctx) {
            log('当前没有执行中的任务', 'info');
            return;
        }
        if (ctx.controller.signal.aborted) return;
        log(`正在停止「${runningTask}」…`, 'warn');
        ctx.controller.abort(ctx.stopError);
    }

    stopBtn.onclick = () => requestTaskStop();

    // 调用游戏自身的 Pinia store 刷新前台数据（不重载页面）：
    // #app.__vue_app__ → globalProperties.$pinia → _s(Map of stores)，对各 store 调它自己的 fetch* 方法
    async function refreshGameState() {
        await api('/status');
        const app = document.querySelector('#app')?.__vue_app__;
        const stores = app?.config?.globalProperties?.$pinia?._s;
        if (!stores) return;
        const store = [...stores.values()].find((x) => typeof x.fetchStatus === 'function');
        if (store) await awaitTaskRead(store.fetchStatus(), 10000);
        checkStop();
    }
    function awaitTaskRead(promise, timeout) {
        const ctx = activeTaskContext;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true; clearTimeout(timer);
                ctx?.controller.signal.removeEventListener('abort', stop);
                fn(value);
            };
            const stop = () => finish(reject, ctx.stopError);
            const timer = setTimeout(() => finish(reject, new Error('游戏前台刷新超时')), timeout);
            ctx?.controller.signal.addEventListener('abort', stop, { once: true });
            Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
            if (ctx?.controller.signal.aborted) stop();
        });
    }
    async function withCharacterLock(character, fn) {
        if (!navigator.locks?.request) throw new Error('浏览器不支持任务锁，请使用新版 Chrome / Edge');
        return navigator.locks.request(`aether-helper:${character}`, { ifAvailable: true }, async (lock) => {
            if (!lock) throw new Error('另一标签页正在操作该角色，请先停止那里的助手');
            return fn();
        });
    }

    // 任务互斥执行包装：同一时间只跑一个任务
    async function runTask(name, fn, { batch = false } = {}) {
        if (runningTask) { log(`「${runningTask}」执行中，请等待或停止`, 'warn'); return; }
        reconcileCharacter();
        const character = getCharacter();
        if (!character) { log('请先登录游戏并选择角色', 'warn'); return; }
        clearSettingsImport();
        const ctx = {
            name, character, settings: { ...settings, friends: [...preferredFriends], characterOrder: [...settings.characterOrder], dailyShopOverrides: { ...settings.dailyShopOverrides } },
            controller: new AbortController(), stopError: new StopError(),
            dungeonId: null, nodeIndex: null, accelUsed: 0,
        };
        runningTask = name; activeTaskContext = ctx;
        Object.assign(runtime, { task: name, phase: '正在准备', startedAt: Date.now(), endedAt: 0,
            progress: 0, total: 0, outcome: 'running', ...newCounters() });
        setBusy(true); renderDashboard();
        try {
            const execute = async () => {
                checkStop(ctx); await fn(); checkStop(ctx);
                if (!batch && ctx.settings.sync) {
                    try { await refreshGameState(); }
                    catch (e) { rethrowIfStopped(e); markIssue(`角色数据同步失败：${e.message}`); }
                }
                checkStop(ctx);
            };
            if (batch) await execute();
            else await withCharacterLock(character, execute);
            runtime.outcome = runtime.issues ? 'partial' : 'success';
            runtime.phase = runtime.issues ? `处理结束 · ${runtime.issues} 项需留意` : '任务完成';
            log(`「${name}」${runtime.issues ? '处理结束，详情见日志' : '完成'}`, runtime.issues ? 'warn' : 'success');
        } catch (e) {
            runtime.outcome = isStopError(e) ? 'stopped' : 'error';
            runtime.phase = isStopError(e) ? '已停止' : '需要处理';
            log(`「${name}」${isStopError(e) ? e.message : `出错：${e.message}`}`, isStopError(e) ? 'warn' : 'error');
            if (e.uncertain) log('请求结果未确认：操作可能已在服务器执行，请先刷新状态再继续。', 'warn');
        } finally {
            if (activeTaskContext === ctx) {
                runningTask = null; activeTaskContext = null;
                runtime.endedAt = Date.now(); runtime.waitUntil = 0;
                setBusy(false); reconcileCharacter(); renderDashboard();
            }
        }
    }

    document.body.appendChild(panel);

    /******************** 功能实现 ********************/

    // ---------- 1. 邮件一键领取 ----------
    async function doMail() {
        const mails = (await api('/mail')).data?.mails || [];
        const claimable = mails.filter((m) => !m.claimed && m.has_items);
        if (!claimable.length) { log('邮件：没有可领取的物品', 'info'); return; }
        let ok = 0;
        for (const m of claimable) {
            checkStop();
            try {
                await api(`/mail/${m.mail_id}/claim`, { method: 'POST' });
                ok++;
            } catch (e) {
                rethrowIfStopped(e);
                markIssue(`邮件 #${m.mail_id} 领取失败：${e.message}`);
            }
            await jitter();
        }
        log(`邮件：已领取 ${ok}/${claimable.length} 封`, 'success');
    }

    // ---------- 战斗自动编队（战斗 prepare 后、start/complete 前调用） ----------
    // GET /battle/{id} 的 preset.allies[] 决定各槽类型：character=自己、helper=好友、preset=锁定角色；
    // 空槽需 GET /position/{pos}/options，并将选中项的完整 entry POST 到 /register。
    // 编队完成后按站位策略换位；自定义顺序失败时暂停，避免按错误顺序开战。
    function isPreferredEntry(option) {
        const keys = taskSettings().friends || [];
        return keys.includes(option?.entry?.key) || keys.includes(option?.username);
    }
    async function setupBattleLineup(entryId, label, policy = taskSettings()) {
        if (!entryId) return null;
        let state = (await api(`/battle/${entryId}`)).data || {};
        if (state.result || state.status === 'ongoing' || state.status === 'completed') return state;
        if (policy.lineupDungeon) {
            // 新战斗 prepare 后先刷新完整探索，再确定专属策略，避免部分响应丢失队伍或预设。
            policy = dungeonPolicy(await refreshLineupDungeon(policy.lineupDungeon, label), policy);
        }

        const presetSlots = Array.isArray(state.preset?.allies) ? state.preset.allies : [];
        const allies = Array.isArray(state.allies) ? state.allies : [];
        const slotCount = Math.max(presetSlots.length, allies.length, 1);
        const usedKeys = new Set(allies.map((a) => a?.entry?.key).filter(Boolean));

        for (let pos = 0; pos < slotCount; pos++) {
            checkStop();
            const slot = presetSlots[pos] || {};
            const current = state.allies?.[pos];
            if (slot.type === 'preset' || (current && (current.entry || current.battler))) continue;

            let optionData;
            try {
                optionData = (await api(`/battle/${entryId}/position/${pos}/options`)).data || {};
            } catch (e) {
                rethrowIfStopped(e);
                log(`${label}：读取 ${pos + 1} 号位选项失败（${e.message}）`, 'warn');
                continue;
            }

            const expectedType = optionData.ally_type || slot.type || '';
            let candidates = (optionData.options || [])
                .filter((o) => o?.entry?.key && !usedKeys.has(o.entry.key))
                .sort((a, b) => Number(isPreferredEntry(b)) - Number(isPreferredEntry(a)) || (b.level ?? 0) - (a.level ?? 0));
            if (expectedType) candidates = candidates.filter((o) => o.entry?.ally_type === expectedType);

            let best = null;
            if (expectedType === 'character') {
                best = candidates.find((o) => o.entry?.ally_type === 'character');
            } else if (expectedType === 'helper') {
                best = candidates.find((o) => o.entry?.ally_type === 'helper');
            } else {
                best = candidates.find((o) => o.entry?.ally_type === 'helper')
                    || candidates.find((o) => o.entry?.ally_type === 'character');
            }

            if (!best) {
                const what = expectedType === 'helper' ? '好友助战' : expectedType === 'character' ? '自己的角色' : '可用角色';
                log(`${label}：${pos + 1} 号位没有${what}${expectedType === 'helper' ? '，跳过可选助战位' : ''}`, expectedType === 'helper' ? 'info' : 'warn');
                continue;
            }

            try {
                await api(`/battle/${entryId}/position/${pos}/register`, { method: 'POST', body: best.entry });
            } catch (e) {
                rethrowIfStopped(e);
                log(`${label}：${pos + 1} 号位登记失败（${e.message}）`, 'warn');
                continue;
            }

            usedKeys.add(best.entry.key);
            const type = best.entry.ally_type;
            const name = best.remark || best.battler?.name || best.entry.key;
            if (type === 'helper') {
                log(`${label}：已借好友「${name}」(Lv.${best.level ?? '?'}) 放到 ${pos + 1} 号位`, 'success');
            } else {
                log(`${label}：已将自己的角色「${name}」放到 ${pos + 1} 号位`, 'success');
            }
            await jitter();
            state = (await api(`/battle/${entryId}`)).data || state;
            if (state.result || state.status === 'ongoing' || state.status === 'completed') return state;
        }

        if (policy.front === 'custom') return applyCharacterOrder(entryId, label, policy);
        // 生命值优先模式保留原有容错行为。
        try {
            state = await moveTankToFront(entryId, label);
        } catch (e) {
            rethrowIfStopped(e);
            log(`${label}：调整 1 号位失败（${e.message}），按原阵容继续`, 'warn');
        }
        return state;
    }

    // 生命值最高的队友换到 1 号位。官方换位：POST /battle/{id}/swap {index1,index2}，
    // 下标为 allies 数组的 0 基下标；显示站位 = allies_order[i] || i+1，1 号位即站位 1。
    async function moveTankToFront(entryId, label) {
        if (taskSettings().front === 'keep') return (await api(`/battle/${entryId}`)).data;
        let state = (await api(`/battle/${entryId}`)).data || {};
        if (state.result || state.status === 'ongoing' || state.status === 'completed') return state;
        const allies = Array.isArray(state.allies) ? state.allies : [];
        const order = Array.isArray(state.allies_order) ? state.allies_order : [];
        const filled = allies
            .map((a, i) => ({
                i,
                name: a?.battler?.name || a?.remark || '',
                hp: Number(a?.battler?.max_hp ?? 0),
                pos: Number(order[i]) || i + 1,
            }))
            .filter((x) => allies[x.i]?.battler);
        if (filled.length < 2) return state;
        const tank = filled.reduce((best, x) => (x.hp > best.hp ? x : best));
        const front = filled.find((x) => x.pos === 1);
        if (!front || tank.i === front.i) return state;
        await api(`/battle/${entryId}/swap`, { method: 'POST', body: { index1: tank.i, index2: front.i } });
        log(`${label}：已将生命值最高的「${tank.name || '?'}」(HP ${tank.hp}) 换到 1 号位`, 'success');
        return (await api(`/battle/${entryId}`)).data || state;
    }

    function battleOrderRows(state) {
        if (!Array.isArray(state?.allies)) throw new Error('战斗阵容数据缺失，已停止排序');
        const rows = state.allies.map((ally, index) => ({ ally, index, position: state.allies_order?.[index] || index + 1 }));
        if (rows.some(r => !Number.isInteger(r.position) || r.position < 1 || r.position > rows.length) ||
            new Set(rows.map(r => r.position)).size !== rows.length) throw new Error('战斗站位数据异常，已停止排序');
        return rows.filter(r => r.ally?.battler).sort((a, b) => a.position - b.position);
    }
    const battleStarted = state => !!state?.result || ['ongoing', 'completed'].includes(state?.status);
    const battleOrderSignature = state => JSON.stringify([state?.allies_order, state?.preset?.allies,
        state?.allies?.map(a => [a?.entry && { ...a.entry, battler_cache: a.entry.battler_cache && {
            ...a.entry.battler_cache, position: undefined, // 换位可同步更新缓存站位，不属于角色替换。
        } }, a?.username, a?.battler?.name])]);
    function battleOrderAccount(ally, dungeon) {
        if (ally?.entry?.ally_type !== 'dungeon_member') return ally?.entry?.key || ally?.username || '';
        // entry.key 可能是账号、显示名或战斗内部标识；只与本场最新队伍精确关联。
        // username 明确给出账号时优先使用，否则结合 key 与实际战斗名，拒绝冲突或同名歧义。
        const members = dungeon?.members || [];
        const matches = members.filter(m => m.key && (ally.username
            ? ally.username === m.key
            : ally.entry.key === m.key || m.name && (ally.entry.key === m.name || ally.battler?.name === m.name)));
        if (matches.length !== 1) throw new Error(`地下城角色「${ally?.battler?.name || ally?.entry?.key || '?'}」无法唯一关联队伍账号（匹配 ${matches.length} 人，已刷新队伍），请核对队员昵称后接管`);
        return matches[0].key;
    }
    async function refreshLineupDungeon(previous, label) {
        const ctx = activeTaskContext, dungeonId = ctx?.dungeonId || previous?.dungeon_id;
        const nodeIndex = ctx?.nodeIndex ?? previous?.current_node_index;
        const leaderId = ctx?.leaderId || previous?.leader_id;
        const latest = await fetchCurrentDungeon();
        if (!dungeonId || latest?.dungeon_id !== dungeonId || latest.status !== 'exploring' ||
            nodeIndex != null && latest.current_node_index !== nodeIndex || leaderId && latest.leader_id !== leaderId) {
            throw new Error(`${label}：排序前探索、节点或队长已变化，请重新接管`);
        }
        if (!Array.isArray(latest.members) || !latest.members.length) throw new Error(`${label}：最新队伍数据缺失，已暂停排序`);
        return latest;
    }
    async function applyCharacterOrder(entryId, label, policy = taskSettings()) {
        let state = (await api(`/battle/${entryId}`)).data;
        if (battleStarted(state)) return state;
        const rows = battleOrderRows(state), desired = [];
        if (rows.some(({ ally }) => ally.entry?.ally_type === 'dungeon_member')) {
            policy = { ...policy, lineupDungeon: await refreshLineupDungeon(policy.lineupDungeon, label) };
        }
        const accounts = new Map(rows.map(({ ally, index }) => [index, battleOrderAccount(ally, policy.lineupDungeon)]));
        if (policy.lineupDungeon && new Set(accounts.values()).size !== rows.length) throw new Error(`${label}：战斗角色重复关联同一账号，已暂停排序`);
        for (const key of policy.characterOrder) {
            const matches = rows.filter(({ ally, index }) => key === 'self'
                ? ally.entry?.ally_type === 'character' || !!runtime.status?.username && accounts.get(index) === runtime.status.username
                : accounts.get(index) === key.slice(4) || ally.entry?.ally_type !== 'dungeon_member' && ally.username === key.slice(4));
            if (matches.length > 1) throw new Error(`${label}：排序角色 ${key} 无法唯一匹配，已暂停`);
            if (policy.requireExactOrder && matches.length !== 1) throw new Error(`${label}：旧日指定角色 ${key} 未能匹配，已暂停开战，请核对队伍`);
            if (matches.length && !desired.includes(matches[0].index)) desired.push(matches[0].index);
        }
        if (policy.requireExactOrder && (rows.length !== 3 || desired.length !== 3 || rows.some((r, i) => r.position !== i + 1))) {
            throw new Error(`${label}：旧日阵容不满足三人站位，已暂停开战`);
        }
        if (!desired.length) { log(`${label}：自定义名单中没有本场角色，保留游戏站位`); return state; }
        desired.push(...rows.filter(r => !desired.includes(r.index)).map(r => r.index));
        // allies_order 保存的是每个原始数组下标对应的站位；swap 参数必须仍用原始下标。
        for (let slot = 0; slot < desired.length; slot++) {
            checkStop();
            const current = battleOrderRows(state), from = current.find(r => r.index === desired[slot]), to = current[slot];
            if (from.index === to.index) continue;
            const fresh = (await api(`/battle/${entryId}`)).data;
            if (battleStarted(fresh)) return fresh;
            if (battleOrderSignature(fresh) !== battleOrderSignature(state)) throw new Error(`${label}：阵容或站位已被改变，请重新接管`);
            await api(`/battle/${entryId}/swap`, { method: 'POST', body: { index1: from.index, index2: to.index } });
            state = (await api(`/battle/${entryId}`)).data;
            const expected = { ...fresh, allies_order: fresh.allies.map((_, i) => fresh.allies_order?.[i] || i + 1) };
            [expected.allies_order[from.index], expected.allies_order[to.index]] = [expected.allies_order[to.index], expected.allies_order[from.index]];
            if (battleOrderSignature(state) !== battleOrderSignature(expected)) throw new Error(`${label}：换位结果未符合预期，已暂停，请核对游戏阵容`);
            if (battleStarted(state)) return state;
        }
        log(`${label}：角色顺序 ${battleOrderRows(state).map(r => `${r.position}号位 ${r.ally.battler.name || '角色'}${accounts.get(r.index) ? ` (@${accounts.get(r.index)})` : ''}`).join(' → ')}`, 'success');
        return state;
    }

    // 等待通用战斗出结果：GET /battle/{id} → data.result{winner:"allies"|"enemies"|"draw",...}
    async function waitBattleResult(entryId, label) {
        const deadline = Date.now() + CONFIG.battleMaxWait * 1000;
        while (true) {
            checkStop();
            const data = (await api(`/battle/${entryId}`)).data;
            if (data?.result) return data.result;
            const budget = (deadline - Date.now()) / 1000;
            if (budget <= 0) throw new Error(`${label}：等待结果超时，可重新接管`);
            if (!['ongoing', 'completed'].includes(data?.status)) throw new Error(`${label}：战斗尚未启动或状态异常`);
            const remain = natural(data?.remaining_seconds);
            runtime.phase = `${label} · 等待结算`;
            await waitSeconds(Math.min(remain > 0 ? remain + 1 : 2, budget, 30));
        }
    }
    async function executeBattle(entryId, label) {
        if (!entryId) throw new Error(`${label}：缺少战斗编号`);
        let state = await setupBattleLineup(entryId, label);
        if (!state?.result && !['ongoing', 'completed'].includes(state?.status)) {
            if (state?.can_start !== true) throw new Error(`${label}：编队未满足开始条件`);
            try { await api(`/battle/${entryId}/start`, { method: 'POST' }); }
            catch (e) {
                rethrowIfStopped(e, true); // start 响应丢失可先回查，不能重发。
                state = (await api(`/battle/${entryId}`)).data;
                if (!state?.result && !['ongoing', 'completed'].includes(state?.status)) throw e;
                log(`${label}：开始响应异常，已回查确认战斗启动`, 'warn');
            }
        }
        return state?.result || await waitBattleResult(entryId, label);
    }

    // ---------- 2. 每日战斗 ----------
    async function completeDaily(battleId) {
        try { return await api(`/daily/${battleId}/complete`, { method: 'POST' }); }
        catch (e) {
            rethrowIfStopped(e, true);
            const current = ((await api('/daily')).data?.battles || []).find((b) => b.battle_id === battleId);
            if (current && ['completed', 'failed'].includes(current.status)) return { data: current };
            throw e;
        }
    }
    async function doDaily() {
        const battles = (await api('/daily')).data?.battles || [];
        // 每天只完成一个挑战；已经准备的战斗先接管，不另选造成串场。
        const pending = battles.find((b) => b.status === 'pending');
        if (!pending && battles.some((b) => b.status === 'completed')) {
            log('每日挑战今日已完成，其他挑战已锁定'); return;
        }
        const rank = (b) => [natural(b.rewards_preview?.money), natural(b.rewards_preview?.exp),
            (b.enemies || []).reduce((sum, e) => sum + natural(e.max_hp), 0), natural(b.rewards_preview?.loot_count)];
        const candidates = battles.filter((b) => ['available', 'failed'].includes(b.status))
            .sort((a, b) => { const x = rank(a), y = rank(b); return y.map((n, i) => n - x[i]).find((n) => n !== 0) || 0; });
        const b = pending || candidates[0];
        if (!b) { log('每日挑战暂无可挑战项目'); return; }
        const label = `每日挑战「${b.name || b.battle_id}」`;
        log(`${label}：${pending ? '继续已有战斗' : '优先高收益'} · 碎片 ${natural(b.rewards_preview?.money)} · 经验 ${natural(b.rewards_preview?.exp)}`);
        checkStop(); setProgress(0, 1, label);
        let entryId = b.battle_entry_id;
        if (b.status !== 'pending' || !entryId) entryId = (await api('/daily/prepare', { method: 'POST', body: { battle_id: b.battle_id } })).data?.battle_entry_id;
        const result = await executeBattle(entryId, label);
        await completeDaily(b.battle_id);
        if (result?.winner === 'allies') { runtime.wins++; log(`${label}：胜利，已结算`, 'success'); }
        else { runtime.losses++; markIssue(`${label}：未获胜，已结算；本次不改打其他挑战`); }
        setProgress(1, 1, '每日挑战已处理');
    }

    // ---------- 3. 活动领奖（单项失败容错跳过） ----------
    async function claimLeiyuan() {
        const data = (await api('/events/leiyuan_recruit')).data;
        if (!data?.claimable) { log('雷源招募：暂无可领取', 'info'); return; }
        const r = await api('/events/leiyuan_recruit/claim', { method: 'POST' });
        const rw = fmtRewards(r.data?.rewards);
        log(`雷源招募：已领取${rw ? '（' + rw + '）' : ''}`, 'success');
    }
    async function doThesis() {
        const courses = (await api('/events/polithia_thesis')).data?.courses || [];
        for (const course of courses.filter((c) => !c.cleared && ['available', 'pending'].includes(c.status))) {
            checkStop();
            try {
                const label = `论文课程 #${course.course_id}`;
                const entryId = course.status === 'pending' && course.battle_entry_id ? course.battle_entry_id
                    : (await api(`/events/polithia_thesis/${course.course_id}/prepare`, { method: 'POST' })).data?.battle_entry_id;
                const result = await executeBattle(entryId, label);
                await api(`/events/polithia_thesis/${course.course_id}/complete`, { method: 'POST' });
                if (result?.winner === 'allies') { runtime.wins++; log(`${label}：通过`, 'success'); }
                else { runtime.losses++; markIssue(`${label}：未通过`); }
            } catch (e) { rethrowIfStopped(e); markIssue(`论文课程 #${course.course_id}：${e.message}`); }
            await jitter();
        }
    }
    async function claimTaskEvent(id, label) {
        const tasks = ((await api(`/events/${id}`)).data?.tasks || []).filter((t) => t.claimable && !t.claimed);
        if (!tasks.length) log(`${label}：暂无可领取`);
        for (const task of tasks) {
            checkStop();
            try {
                const r = await api(`/events/${id}/claim/${task.task_id}`, { method: 'POST' });
                const rewards = fmtRewards(r.data?.rewards);
                log(`${label} #${task.task_id}：已领取${rewards ? `（${rewards}）` : ''}`, 'success');
            } catch (e) { rethrowIfStopped(e); markIssue(`${label} #${task.task_id} 领取失败：${e.message}`); }
            await jitter();
        }
    }
    async function doEvents(claimOnly = false) {
        const list = (await api('/events')).data?.events;
        if (!Array.isArray(list)) throw new Error('活动列表格式变化，已暂停活动处理');
        const handlers = {
            bai_li_commission: ['百里委托', () => claimTaskEvent('bai_li_commission', '百里委托')], leiyuan_recruit: ['雷源招募', claimLeiyuan],
            cecilia_support: ['塞西莉亚的声援', () => claimTaskEvent('cecilia_support', '塞西莉亚的声援')],
            polithia_thesis: ['论文课程', doThesis],
        };
        for (const event of list) {
            checkStop();
            const handler = handlers[event.event_id];
            if (!handler || (claimOnly && event.event_id === 'polithia_thesis')) continue;
            const [label, fn] = handler;
            try { await fn(); } catch (e) { rethrowIfStopped(e); markIssue(`${label}：${e.message}`); }
            await jitter();
        }
    }

    // ---------- 预设列表（扫荡与挂机共用） ----------
    async function loadPresets() {
        const list = (await api('/dungeon/presets')).data || [];
        return list.filter((p) => !p.locked);
    }
    const dungeonPreset = (dungeon) => runtime.presets.find((p) => String(p.id) === String(dungeon?.preset_id));
    const dungeonName = (dungeon) => dungeon?.preset_name || dungeonPreset(dungeon)?.name || '';
    function fillPresetSelect(select, presets, sweep = false) {
        const previous = select.value || (sweep ? settings.sweepPreset : settings.dungeonPreset);
        select.replaceChildren(new Option(sweep ? '选择扫荡副本…' : '选择探索副本…', ''));
        for (const p of presets) {
            if (sweep && (!p.sweep_supported || !p.sweep_unlocked)) continue;
            const opt = new Option(`${p.name || p.id}${p.daily_free_available ? ' · 免费' : ''}`, String(p.id));
            select.appendChild(opt);
        }
        if ([...select.options].some((o) => o.value === previous)) select.value = previous;
    }

    // ---------- 4. 地下城扫荡 ----------
    async function fetchSweepInfo(presetId) {
        return (await api(`/dungeon/sweep/info?preset_id=${encodeURIComponent(presetId)}`)).data || {};
    }
    // 默认限制单次请求；计划总次数允许分批，但仍受票券、每日额度和 16 次上限限制。
    function clampSweepTimes(info, want, perRequest = true) {
        if (info.max_times == null || !Number.isFinite(Number(info.max_times))) throw new Error('扫荡信息缺少有效上限，请刷新后重试');
        const ticketCost = Number(info.ticket_cost);
        const ticketCap = ticketCost > 0 ? Math.floor(natural(info.ticket_owned) / ticketCost) : natural(info.daily_remaining);
        const cap = Math.min(perRequest ? natural(info.max_times) : natural(info.max_times) > 0 ? Infinity : 0,
            ticketCap, natural(info.daily_remaining), CONFIG.sweepMaxTimes);
        const desired = Number(want);
        if (!Number.isInteger(desired) || desired < 0) throw new Error('扫荡次数必须为非负整数');
        return Math.min(desired === 0 ? cap : desired, cap);
    }
    async function doSweep(presetId, times) {
        if (!presetId) throw new Error('请先选择扫荡副本');
        let info = await fetchSweepInfo(presetId);
        if (info.unlocked === false) throw new Error('该副本尚未解锁扫荡');
        const target = clampSweepTimes(info, times, false);
        if (target <= 0) throw new Error('没有可用扫荡次数，请检查门票、加速券和每日额度');
        log(`计划扫荡 ${target} 次 · 预计加速券 ${target * natural(info.ticket_cost)} 张 · 按服务器单次上限分批`, 'info');
        let done = 0;
        while (done < target) {
            checkStop();
            if (done > 0) info = await fetchSweepInfo(presetId);
            if (info.unlocked === false) { markIssue('扫荡解锁状态已变化，停止后续批次'); break; }
            const n = clampSweepTimes(info, target - done);
            if (n <= 0) { markIssue('扫荡额度、票券或门票不足，停止后续批次'); break; }
            const r = (await api('/dungeon/sweep', { method: 'POST', body: { preset_id: presetId, times: n } })).data;
            if (!Number.isInteger(r?.times) || r.times < 0 || r.times > n) throw new ApiError('扫荡已提交但返回次数异常，请刷新游戏核对结果', 200, 0, '/dungeon/sweep', true);
            done += r.times; runtime.sweepDone += r.times;
            log(`本批扫荡 ${r.times}/${n} 次 · 累计 ${done}/${target} 次 · 碎片 ${r.total?.money ?? 0} · 经验 ${r.total?.exp ?? 0} · ${fmtRewards(r.total?.items) || '无物品'} · 用券 ${r.cost?.ticket_cost ?? '?'}`, 'success');
            if (r.stopped_reason || r.times < n) { markIssue(`扫荡提前结束：${r.stopped_reason || '实际完成次数少于请求次数'}`); break; }
            if (done < target) await jitter();
        }
        log(`扫荡任务结束：实际完成 ${done}/${target} 次`);
        return done;
    }

    // ---------- 5. 地下城检测、接管与全自动挂机 ----------
    function isDungeonTerminal(dungeon) {
        return !!dungeon && ['completed', 'failed'].includes(dungeon.status);
    }

    async function fetchCurrentDungeon() {
        return (await api('/dungeon/current')).data || null;
    }

    // 节点推进接口只允许队长操作；不自动调用 /leader/takeover，避免抢夺队长权限。
    function bindDungeon(dungeon) {
        if (!dungeon?.dungeon_id) throw new Error('缺少副本编号，已暂停');
        const ctx = activeTaskContext;
        if (!ctx) return;
        if (ctx.dungeonId && ctx.dungeonId !== dungeon.dungeon_id) throw new Error('当前副本已改变，已停止操作');
        ctx.dungeonId = dungeon.dungeon_id;
    }
    async function ensureDungeonLeader(dungeon) {
        bindDungeon(dungeon);
        if (!dungeon?.leader_id) throw new Error('当前地下城缺少队长信息，已暂停接管');
        const status = (await api('/status')).data || {};
        const username = status.username || '';
        if (!username) throw new Error('无法确认当前账号用户名，已暂停接管');
        if (dungeon.leader_id !== username) {
            throw new Error(`检测到进行中的地下城，但当前队长是「${dungeon.leader_id}」；助手不会自动夺取队长权限`);
        }
        if (activeTaskContext) activeTaskContext.leaderId = username;
    }

    function logDungeonFinished(dungeon, hasSettlement = false) {
        const status = dungeon?.status || 'completed';
        const reason = dungeon?.completion_reason ? `，原因：${dungeon.completion_reason}` : '';
        log(`地下城探索结束：${status}${reason}${hasSettlement ? '（已结算）' : ''}`, dungeonSucceeded(dungeon) ? 'success' : 'warn');
    }

    // 组队后招募好友（离线好友）补齐空位，与前端一致：
    // GET /social/friends → friends[]（前端过滤 !offline），POST /dungeon/recruit {type:"offline_friend", key:用户名}
    // 招募优先级：面板勾选 → orderedUsernames（望雪台原有候补）→ 按等级自动。
    // 队伍招不满 3 人时抛错中断本次挂机（由调用方解散大厅）。
    async function recruitTopFriends(dungeon, orderedUsernames = [], fixedOnly = false) {
        bindDungeon(dungeon);
        if ((dungeon.members?.length || 0) >= 3) return;
        let friends = [];
        try {
            friends = ((await api('/social/friends')).data?.friends || []).filter((f) => !f.offline);
        } catch (e) {
            rethrowIfStopped(e);
            throw new Error(`获取好友列表失败，无法组队：${e.message}`);
        }
        if (!friends.length) throw new Error('没有可招募的好友，队伍无法组满');

        const members = dungeon.members || [];
        const inTeam = new Set(members.map((m) => m.key));
        const slots = Math.max(0, 3 - members.length); // 队伍上限 3 人
        const byLevelDesc = (a, b) => (b.level ?? 0) - (a.level ?? 0);
        const candidates = friends.filter((f) => f.username && !inTeam.has(f.username));
        const ordered = [];
        for (const key of orderedUsernames) {
            const f = candidates.find((c) => !ordered.includes(c) && (c.username === key || (!fixedOnly && c.name === key)));
            if (f) ordered.push(f);
            else log(`组队：固定队友「${key}」不在可招募列表中，跳过`, 'warn');
        }
        const orderedKeys = new Set(ordered.map((f) => f.username));
        const preferred = fixedOnly ? [] : candidates.filter((f) => (taskSettings().friends || []).includes(f.username)).sort(byLevelDesc);
        for (let i = ordered.length - 1; i >= 0; i--) if (preferred.includes(ordered[i])) ordered.splice(i, 1);
        const auto = fixedOnly ? [] : candidates.filter((f) => !orderedKeys.has(f.username) && !(taskSettings().friends || []).includes(f.username)).sort(byLevelDesc);
        const picks = [...preferred, ...ordered, ...auto];
        if (fixedOnly && picks.length < slots) throw new Error(`需要队友 ${orderedUsernames.map(name => '@' + name).join(' 和 ')}，可用指定队友不足，已停止组队`);
        let filledSlots = 0;
        if (!picks.length && slots > 0) throw new Error('好友均已在队中，仍无法组满队伍');
        if (ordered.length) {
            log(`组队：按固定顺序招募 ${ordered.map((f) => f.name || f.username).join(' → ')}`, 'info');
        } else if (preferred.length) {
            log(`优先招募勾选的助战好友 ${Math.min(preferred.length, slots)}/${preferred.length} 人，其余空位按等级补齐`, 'info');
        }
        for (const f of picks) {
            if (filledSlots >= slots) break;
            checkStop();
            try {
                await api('/dungeon/recruit', { method: 'POST', body: { type: 'offline_friend', key: f.username } });
                filledSlots++;
                log(`已招募好友「${f.name || f.username}」(Lv.${f.level ?? '?'})`, 'success');
            } catch (e) {
                rethrowIfStopped(e);
                log(`招募好友「${f.name || f.username}」失败：${e.message}`, 'warn');
            }
            await jitter();
        }

        // 以服务端最新大厅状态确认队伍人数，不满 3 人则中断
        const latest = await fetchCurrentDungeon();
        bindDungeon(latest);
        const count = latest.members?.length ?? members.length;
        if (count < 3) throw new Error(`队伍人数不足（${count}/3），中断本次挂机`);
        log(`队伍已组满（${count}/3）`, 'success');
    }

    // 新版搜索免费；是否能进入由每日次数、首次免次数和门票本豁免共同决定。
    // 每次开局重新读取，不用旧预设的 daily_free_available 覆盖最新报价。
    async function readDungeonEntryAllowance(presetId) {
        if (presetId == null || presetId === '') throw new Error('无法确认副本预设，已暂停进入');
        const quote = await api(`/dungeon/search-cost?preset_id=${encodeURIComponent(presetId)}`);
        const hasDaily = Object.hasOwn(quote, 'daily') || quote.data && Object.hasOwn(quote.data, 'daily');
        const daily = Object.hasOwn(quote, 'daily') ? quote.daily : quote.data?.daily;
        const hasCost = Object.hasOwn(quote, 'cost') || quote.data && Object.hasOwn(quote.data, 'cost');
        const rawCost = Object.hasOwn(quote, 'cost') ? quote.cost : quote.data?.cost;
        const numericCost = typeof rawCost === 'number' || typeof rawCost === 'string' && rawCost.trim() !== '';
        const cost = !hasCost && hasDaily ? 0 : numericCost ? Number(rawCost) : NaN;
        if (!Number.isFinite(cost) || cost < 0) throw new Error('无法确认搜索费用，已暂停建队');
        const allowance = { presetId, cost, daily: null, free: false, exempt: false };
        if (hasDaily) {
            if (!daily || typeof daily !== 'object' || Array.isArray(daily) ||
                !Number.isSafeInteger(daily.quota) || daily.quota < 0 ||
                !Number.isSafeInteger(daily.remaining) || daily.remaining < 0 || daily.remaining > daily.quota ||
                typeof daily.free !== 'boolean' || Object.hasOwn(daily, 'exempt') && typeof daily.exempt !== 'boolean') {
                throw new Error('每日探索次数数据异常，已暂停进入');
            }
            allowance.daily = { ...daily };
            allowance.free = daily.free;
            allowance.exempt = daily.exempt ?? dungeonPreset({ preset_id: presetId })?.daily_count_exempt === true;
        }
        runtime.explorationAllowance = allowance;
        renderPolicySummary();
        if (activeTaskContext?.freeOnly && (cost > 0 || hasDaily && !allowance.free && !allowance.exempt)) {
            throw new Error('首次免次数额度已变化，免费队列已停止，未消耗每日探索次数');
        }
        if (hasDaily && !allowance.free && !allowance.exempt && daily.remaining <= 0) {
            throw new Error(`每日探索次数已用完（0/${daily.quota}），当前副本不免次数，已保留大厅或未创建新局`);
        }
        return allowance;
    }
    function logDungeonEntryAllowance(allowance, stage) {
        const daily = allowance.daily;
        if (!daily) {
            log(`${stage}：旧版搜索报价 ${allowance.cost} 碎片`);
            return;
        }
        const mode = allowance.exempt ? '门票副本，免每日次数' : allowance.free ? '今日首次进入，免次数' : '进入时消耗 1 次';
        log(`${stage}：${mode} · 剩余 ${daily.remaining}/${daily.quota} 次${daily.holiday_bonus ? '（节假日额度）' : ''}`);
    }

    async function createDungeon(presetId, visibility, difficulty) {
        if (!presetId) throw new Error('当前没有可接管的地下城；请先刷新并选择预设后再开始新局');
        const preset = (await loadPresets()).find((x) => String(x.id) === String(presetId));
        if (!preset) throw new Error('预设已不可用，请刷新副本列表');
        const eventDifficulty = !!preset.difficulty_by_event;
        const allowance = await readDungeonEntryAllowance(presetId);
        logDungeonEntryAllowance(allowance, '建队检查');
        const lobby = (await api('/dungeon/search', {
            method: 'POST',
            body: { preset_id: presetId, visibility, difficulty: eventDifficulty ? null : (difficulty || null) },
        })).data || {};
        runtime.searchSpent += allowance.cost;
        if (lobby.status && lobby.status !== 'lobby') {
            throw new Error(`搜索后地下城状态异常：${lobby.status}`);
        }
        await ensureDungeonLeader(lobby);
        if ((lobby.visibility ?? visibility) === 'public') return enterExistingLobby(lobby, true, visibility, presetId);
        try {
            await recruitDungeonFriends(lobby, preset.name);
        } catch (e) {
            rethrowIfStopped(e);
            // 组队失败时解散大厅，避免残留空队伍
            try {
                await api('/dungeon/disband', { method: 'POST' });
                log('队伍未组满，已解散大厅', 'warn');
            } catch (de) {
                rethrowIfStopped(de);
                log(`解散大厅失败：${de.message}，请手动处理残留大厅`, 'warn');
            }
            throw e;
        }
        log('未发现现有探索，已搜索到新地下城，进入…');
        await jitter();
        return await enterExistingLobby(lobby, true, visibility, presetId);
    }

    async function enterExistingLobby(dungeon, isNew = false, visibility = taskSettings().visibility, presetId = dungeon?.preset_id) {
        bindDungeon(dungeon);
        const ctx = activeTaskContext;
        let publicLobby = null, previousCount = -1;
        try {
            while (true) {
                checkStop();
                const latest = await fetchCurrentDungeon();
                if (!latest || isDungeonTerminal(latest)) throw new Error('准备进入时地下城已不存在或已经结束');
                if (dungeon.dungeon_id !== latest.dungeon_id) throw new Error('准备进入时当前地下城已发生变化，已暂停以避免误操作');
                await ensureDungeonLeader(latest);
                if (latest.status === 'exploring') {
                    log('检测到地下城已由其他页面进入，直接接管现有探索', 'success');
                    return latest;
                }
                if (latest.status !== 'lobby') throw new Error(`无法进入未知地下城状态：${latest.status || '?'}`);
                publicLobby ??= (latest.visibility ?? dungeon.visibility ?? visibility) === 'public';
                if (publicLobby && latest.visibility && latest.visibility !== 'public') throw new Error('公开大厅可见性已改变，已停止等待');
                if (ctx) ctx.requireFullParty = publicLobby;
                const memberCount = latest.members?.length || 0;
                if (publicLobby && memberCount < 3) {
                    runtime.phase = `公开大厅等待队友 · ${memberCount}/3`;
                    if (previousCount !== memberCount) log(`公开大厅：${memberCount}/3 人，等待玩家加入；满员后自动开始，可随时停止等待`);
                    previousCount = memberCount;
                    await waitSeconds(CONFIG.publicLobbyPollSeconds);
                    continue;
                }
                if (!publicLobby && (memberCount < 3 || hermitDefaultsEnabled(latest))) await recruitDungeonFriends(latest);
                runtime.phase = '队伍已满，正在进入探索'; renderDashboard();
                // 等待公开房间或招募期间，首次免费及剩余次数可能已在其他页面消耗。
                const allowance = await readDungeonEntryAllowance(latest.preset_id ?? presetId);
                logDungeonEntryAllowance(allowance, '开局检查');
                let entered;
                try { entered = (await api('/dungeon/enter', { method: 'POST' })).data || {}; }
                catch (e) {
                    rethrowIfStopped(e);
                    if (!e.lobbyNotFull) throw e;
                    previousCount = -1;
                    runtime.phase = '公开大厅有人离队，继续等待';
                    await waitSeconds(CONFIG.publicLobbyPollSeconds);
                    continue;
                }
                if (entered.status !== 'exploring') throw new Error(`继续进入后状态异常：${entered.status || '?'}`);
                await ensureDungeonLeader(entered);
                log(`${isNew ? '已进入新地下城' : '已从现有大厅进入地下城'}，开始接管`, 'success');
                return entered;
            }
        } finally { if (ctx) ctx.requireFullParty = false; }
    }

    // 倒计时归零后服务端仍可能在生成结果；只有节点战斗状态变为 completed 才能提交 complete。
    // 等待上限用墙上时钟计算：后台标签页定时器被节流时，累加计划秒数会严重低估真实耗时。
    async function waitDungeonBattleReady(label, initialRemaining = 0) {
        let startAt = Date.now();
        let remaining = Math.max(0, Number(initialRemaining) || 0);
        let first = true;
        let accelerationAttempted = false;

        while (true) {
            checkStop();
            const node = (await api('/dungeon/node')).data || {};
            if (node.completed || node.battle_status?.status === 'completed') return node;

            const phase = node.battle_status?.status || '';
            if (phase !== 'ongoing') {
                throw new Error(`${label}：等待结果时战斗状态异常（status=${phase || '?'}），已暂停并保留探索`);
            }
            remaining = Math.max(0, Number(node.battle_status?.remaining_seconds ?? remaining) || 0);
            const policy = taskSettings();
            const used = activeTaskContext?.accelUsed || 0;
            const waited = (Date.now() - startAt) / 1000;
            // 超长战斗先加速，不能在常规阈值关闭或预算耗尽时直接触发 600 秒超时。
            // 每场最多提交一次；写请求结果不确定时仍暂停，避免重复扣券。
            const timeoutAcceleration = remaining > CONFIG.battleMaxWait || waited >= CONFIG.battleMaxWait;
            const regularAcceleration = policy.accelThreshold > 0 && remaining > policy.accelThreshold && used < policy.accelBudget;
            if (!accelerationAttempted && (timeoutAcceleration || regularAcceleration)) {
                accelerationAttempted = true;
                try {
                    await api('/dungeon/node/battle/accelerate', { method: 'POST' });
                    if (activeTaskContext) activeTaskContext.accelUsed++;
                    runtime.accelUsed++;
                    startAt = Date.now(); // 给加速后的服务端结算完整等待时间。
                    log(`${label}：${timeoutAcceleration ? '触发 600 秒超时保护，自动使用加速券' : '使用加速券'}（本批已用 ${runtime.accelUsed} 张）`, 'success');
                    continue;
                } catch (e) {
                    rethrowIfStopped(e);
                    markIssue(`加速失败，改为等待：${e.message}`);
                }
            }
            if (waited >= CONFIG.battleMaxWait) {
                throw new Error(`${label}：等待服务端生成战斗结果超过 ${CONFIG.battleMaxWait}s，已暂停并保留探索`);
            }

            const budget = CONFIG.battleMaxWait - waited;
            const seconds = Math.min(remaining > 0 ? Math.ceil(remaining) + 1 : 2, budget, 30);
            if (seconds <= 0) continue;
            if (first) {
                first = false;
                log(`${label}：${remaining > 0 ? `等待倒计时 ${remaining}s` : '倒计时已结束，等待服务端生成结果'}`, 'info');
            }
            await waitSeconds(seconds);
        }
    }

    // 可恢复新战斗、已 prepare、ongoing 以及等待 complete 的四种状态。
    async function dungeonBattle(node) {
        const label = `地下城${node.node_type === 'boss' ? ' Boss' : ''}战斗`;
        let entryId = node.dungeon_battle_id || '';
        let phase = node.battle_status?.status || '';
        let remaining = Number(node.battle_status?.remaining_seconds ?? 0);
        let nodeReadyForComplete = phase === 'completed';

        if (phase === 'ongoing') {
            log(`${label}：检测到进行中的战斗，接管剩余倒计时 ${remaining}s`, 'info');
        } else if (phase === 'completed') {
            log(`${label}：战斗结果已生成，直接提交节点结算`, 'info');
        } else {
            if (!entryId) {
                const prepData = (await api('/dungeon/node/battle/prepare', { method: 'POST' })).data || {};
                entryId = prepData.battle_id || '';
                if (!entryId) throw new Error(`${label}：prepare 未返回 battle_id`);
                log(`${label}：已准备新战斗`);
            } else {
                log(`${label}：检测到已准备的战斗，复用 battle_id 接管`, 'info');
            }

            const entryState = await setupBattleLineup(entryId, label, dungeonPolicy());
            if (entryState?.result || entryState?.status === 'completed') {
                phase = 'completed';
            } else if (entryState?.status === 'ongoing') {
                phase = 'ongoing';
                remaining = Number(entryState.remaining_seconds ?? remaining);
            } else {
                if (entryState?.can_start !== true) {
                    throw new Error(`${label}：自动编队后仍未满足开始条件（status=${entryState?.status || '?'}）`);
                }
                await jitter();
                try {
                    const startBody = await api('/dungeon/node/battle/start', { method: 'POST' });
                    if (startBody.forced_exit || startBody.data?.forced_exit) {
                        const forcedState = startBody.data || {};
                        if (forcedState.status) {
                            log(`${label}：被服务器强制退出（${forcedState.status}）`, 'warn');
                            return forcedState;
                        }
                        throw new Error(`${label}：战斗被服务器强制退出`);
                    }
                    const battle = startBody.battle || startBody.data?.battle || {};
                    phase = 'ongoing';
                    remaining = Number(battle.remaining_seconds ?? 0);
                } catch (e) {
                    rethrowIfStopped(e, true);
                    // start 响应丢失时，以节点的服务端状态判定是否已经成功启动。
                    let refreshed;
                    try {
                        refreshed = (await api('/dungeon/node')).data;
                    } catch (refreshError) {
                        rethrowIfStopped(refreshError);
                        throw new Error(`${label}：start 失败且无法回查状态（${e.message}）`);
                    }
                    const refreshedPhase = refreshed?.battle_status?.status || '';
                    if (!['ongoing', 'completed'].includes(refreshedPhase)) {
                        throw new Error(`${label}：战斗无法开始（${e.message}；status=${refreshedPhase || '?' }）`);
                    }
                    phase = refreshedPhase;
                    nodeReadyForComplete = refreshedPhase === 'completed';
                    remaining = Number(refreshed.battle_status?.remaining_seconds ?? 0);
                    log(`${label}：start 返回「${e.message}」，但服务端已启动战斗，继续接管`, 'warn');
                }
            }
        }

        if (!nodeReadyForComplete) {
            const readyNode = await waitDungeonBattleReady(label, remaining);
            if (readyNode.completed) {
                log(`${label}：节点已由服务端完成，继续推进`, 'success');
                return await fetchCurrentDungeon();
            }
            phase = readyNode.battle_status?.status || phase;
            nodeReadyForComplete = phase === 'completed';
        }
        if (!nodeReadyForComplete) throw new Error(`${label}：服务端尚未生成可提交的战斗结果，已暂停并保留探索`);

        const doneBody = await api('/dungeon/node/battle/complete', { method: 'POST' });
        const done = doneBody.data || {};
        log(`${label}：节点结算完成`, 'success');
        return done;
    }

    // ---------- 望雪台（冰龙本）专属流程 ----------
    // 火系保留原招募优先级；双光按账号精确招募指定队友。公开大厅仍走等待满员流程。
    // 难度按用户选择；第二事件按策略刷开局，第三事件优先霜藏，撤离权限沿用原规则。
    const WXT_PRESET_RE = /望雪台/;
    const WXT_STRATEGIES = {
        fire: { name: '火系烬蓟', opening: '烬蓟', friends: ['爱神', 'Guqii0812'] },
        light: { name: '双光爆破', opening: '晨露草', friends: ['Ilya', 'a'] },
    };
    const wxtStrategy = (policy = taskSettings()) => WXT_STRATEGIES[policy.wxtStrategy] || WXT_STRATEGIES.fire;
    async function recruitDungeonFriends(dungeon, presetName = '') {
        if (hermitDefaultsEnabled({ ...dungeon, preset_name: presetName || dungeonName(dungeon) })) {
            log('旧日救援据点：指定助战 @ldya、@Guqii0812');
            await recruitTopFriends(dungeon, ['ldya', 'Guqii0812'], true);
            const latest = await fetchCurrentDungeon();
            bindDungeon(latest);
            if (!['ldya', 'Guqii0812'].every(key => latest.members?.some(m => m.key === key))) {
                throw new Error('旧日救援据点需要 @ldya 和 @Guqii0812；现有队伍不符，请调整队伍后接管');
            }
            return;
        }
        // 火系接管旧大厅时保留原通用补员规则；双光补员仍限定指定账号。
        if (!presetName && taskSettings().wxtStrategy !== 'light') return recruitTopFriends(dungeon);
        const name = presetName || dungeonName(dungeon);
        if (!WXT_PRESET_RE.test(name)) return recruitTopFriends(dungeon);
        const strategy = wxtStrategy();
        log(`望雪台组队策略：${strategy.name} · 开局目标「${strategy.opening}」`);
        return recruitTopFriends(dungeon, strategy.friends, taskSettings().wxtStrategy === 'light');
    }
    // 返回难度/专属事件选择、{ restart:true } 或 null（回退通用 chooseEventOption）。
    function chooseWxtEventOption(opts, eventNo, policy = taskSettings()) {
        // 首事件应为难度选择；缺失、重复或锁定目标时暂停，不回退到其他难度。
        const difficulty = chooseDifficultyEvent({ name: eventNo === 1 ? '望雪台难度选择' : '', options: opts },
            { difficulty_by_event: true }, policy.wxtDifficulty || policy.difficulty);
        if (difficulty) return difficulty;
        if (!Array.isArray(opts) || !opts.length) throw new Error('望雪台事件选项为空');
        const text = (o) => `${o?.label || ''} ${o?.description || ''}`;
        const opening = opts.findIndex((o) => text(o).includes(wxtStrategy(policy).opening));
        if (opening >= 0) return { index: opening, source: 'wxt' };
        if (eventNo === 2 && policy.rerollWxt) return { restart: true, source: 'wxt' };
        const frost = opts.findIndex((o) => text(o).includes('霜藏'));
        if (frost >= 0) return { index: frost, source: 'wxt' };
        return null;
    }
    function wxtEventOrdinal(dungeon, node) {
        const index = Number(node.index ?? dungeon?.current_node_index);
        if (!Number.isInteger(index) || !Array.isArray(dungeon?.nodes) || index < 0 || index >= dungeon.nodes.length) return null;
        return dungeon.nodes.slice(0, index + 1).filter((n) => n?.node_type === 'event').length;
    }
    function sanityReserve(dungeon = runtime.dungeon) {
        const next = dungeon?.nodes?.[Number(dungeon?.current_node_index) + 1];
        return 1 + (['battle', 'elite', 'boss'].includes(next?.node_type) ? 1 : 0);
    }


    // 理智保护同时预留下一节点的推进/战后消耗；未知理智不假设足够。
    function saneEnough(ctx, cost) {
        const s = ctx?.sanity;
        return Number.isFinite(s) && s - cost - sanityReserve(ctx?.dungeon) >= natural(taskSettings().sanityFloor, 10, 20);
    }
    // 既有事件资料按选项名称建模：偏好、消耗及备用选项只维护一份。
    // 运行时映射到服务器实际下标，兼容选项重排、删减。
    const EVENT_RULES = {
        '石中手印': { pick: '把手掌贴上去感知震动' },
        '晶簇里的回声': { pick: '记录声音内容', cost: 2 },
        '矿工的半截日志': { pick: '仔细阅读日志', cost: 2 },
        '巨兽未成形的脚印': { pick: '沿脚印追踪' },
        '失踪矿工的灯': { pick: '取下矿灯', cost: 3 },
        '塌方后的低语': { pick: '离开' },
        '被矿石包住的饭盒': { pick: '取出饭盒', cost: 2 },
        '不该存在的温热': { pick: '抽取流动以太' },
        '活石剥落层': { pick: '收集剥落外壳', cost: 5, fallback: '避开薄壳前进' },
        '倒流的矿车轨道': { pick: '等待矿车回来' },
        '会呼吸的矿壁': { pick: '立刻穿过缝隙' },
        '自己排列的矿石': { pick: '保持原状，绕开' },
        '收拾整齐的空帐篷': { pick: '检查帐篷夹层' },
        '尚有余温的灰烬': { pick: '取出根须' },
        '多出来的一串脚步': { pick: '打乱所有人的步伐' },
        '过分干净的巡逻道': { pick: '离开道路' },
        '回到掌心的红叶': { pick: '用容器封存' },
        '被抹去的测绘桩': { pick: '拓下仍可辨认的部分', cost: 10, fallback: '拔掉测绘桩' },
        '只剩结论的报告': { pick: '拼回报告碎片', cost: 12, fallback: '在结论旁留下反证' },
        '第七道叶脉': { pick: '切断第七道叶脉' },
        '深渊低语': { pick: '以痛镇魂' },
    };

    // 事件选项评分：正面关键词 +2 分，负面关键词 -3 分（惩罚更重，宁可不赚也不踩坑）。
    // 仅在事件表里没有记录时作为兜底；结果仍可能有随机成分。
    const EVENT_GOOD_RE = /恢复|回复|治疗|治愈|获得|提升|强化|祝福|增益|净化|宝箱|碎片|经验|金币|材料|装备|安全|免费|好运|灵感|共鸣|情报|Sanity/i;
    const EVENT_BAD_RE = /失去|减少|扣除|受伤|伤害|诅咒|恶化|消耗|减益|腐蚀|降低|牺牲|代价|中毒|虚弱|破碎|迷失/i;
    function normalizeEventLabel(value) {
        return String(value ?? '').normalize('NFKC').trim()
            .replace(/^(?:选项\s*)?(?:[A-Da-d]|\d+)[.、:)：]\s*/, '')
            .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
            .replace(/[\p{P}\p{Z}\s]/gu, '');
    }
    function eventSanityCost(option) {
        const text = `${option?.label || ''} ${option?.description || ''}`.normalize('NFKC');
        const values = [...text.matchAll(/理智\s*[:：]?\s*(?:[-−－]\s*|(?:消耗|减少|降低|扣除|损失)\s*[:：]?\s*)(\d+(?:\.\d+)?)/g),
            ...text.matchAll(/(?:消耗|减少|降低|扣除|失去|损失)\s*(\d+(?:\.\d+)?)\s*(?:点)?\s*理智/g),
            ...text.matchAll(/(?:消耗|减少|降低|扣除|失去|损失)\s*理智\s*[:：]?\s*(\d+(?:\.\d+)?)/g)];
        return Math.max(0, ...values.map((m) => Number(m[1])));
    }
    // 难度事件先于普通事件评分；按语义定位实际下标，不依赖副本名称和事件位置。
    function difficultyOption(option) {
        const label = normalizeEventLabel(option?.label);
        const match = label.match(/^(?:选择|进入|挑战|以)?(?:副本)?(?:难度)?(简单|普通|困难|极难)(?:难度|模式)?(?:进入|挑战)?$/);
        if (match) return match[1];
        const description = String(option?.description || '').normalize('NFKC');
        // 说明必须明确声明难度，不能仅因文本提到“困难”就推测是难度选择。
        return description.match(/(?:^|[。；;\n])\s*(?:副本|本次探索|本次挑战)?难度\s*(?::|设为|调整为|为)\s*[【「]?(简单|普通|困难|极难)(?=$|[】」\s，,。；;])/u)?.[1] || null;
    }
    function chooseDifficultyEvent(event, dungeon, wanted = taskSettings().difficulty) {
        const options = event?.options ?? [];
        if (!Array.isArray(options) || options.some((o) => !o || typeof o !== 'object')) throw new Error('事件选项格式异常');
        const mapped = options.map(difficultyOption);
        const byEvent = dungeon?.difficulty_by_event === true || dungeonPreset(dungeon)?.difficulty_by_event === true;
        const explicit = /(?:选择|设定|设置|调整|确认).{0,6}难度|难度.{0,6}(?:选择|设定|设置|调整|确认)/.test(String(event?.name || ''));
        const recognized = new Set(mapped.filter(Boolean));
        if (!explicit && recognized.size < 2 && !(byEvent && recognized.size > 0)) return null;
        const matches = mapped.map((value, index) => value === wanted ? index : -1).filter((index) => index >= 0);
        if (matches.length !== 1) throw new Error(`难度事件「${event?.name || '未命名'}」无法唯一选择「${wanted}」，当前选项：${options.map((o) => o.label || '未命名').join(' / ') || '空'}；请手动处理或调整难度后接管`);
        const index = matches[0];
        if (options[index].disabled === true || options[index].locked === true || options[index].available === false) throw new Error(`目标难度「${wanted}」当前不可选，请调整难度后接管`);
        return { index, source: `difficulty:${wanted}` };
    }
    // 无选项事件按游戏“确认”提交 0；有选项时按标签映射，未知事件自动保守评分。
    function chooseEventOption(options, eventName = '', ctx = {}) {
        if (!Array.isArray(options)) throw new Error('事件选项格式异常');
        if (!options.length) return { index: 0, source: 'confirm' };
        if (options.some((o) => !o || typeof o !== 'object')) throw new Error('事件选项内容异常');
        eventName = String(eventName).normalize('NFKC').trim();
        const costs = options.map(eventSanityCost);
        const rule = Object.hasOwn(EVENT_RULES, eventName) ? EVENT_RULES[eventName] : null;
        const findLabel = (label) => {
            const expected = normalizeEventLabel(label);
            if (!expected) return -1;
            const matches = options.map((o, i) => normalizeEventLabel(o.label) === expected ? i : -1).filter((i) => i >= 0);
            return matches.length === 1 ? matches[0] : -1;
        };
        const preferred = findLabel(rule?.pick);
        if (preferred >= 0) costs[preferred] = Math.max(costs[preferred], rule.cost || 0);
        const allowed = (i) => taskSettings().eventGoal === 'collect' || !costs[i] || saneEnough(ctx, costs[i]);
        if (preferred >= 0 && allowed(preferred)) return { index: preferred, source: 'table' };
        const fallback = findLabel(rule?.fallback);
        if (fallback >= 0 && allowed(fallback)) {
            log(`事件「${eventName}」首选不可用或理智不足，改选「${options[fallback].label}」`);
            return { index: fallback, source: 'table' };
        }
        const candidates = options.map((option, index) => ({ option, index })).filter(({ index }) => allowed(index));
        if (!candidates.length) throw new Error(`事件「${eventName}」所有选项都超出理智保留值，请手动选择或调整策略`);
        if (taskSettings().eventMode === 'pause' && !rule) throw new Error(`事件「${eventName}」需手动选择，完成后可继续接管`);
        if (options.length === 1) return { index: 0, source: 'single' };
        if (taskSettings().eventMode !== 'score') {
            const safe = candidates.find(({ option: o }) => /^(离开|默默离开|沉默离开|保持原|留它原样|绕|小心绕|捂住口鼻绕|避开|不去触碰|不理会|不听|放弃|继续前进|浅尝辄止)/.test(normalizeEventLabel(o.label))
                && !/消耗|减少|扣除|受伤|失去|理智.*[-−－]/.test(o.description || ''));
            if (safe) return { index: safe.index, source: 'safe' };
            if (taskSettings().eventMode === 'pause') throw new Error(`事件「${eventName}」需手动选择，完成后可继续接管`);
        }
        let best = candidates[0].index, bestScore = -Infinity;
        for (const { option: o, index } of candidates) {
            const text = `${o.label || ''} ${o.description || ''}`;
            const good = (text.match(new RegExp(EVENT_GOOD_RE.source, 'gi')) || []).length;
            const bad = (text.match(new RegExp(EVENT_BAD_RE.source, 'gi')) || []).length;
            const enemyGood = /敌[方人].{0,8}(降低|减少|减速|虚弱)/.test(text) ? 5 : 0;
            const enemyBad = /敌[方人].{0,8}(提升|增加|强化)/.test(text) ? 8 : 0;
            const score = good * 2 - bad * 3 + enemyGood - enemyBad - costs[index] * 2;
            if (score > bestScore) { bestScore = score; best = index; }
        }
        return { index: best, source: 'score' };
    }

    // 商店商品本身不带类型字段（前端只渲染 name/description/price/remaining/stock），
    // 类型改用公开物品接口 /items 建「名称→kind」映射判定（装备命名如「活石余炎刃」，
    // 纯关键词匹配会漏判）；技能书在物品库里是 consumable，需按名称/描述单独识别。
    let shopItemKindMap = null;
    async function getShopItemKindMap() {
        if (shopItemKindMap) return shopItemKindMap;
        try {
            const list = (await api('/items')).data;
            if (!Array.isArray(list)) throw new Error('物品表格式异常');
            const next = new Map();
            for (const item of list) if (item?.name) next.set(item.name, item.kind || '');
            shopItemKindMap = next;
            return next;
        } catch (e) {
            rethrowIfStopped(e);
            markIssue(`物品分类加载失败：${e.message}，本次仅按名称识别`);
            return new Map();
        }
    }

    // 物品库查不到时的兜底关键词（尽量覆盖本游戏装备命名习惯）
    const SHOP_EQUIP_FALLBACK_RE = /装备|武器|护甲|甲衣|腿甲|护臂|头盔|饰品|法杖|长杖|短杖|弓|剑|盾|刃|枪|匕|锤|斧|大衣|束装|袍|冠|手套|戒指|项链|靴/;
    const SHOP_SKILL_RE = /技能书|技能卷轴|技能|奥义|秘籍/;
    // 理智水晶：名称/描述含「理智」即视为理智类商品
    const SHOP_SANITY_RE = /理智|sanity/i;
    // 旧副本沿用不购符文的策略；旧日救援据点优先购买探索增益。
    // 商店的符文不在公开物品表中，不能套用背包装备分类。
    const SHOP_RUNE_RE = /符文/;
    const SHOP_BUFF_NAME_RE = /符文|祝福|加护|增益|\bbuff\b/i;
    function dungeonBuffShop(dungeon = runtime.dungeon) {
        return dungeon?.preset_id === 'hermit_hideout' || dungeonName(dungeon) === '旧日救援据点';
    }
    function hermitDefaultsEnabled(dungeon = runtime.dungeon, policy = taskSettings()) {
        return policy.hermitDefaults && dungeonBuffShop(dungeon);
    }
    function dungeonPolicy(dungeon = runtime.dungeon, policy = taskSettings()) {
        if (!hermitDefaultsEnabled(dungeon, policy)) return { ...policy, lineupDungeon: dungeon };
        return { ...policy, lineupDungeon: dungeon, requireExactOrder: dungeon?.visibility !== 'public',
            front: 'custom', characterOrder: ['key:ldya', 'key:Guqii0812', 'self'],
            campMode: 'off', bossCampMode: 'fixed', bossCampSeconds: 100 };
    }
    // 返回 'crystal' | 'buff' | 'rune' | 'equip' | 'skill' | 'other'。
    // 已知装备和技能书先按实际类型识别，避免描述里的“增益”抢占购买优先级。
    function shopItemGroup(it, kindMap, buffShop = false) {
        const text = `${it?.name || ''} ${it?.description || ''}`;
        if (SHOP_SANITY_RE.test(it?.name || '') && /水晶|结晶|药/.test(it?.name || '')) return 'crystal';
        const kind = kindMap.get(it?.name) || '';
        if (buffShop) {
            if (kind === 'equipment') return 'equip';
            if (SHOP_SKILL_RE.test(it?.name || '')) return 'skill';
            if (SHOP_BUFF_NAME_RE.test(it?.name || '') || kind === 'buff') return 'buff';
        }
        if (SHOP_RUNE_RE.test(it?.name || '')) return 'rune';
        if (kind === 'equipment') return 'equip';
        if (!kind && SHOP_EQUIP_FALLBACK_RE.test(text)) return 'equip';
        if (SHOP_SKILL_RE.test(text)) return 'skill';
        return 'other';
    }

    // 商店节点：按策略自动购买（货币为本次探索的以太碎片）后离开。
    // GET /node/shop → {shop_items[{name,description,price,remaining,stock}], current_money}；
    // 购买 POST /node/shop/buy {item_index, quantity}，item_index 为 shop_items 数组下标。
    // 按理智需要、实际余额和单品限额购买；每次购买后重新读取服务端余额和库存。
    async function handleShopNode(ctx = {}) {
        const policy = taskSettings();
        const buffShop = dungeonBuffShop();
        const buyAllBuffs = hermitDefaultsEnabled();
        const priority = { crystal: 0, buff: 1, equip: 2, skill: 3, other: 4 };
        let data = (await api('/dungeon/node/shop')).data || {};
        let bought = 0, units = 0;
        const kindMap = policy.shop === 'off' ? new Map() : await getShopItemKindMap();
        const counts = new Map();
        const skipped = new Set();
        while (policy.shop !== 'off' && bought < 50) {
            checkStop();
            const items = Array.isArray(data.shop_items) ? data.shop_items : [];
            const money = Number(data.current_money ?? 0);
            if (!Number.isFinite(money) || money < 0) throw new Error('商店余额异常，已保留当前节点');
            const sanity = bought === 0 ? (ctx.sanity ?? runtime.dungeon?.sanity) : runtime.dungeon?.sanity;
            const needCrystal = buyAllBuffs || !Number.isFinite(sanity) || sanity < natural(policy.sanityFloor, 10, 20) + sanityReserve();
            const candidates = items.map((item, index) => ({ item, index, group: shopItemGroup(item, kindMap, buffShop) }))
                .filter(({ item, index, group }) => !skipped.has(index) && natural(item.remaining) > 0
                    && (typeof item.price === 'number' || typeof item.price === 'string' && item.price.trim() !== '')
                    && Number(item.price) >= 0 && Number.isFinite(Number(item.price))
                    && money >= Number(item.price)
                    && (buyAllBuffs || (counts.get(item.name) || 0) < Math.max(1, natural(policy.shopMaxEach, 1, 10)))
                    && group !== 'rune' && (group !== 'crystal' || needCrystal)
                    && (buyAllBuffs ? ['crystal', 'buff'].includes(group) : policy.shop === 'all' || ['crystal', 'buff', 'equip', 'skill'].includes(group)))
                .sort((a, b) => priority[a.group] - priority[b.group] || Number(a.item.price) - Number(b.item.price));
            if (!candidates.length) break;
            const { item, index } = candidates[0];
            const quantity = buyAllBuffs ? Math.min(natural(item.remaining), Number(item.price) === 0 ? natural(item.remaining) : Math.floor(money / Number(item.price))) : 1;
            try { await api('/dungeon/node/shop/buy', { method: 'POST', body: { item_index: index, quantity } }); }
            catch (e) { rethrowIfStopped(e); skipped.add(index); markIssue(`购买「${item.name}」失败：${e.message}`); continue; }
            counts.set(item.name, (counts.get(item.name) || 0) + quantity); bought++; units += quantity;
            runtime.shopSpent += Number(item.price) * quantity;
            log(`商店：购买「${item.name}」×${quantity} · ${Number(item.price) * quantity} 碎片`, 'success');
            await jitter();
            await fetchCurrentDungeon();
            data = (await api('/dungeon/node/shop')).data || {};
        }
        const left = (await api('/dungeon/node/shop/leave', { method: 'POST' })).data;
        log(`商店：购买 ${units} 件，已离开`);
        return left;
    }
    function chooseBranch(node, dungeon = runtime.dungeon) {
        const choices = node.branches || [];
        if (!choices.length) throw new Error('路线选项为空');
        const presetName = dungeonName(dungeon);
        // 红叶山谷按专属策略走第二条战斗路线，优先于通用分支偏好。
        if (presetName.includes('红叶山谷') && choices.length >= 2) return 1;
        const mode = taskSettings().route;
        const re = { camp: /营地|恢复|休息/, treasure: /宝箱|材料|奖励/, boss: /Boss|首领|捷径/i }[mode];
        const index = re ? choices.findIndex((x) => re.test(`${x.label || ''} ${x.description || ''}`)) : 0;
        return Math.max(0, index);
    }
    function campKind(dungeon, node) {
        if (node?.node_type !== 'camp' || !Array.isArray(dungeon?.nodes)) return 'normal';
        const index = node.index ?? dungeon.current_node_index, nodes = dungeon.nodes;
        if (!Number.isInteger(index) || index < 0 || index >= nodes.length || nodes[index]?.node_type !== 'camp' ||
            nodes[index].index != null && nodes[index].index !== index) return 'normal';
        // 以当前已展开路线为准；越过商店/事件/普通宝箱，查看下一场战斗。
        // 下一个营地、未决分支、隐藏节点或索引断裂都会中止识别，不猜测尚未展开的路线。
        for (let i = index + 1; i < nodes.length; i++) {
            const next = nodes[i];
            if (!next || next.index != null && next.index !== i) return 'normal';
            if (next.node_type === 'boss') return 'boss';
            if (!['event', 'shop', 'treasure'].includes(next.node_type)) return 'normal';
        }
        return 'normal';
    }
    function campPolicy(dungeon, node, policy = taskSettings()) {
        policy = dungeonPolicy(dungeon, policy);
        const kind = campKind(dungeon, node);
        return { ...policy, kind, label: kind === 'boss' ? 'Boss 前营地' : '普通营地',
            campMode: kind === 'boss' ? policy.bossCampMode ?? policy.campMode : policy.campMode,
            campSeconds: kind === 'boss' ? policy.bossCampSeconds ?? policy.campSeconds : policy.campSeconds,
            campTarget: kind === 'boss' ? policy.bossCampTarget ?? policy.campTarget : policy.campTarget };
    }
    function campRecoveryRows(dungeon, policy = taskSettings()) {
        const members = dungeon?.members;
        if (!Array.isArray(members) || !members.length) throw new Error('营地队伍状态缺失，已暂停恢复');
        const target = natural(policy.campTarget, 90, 100) / 100;
        return members.map((member) => {
            const status = dungeon.member_status?.[member.key];
            const maxHp = member.max_hp, maxAp = member.max_ap;
            const cap = dungeon.camp_ap_caps?.[member.key];
            if (!Number.isFinite(maxHp) || maxHp <= 0 || !Number.isFinite(maxAp) || maxAp < 0 ||
                !Number.isFinite(status?.hp) || status.hp < 0 || !Number.isFinite(status?.ap) || status.ap < 0 ||
                cap != null && (!Number.isFinite(cap) || cap < 0)) {
                throw new Error(`营地成员「${member.name || member.key}」HP/AP 或上限数据异常，已暂停恢复`);
            }
            const hpTarget = Math.min(maxHp, Math.ceil(maxHp * target)), apGoal = Math.min(maxAp, Math.ceil(maxAp * target));
            const apTarget = Math.min(apGoal, cap ?? Infinity);
            return { key: member.key, name: member.name || member.key, hp: status.hp, ap: status.ap,
                maxHp, maxAp, hpTarget, apTarget, apLimited: cap != null && cap < apGoal };
        });
    }
    function campWait(dungeon, node, policy = taskSettings()) {
        if (policy.campMode === 'off') return 0;
        const elapsed = node?.camp_enter_time ? Math.max(0, Date.now() / 1000 - node.camp_enter_time) : 0;
        const limit = natural(policy.campSeconds, 60, 300);
        if (policy.campMode === 'fixed') return Math.max(0, Math.ceil(limit - elapsed));
        let seconds = 0;
        for (const row of campRecoveryRows(dungeon, policy)) {
            seconds = Math.max(seconds, (row.hpTarget - row.hp) / row.maxHp * 100);
            if (row.maxAp > 0) seconds = Math.max(seconds, (row.apTarget - row.ap) / row.maxAp * 100);
        }
        // 官网每秒恢复最大 HP/AP 的 1%；自动模式以目标为准，不截到固定模式的 60 秒。
        // 当前快照可能已结算部分恢复，接管时不再扣 elapsed，以免重复扣除等待时间。
        // 留出一个整秒的结算余量，已达标则无需再等。
        return seconds > 0 ? Math.ceil(seconds) + 1 : 0;
    }
    async function handleCampNode(dungeon, node) {
        const policy = campPolicy(dungeon, node), automatic = policy.campMode === 'auto';
        log(`${policy.label}：${automatic ? `恢复目标 ${policy.campTarget}%` : policy.campMode === 'fixed' ? `固定休息 ${policy.campSeconds} 秒` : '直接离开'}`);
        if (automatic) campRecoveryRows(dungeon, policy);
        if (!node.camp_enter_time) await api('/dungeon/node/camp/enter', { method: 'POST' });
        const snapshot = automatic ? await fetchCurrentDungeon() : dungeon;
        if (!snapshot || snapshot.dungeon_id !== dungeon.dungeon_id || snapshot.status !== 'exploring' ||
            snapshot.current_node_index !== dungeon.current_node_index) throw new Error('进入营地后探索已变化，请重新接管');
        if (automatic) {
            for (const row of campRecoveryRows(snapshot, policy)) {
                if (row.apLimited) log(`${row.name}：沿用游戏 AP 上限 ${row.apTarget}，本次 AP 目标受该上限限制`);
            }
            if (Number.isFinite(snapshot.sanity) && snapshot.sanity < 10) log('当前理智低于 10，游戏存在最大生命惩罚；营地不会恢复理智', 'warn');
        }
        const seconds = campWait(snapshot, node, policy);
        if (seconds > 0) {
            runtime.phase = `${policy.label}恢复 · ${seconds}s`;
            log(automatic ? `${policy.label}：按 HP/AP 目标 ${policy.campTarget}% 等待约 ${seconds} 秒（含结算余量）` : `${policy.label}：固定休息剩余 ${seconds} 秒`);
            await waitSeconds(seconds);
        }
        const result = (await api('/dungeon/node/camp/leave', { method: 'POST' })).data;
        if (!automatic) return result;
        // 不依赖 GET 在休息期间是否结算回血；只以离营后服务器结果核对实际恢复量。
        const settled = result?.dungeon_id ? result : await fetchCurrentDungeon();
        if (!settled || settled.dungeon_id !== dungeon.dungeon_id) throw new Error('营地结算所属探索无法确认，已暂停');
        const rows = campRecoveryRows(settled, policy);
        const describe = row => `${row.name} HP ${row.hp}/${row.hpTarget}、AP ${row.ap}/${row.apTarget}`;
        const missing = rows.filter(row => row.hp < row.hpTarget || row.ap < row.apTarget);
        if (missing.length) throw new Error(`${policy.label}结算未达目标：${missing.map(describe).join('；')}。请检查理智惩罚或游戏恢复限制，已暂停后续推进`);
        log(`${policy.label}已达到本次目标：${rows.map(describe).join('；')}`, 'success');
        return settled;
    }

    function nodeResolved(node) {
        return !!node && (node.completed === true || node.node_type === 'event' && node.event_choice != null);
    }
    async function advanceDungeon(difficulty = taskSettings().difficulty) {
        for (let step = 0; step < CONFIG.dungeonMaxSteps; step++) {
            checkStop(); await jitter();
            const cur = await fetchCurrentDungeon();
            if (isDungeonTerminal(cur)) return cur;
            if (!cur || cur.status !== 'exploring') throw new Error('探索已变化，请刷新状态后接管');
            const ctx = activeTaskContext;
            if (ctx?.dungeonId && ctx.dungeonId !== cur.dungeon_id) throw new Error('当前副本已改变，已暂停');
            if (ctx) { ctx.dungeonId = cur.dungeon_id; ctx.nodeIndex = cur.current_node_index; }
            const nodeResp = await api('/dungeon/node');
            let node = nodeResp.data;
            const sanity = Number.isFinite(nodeResp.sanity) ? nodeResp.sanity : cur.sanity;
            if (!node?.node_type) throw new Error('节点信息缺失，已保留探索');
            if (node.index != null && node.index !== cur.current_node_index) throw new Error('读取期间节点已改变，已暂停');
            const type = node.node_type;
            const nodeName = type === 'camp' ? campPolicy(cur, node).label : NODE_NAMES[type] || type;
            runtime.phase = `${cur.preset_name || '地下城'} · ${nodeName}`;
            renderDashboard();
            log(`节点 ${Number(cur.current_node_index) + 1}：${nodeName} · 理智 ${sanity ?? '?'}/20`);
            let current = null;
            if (!nodeResolved(node)) {
                if (['battle', 'elite', 'boss'].includes(type)) current = await dungeonBattle(node);
                else if (type === 'event') {
                    if (!node.event || typeof node.event !== 'object') throw new Error('事件尚未加载，请稍后接管');
                    const opts = node.event.options ?? [];
                    if (!Array.isArray(opts)) throw new Error('事件选项格式异常');
                    const name = node.event?.name || '';
                    const isWxt = WXT_PRESET_RE.test(dungeonName(cur));
                    const ordinal = isWxt ? wxtEventOrdinal(cur, node) : null;
                    const wanted = isWxt ? taskSettings().wxtDifficulty || difficulty : difficulty;
                    let pick = chooseDifficultyEvent(node.event, cur, wanted);
                    if (!pick && isWxt && (opts.length || ordinal === 1)) {
                        pick = chooseWxtEventOption(opts, ordinal, { ...taskSettings(), difficulty: wanted });
                        if (!pick && ordinal == null && taskSettings().rerollWxt) throw new Error('望雪台事件阶段不明，已暂停刷开局以避免误撤离');
                        if (pick?.restart) {
                            const limit = Math.min(CONFIG.dungeonMaxRestarts, natural(taskSettings().restartLimit, 10, 30));
                            if (!ctx?.allowRestart) throw new Error(`当前模式不自动撤离；如需刷${wxtStrategy().opening}，请使用“开始探索”`);
                            if (runtime.restarts >= limit) throw new Error(`已达到本批 ${limit} 次重开上限，保留当前局`);
                            await api('/dungeon/retreat', { method: 'POST' });
                            runtime.restarts++;
                            ctx.dungeonId = null; ctx.nodeIndex = null;
                            throw new DungeonRestartError(`望雪台未出现${wxtStrategy().opening}，已撤离；门票和奖励以游戏结算为准`);
                        }
                    }
                    if (!pick) pick = chooseEventOption(opts, name, { sanity, dungeon: cur });
                    if (opts.length && !opts[pick.index]) throw new Error('事件选项已变化');
                    log(`事件「${name}」→ ${opts[pick.index]?.label || '确认'} [${pick.source}]`);
                    current = (await api('/dungeon/node/event/choice', { method: 'POST', body: { choice_index: pick.index }, expectedEvent: node.event })).data;
                } else if (type === 'branch') {
                    const index = chooseBranch(node, cur);
                    current = (await api('/dungeon/node/branch/choose', { method: 'POST', body: { choice_index: index } })).data;
                    log(`路线：${node.branches[index]?.label || index}`);
                } else if (type === 'treasure' || type === 'boss_treasure') {
                    current = (await api('/dungeon/node/treasure', { method: 'POST' })).data;
                    log('宝箱已开启', 'success');
                } else if (type === 'shop') current = await handleShopNode({ sanity });
                else if (type === 'camp') current = await handleCampNode(cur, node);
                else throw new Error(`未知节点「${type}」，已暂停并保留探索`);
                if (current?.dungeon_id) bindDungeon(current);
                if (isDungeonTerminal(current)) { logDungeonFinished(current); return current; }
                // 事件或分支自身已移动到后续节点时，从新节点继续，不额外 next 跳过一格。
                if (current?.status === 'exploring' && current.current_node_index > cur.current_node_index) continue;
                await jitter();
                node = (await api('/dungeon/node')).data;
                if (!nodeResolved(node)) throw new Error('节点尚未完成，已暂停并保留探索');
            }
            const next = await api('/dungeon/node/next', { method: 'POST' });
            if (isDungeonTerminal(next.data)) { logDungeonFinished(next.data, !!next.settlement); return next.data; }
            if (next.settlement || next.data?.settlement) {
                const ended = await fetchCurrentDungeon();
                if (!isDungeonTerminal(ended)) throw new Error('已收到结算但无法确认探索结果，请刷新核对');
                return ended;
            }
        }
        throw new Error(`超过 ${CONFIG.dungeonMaxSteps} 个节点，已暂停并保留探索`);
    }

    // 先检测 current：已有 exploring/lobby 就接管，仅在无活动地下城时才创建新局。
    async function doDungeonRun(presetId, visibility, difficulty, createIfMissing = true, strictPreset = false) {
        let current = await fetchCurrentDungeon();
        if (current && !isDungeonTerminal(current)) {
            if ((strictPreset || presetId) && String(current.preset_id) !== String(presetId)) throw new Error('仍有其他副本探索，请先接管当前副本');
            if (current.status === 'lobby') current = await enterExistingLobby(current);
            else if (current.status === 'exploring') await ensureDungeonLeader(current);
            else throw new Error(`不能接管状态：${current.status}`);
        } else {
            if (!createIfMissing) { log('当前没有可接管的探索'); return null; }
            current = await createDungeon(presetId, visibility, difficulty);
        }
        if (!current?.dungeon_id) throw new Error('缺少副本编号，已暂停');
        if (activeTaskContext) {
            activeTaskContext.dungeonId = current.dungeon_id;
            activeTaskContext.nodeIndex = current.current_node_index;
        }
        return advanceDungeon(difficulty ?? taskSettings().difficulty);
    }
    function dungeonSucceeded(result) {
        // 通关只看结束状态与原因；no_reward、零经验等属于奖励结算，不能用于判负。
        // 安全撤离 safe_exit 即使附带无奖励标记，也应计入成功并重置连续失败次数。
        if (!result || result.status !== 'completed') return false;
        return !['wipe', 'timeout', 'sanity_zero', 'retreat'].includes(result.completion_reason);
    }
    async function resumeDungeon() {
        const result = await doDungeonRun(null, null, null, false);
        if (!result) return;
        if (dungeonSucceeded(result)) runtime.wins++;
        else { runtime.losses++; markIssue(`接管结束但未通关：${result.completion_reason || result.status}`); }
    }

    // 连续挂机：重复执行 doDungeonRun N 次（次数留空/0/1 = 单局）。
    // 每局结束应已自动结算；若仍有残留的活动地下城则停止并提示人工接管，避免误入旧局。
    async function doDungeonRuns(presetId, visibility, difficulty, times, strictPreset = false) {
        const total = Math.max(1, natural(times, 1, 50));
        let finished = 0, wins = 0, losses = 0, consecutiveLosses = 0;
        const ctx = activeTaskContext;
        if (ctx) { ctx.allowRestart = !strictPreset; ctx.freeOnly = strictPreset; }
        try {
            while (finished < total) {
                checkStop();
                setProgress(finished, total, `第 ${finished + 1}/${total} 局`);
                if (finished > 0) {
                    const leftover = await fetchCurrentDungeon();
                    if (leftover && !isDungeonTerminal(leftover)) throw new Error('上一局仍有残留探索，请先接管');
                }
                let result;
                try { result = await doDungeonRun(presetId, visibility, difficulty, true, strictPreset); }
                catch (e) { if (!isRestartError(e)) throw e; log(e.message, 'warn'); await jitter(); continue; }
                if (!isDungeonTerminal(result)) throw new Error('无法确认单局结果，已停止连续探索');
                if (ctx) { ctx.dungeonId = null; ctx.nodeIndex = null; }
                finished++;
                if (dungeonSucceeded(result)) { wins++; runtime.wins++; consecutiveLosses = 0; }
                else { losses++; runtime.losses++; consecutiveLosses++; markIssue(`本局未通关：${result.completion_reason || result.status}`); }
                setProgress(finished, total, `已结束 ${finished}/${total} 局 · 通关 ${wins} · 未通关 ${losses}`);
                if (strictPreset && losses > 0) throw new Error('免费探索未通关，已停止后续副本');
                if (consecutiveLosses >= Math.max(1, natural(taskSettings().lossLimit, 1, 10))) throw new Error(`连续 ${consecutiveLosses} 局未通关，触发止损`);
                await jitter();
            }
            return { finished, wins, losses };
        } finally { if (ctx) { ctx.allowRestart = false; ctx.freeOnly = false; ctx.dungeonId = null; ctx.nodeIndex = null; } }
    }

    async function doAllFreeDungeons(visibility, difficulty) {
        const existing = await fetchCurrentDungeon();
        if (existing && !isDungeonTerminal(existing)) throw new Error('有未结束的副本，请先“接管当前”，再刷全部免费');
        const queue = (await loadPresets()).filter((p) => p.daily_free_available);
        let wins = 0;
        for (let i = 0; i < queue.length; i++) {
            checkStop();
            const p = queue[i];
            setProgress(i, queue.length, `免费探索 · ${p.name || p.id}`);
            const current = await fetchCurrentDungeon();
            if (current && !isDungeonTerminal(current)) throw new Error('发现残留探索，免费队列已暂停');
            const fresh = (await loadPresets()).find((x) => String(x.id) === String(p.id));
            if (!fresh?.daily_free_available) { log(`${p.name} 免费额度已变化，跳过`); continue; }
            // 单局失败即停止队列，不把接管旧本记入下一个副本，也不在免费模式中付费重开。
            const result = await doDungeonRuns(p.id, visibility, difficulty, 1, true);
            wins += result.wins;
            setProgress(i + 1, queue.length, `免费探索 · 已通关 ${wins} 个`);
        }
        log(queue.length ? `免费探索结束：通关 ${wins}/${queue.length}` : '当前没有可用的每日免费探索', 'success');
    }


    // ---------- 6. 自动过剧情 ----------
    // 前端逻辑（index 主 bundle + StoryPlayer）：
    // GET /plot/status → data {available[], completed[], disabled[], categories}，条目含 id/name/order/completed_at；
    // GET /plot/{id}/content（回放加 ?replay=1）→ data.operations[]，每项 {type, payload}；
    // type==="startBattle"：payload {battleId, allowFailure}，走 POST /battle/prepare {battle_id} → data.battle_id(entry)
    //   → 战斗结束后 winner!=="allies" 且 !allowFailure 时前端不推进剧情（战斗失败）；
    // type==="runScript"：payload {scriptId, code}，POST /plot/run-script {script_id, code}（前端失败也继续）；
    // 其余 type（dialogue/choice/演出类）为纯客户端播放，无服务器交互；
    // 全部播完后 POST /plot/{id}/complete。
    async function plotBattle(p, payload, battleNo) {
        const label = `剧情「${p.name || p.id}」第 ${battleNo} 场战斗`;
        const prep = (await api('/battle/prepare', { method: 'POST', body: { battle_id: payload.battleId } })).data;
        const result = await executeBattle(prep?.battle_id, label);
        if (result?.winner !== 'allies' && !payload.allowFailure) throw new Error(`${label}：战败，已停止剧情`);
        log(`${label}：${result?.winner === 'allies' ? '胜利' : '剧情允许失败，继续'}`, result?.winner === 'allies' ? 'success' : 'warn');
    }

    async function runOnePlot(p) {
        log(`剧情：开始「${p.name || p.id}」（${p.id}）`);
        const content = (await api(`/plot/${p.id}/content`)).data;
        const ops = content?.operations || [];
        if (!ops.length) throw new Error(`剧情「${p.name || p.id}」没有可执行的内容`);

        // StoryPlayer 的画面、对话、选项和音频操作都只在浏览器本地播放；
        // 自动模式只需执行会改变服务器状态的战斗与脚本，不能逐条等待本地演出。
        const actions = ops
            .map((op, index) => ({ op, index }))
            .filter(({ op }) => op?.type === 'startBattle' || op?.type === 'runScript');
        const battleCount = actions.filter(({ op }) => op.type === 'startBattle').length;
        const scriptCount = actions.length - battleCount;
        log(`剧情「${p.name || p.id}」：共 ${ops.length} 条指令（战斗 ${battleCount} / 脚本 ${scriptCount} / 跳过纯演出 ${ops.length - actions.length}）`);

        let battleNo = 0;
        for (let actionNo = 0; actionNo < actions.length; actionNo++) {
            checkStop();
            const { op, index } = actions[actionNo];
            if (op.type === 'startBattle') {
                if (!op.payload?.battleId) throw new Error(`剧情「${p.name || p.id}」第 ${index + 1} 条战斗指令缺少 battleId`);
                battleNo++;
                await plotBattle(p, op.payload, battleNo);
            } else if (op.type === 'runScript') {
                log(`剧情「${p.name || p.id}」：执行脚本 ${actionNo + 1}/${actions.length}（原指令 #${index + 1}）`);
                try {
                    await api('/plot/run-script', {
                        method: 'POST',
                        body: { script_id: op.payload?.scriptId || '', code: op.payload?.code || '' },
                    });
                    log(`剧情「${p.name || p.id}」：脚本已执行`, 'info');
                } catch (e) {
                    rethrowIfStopped(e);
                    markIssue(`剧情「${p.name || p.id}」：脚本执行失败（${e.message}），按游戏流程继续`);
                }
            }
            if (actionNo < actions.length - 1) await jitter();
        }
        checkStop();
        await jitter(); // 仅在提交章节完成前保留一次请求间隔，不再按纯演出指令逐条等待
        checkStop();
        await api(`/plot/${p.id}/complete`, { method: 'POST' });
        log(`剧情「${p.name || p.id}」：已完成`, 'success');
    }

    async function doAutoPlot() {
        const completedThisRun = new Set();
        let completedCount = 0;

        // 每轮重新查询状态，让刚完成章节所解锁的新章节也能在同一次任务中继续推进。
        while (true) {
            checkStop();
            const status = (await api('/plot/status')).data || {};
            const plots = (status.available || [])
                .filter((p) => !completedThisRun.has(p.id))
                .sort((a, b) => (a.order ?? 99999) - (b.order ?? 99999));

            if (!plots.length) {
                log(completedCount ? `剧情：全部可推进章节已完成（共 ${completedCount} 章）` : '剧情：没有可推进的章节',
                    completedCount ? 'success' : 'info');
                return;
            }

            log(completedCount ? `剧情：发现 ${plots.length} 章新解锁剧情` : `剧情：共 ${plots.length} 章可推进`);
            for (const p of plots) {
                checkStop();
                await runOnePlot(p); // 战斗失败/complete 失败会抛出，停止整个自动剧情
                completedThisRun.add(p.id);
                completedCount++;
                await jitter();
            }
        }
    }

    async function showPlotStatus() {
        const status = (await api('/plot/status')).data || {};
        log(`剧情状态：可推进 ${(status.available || []).length} / 已完成 ${(status.completed || []).length} / 未解锁 ${(status.disabled || []).length}`, 'info');
    }

    // ---------- 7. 背包管理 ----------
    const RECYCLE_EXCLUDED_NAMES = new Set(['幸运花饰', '修复过的驱动器']);
    let backpackItems = [], equippedItems = [];
    let bagReview = null;
    function updateInventory(data) {
        backpackItems = Array.isArray(data?.backpack?.equipment) ? data.backpack.equipment.filter(Boolean) : [];
        equippedItems = Array.isArray(data?.equipment_slots) ? data.equipment_slots.filter((x) => x?.item) : [];
    }
    async function loadBackpack() {
        const data = (await api('/status')).data || {};
        updateInventory(data);
    }
    function selectedUuids(box) {
        // 任务锁定也会 disabled；仅排除装备保护，不能把临时禁用误当成未选择。
        return [...box.querySelectorAll('input[type=checkbox]:checked')]
            .filter((c) => c.dataset.protected !== '1').map((c) => c.value).sort();
    }
    function protectionReason(item, policy = taskSettings()) {
        if (item.locked) return '已锁定';
        if (RECYCLE_EXCLUDED_NAMES.has(String(item.name || '').trim())) return '不可出售/分解';
        // 与游戏物品工具一致：sellable=false 或售价非正数的装备不能出售，也不能分解。
        if (item.sellable === false || !Number.isFinite(Number(item.value)) || Number(item.value) <= 0) return '不可出售/分解';
        if (Number(item.rarity) >= 5) return '五星及以上保护';
        if (natural(item.rarity) >= natural(policy.protectRarity, 4, 5)) return '品质保护';
        if (policy.protectReinforced && natural(item.reinforce_level) > 0) return '强化保护';
        return '';
    }
    function itemFingerprint(items) {
        return JSON.stringify(items.map((i) => [i.uuid, i.locked, i.rarity, i.reinforce_level, i.name, i.sellable, i.value]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    }
    async function validateBagSelection(uuids) {
        if (!uuids.length) throw new Error('请先勾选装备');
        await loadBackpack();
        const items = uuids.map((id) => backpackItems.find((i) => i.uuid === id));
        if (items.some((i) => !i)) throw new Error('所选装备已变化，请重新加载背包');
        const protectedItem = items.find((i) => protectionReason(i));
        if (protectedItem) throw new Error(`「${protectedItem.name}」受保护：${protectionReason(protectedItem)}`);
        return items;
    }
    async function previewBagAction(kind, box) {
        const uuids = selectedUuids(box);
        bagReview = null; renderBagReview();
        const items = await validateBagSelection(uuids);
        let estimate = '';
        if (kind === 'decompose') {
            const data = (await api('/decompose/preview', { method: 'POST', body: { uuids } })).data;
            estimate = Object.entries(data?.rewards_estimate || {}).map(([name, value]) => `${name} ${value.min ?? 0}–${value.max ?? value.min ?? 0}`).join(' · ')
                || fmtRewards(data?.materials || data?.rewards) || '按游戏实际结算';
        }
        bagReview = { kind, character: getCharacter(), uuids, fingerprint: itemFingerprint(items), names: items.map((i) => i.name || i.uuid), estimate };
        renderBagReview();
    }
    async function commitBagAction(kind, box) {
        const review = bagReview;
        const uuids = selectedUuids(box);
        if (!review || review.kind !== kind || review.character !== getCharacter() || JSON.stringify(uuids) !== JSON.stringify(review.uuids)) throw new Error('预览已失效，请重新预览');
        bagReview = null; renderBagReview();
        const items = await validateBagSelection(uuids);
        if (review.fingerprint !== itemFingerprint(items)) throw new Error('装备状态已变化，请重新预览');
        const result = await api(kind === 'sell' ? '/status/sell_items_bulk' : '/decompose', {
            method: 'POST', body: kind === 'sell' ? { items: uuids.map((u) => ({ entry_uuid: u, count: null })) } : { uuids },
        });
        log(`${kind === 'sell' ? '出售' : '分解'} ${uuids.length} 件：${result.message || '完成'}`, 'success');
        await loadBackpack(); renderBagList();
    }

    // ---------- 8. 强化连点 ----------
    async function doReinforce(selValue, useVoucher, attempts = 1, expectedUuid = null) {
        if (!selValue) throw new Error('请先选择装备');
        const [source, id] = selValue.split('|');
        if (!['backpack', 'equipped'].includes(source) || !id) throw new Error('装备位置无效');
        const count = useVoucher ? 1 : Math.max(1, natural(attempts, 1, 50));
        await loadBackpack();
        const initial = source === 'backpack' ? backpackItems.find((i) => i.uuid === id) : equippedItems.find((i) => i.slot === id)?.item;
        if (!initial || expectedUuid != null && initial.uuid !== expectedUuid) throw new Error('装备已变化，请重新选择');
        const body = { source, ...(source === 'backpack' ? { uuid: id } : { slot: id }), ...(useVoucher ? { use_voucher: true } : {}) };
        try {
            for (let i = 0; i < count; i++) {
                checkStop(); setProgress(i, count, `强化 ${initial.name || '装备'} · 第 ${i + 1} 次`);
                if (i > 0) {
                    await loadBackpack();
                    const current = source === 'backpack' ? backpackItems.find((x) => x.uuid === id) : equippedItems.find((x) => x.slot === id)?.item;
                    if (!current || (initial.uuid && current.uuid !== initial.uuid)) throw new Error('装备已被替换，强化停止');
                }
                const data = (await api('/reinforce/attempt', { method: 'POST', body })).data;
                if (typeof data?.success !== 'boolean') throw new ApiError('强化响应缺少结果，已停止连点，请刷新装备核对', 200, 0, '/reinforce/attempt', true);
                setProgress(i + 1, count);
                log(`第 ${i + 1} 次强化：${data.success ? `成功 +${data.new_level}` : `失败，保底计数 ${data.pity ?? '?'}`}`, data.success ? 'success' : 'warn');
                if (data.success) return data;
                await jitter();
            }
            markIssue(`已达到 ${count} 次强化上限，停止尝试`);
        } finally {
            if (!activeTaskContext?.controller.signal.aborted && getCharacter() === settingsCharacter) {
                try { await loadBackpack(); renderBagList(); } catch (e) { rethrowIfStopped(e); }
            }
        }
    }
    // 每日商店使用独立的购买范围；地下城节点商店仍采用探索策略。
    let dailyShopCatalog = [];
    const dailyShopKey = (shopId, entry) => JSON.stringify([String(shopId), String(entry.entry_id)]);
    function dailyShopSelected(shopId, entry, policy = taskSettings()) {
        const overrides = policy.dailyShopOverrides;
        const key = dailyShopKey(shopId, entry);
        return Object.hasOwn(overrides, key) ? overrides[key]
            : entry.item_id !== 'thunder_gem' && entry.item?.name !== '雷渊晶石';
    }
    async function readDailyShop(shopId) {
        const data = (await api(`/shop/${encodeURIComponent(shopId)}`)).data;
        if (!data || !Array.isArray(data.items)) throw new Error('每日商店商品格式异常');
        return data;
    }
    async function loadDailyShopCatalog() {
        const list = (await api('/shop')).data;
        if (!Array.isArray(list)) throw new Error('商店列表格式异常');
        const catalog = [];
        for (const shop of list) {
            checkStop();
            if (!shop?.shop_id || shop.refresh_type === 'permanent') continue;
            const data = await readDailyShop(shop.shop_id);
            if ((data.refresh_type ?? shop.refresh_type) !== 'daily') continue;
            catalog.push({ ...data, shop_id: shop.shop_id });
        }
        dailyShopCatalog = catalog;
        renderDailyShopList();
        return catalog;
    }
    function dailyShopQuantity(shop, entry) {
        const remaining = entry.remaining, price = entry.price;
        const balance = entry.currency === 'money' ? shop.player_money : entry.currency_balance;
        if (!Number.isSafeInteger(remaining) || remaining < 0 || !Number.isFinite(price) || price < 0
            || typeof entry.currency !== 'string' || !entry.currency
            || !Number.isFinite(balance) || balance < 0) throw new Error('限购、价格或货币余额无效');
        return Math.min(remaining, price === 0 ? remaining : Math.floor(balance / price));
    }
    async function doDailyShop() {
        const catalog = await loadDailyShopCatalog();
        let bought = 0;
        for (const shop of catalog) {
            // 固定本批商品清单，每项只提交一次；重新读取后按稳定编号匹配，避免顺序变化串项。
            const ids = [...new Set(shop.items.filter((entry) => entry?.entry_id != null
                && dailyShopSelected(shop.shop_id, entry)).map((entry) => entry.entry_id))];
            for (const id of ids) {
                checkStop();
                const fresh = await readDailyShop(shop.shop_id);
                if ((fresh.refresh_type ?? shop.refresh_type) !== 'daily') throw new Error('商店刷新类型已变化，停止购买');
                const entry = fresh.items.find((item) => item.entry_id === id);
                if (!entry || !dailyShopSelected(shop.shop_id, entry)) continue;
                const name = entry.item?.name || entry.item_id || String(id);
                let quantity;
                try { quantity = dailyShopQuantity(fresh, entry); }
                catch (e) { markIssue(`每日商店「${name}」：${e.message}，跳过`); continue; }
                if (quantity <= 0) {
                    if (entry.remaining > 0) markIssue(`每日商店「${name}」：${entry.currency_item?.name || (entry.currency === 'money' ? '以太碎片' : entry.currency)}不足，跳过`);
                    continue;
                }
                try {
                    await api(`/shop/${encodeURIComponent(shop.shop_id)}/buy`, { method: 'POST', body: { entry_id: id, quantity } });
                } catch (e) { rethrowIfStopped(e); markIssue(`每日商店「${name}」购买失败：${e.message}`); continue; }
                bought += quantity;
                log(`每日商店：购买「${name}」×${quantity} · ${priceLabel(entry, quantity)}`, 'success');
                if (quantity < entry.remaining) markIssue(`每日商店「${name}」余额不足，仅购买 ${quantity}/${entry.remaining} 件`);
                await jitter();
            }
        }
        await loadDailyShopCatalog();
        log(`每日商店：本次购买 ${bought} 件${catalog.length ? '' : '，暂无每日商店'}`);
    }
    function priceLabel(entry, quantity = 1) {
        return `${entry.price * quantity} ${entry.currency === 'money' ? '以太碎片' : entry.currency_item?.name || entry.currency}`;
    }
    // 建筑个人物品支持 quantity；共享材料每次扣量由游戏决定，按指定次数与冷却执行。
    let donationBuildings = [], donationStatus = null;
    function donationStock(status, itemId) {
        const bag = status?.backpack;
        if (!bag || !Array.isArray(bag.materials) || bag.consumables != null && !Array.isArray(bag.consumables)) {
            throw new Error('材料库存数据缺失，请重新加载');
        }
        let total = 0;
        for (const item of [...bag.materials, ...(bag.consumables || [])]) {
            if (String(item?.item_id) !== String(itemId)) continue;
            if (!Number.isSafeInteger(item.count) || item.count < 0) throw new Error('材料库存数量异常');
            total += item.count;
        }
        if (!Number.isSafeInteger(total)) throw new Error('材料库存数量异常');
        return total;
    }
    async function loadDonationData() {
        const results = await Promise.allSettled([api('/building'), api('/status')]);
        for (const result of results) if (result.status === 'rejected') { rethrowIfStopped(result.reason); throw result.reason; }
        const buildings = results[0].value.data;
        if (!Array.isArray(buildings) || buildings.some(b => !b || b.building_id == null)) throw new Error('建筑列表格式异常');
        donationBuildings = buildings; donationStatus = results[1].value.data;
        renderDonationSettings();
        return { buildings, status: donationStatus };
    }
    function donationSelection(buildings, policy) {
        const matches = buildings.filter(b => String(b.building_id) === policy.donationBuilding);
        if (matches.length !== 1) throw new Error('所选建筑不可用，请重新加载并选择');
        const building = matches[0], upgrade = building.next_upgrade;
        if (!upgrade) return { building, finished: true };
        if (!Number.isSafeInteger(upgrade.target_level) || upgrade.target_level < 1) throw new Error('建筑目标等级异常');
        if (upgrade.target_level !== policy.donationLevel) return { building, finished: true };
        const list = policy.donationType === 'shared' ? upgrade.shared_materials : upgrade.quest_items;
        if (!Array.isArray(list)) throw new Error('建筑材料需求格式异常');
        const items = list.filter(item => item && String(item.item_id) === policy.donationItem);
        if (items.length !== 1) throw new Error('所选材料不在当前需求中，请重新加载并选择');
        const item = items[0], shared = policy.donationType === 'shared';
        const required = shared ? item.total_required : item.required_per_player;
        const contributed = shared ? item.total_contributed : item.player_contributed;
        if (![required, contributed].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('建筑贡献进度异常');
        return { building, item, remaining: Math.max(0, required - contributed), finished: item.is_complete === true || contributed >= required };
    }
    async function doDonation({ waitForCooldown = true } = {}) {
        const policy = { ...taskSettings() }, shared = policy.donationType === 'shared';
        if (!policy.donationBuilding || !policy.donationItem || !policy.donationLevel) throw new Error('请先加载建筑并选择材料及目标等级');
        const times = shared ? policy.donationTimes : 1;
        let completed = 0, expiredCooldownReads = 0, cooldownDeadline = null;
        while (completed < times) {
            checkStop();
            const snapshot = await loadDonationData();
            const selected = donationSelection(snapshot.buildings, policy);
            if (selected.finished) {
                log(`捐献已停止：所选材料需求已完成或建筑已离开目标 Lv.${policy.donationLevel}，本次成功 ${completed} 次`); return;
            }
            const { building, item, remaining } = selected;
            // 等待前就检查库存，避免没有材料仍占用任务锁。
            const owned = donationStock(snapshot.status, item.item_id);
            const quantity = shared ? null : Math.min(policy.donationQuantity, remaining);
            if (owned < (quantity ?? 1)) throw new Error(`「${item.name || item.item_id}」库存不足：现有 ${owned}${quantity != null ? `，本次需要 ${quantity}` : ''}；已停止捐献`);
            if (shared) {
                const cooldown = building.shared_cooldown;
                if (!cooldown || typeof cooldown.can_contribute !== 'boolean') throw new Error('无法确认共享材料冷却状态，已停止');
                if (!cooldown.can_contribute) {
                    if (!waitForCooldown) {
                        log(`自动捐献：共享材料处于冷却，本批已完成 ${completed}/${times} 次；日常不等待，可稍后单独启动捐献`);
                        return;
                    }
                    const until = cooldown.next_available_at;
                    if (!Number.isFinite(until) || until <= 0) throw new Error('共享材料冷却时间异常，请刷新游戏后再试');
                    const now = Date.now() / 1000, remainingSeconds = until - now;
                    if (remainingSeconds > CONFIG.donationMaxWait) throw new Error(`共享捐献冷却超过 ${CONFIG.donationMaxWait / 60} 分钟等待上限，已结束本批，请稍后再启动`);
                    // 首次观察时固定期限，之后的报价不能不断延长；给到期状态留 8 秒同步余量。
                    const firstWait = cooldownDeadline == null;
                    cooldownDeadline ??= now + Math.min(CONFIG.donationMaxWait, Math.max(0, remainingSeconds) + 8);
                    const budget = cooldownDeadline - now;
                    if (budget <= 0) throw new Error('共享捐献冷却等待超时，已结束本批，请刷新游戏后再启动');
                    if (remainingSeconds <= 0 && ++expiredCooldownReads > 3) throw new Error('共享材料冷却已到期但服务器仍不允许贡献，已暂停');
                    if (remainingSeconds > 0) expiredCooldownReads = 0;
                    // 分段等待，定期重新检查需求；停止按钮可立即中断等待。
                    const seconds = Math.min(budget, remainingSeconds <= 0 ? 2 : Math.min(60, Math.ceil(remainingSeconds) + 1));
                    if (firstWait) {
                        log(`共享捐献：等待冷却约 ${Math.max(0, Math.ceil(remainingSeconds))} 秒，可随时停止；本次最多再等 ${Math.ceil(budget)} 秒`);
                    }
                    setProgress(completed, times, `共享捐献冷却 · 剩余约 ${Math.max(0, Math.ceil(remainingSeconds))}s · ${building.name || building.building_id}`);
                    await waitSeconds(seconds);
                    continue;
                }
                expiredCooldownReads = 0;
                cooldownDeadline = null;
            }
            if (!shared && quantity < policy.donationQuantity) log(`所选需求只剩 ${remaining} 件，本次捐献 ${quantity} 件`);
            setProgress(completed, times, `捐献 ${item.name || item.item_id} · ${shared ? `第 ${completed + 1}/${times} 次` : `${quantity} 件`}`);
            const path = `/building/${encodeURIComponent(building.building_id)}/contribute/${policy.donationType}`;
            // shared 没有 quantity 参数，绝不把填写的次数伪装成单次扣料数量。
            const result = await api(path, { method: 'POST', body: { item_id: item.item_id, target_level: policy.donationLevel,
                ...(!shared ? { quantity } : {}) } });
            completed++;
            log(`${building.name || building.building_id}：${shared ? `共享贡献第 ${completed}/${times} 次已提交` : `已捐献「${item.name || item.item_id}」×${quantity}`} · ${result.message || '成功'}`, 'success');
            setProgress(completed, times);
            // 写成功后只回查，不重复提交；新等级和新需求必须重新选择才能继续投入。
            const after = await loadDonationData();
            const nowOwned = donationStock(after.status, item.item_id), used = owned - nowOwned;
            if (!Number.isSafeInteger(used) || used <= 0 || !shared && used !== quantity) {
                throw new ApiError('捐献已返回成功，但库存变化无法核对；请检查游戏记录后再启动', 200, 0, path, true);
            }
            if (shared) log(`本次共享贡献实际扣除「${item.name || item.item_id}」×${used}`);
            if (donationSelection(after.buildings, policy).finished) {
                log(`目标等级或所选材料需求已完成，本次成功捐献 ${completed} 次`, 'success'); return;
            }
            if (completed < times) await jitter();
        }
        log(`指定捐献任务完成：${shared ? `${completed} 次共享贡献` : '本次指定数量已处理'}`, 'success');
    }
    async function doDailyAll(sweepPresetId, sweepTimes = 1, includeSweep = false) {
        const steps = [['邮件领取', doMail], ['每日战斗', doDaily], ['活动处理', () => doEvents()]];
        if (includeSweep) {
            if (!sweepPresetId) throw new Error('已开启日常扫荡，请先选择副本');
            steps.push(['地下城扫荡', () => doSweep(sweepPresetId, sweepTimes)]);
        }
        steps.push(['补领活动奖励', () => doEvents(true)]);
        if (taskSettings().dailyShop) steps.push(['每日商店', doDailyShop]);
        if (taskSettings().dailyDonation) steps.push(['自动捐献', async () => {
            const policy = taskSettings();
            if (!policy.donationBuilding || !policy.donationItem || !policy.donationLevel) {
                log('自动捐献：尚未配置建筑、材料及目标等级，本次跳过'); return;
            }
            await doDonation({ waitForCooldown: false });
        }]);
        for (let i = 0; i < steps.length; i++) {
            checkStop(); const [name, fn] = steps[i]; setProgress(i, steps.length, name);
            try { await fn(); } catch (e) { rethrowIfStopped(e); markIssue(`${name}：${e.message}`); }
            setProgress(i + 1, steps.length, name); await jitter();
        }
    }


    // ---------- 多角色队列：通过请求角色参数切换目标，前台角色保持一致 ----------
    const characterBatch = { characters: [], selected: new Set(), results: [], daily: true, dungeon: false, donation: false };
    function accountCharacters(data) {
        const list = data?.characters;
        if (!Array.isArray(list) || list.some(c => !c || typeof c.username !== 'string' || !c.username.trim() || c.username !== c.username.trim()) ||
            new Set(list.map(c => c.username)).size !== list.length) throw new Error('已绑定角色列表异常，请重新加载');
        return list.map(c => ({ username: c.username, name: typeof c.name === 'string' ? c.name : c.username }));
    }
    async function loadBatchCharacters() {
        characterBatch.characters = [];
        renderCharacterBatch();
        const list = accountCharacters((await api('/account')).data);
        characterBatch.characters = list;
        characterBatch.selected = new Set([...characterBatch.selected].filter(key => list.some(c => c.username === key)));
        renderCharacterBatch();
        log(`已加载 ${list.length} 个绑定角色，请勾选本批角色和任务`);
    }
    async function executeCharacterBatch() {
        const root = activeTaskContext;
        const modes = { daily: characterBatch.daily, dungeon: characterBatch.dungeon, donation: characterBatch.donation };
        const queue = characterBatch.characters.filter(c => characterBatch.selected.has(c.username))
            .map(c => ({ ...c, policy: readCharacterSettings(c.username), outcome: 'pending', detail: '等待执行', steps: [] }));
        if (!queue.length) throw new Error('请先加载并勾选已绑定角色');
        if (!Object.values(modes).some(Boolean)) throw new Error('请至少选择一种批量任务');
        characterBatch.results = queue;
        renderCharacterBatch();
        const original = { status: runtime.status, dungeon: runtime.dungeon, presets: runtime.presets, explorationAllowance: runtime.explorationAllowance };
        const originalCatalogs = { dailyShopCatalog, donationBuildings, donationStatus };
        const totals = newCounters();
        try {
            for (const item of queue) {
                checkStop(root);
                item.outcome = 'running'; item.detail = '正在核对角色'; renderCharacterBatch();
                const child = { ...root, character: item.username, pageCharacter: root.character, batchCharacter: true,
                    settings: item.policy, dungeonId: null, nodeIndex: null, leaderId: null, accelUsed: 0 };
                Object.assign(runtime, { status: null, dungeon: null, presets: [], explorationAllowance: null, ...newCounters() });
                dailyShopCatalog = []; donationBuildings = []; donationStatus = null;
                try {
                    // 复查绑定关系后才设置目标上下文；角色锁在所有读写结束前一直持有。
                    const allowed = accountCharacters((await api('/account')).data);
                    if (!allowed.some(c => c.username === item.username)) {
                        const error = new Error(`角色 @${item.username} 已不在当前登录账户中，已停止整批任务`);
                        error.fatal = true; throw error;
                    }
                    activeTaskContext = child;
                    await withCharacterLock(item.username, async () => {
                        await api('/status'); // observeResponse 严格确认 username，失败时不写入。
                        const policy = child.settings, steps = [];
                        if (modes.daily) steps.push(['日常', () => doDailyAll(policy.sweepPreset, policy.sweepTimes, policy.dailySweep)]);
                        if (modes.dungeon) steps.push(['探索', async () => {
                            if (!policy.dungeonPreset) throw new Error('该角色未保存探索副本，请切换到该角色配置后再运行');
                            await loadPresets();
                            await doDungeonRuns(policy.dungeonPreset, policy.visibility, policy.difficulty, policy.runs);
                        }]);
                        if (modes.donation && !(modes.daily && policy.dailyDonation)) steps.push(['捐献', () => doDonation({ waitForCooldown: false })]);
                        for (const [name, action] of steps) {
                            checkStop(child);
                            item.detail = `正在执行${name}`; renderCharacterBatch();
                            const before = runtime.issues;
                            await action(); checkStop(child);
                            item.steps.push(`${name}${runtime.issues > before ? '有警告' : '已处理'}`);
                        }
                        item.outcome = runtime.issues ? 'partial' : 'success';
                        item.detail = item.steps.join(' · ');
                    });
                } catch (error) {
                    item.outcome = isStopError(error) ? 'stopped' : 'error'; item.detail = error.message;
                    runtime.issues++;
                    log(`角色任务结束：${error.message}`, isStopError(error) ? 'warn' : 'error');
                    // 停止、登录失效、身份变化及结果不确定必须终止整批，普通错误仅结束本角色。
                    rethrowIfStopped(error);
                } finally {
                    item.counters = Object.fromEntries(Object.keys(totals).map(key => [key, runtime[key]]));
                    for (const key of Object.keys(totals)) totals[key] += runtime[key];
                    activeTaskContext = root;
                    renderCharacterBatch();
                }
            }
        } finally {
            activeTaskContext = root;
            Object.assign(runtime, original, totals);
            ({ dailyShopCatalog, donationBuildings, donationStatus } = originalCatalogs);
            renderDailyShopList(); renderDonationSettings();
            for (const item of queue) if (item.outcome === 'pending') item.detail = '本批已停止，未执行';
            setProgress(queue.filter(item => item.outcome !== 'pending').length, queue.length, '多角色任务处理结束');
            renderCharacterBatch();
        }
    }

    /******************** 控制台页面 ********************/
    loadSettings();
    function card(page, title, symbol, description = '') {
        const box = el('section', 'ah-card');
        const head = el('div', 'ah-card-head'); head.append(icon(symbol), el('span', '', title)); box.appendChild(head);
        if (description) box.appendChild(el('p', 'ah-sub', description));
        page.appendChild(box); return box;
    }
    function button(parent, text, symbol, callback, variant = '') {
        const b = el('button', `ah-btn ${variant}`); if (symbol) b.appendChild(icon(symbol)); b.appendChild(el('span', '', text));
        b.onclick = callback; parent.appendChild(b); return b;
    }
    function taskButton(parent, text, symbol, name, fn, variant = '') {
        const b = button(parent, text, symbol, () => runTask(name, fn), variant); ui.taskButtons.push(b); return b;
    }
    function field(parent, label, input, full = false) {
        const wrap = el('label', `ah-field ${full ? 'full' : ''}`); wrap.append(el('span', '', label), input); input.setAttribute('aria-label', label); parent.appendChild(wrap); return input;
    }
    function numberSetting(parent, key, label) {
        const [min, max] = NUMBER_LIMITS[key];
        const input = el('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = '1'; input.value = settings[key];
        input.dataset.setting = key; ui.controls[key] = input;
        input.onchange = () => {
            const value = Number(input.value);
            if (runningTask) { input.value = settings[key]; return; }
            if (!input.value.trim() || !Number.isInteger(value) || value < min || value > max) { input.value = settings[key]; log(`${label}应为 ${min}–${max} 的整数`, 'warn'); return; }
            setSetting(key, value); renderPolicySummary();
        };
        return field(parent, label, input);
    }
    function selectSetting(parent, key, label, choices, full = false) {
        const select = el('select'); select.dataset.setting = key; ui.controls[key] = select;
        for (const [value, name] of choices) select.appendChild(new Option(name, value));
        select.value = settings[key];
        select.onchange = () => { if (runningTask) { select.value = settings[key]; return; } setSetting(key, select.value); renderPolicySummary(); };
        return field(parent, label, select, full);
    }
    function toggleSetting(parent, key, label) {
        const wrap = el('label', 'ah-toggle'), cb = el('input'); cb.type = 'checkbox'; cb.checked = !!settings[key]; cb.setAttribute('aria-label', label); cb.dataset.setting = key;
        ui.controls[key] = cb; wrap.append(el('span', '', label), cb); parent.appendChild(wrap);
        cb.onchange = () => { if (runningTask) { cb.checked = !!settings[key]; return; } setSetting(key, cb.checked); renderPolicySummary(); if (key === 'protectReinforced') { renderBagList(); } };
        return cb;
    }
    function row(parent) { const r = el('div', 'ah-row'); parent.appendChild(r); return r; }
    function fields(parent) { const r = el('div', 'ah-fields'); parent.appendChild(r); return r; }
    function openTab(name) {
        if (!ui.pages[name]) name = 'overview';
        ui.scrolls = ui.scrolls || {}; ui.scrolls[ui.tab] = content.scrollTop; ui.tab = name;
        for (const [key, page] of Object.entries(ui.pages)) page.hidden = key !== name;
        for (const tab of tabs.children) { tab.setAttribute('aria-selected', String(tab.dataset.page === name)); tab.tabIndex = tab.dataset.page === name ? 0 : -1; }
        content.scrollTop = ui.scrolls[name] || 0; writeStorage('aether-helper-v2-tab', name);
        if (name === 'logs') renderLogs();
        if (name === 'dungeon' && ui.ready) renderCharacterOrder();
        constrainPanel();
    }
    for (const [key, label, symbol] of [['overview', '总览', 'grid'], ['daily', '日常', 'bolt'], ['dungeon', '探索', 'compass'], ['bag', '背包', 'bag'], ['settings', '策略', 'settings'], ['logs', '日志', 'log']]) {
        const b = el('button', 'ah-tab'); b.append(icon(symbol), el('span', '', label)); b.dataset.page = key; b.id = `ah-tab-${key}`;
        b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', `ah-page-${key}`); b.onclick = () => openTab(key); tabs.appendChild(b);
        const page = el('div', 'ah-page'); page.id = `ah-page-${key}`; page.setAttribute('role', 'tabpanel'); page.setAttribute('aria-labelledby', b.id); ui.pages[key] = page; content.appendChild(page);
        b.onkeydown = (e) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault(); const buttons = [...tabs.children], index = buttons.indexOf(b);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next].click(); buttons[next].focus();
        };
    }
    const overview = ui.pages.overview;
    const hero = el('section', 'ah-card ah-hero'), heroRow = el('div', 'ah-hero-row'), heroCopy = el('div', 'ah-hero-copy');
    ui.heroTitle = el('div', 'ah-hero-title'); ui.heroMeta = el('div', 'ah-hero-meta');
    heroCopy.append(el('div', 'ah-eyebrow', 'MISSION CONTROL'), ui.heroTitle, ui.heroMeta);
    ui.ring = el('div', 'ah-ring'); ui.ring.setAttribute('role', 'img'); const ringInner = el('div', 'ah-ring-inner'); ui.ringValue = el('strong', '', '—'); ringInner.append(ui.ringValue, el('small', '', '理智 / 20')); ui.ring.appendChild(ringInner);
    heroRow.append(heroCopy, ui.ring); hero.appendChild(heroRow);
    const progress = el('div', 'ah-progress'); ui.progress = el('span'); progress.appendChild(ui.progress);
    const progressLabel = el('div', 'ah-progress-label'); ui.progressLabel = el('span'); ui.waitLabel = el('span'); progressLabel.append(ui.progressLabel, ui.waitLabel); hero.append(progress, progressLabel); overview.appendChild(hero);
    const stats = el('div', 'ah-stats'); ui.stats = [];
    for (const text of ['本批胜利', '未获胜', '加速用券', '商店支出']) { const stat = el('div', 'ah-stat'), value = el('strong', '', '0'); ui.stats.push(value); stat.append(value, el('small', '', text)); stats.appendChild(stat); } overview.appendChild(stats);
    const overviewActions = row(overview);
    taskButton(overviewActions, '同步状态', 'refresh', '同步状态', refreshAll);
    button(overviewActions, '安排探索', 'compass', () => openTab('dungeon'), 'primary ah-grow');
    const routeCard = card(overview, '探索路线', 'compass'); ui.dungeonTitle = el('div'); ui.dungeonMeta = el('div', 'ah-sub'); ui.route = el('div', 'ah-route');
    const legend = el('div', 'ah-legend'); legend.append(el('b', '', '■ 当前 / 已完成'), el('span', '', '□ 待探索'), el('span', '', '金框 · 首领'));
    routeCard.append(ui.dungeonTitle, ui.dungeonMeta, ui.route, legend);
    const teamCard = card(overview, '队伍状态', 'heart'); ui.team = el('div', 'ah-team'); teamCard.appendChild(ui.team);

    const batchCard = card(overview, '多角色任务队列', 'grid', '勾选同一登录账户下的已绑定角色，按列表顺序执行各角色保存的配置。请先在游戏中分别切换角色，保存日常、探索和捐献设置。');
    const batchActions = row(batchCard);
    taskButton(batchActions, '加载绑定角色', 'refresh', '加载绑定角色', loadBatchCharacters);
    const batchClear = button(batchActions, '清空勾选', null, () => {
        if (runningTask) return;
        characterBatch.selected.clear(); renderCharacterBatch();
    }); batchClear.dataset.lockTask = '1';
    const batchList = el('div', 'ah-list'); batchList.style.marginTop = '10px'; batchCard.appendChild(batchList);
    for (const [key, title] of [['daily', '执行日常（包含该角色已开启的扫荡、商店和捐献）'], ['dungeon', '执行探索（保存的副本及连续局数）'], ['donation', '执行捐献（日常已包含时不重复）']]) {
        const label = el('label', 'ah-toggle'), input = el('input'); input.type = 'checkbox';
        input.checked = characterBatch[key]; input.dataset.lockTask = '1'; input.dataset.batchMode = key;
        input.setAttribute('aria-label', title); label.append(el('span', '', title), input); batchCard.appendChild(label);
        input.onchange = () => { if (runningTask) { input.checked = characterBatch[key]; return; } characterBatch[key] = input.checked; };
    }
    const batchStart = button(row(batchCard), '开始多角色任务', 'play', () => runTask('多角色任务', executeCharacterBatch, { batch: true }), 'primary');
    ui.taskButtons.push(batchStart);
    batchCard.appendChild(el('div', 'ah-sub', '助手显示正在处理的角色，游戏页面仍保留原角色；运行中请勿手动操作游戏。共享捐献遇冷却即结束本批。普通错误跳到下一角色；停止、登录失效或操作结果不确定时停止整批。刷新页面不会自动继续。'));
    const batchResults = el('div', 'ah-list'); batchResults.setAttribute('aria-live', 'polite'); batchCard.appendChild(batchResults);
    function renderCharacterBatch() {
        batchList.replaceChildren();
        for (const character of characterBatch.characters) {
            const label = el('label', 'ah-item'), input = el('input'); input.type = 'checkbox';
            input.value = character.username; input.dataset.batchCharacter = character.username; input.dataset.lockTask = '1';
            input.checked = characterBatch.selected.has(character.username); input.disabled = !!runningTask;
            input.onchange = () => {
                if (runningTask) { input.checked = characterBatch.selected.has(character.username); return; }
                if (input.checked) characterBatch.selected.add(character.username); else characterBatch.selected.delete(character.username);
            };
            const copy = el('span', 'ah-item-copy', character.name);
            const policy = readCharacterSettings(character.username);
            copy.appendChild(el('small', '', `@${character.username} · 探索 ${policy.dungeonPreset || '未配置'} ×${policy.runs} · 捐献 ${policy.donationItem || '未配置'}`));
            label.append(input, copy); batchList.appendChild(label);
        }
        if (!characterBatch.characters.length) batchList.appendChild(el('div', 'ah-empty', '加载绑定角色后勾选本批名单'));
        batchResults.replaceChildren();
        const names = { pending: '未执行', running: '执行中', success: '已完成', partial: '有警告', error: '失败', stopped: '已停止' };
        for (const item of characterBatch.results) {
            const row = el('div', 'ah-item'), copy = el('span', 'ah-item-copy', `${item.name} (@${item.username}) · ${names[item.outcome]}`);
            copy.appendChild(el('small', '', item.detail));
            if (item.counters) copy.appendChild(el('small', '', `胜利 ${item.counters.wins} · 未获胜 ${item.counters.losses} · 扫荡 ${item.counters.sweepDone} · 用券 ${item.counters.accelUsed}`));
            row.appendChild(copy); batchResults.appendChild(row);
        }
    }
    renderCharacterBatch();

    const dailyCard = card(ui.pages.daily, '日常一条龙', 'bolt', '领取邮件，优先高收益每日挑战，完成活动后补领奖励，再购买每日商店商品并按已保存配置捐献。');
    toggleSetting(dailyCard, 'dailySweep', '一键日常包含扫荡'); ui.dailySummary = el('div', 'ah-note'); dailyCard.appendChild(ui.dailySummary);
    const dailyActions = row(dailyCard); dailyActions.style.marginTop = '12px';
    taskButton(dailyActions, '开始日常', 'play', '日常一条龙', () => doDailyAll(settings.sweepPreset, settings.sweepTimes, settings.dailySweep), 'primary ah-grow');
    const quick = row(dailyCard); quick.style.marginTop = '8px';
    taskButton(quick, '邮件', null, '邮件领取', doMail); taskButton(quick, '每日战斗', null, '每日战斗', doDaily); taskButton(quick, '活动', null, '活动处理', () => doEvents());
    const dailyShopCard = card(ui.pages.daily, '每日商店', 'bag', '默认购买除雷渊晶石以外的所有商品，按今日剩余限购和实际余额购买。材料兑换商品也包含在内，可逐项取消勾选。');
    toggleSetting(dailyShopCard, 'dailyShop', '一键日常包含每日商店');
    const dailyShopActions = row(dailyShopCard);
    taskButton(dailyShopActions, '加载商品', 'refresh', '加载每日商店', loadDailyShopCatalog);
    taskButton(dailyShopActions, '购买所选商品', 'bag', '每日商店购买', doDailyShop, 'primary');
    const dailyShopReset = button(dailyShopActions, '恢复默认范围', null, () => {
        if (runningTask) return;
        setSetting('dailyShopOverrides', {}); renderDailyShopList();
    }); dailyShopReset.dataset.lockTask = '1';
    const dailyShopList = el('div', 'ah-list'); dailyShopList.style.marginTop = '10px'; dailyShopCard.appendChild(dailyShopList);
    function renderDailyShopList() {
        dailyShopList.replaceChildren();
        for (const shop of dailyShopCatalog) {
            dailyShopList.appendChild(el('div', 'ah-sub', shop.name || String(shop.shop_id)));
            for (const entry of shop.items) {
                if (!entry || entry.entry_id == null) continue;
                const label = el('label', 'ah-item'), cb = el('input');
                cb.type = 'checkbox'; cb.dataset.lockTask = '1'; cb.dataset.shopEntry = dailyShopKey(shop.shop_id, entry);
                cb.checked = dailyShopSelected(shop.shop_id, entry, settings); cb.disabled = !!runningTask;
                cb.onchange = () => {
                    if (runningTask) { cb.checked = dailyShopSelected(shop.shop_id, entry, settings); return; }
                    setSetting('dailyShopOverrides', { ...settings.dailyShopOverrides, [dailyShopKey(shop.shop_id, entry)]: cb.checked });
                };
                const copy = el('span', 'ah-item-copy', entry.item?.name || entry.item_id || String(entry.entry_id));
                copy.appendChild(el('small', '', `${priceLabel(entry)} / 件 · ${entry.remaining === 0 ? '今日已售完' : `今日剩余 ${entry.remaining ?? '?'}`}`));
                label.append(cb, copy); dailyShopList.appendChild(label);
            }
        }
        if (!dailyShopCatalog.length) dailyShopList.appendChild(el('div', 'ah-empty', '加载商品后可调整范围；未修改时采用默认范围。'));
    }
    renderDailyShopList();
    const donationCard = card(ui.pages.daily, '建筑材料捐献', 'bag', '选择建筑和材料后启动。个人物品按指定数量捐献；共享材料按指定次数贡献，冷却期间自动等待。');
    toggleSetting(donationCard, 'dailyDonation', '一键日常包含自动捐献');
    const donationActions = row(donationCard);
    taskButton(donationActions, '加载建筑材料', 'refresh', '加载建筑材料', loadDonationData);
    const donationFields = fields(donationCard); donationFields.style.marginTop = '10px';
    const donationBuildingSel = selectSetting(donationFields, 'donationBuilding', '捐献建筑', [['', '先加载建筑…']], true);
    const donationTypeSel = selectSetting(donationFields, 'donationType', '捐献类型', [['quest', '个人任务物品（指定数量）'], ['shared', '共享材料（指定次数）']], true);
    const donationItemSel = selectSetting(donationFields, 'donationItem', '捐献材料', [['', '先选择建筑…']], true);
    const donationQuantityInput = numberSetting(donationFields, 'donationQuantity', '本次捐献数量');
    const donationTimesInput = numberSetting(donationFields, 'donationTimes', '本次共享贡献次数');
    const donationNote = el('div', 'ah-note'); donationCard.appendChild(donationNote);
    const donationStartRow = row(donationCard); donationStartRow.style.marginTop = '10px';
    taskButton(donationStartRow, '开始指定捐献', 'play', '自动捐献', doDonation, 'primary');
    const donationLevelBtn = button(donationStartRow, '采用当前目标等级', null, () => {
        if (runningTask) return;
        selectDonationLevel(); renderDonationSettings();
    }); donationLevelBtn.dataset.lockTask = '1';
    donationCard.appendChild(el('div', 'ah-sub', '仅向选定等级投入，需求完成或建筑升级后停止。库存不足时停止，个人物品需求不足时只补缺口；共享材料每次扣量由游戏决定。一键日常遇到共享冷却就结束本批；单独启动每次冷却最多等待 10 分钟，可随时停止。未配置时日常跳过。'));
    function selectDonationLevel() {
        const building = donationBuildings.find(b => String(b.building_id) === settings.donationBuilding);
        setSetting('donationLevel', building?.next_upgrade?.target_level || 0);
        setSetting('donationItem', '');
    }
    donationBuildingSel.onchange = () => {
        if (!runningTask) { setSetting('donationBuilding', donationBuildingSel.value); selectDonationLevel(); }
        renderDonationSettings();
    };
    donationTypeSel.onchange = () => {
        if (!runningTask) { setSetting('donationType', donationTypeSel.value); setSetting('donationItem', ''); }
        renderDonationSettings();
    };
    donationItemSel.onchange = () => {
        if (!runningTask) setSetting('donationItem', donationItemSel.value);
        renderDonationSettings();
    };
    function renderDonationSettings() {
        const fill = (select, choices, value, empty) => {
            select.replaceChildren(new Option(empty, ''));
            for (const choice of choices) {
                const option = new Option(choice.text, choice.value); option.disabled = !!choice.disabled; select.appendChild(option);
            }
            if (value && !choices.some(c => c.value === value)) select.appendChild(new Option(`已保存 #${value}（当前不可用）`, value));
            select.value = value;
        };
        fill(donationBuildingSel, donationBuildings.map(b => ({ value: String(b.building_id),
            text: `${b.name || b.building_id}${b.next_upgrade ? ` → Lv.${b.next_upgrade.target_level}` : '（已满级）'}`,
            disabled: !b.next_upgrade })), settings.donationBuilding, '请选择建筑…');
        donationTypeSel.value = settings.donationType;
        const building = donationBuildings.find(b => String(b.building_id) === settings.donationBuilding);
        const shared = settings.donationType === 'shared', upgrade = building?.next_upgrade;
        const items = (shared ? upgrade?.shared_materials : upgrade?.quest_items) || [];
        fill(donationItemSel, (Array.isArray(items) ? items : []).filter(item => item?.item_id != null).map(item => {
            let stock = '未知';
            try { stock = donationStock(donationStatus, item.item_id); } catch (_) { /* 执行前仍严格核对 */ }
            return { value: String(item.item_id), text: `${item.name || item.item_id} · 库存 ${stock}${item.is_complete ? ' · 已完成' : ''}`, disabled: item.is_complete === true };
        }), settings.donationItem, '请选择材料…');
        donationQuantityInput.closest('label').hidden = shared;
        donationTimesInput.closest('label').hidden = !shared;
        const item = Array.isArray(items) && items.find(i => String(i?.item_id) === settings.donationItem);
        const amount = item ? shared ? `${item.total_contributed}/${item.total_required}` : `${item.player_contributed}/${item.required_per_player}` : '未选择材料';
        donationNote.textContent = `保存的目标：${settings.donationLevel ? `Lv.${settings.donationLevel}` : '未选择'} · ${shared ? '共享进度' : '个人进度'} ${amount}`;
        if (upgrade && upgrade.target_level !== settings.donationLevel) donationNote.textContent += '。目标等级不一致，请点击“采用当前目标等级”后重新选择材料。';
        if (shared && building?.shared_cooldown?.can_contribute === false) {
            donationNote.textContent += '。当前处于冷却中：日常跳过，单独启动最多等待 10 分钟并复查。';
        }
    }
    renderDonationSettings();
    const sweepCard = card(ui.pages.daily, '地下城扫荡', 'compass', '一次任务最多 16 次，按服务器单次上限自动分批。每批重新核对每日额度、票券和门票条件。');
    const sweepFields = fields(sweepCard);
    const sweepPresetSel = selectSetting(sweepFields, 'sweepPreset', '扫荡副本', [['', '选择扫荡副本…']], true);
    numberSetting(sweepFields, 'sweepTimes', '扫荡次数');
    ui.sweepInfo = el('div', 'ah-note', '先选择副本，查询可用次数与消耗。'); sweepCard.appendChild(ui.sweepInfo);
    const sweepActions = row(sweepCard); sweepActions.style.marginTop = '10px';
    taskButton(sweepActions, '查询额度', 'refresh', '查询扫荡', async () => {
        if (!settings.sweepPreset) throw new Error('请先选择扫荡副本');
        const info = await fetchSweepInfo(settings.sweepPreset);
        const n = clampSweepTimes(info, settings.sweepTimes, false);
        ui.sweepInfo.textContent = `单次请求上限 ${info.max_times} 次 · 今日剩余 ${info.daily_remaining} 次 · 加速券 ${info.ticket_owned} 张 · 每次 ${info.ticket_cost} 张${info.entry_item_cost?.id ? ` · 每次门票 ${info.entry_item_cost.amount}` : ''}。本次计划 ${n} 次（最多 16 次，自动分批；每批重新核对）。`;
    });
    taskButton(sweepActions, '执行扫荡', 'play', '地下城扫荡', () => doSweep(settings.sweepPreset, settings.sweepTimes), 'primary');
    const plotCard = card(ui.pages.daily, '剧情推进', 'log', '按章节顺序执行战斗和剧情脚本。要求胜利的战斗失败后停止。');
    const plotActions = row(plotCard); taskButton(plotActions, '推进可用剧情', 'play', '自动剧情', doAutoPlot); taskButton(plotActions, '查看章节', null, '剧情状态', showPlotStatus);

    const dungeonCard = card(ui.pages.dungeon, '探索计划', 'compass', '可接管已有探索；有其他副本残留时，免费全刷会暂停。');
    const dungeonFields = fields(dungeonCard);
    const dungeonPresetSel = selectSetting(dungeonFields, 'dungeonPreset', '探索副本', [['', '选择探索副本…']], true);
    numberSetting(dungeonFields, 'runs', '连续局数');
    selectSetting(dungeonFields, 'difficulty', '难度', SETTING_CHOICES.difficulty.map((d) => [d, d]));
    selectSetting(dungeonFields, 'visibility', '队伍可见性', [['private', '私密'], ['friends', '仅好友'], ['public', '公开']], true);
    selectSetting(dungeonFields, 'wxtStrategy', '望雪台组队策略', Object.entries(WXT_STRATEGIES).map(([key, strategy]) => [key, strategy.name]), true);
    selectSetting(dungeonFields, 'wxtDifficulty', '冰龙本事件难度（望雪台）', [['', '跟随上方难度'], ...SETTING_CHOICES.difficulty.map(d => [d, d])], true);
    dungeonCard.appendChild(el('div', 'ah-sub', '冰龙本难度事件按此选择执行，开启刷目标开局也不会改成简单。设置按角色保存；配队、事件目标与营地休息策略独立生效。'));
    dungeonCard.appendChild(el('div', 'ah-sub', '火系烬蓟沿用原队友优先级；双光爆破招募 @Ilya、@a，开局目标为晨露草。自动重开仍由策略页“望雪台刷目标开局”控制；公开队伍继续等待满员。'));
    ui.dungeonSummary = el('div', 'ah-note'); dungeonCard.appendChild(ui.dungeonSummary);
    dungeonCard.appendChild(el('div', 'ah-sub', '难度也用于认知晶庭等副本内的难度选择事件；冰龙本可单独指定。按选项名称匹配，不按排列顺序猜测；目标难度缺失、重复或不可选时暂停。'));
    const dungeonActions = row(dungeonCard); dungeonActions.style.marginTop = '12px';
    taskButton(dungeonActions, '接管当前', 'refresh', '接管探索', resumeDungeon);
    taskButton(dungeonActions, '开始探索', 'play', '地下城探索', () => doDungeonRuns(settings.dungeonPreset, settings.visibility, settings.difficulty, settings.runs), 'primary ah-grow');
    const dungeonExtra = row(dungeonCard); dungeonExtra.style.marginTop = '8px';
    taskButton(dungeonExtra, '刷全部免费', null, '免费探索全刷', () => doAllFreeDungeons(settings.visibility, settings.difficulty));
    taskButton(dungeonExtra, '刷新副本', null, '刷新副本', refreshPresets);
    const hermitCard = card(ui.pages.dungeon, '旧日救援据点默认配置', 'shield');
    toggleSetting(hermitCard, 'hermitDefaults', '启用旧日专属配置');
    hermitCard.appendChild(el('div', 'ah-note', '助战：@ldya → 1 号位，@Guqii0812 → 2 号位，自己 → 3 号位。商店购买全部 Buff / 符文和理智补给；普通营地跳过，Boss 前营地固定休息 100 秒。'));
    hermitCard.appendChild(el('div', 'ah-sub', '仅在旧日救援据点生效，关闭后使用通用配置。私密/仅好友队伍使用指定助战；公开队伍仍等待玩家满员。购买按库存与余额进行，不受单品上限和理智余量限制；“跳过商店”仍生效。'));
    const friendCard = card(ui.pages.dungeon, '助战好友', 'shield', '私密/仅好友队伍最多优先选择 2 人，其余按等级补齐；望雪台火系保留原候补，双光使用指定账号。公开队伍等待玩家加满 3 人后自动开始。');
    const friendActions = row(friendCard);
    taskButton(friendActions, '加载好友', 'refresh', '加载好友', async () => { const friends = (await api('/social/friends')).data?.friends || []; renderFriendList(friends.filter((f) => !f.offline && f.username)); });
    const clearFriends = button(friendActions, '清空优先', null, () => { preferredFriends.clear(); setSetting('friends', []); for (const cb of friendListBox.querySelectorAll('input')) cb.checked = false; }); clearFriends.dataset.lockTask = '1';
    const friendListBox = el('div', 'ah-list'); friendListBox.style.marginTop = '10px'; friendListBox.appendChild(el('div', 'ah-empty', '加载好友后设置优先队友')); friendCard.appendChild(friendListBox);
    function renderFriendList(friends) {
        orderFriends = friends;
        renderCharacterOrder();
        friendListBox.replaceChildren();
        if (!friends.length) { friendListBox.appendChild(el('div', 'ah-empty', '没有可招募的好友')); return; }
        for (const friend of friends.sort((a, b) => (b.level || 0) - (a.level || 0))) {
            const item = el('label', 'ah-item'), cb = el('input'); cb.type = 'checkbox'; cb.checked = preferredFriends.has(friend.username); cb.dataset.lockTask = '1'; cb.disabled = !!runningTask;
            cb.value = friend.username;
            cb.onchange = () => {
                if (cb.checked && preferredFriends.size >= 2) { cb.checked = false; log('最多优先选择两名好友', 'warn'); return; }
                cb.checked ? preferredFriends.add(friend.username) : preferredFriends.delete(friend.username); setSetting('friends', [...preferredFriends]);
            };
            const copy = el('span', 'ah-item-copy', friend.name || friend.username); copy.appendChild(el('small', '', `@${friend.username}`));
            item.append(cb, copy, el('span', 'ah-item-badge', `Lv.${friend.level ?? '?'}`)); friendListBox.appendChild(item);
        }
    }

    const orderCard = card(ui.pages.dungeon, '角色站位排序', 'shield', '设置每场战斗的前后顺序，适用于探索、每日挑战和剧情战斗。上方角色优先靠前；未上场者跳过，未指定者按原相对顺序排在后面。');
    selectSetting(fields(orderCard), 'front', '战斗站位', [['keep', '保留游戏站位'], ['hp', '最大生命值优先'], ['custom', '自定义角色顺序']], true);
    let orderFriends = [];
    const orderActions = row(orderCard);
    taskButton(orderActions, '加载队伍与好友', 'refresh', '加载排序角色', async () => {
        const results = await Promise.allSettled([api('/status'), fetchCurrentDungeon(), api('/social/friends')]);
        for (const result of results) if (result.status === 'rejected') { rethrowIfStopped(result.reason); markIssue(`读取排序角色失败：${result.reason.message}`); }
        if (results[2].status === 'fulfilled') orderFriends = results[2].value.data?.friends || [];
        renderCharacterOrder();
    });
    const orderClear = button(orderActions, '清空排序', null, () => {
        if (runningTask) return;
        setSetting('characterOrder', []); setSetting('front', 'keep'); ui.controls.front.value = 'keep'; renderCharacterOrder();
    }); orderClear.dataset.lockTask = '1';
    const orderAddRow = row(orderCard); orderAddRow.style.marginTop = '10px';
    const orderSelect = el('select'); orderSelect.dataset.lockTask = '1'; orderSelect.style.flex = '1';
    orderSelect.setAttribute('aria-label', '添加排序角色'); orderAddRow.appendChild(orderSelect);
    const orderAdd = button(orderAddRow, '添加', null, () => {
        if (runningTask || !orderSelect.value) return;
        saveCharacterOrder([...settings.characterOrder, orderSelect.value]);
    }); orderAdd.dataset.lockTask = '1';
    const orderList = el('div', 'ah-list'); orderList.style.marginTop = '10px'; orderCard.appendChild(orderList);
    orderCard.appendChild(el('div', 'ah-sub', '添加或调整顺序会启用自定义模式，按当前游戏角色保存。这里只调整站位，招募人选仍由组队策略决定。战斗已经开始时，下场再应用。'));
    function saveCharacterOrder(next) {
        if (runningTask) return;
        setSetting('characterOrder', next); setSetting('front', 'custom'); ui.controls.front.value = 'custom';
        renderCharacterOrder();
    }
    function renderCharacterOrder() {
        const candidates = new Map([['self', '自己（当前角色）']]);
        for (const member of runtime.dungeon?.members || []) {
            if (member.key && member.key !== runtime.status?.username) candidates.set(`key:${member.key}`, `${member.name || member.key} · @${member.key}`);
        }
        for (const friend of orderFriends) if (friend.username && friend.username !== runtime.status?.username) {
            candidates.set(`key:${friend.username}`, `${friend.name || friend.username} · @${friend.username}`);
        }
        const previous = orderSelect.value;
        orderSelect.replaceChildren(new Option('选择角色…', ''));
        for (const [key, name] of candidates) if (!settings.characterOrder.includes(key)) orderSelect.appendChild(new Option(name, key));
        if ([...orderSelect.options].some(o => o.value === previous)) orderSelect.value = previous;
        orderSelect.disabled = !!runningTask;
        orderList.replaceChildren();
        settings.characterOrder.forEach((key, index) => {
            const item = el('div', 'ah-item'); item.dataset.orderKey = key;
            const name = candidates.get(key) || `@${key.slice(4)}（未加载或不在当前队伍）`;
            item.appendChild(el('span', 'ah-item-copy', `${index + 1}. ${name}`));
            for (const [text, delta] of [['↑', -1], ['↓', 1], ['移除', 0]]) {
                const control = button(item, text, null, () => {
                    if (runningTask) return;
                    const next = [...settings.characterOrder], target = index + delta;
                    if (!delta) next.splice(index, 1);
                    else if (target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]];
                    else return;
                    saveCharacterOrder(next);
                    orderList.querySelectorAll('[data-order-action="' + delta + '"]')[Math.min(Math.max(0, target), next.length - 1)]?.focus({ preventScroll: true });
                });
                control.dataset.orderAction = String(delta); control.dataset.lockTask = '1';
                control.setAttribute('aria-label', `${text === '↑' ? '上移' : text === '↓' ? '下移' : '移除'} ${name}`);
                control.dataset.protected = delta && (index + delta < 0 || index + delta >= settings.characterOrder.length) ? '1' : '0';
                control.disabled = !!runningTask || control.dataset.protected === '1';
            }
            orderList.appendChild(item);
        });
        if (!settings.characterOrder.length) orderList.appendChild(el('div', 'ah-empty', '尚未指定顺序；加载队伍与好友后添加角色。'));
    }
    renderCharacterOrder();

    const bagCard = card(ui.pages.bag, '装备清理', 'bag', '五星及以上、不可出售/分解装备始终排除。默认另保护已强化及紫色装备；出售和分解先预览再执行。');
    const bagActions = row(bagCard);
    taskButton(bagActions, '加载背包', 'refresh', '加载背包', async () => { await loadBackpack(); renderBagList(); });
    const selectAll = button(bagActions, '全选可处理项', null, () => {
        const cbs = [...bagListBox.querySelectorAll('input:not(:disabled)')]; const all = cbs.length && cbs.every((c) => c.checked);
        for (const c of cbs) c.checked = !all; bagReview = null; renderBagReview(); renderBagCount();
    }); selectAll.dataset.lockTask = '1';
    const bagSearch = el('input'); bagSearch.type = 'search'; bagSearch.placeholder = '搜索装备名称'; bagSearch.setAttribute('aria-label', '搜索装备'); bagSearch.style.marginTop = '10px'; bagSearch.dataset.lockTask = '1'; bagSearch.oninput = () => { renderBagList(); }; bagCard.appendChild(bagSearch);
    ui.bagCount = el('div', 'ah-sub', '未加载背包'); bagCard.appendChild(ui.bagCount);
    const bagListBox = el('div', 'ah-list'); bagListBox.appendChild(el('div', 'ah-empty', '加载装备后显示品质与强化等级')); bagCard.appendChild(bagListBox);
    const bagProcess = row(bagCard); bagProcess.style.marginTop = '12px';
    taskButton(bagProcess, '出售预览', null, '出售预览', () => previewBagAction('sell', bagListBox));
    taskButton(bagProcess, '分解预览', null, '分解预览', () => previewBagAction('decompose', bagListBox));
    const bagReviewBox = el('div'); bagReviewBox.style.marginTop = '10px'; bagCard.appendChild(bagReviewBox);
    function renderBagCount() { ui.bagCount.textContent = `背包 ${backpackItems.length} 件 · 已选 ${selectedUuids(bagListBox).length} 件`; }
    const RARITY_COLORS = ['#b5c9ef', '#c7d0da', '#7dcba5', '#80bdf5', '#c19af1', '#f1b46e'];
    function renderBagList() {
        bagReview = null; renderBagReview();
        bagListBox.replaceChildren();
        const query = bagSearch.value.trim().toLowerCase();
        const items = backpackItems.filter((i) => String(i.name || '').toLowerCase().includes(query));
        for (const item of items) {
            const reason = protectionReason(item, settings), label = el('label', 'ah-item'), cb = el('input');
            cb.type = 'checkbox'; cb.value = item.uuid; cb.disabled = !!reason || !!runningTask; cb.dataset.protected = reason ? '1' : '0'; cb.dataset.lockTask = '1';
            cb.onchange = () => { bagReview = null; renderBagReview(); renderBagCount(); };
            const copy = el('span', 'ah-item-copy', item.name || item.uuid); copy.style.color = RARITY_COLORS[item.rarity] || '#d8e4ee';
            copy.appendChild(el('small', '', `强化 +${item.reinforce_level || 0} · ${reason || '可处理'}`)); label.append(cb, copy); bagListBox.appendChild(label);
        }
        if (!items.length) bagListBox.appendChild(el('div', 'ah-empty', query ? '没有匹配的装备' : '背包暂无装备'));
        const previous = reinforceSel.value; reinforceSel.replaceChildren(new Option('选择装备…', ''));
        for (const i of backpackItems) reinforceSel.appendChild(new Option(`[背包] ${i.name} +${i.reinforce_level || 0}`, `backpack|${i.uuid}`));
        for (const i of equippedItems) {
            const option = new Option(`[已装备] ${i.item.name} +${i.item.reinforce_level || 0}`, `equipped|${i.slot}`);
            option.dataset.uuid = i.item.uuid || ''; reinforceSel.appendChild(option);
        }
        if ([...reinforceSel.options].some((o) => o.value === previous)) reinforceSel.value = previous;
        renderBagCount();
    }
    function renderBagReview() {
        bagReviewBox.replaceChildren(); if (!bagReview) return;
        const review = bagReview, box = el('div', 'ah-review'); box.append(el('div', 'ah-review-title', `${review.kind === 'sell' ? '出售' : '分解'} ${review.uuids.length} 件装备`), el('div', 'ah-sub', review.names.join('、')));
        if (review.estimate) box.appendChild(el('div', 'ah-sub', `预计产物：${review.estimate}`));
        const actions = row(box);
        const confirm = button(actions, '确认执行', 'check', () => runTask(review.kind === 'sell' ? '出售装备' : '分解装备', () => commitBagAction(review.kind, bagListBox)), 'danger');
        confirm.dataset.lockTask = '1'; confirm.disabled = !!runningTask;
        button(actions, '取消', null, () => { bagReview = null; renderBagReview(); }); bagReviewBox.appendChild(box);
    }
    const reinforceCard = card(ui.pages.bag, '装备强化', 'bolt', '单次只尝试一次；有限连点逐次尝试，成功即停。用券时只尝试一次。');
    const reinforceFields = fields(reinforceCard);
    const reinforceSel = el('select'); reinforceSel.dataset.lockTask = '1'; reinforceSel.appendChild(new Option('加载背包后选择装备…', '')); field(reinforceFields, '强化目标', reinforceSel, true);
    numberSetting(reinforceFields, 'reinforceAttempts', '最多尝试次数');
    const voucherLabel = el('label', 'ah-toggle'), voucherCb = el('input'); voucherCb.type = 'checkbox'; voucherCb.dataset.lockTask = '1'; voucherCb.setAttribute('aria-label', '使用强化券'); voucherLabel.append(el('span', '', '使用强化券'), voucherCb); reinforceCard.appendChild(voucherLabel);
    const reinforceActions = row(reinforceCard);
    taskButton(reinforceActions, '强化一次', 'bolt', '装备强化', () => doReinforce(reinforceSel.value, voucherCb.checked, 1, reinforceSel.selectedOptions[0]?.dataset.uuid || null));
    taskButton(reinforceActions, '有限连点', 'play', '有限强化', () => doReinforce(reinforceSel.value, voucherCb.checked, settings.reinforceAttempts, reinforceSel.selectedOptions[0]?.dataset.uuid || null), 'primary');

    const budgetCard = card(ui.pages.settings, '本批资源与止损', 'shield', '配置按角色保存。任务启动后使用本次配置，停止后可修改。');
    const budgetFields = fields(budgetCard);
    numberSetting(budgetFields, 'accelThreshold', '常规加速阈值 / 秒（0 关闭）');
    numberSetting(budgetFields, 'accelBudget', '常规加速用券上限');
    budgetCard.appendChild(el('div', 'ah-sub', '地下城剩余战斗时间超过 600 秒或实际等待达到 600 秒时，自动尝试一次加速，不受常规阈值和用券上限限制。加速成功后重新等待结算；每场最多尝试一次。'));
    numberSetting(budgetFields, 'lossLimit', '连续未通关上限');
    numberSetting(budgetFields, 'restartLimit', '望雪台重开上限');
    toggleSetting(budgetCard, 'rerollWxt', '望雪台刷目标开局');
    budgetCard.appendChild(el('div', 'ah-sub', '刷开局仍按“冰龙本事件难度”选择难度；仅“开始探索”可自动撤离重开，接管与免费全刷不会自动重开。'));
    const tacticsCard = card(ui.pages.settings, '探索策略', 'compass'); const tacticsFields = fields(tacticsCard);
    selectSetting(tacticsFields, 'eventMode', '未知事件', [['safe', '自动选择（保守优先）'], ['score', '收益关键词优先'], ['pause', '未知事件手动处理']], true);
    selectSetting(tacticsFields, 'eventGoal', '事件目标', [['clear', '保通关 / 理智保护'], ['collect', '材料情报优先']]);
    numberSetting(tacticsFields, 'sanityFloor', '理智保留底线');
    selectSetting(tacticsFields, 'route', '分支偏好', [['first', '默认第一路线'], ['camp', '优先营地'], ['treasure', '优先宝箱材料'], ['boss', '优先首领捷径']]);
    tacticsCard.appendChild(el('div', 'ah-sub', '红叶山谷优先第二条战斗路线；其他副本使用上述分支偏好。'));
    for (const [title, mode, seconds, target, description] of [
        ['普通营地', 'campMode', 'campSeconds', 'campTarget', '用于沿途营地，以及无法确认后续路线的营地。保留原有恢复设置。'],
        ['Boss 前营地', 'bossCampMode', 'bossCampSeconds', 'bossCampTarget', '下一场战斗为 Boss，且中间只有事件、商店或普通宝箱时使用；其他营地、分支或不明节点会中止识别。'],
    ]) {
        const restCard = card(ui.pages.settings, title, 'heart', description), restFields = fields(restCard);
        selectSetting(restFields, mode, '休息方式', [['auto', '按队伍状态'], ['fixed', '固定时长'], ['off', '直接离开']], true);
        numberSetting(restFields, seconds, '固定休息 / 秒'); numberSetting(restFields, target, '恢复目标 / %');
        for (const [key, name] of [[mode, '休息方式'], [seconds, '固定休息秒数'], [target, '恢复目标百分比']]) ui.controls[key].setAttribute('aria-label', `${title} · ${name}`);
        restCard.appendChild(el('div', 'ah-sub', '自动模式按 HP/AP 目标等待并核对实际恢复；固定模式按秒数休息。游戏 AP 上限与低理智限制仍生效。'));
    }
    const shopCard = card(ui.pages.settings, '地下城商店购买', 'bag'); const shopFields = fields(shopCard);
    selectSetting(shopFields, 'shop', '购买范围', [['equip_skill', '副本推荐 / 理智补给 / 装备 / 技能'], ['all', '全部类别（旧副本仍排除符文）'], ['off', '跳过商店']], true);
    numberSetting(shopFields, 'shopMaxEach', '每种商品最多购买');
    shopCard.appendChild(el('div', 'ah-sub', '开启旧日专属配置时，购买全部 Buff/符文及理智补给，按库存与余额购买；关闭后恢复必要理智 → Buff/符文 → 装备 → 技能及单品上限。望雪台沿用原策略。'));
    shopCard.appendChild(el('div', 'ah-sub', '通用策略仅在理智不足时购买补给；每次购买后重新读取余额和库存。'));
    const protectCard = card(ui.pages.settings, '背包保护与同步', 'shield'); const protectFields = fields(protectCard);
    const raritySelect = selectSetting(protectFields, 'protectRarity', '保护品质起点', [['3', '蓝色及以上'], ['4', '紫色及以上'], ['5', '五星及以上（强制保留）']], true);
    const originalRarityChange = raritySelect.onchange; raritySelect.onchange = () => { originalRarityChange(); renderBagList(); };
    toggleSetting(protectCard, 'protectReinforced', '保护已强化装备'); toggleSetting(protectCard, 'sync', '任务后同步角色数据');
    protectCard.appendChild(el('div', 'ah-sub', '锁定、五星/六星、不可出售装备不参与批量清理；幸运花饰与修复过的驱动器始终排除。游戏部分页面需手动刷新。'));

    const exportCard = card(ui.pages.settings, '配置导入 / 导出', 'settings', '用 JSON 文件备份或恢复助手设置，包含助战、站位、每日商店范围及旧日专属配置开关。导入到当前角色，预览后应用；文件未包含的设置保留现值。');
    const configActions = row(exportCard);
    const exportButton = button(configActions, '导出当前角色配置', null, exportSettings);
    exportButton.dataset.lockTask = '1';
    let importTargetCharacter = '';
    const importInput = el('input'); importInput.type = 'file'; importInput.accept = '.json,application/json'; importInput.hidden = true;
    importInput.dataset.lockTask = '1'; importInput.setAttribute('aria-label', '选择配置 JSON 文件'); exportCard.appendChild(importInput);
    const importButton = button(configActions, '导入配置文件', null, () => {
        if (runningTask) return;
        reconcileCharacter();
        if (!settingsCharacter) { log('请先选择游戏角色再导入配置', 'warn'); return; }
        clearSettingsImport(); importTargetCharacter = settingsCharacter;
        importInput.value = ''; importInput.click();
    });
    importButton.dataset.lockTask = '1';
    importInput.onchange = () => {
        const file = importInput.files?.[0];
        if (file) return readSettingsImport(file, importTargetCharacter);
    };
    const importReviewBox = el('div'); importReviewBox.style.marginTop = '10px'; importReviewBox.setAttribute('aria-live', 'polite'); exportCard.appendChild(importReviewBox);
    function renderSettingsImport() {
        importReviewBox.replaceChildren();
        const review = settingsImport;
        if (!review) return;
        const changes = Object.keys(review.values).filter(key => JSON.stringify(settings[key]) !== JSON.stringify(review.next[key]));
        const box = el('div', 'ah-review');
        box.append(el('div', 'ah-review-title', `导入到「${review.target}」`),
            el('div', 'ah-sub', `来源角色：${review.character} · 将修改 ${changes.length} 项设置${review.ignored ? ` · 忽略 ${review.ignored} 个未知字段` : ''}`));
        if (review.character !== review.target) box.appendChild(el('div', 'ah-note', '来源与当前角色不同；应用后会覆盖当前角色的对应设置。'));
        const list = el('div', 'ah-list');
        for (const key of changes) {
            const label = ui.controls[key]?.getAttribute('aria-label') || ({ friends: '优先助战', characterOrder: '角色站位顺序', dailyShopOverrides: '每日商店范围', donationLevel: '捐献目标等级' }[key]) || key;
            list.appendChild(el('div', 'ah-item', `${label}：${JSON.stringify(settings[key])} → ${JSON.stringify(review.next[key])}`));
        }
        box.appendChild(list);
        const actions = row(box); actions.style.marginTop = '10px';
        const apply = button(actions, '应用到当前角色', 'check', commitSettingsImport, 'primary'); apply.dataset.lockTask = '1';
        button(actions, '取消导入', null, clearSettingsImport);
        importReviewBox.appendChild(box);
    }
    function refreshSettingsControls() {
        for (const [key, input] of Object.entries(ui.controls)) {
            if (input.type === 'checkbox') input.checked = !!settings[key];
            else input.value = settings[key];
        }
        for (const [select, key, sweep] of [[sweepPresetSel, 'sweepPreset', true], [dungeonPresetSel, 'dungeonPreset', false]]) {
            select.value = '';
            fillPresetSelect(select, runtime.presets.filter(p => !p.locked), sweep);
            if (settings[key] && ![...select.options].some(option => option.value === settings[key])) {
                select.appendChild(new Option(`已保存 #${settings[key]}（请刷新副本核对）`, settings[key]));
            }
            select.value = settings[key];
        }
        for (const cb of friendListBox.querySelectorAll('input')) cb.checked = preferredFriends.has(cb.value);
        renderCharacterOrder(); renderDailyShopList(); renderDonationSettings(); renderBagList();
        ui.sweepInfo.textContent = '配置已导入，请重新查询扫荡额度。';
        ui.routeKey = ''; renderDashboard();
    }

    // ---------- 更新检查 ----------
    let checkingUpdate = false;
    let pendingUpdate = null;

    function parseUserscriptMetadata(source) {
        const block = String(source || '').match(/^\/\/ ==UserScript==[\s\S]*?^\/\/ ==\/UserScript==/m)?.[0];
        if (!block) return null;
        const read = key => block.match(new RegExp(`^\\/\\/\\s*@${key}\\s+(.+?)\\s*$`, 'm'))?.[1]?.trim() || '';
        return { name: read('name'), namespace: read('namespace'), version: read('version') };
    }

    // 返回正数表示 a 更新，负数表示 b 更新；支持 3.0.2 以及常见预发布后缀。
    function compareVersions(a, b) {
        const parse = value => {
            const [core, prerelease = ''] = String(value || '').trim().replace(/^v/i, '').split('-', 2);
            return { core: core.split('.').map(x => Number(x) || 0), prerelease };
        };
        const av = parse(a), bv = parse(b);
        const length = Math.max(av.core.length, bv.core.length);
        for (let i = 0; i < length; i++) {
            const diff = (av.core[i] || 0) - (bv.core[i] || 0);
            if (diff) return diff;
        }
        if (!av.prerelease && bv.prerelease) return 1;
        if (av.prerelease && !bv.prerelease) return -1;
        return av.prerelease.localeCompare(bv.prerelease, undefined, { numeric: true });
    }

    async function inspectUpdateSource(source) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const separator = source.url.includes('?') ? '&' : '?';
        const requestUrl = `${source.url}${separator}_aether_check=${Date.now()}`;
        try {
            const response = await fetch(requestUrl, {
                cache: 'no-store', credentials: 'omit', redirect: 'follow', signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const metadata = parseUserscriptMetadata(await response.text());
            if (!metadata || metadata.name !== SCRIPT_IDENTITY.name ||
                metadata.namespace !== SCRIPT_IDENTITY.namespace ||
                !/^\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
                throw new Error('脚本身份或版本元数据不匹配');
            }
            return { ...source, version: metadata.version, installUrl: requestUrl };
        } finally {
            clearTimeout(timeout);
        }
    }

    function resetUpdateButton(delay = 4000) {
        setTimeout(() => {
            if (!checkingUpdate && !pendingUpdate) updateBtn.textContent = '检查更新';
        }, delay);
    }

    async function checkForUpdates() {
        // 异步检查后再 window.open 容易被浏览器当成弹窗拦截；首次点击时先预留安装页。
        const installerWindow = window.open('about:blank', 'aether-helper-update');
        if (installerWindow) {
            try {
                installerWindow.document.title = 'Aether 助手 · 正在检查更新';
                installerWindow.document.body.textContent = '正在检查可信更新源，请稍候……';
            } catch (_) { /* 某些浏览器不允许操作预留页，不影响后续跳转 */ }
        }

        if (pendingUpdate) {
            if (installerWindow) {
                installerWindow.location.replace(pendingUpdate.installUrl);
                pendingUpdate = null;
                resetUpdateButton();
            } else {
                log(`浏览器阻止了更新页，请允许本站弹出窗口后再次点击（待更新 v${pendingUpdate.version}）`);
            }
            return;
        }
        if (checkingUpdate) {
            installerWindow?.close();
            return;
        }

        checkingUpdate = true;
        updateBtn.disabled = true;
        updateBtn.textContent = '检查中…';
        log(`正在检查更新（当前 v${VERSION}）…`);
        try {
            const settled = await Promise.allSettled(UPDATE_SOURCES.map(inspectUpdateSource));
            const available = settled.filter(x => x.status === 'fulfilled').map(x => x.value)
                .sort((a, b) => compareVersions(b.version, a.version));
            if (!available.length) throw new Error('所有可信更新源均不可访问');
            const latest = available[0];
            const reachable = available.map(x => `${x.name} v${x.version}`).join('；');
            if (compareVersions(latest.version, VERSION) <= 0) {
                installerWindow?.close();
                updateBtn.textContent = '已是最新';
                log(`当前已是最新版本 v${VERSION}（已验证：${reachable}）`);
                resetUpdateButton();
                return;
            }

            pendingUpdate = latest;
            updateBtn.textContent = `安装 v${latest.version}`;
            log(`发现新版本 v${latest.version}（${latest.name}），正在打开 Tampermonkey 更新确认页`);
            if (installerWindow) {
                installerWindow.location.replace(latest.installUrl);
                pendingUpdate = null;
                resetUpdateButton();
            } else {
                log('浏览器阻止了更新页；请允许本站弹出窗口，然后再次点击“安装”按钮');
            }
        } catch (e) {
            installerWindow?.close();
            updateBtn.textContent = '检查失败';
            log(`检查更新失败：${e.message || e}`);
            resetUpdateButton();
        } finally {
            checkingUpdate = false;
            updateBtn.disabled = false;
        }
    }

    updateBtn.onclick = checkForUpdates;

    const logBar = row(ui.pages.logs), logFilter = el('select'); logFilter.setAttribute('aria-label', '日志筛选'); logFilter.style.flex = '1';
    for (const [v, t] of [['all', '全部记录'], ['warn', '警告与错误'], ['success', '成功记录']]) logFilter.appendChild(new Option(t, v));
    logFilter.onchange = renderLogs; logBar.appendChild(logFilter);
    button(logBar, '导出', null, () => {
        const text = runtime.logs.slice().reverse().map((x) => `${new Date(x.at).toLocaleString()} [${x.type}] ${x.message}`).join('\n');
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), a = el('a');
        a.href = url; a.download = `aether-${new Date().toISOString().slice(0, 10)}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    button(logBar, '清空', null, () => { runtime.logs = []; renderLogs(); });
    const logBox = el('div', 'ah-logs'); ui.pages.logs.appendChild(logBox);
    function renderLogs() {
        logBox.replaceChildren();
        const logs = runtime.logs.filter((x) => logFilter.value === 'all' || (logFilter.value === 'warn' ? ['warn', 'error'].includes(x.type) : x.type === 'success'));
        for (const entry of logs) { const line = el('div', `ah-log-line ${entry.type}`); line.append(el('time', '', new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })), el('span', '', entry.message)); logBox.appendChild(line); }
        if (!logs.length) logBox.appendChild(el('div', 'ah-empty', '暂无符合条件的记录'));
    }
    function renderPolicySummary() {
        if (!ui.ready) return;
        const policy = taskSettings();
        const name = runtime.presets.find((p) => String(p.id) === String(policy.sweepPreset))?.name;
        ui.dailySummary.textContent = policy.dailySweep ? `日常扫荡已开启 · ${name || '尚未选择副本'} · 最多 ${policy.sweepTimes} 次` : '日常扫荡已关闭，不消耗扫荡票券。';
        ui.dailySummary.textContent += policy.dailyShop ? ' 每日商店已开启，按“每日商店”勾选范围购买。' : ' 每日商店已关闭。';
        ui.dailySummary.textContent += policy.dailyDonation ? ' 自动捐献已开启，按已保存配置执行一批；未配置时跳过。' : ' 自动捐献已关闭。';
        ui.dungeonSummary.textContent = `计划 ${policy.runs} 局 · 连续 ${policy.lossLimit} 局未通关后停止 · ${policy.accelThreshold > 0 ? `常规加速阈值 ${policy.accelThreshold}s，用券上限 ${policy.accelBudget} 张` : '常规加速关闭'} · 600s 超时保护自动加速（不受用券上限限制） · 望雪台：${wxtStrategy(policy).name}${policy.rerollWxt ? ` · 刷${wxtStrategy(policy).opening}` : ''}`;
        if (policy.visibility === 'public') ui.dungeonSummary.textContent += ' · 公开组队：等待满 3 人后自动开始';
        const preset = dungeonPreset({ preset_id: policy.dungeonPreset });
        const plannedDungeon = activeTaskContext?.dungeonId ? runtime.dungeon : { preset_id: policy.dungeonPreset };
        if (hermitDefaultsEnabled(plannedDungeon, policy)) ui.dungeonSummary.textContent += ' · 旧日专属：ldya 1 号位 / Guqii0812 2 号位 · 全部 Buff 与理智 · 道中跳营地 / Boss 前 100s';
        const isWxt = WXT_PRESET_RE.test(dungeonName(plannedDungeon));
        ui.dungeonSummary.textContent += preset?.difficulty_by_event || isWxt
            ? ` · 事件难度目标：${isWxt ? policy.wxtDifficulty || policy.difficulty : policy.difficulty}` : ` · 难度：${policy.difficulty}`;
        const allowance = runtime.explorationAllowance;
        const presetId = activeTaskContext?.dungeonId ? runtime.dungeon?.preset_id : policy.dungeonPreset;
        if (allowance?.daily && String(allowance.presetId) === String(presetId)) {
            ui.dungeonSummary.textContent += ` · 最近开局检查：剩余 ${allowance.daily.remaining}/${allowance.daily.quota} 次（${allowance.exempt ? '门票本免次数' : allowance.free ? '首次免次数' : '进入消耗 1 次'}）`;
        } else ui.dungeonSummary.textContent += ' · 开局前核对每日探索次数';
    }
    function applyPresets(list) {
        fillPresetSelect(sweepPresetSel, list, true); fillPresetSelect(dungeonPresetSel, list);
        setSetting('sweepPreset', sweepPresetSel.value); setSetting('dungeonPreset', dungeonPresetSel.value); renderPolicySummary();
    }
    async function refreshPresets() { applyPresets(await loadPresets()); }
    async function refreshAll() {
        const results = await Promise.allSettled([api('/status'), fetchCurrentDungeon(), loadPresets()]);
        for (const result of results) if (result.status === 'rejected') { rethrowIfStopped(result.reason); markIssue(`同步失败：${result.reason.message}`); }
        if (results[2].status === 'fulfilled') applyPresets(results[2].value);
        if (results[0].status === 'fulfilled') { updateInventory(results[0].value.data); renderBagList(); }
        renderCharacterOrder();
        renderDashboard();
    }
    function reconcileCharacter() {
        const character = getCharacter();
        if (character === settingsCharacter) return;
        if (activeTaskContext) { checkStop(activeTaskContext); return; }
        clearSettingsImport();
        loadSettings(character);
        Object.assign(runtime, { status: null, dungeon: null, presets: [], explorationAllowance: null, phase: character ? '角色已切换，请同步状态' : '请先选择游戏角色', task: '', total: 0, progress: 0, outcome: 'idle', startedAt: 0, endedAt: 0, ...newCounters(), logs: [] });
        backpackItems = []; equippedItems = []; bagReview = null; dailyShopCatalog = []; orderFriends = [];
        donationBuildings = []; donationStatus = null;
        for (const [key, input] of Object.entries(ui.controls)) { if (input.type === 'checkbox') input.checked = !!settings[key]; else input.value = settings[key]; }
        if (ui.ready) {
            fillPresetSelect(sweepPresetSel, [], true); fillPresetSelect(dungeonPresetSel, []); renderBagList();
            renderDailyShopList();
            renderDonationSettings();
            renderCharacterOrder();
            friendListBox.replaceChildren(el('div', 'ah-empty', '角色已切换，请重新加载好友')); ui.sweepInfo.textContent = '请先同步副本，再查询扫荡额度。';
            renderLogs(); renderDashboard();
        }
    }
    ui.ready = true;
    openTab(readStorage('aether-helper-v2-tab', 'overview')); applyCollapsed(); renderDashboard();
    log(`助手 ${VERSION} 已就绪，资源配置与助战选择按角色保存。`);
    // 仅更新时钟与检测角色，不在后台周期性请求游戏接口。
    setInterval(() => {
        try { reconcileCharacter(); if (!document.hidden && !collapsed) renderDashboard(); }
        catch (e) { if (!isStopError(e)) console.error('[Aether Helper]', e); }
    }, 1000);
    window.addEventListener('pagehide', () => { if (activeTaskContext) activeTaskContext.controller.abort(activeTaskContext.stopError); });
    window.addEventListener('pageshow', () => { reconcileCharacter(); renderDashboard(); });
    if (getCharacter()) runTask('同步状态', refreshAll);
})();
