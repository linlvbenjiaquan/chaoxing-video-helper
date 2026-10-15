// ==UserScript==
// @name         学习通网页版视频挂机器
// @namespace    local.cx.autoplay
// @version      3.0
// @description  按目录顺序自动播放课时视频，播完立刻进下一节；跳过分组标题，只处理视频（不做测验）；含卡住保护、多标签互斥、通知提醒、倍速、结束汇总
// @match        *://*.chaoxing.com/*
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    try { console.log('[挂机器] 脚本已载入：' + location.href); } catch (e) { }

    // 只在最外层窗口里跑：学习通页面里嵌了好几个 iframe，
    // 不挡住的话面板和提示条会一份一份地叠出来。
    try {
        if (window.top !== window.self) { return; }
    } catch (e) {
        return;   // 跨域访问 window.top 会抛错，说明这里是子框架，直接退出
    }

    var STORE = 'cxAutoplayState_v1';
    var TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var ON_STUDY_PAGE = location.href.indexOf('studentstudy') > -1;

    // ---------------- 页面结构相关 ----------------
    function tree() { return document.querySelector('#coursetree'); }

    function allRows() {
        var t = tree();
        return t ? Array.prototype.slice.call(t.querySelectorAll('div.posCatalog_select')) : [];
    }

    // 课时 = 不带 firstLayer、且 id 以 cur 开头的行
    function lessons() {
        return allRows().filter(function (el) {
            return !el.classList.contains('firstLayer') && /^cur\d/.test(el.id);
        });
    }

    function isDone(el) { return !!el.querySelector('.icon_Completed'); }

    // 这一节要不要跳过：目录里有绿勾（以前刷完的）或本轮已经播完过
    function skippable(el) {
        if (isDone(el)) { return true; }
        return !!state.doneIds[idOf(el)];
    }

    function nameEl(el) {
        return el.querySelector('.posCatalog_name') || el.querySelector('.posCatalog_title') || el;
    }

    function titleOf(el) {
        var n = nameEl(el);
        var t = n.getAttribute('title') || n.textContent || '';
        return t.replace(/\s+/g, ' ').trim().slice(0, 30);
    }

    function idOf(el) { return String(el.id || '').replace(/^cur/, ''); }

    function currentLesson() {
        var t = tree();
        var act = t ? t.querySelector('div.posCatalog_active') : null;
        if (act && !act.classList.contains('firstLayer')) { return act; }
        var v = document.querySelector('#curChapterId');
        v = v ? v.value : '';
        if (v) {
            var hit = lessons().filter(function (el) { return idOf(el) === v; });
            if (hit.length) { return hit[0]; }
        }
        return null;
    }

    // ---------------- 视频控制 ----------------
    var videoNote = '';
    var wdLastCur = -1;      // 卡住保护：上次看到的播放位置
    var wdLastAt = 0;        // 卡住保护：上次进度有变化的时间
    var wdRescues = 0;       // 卡住保护：本节点已抢救几次

    function eachDoc(fn) {
        fn(document);
        Array.prototype.slice.call(document.querySelectorAll('iframe')).forEach(function (f) {
            var d = null;
            try { d = f.contentDocument; } catch (e) { d = null; }
            if (!d) { return; }
            fn(d);
            Array.prototype.slice.call(d.querySelectorAll('iframe')).forEach(function (g) {
                try { if (g.contentDocument) { fn(g.contentDocument); } } catch (e) { }
            });
        });
    }

    function findVideo() {
        var v = null;
        eachDoc(function (d) { if (!v) { v = d.querySelector('video') || null; } });
        return v;
    }

    var boundVideo = null;    // 已经挂上监听的 video 元素（换节后页面会换新元素，要重新挂）
    var rateTries = 0;        // 本节点里试过几次设倍速（有些课程不允许倍速，别死磕）
    var endedHookAt = 0;      // 防止 ended 事件和轮询重复处理同一节
    var weMuted = false;      // 是不是我们自己为了绕过自动播放限制按的静音

    // 倍速：设一次，被播放器改回去就再设；连试 3 次不行就放弃，并提示课程不支持
    function applyRate(v) {
        if (!v || !state.rate || state.rate === 1) { return; }
        try {
            if (v.playbackRate === state.rate) { return; }
            if (rateTries >= 3) { return; }
            rateTries++;
            v.playbackRate = state.rate;
            if (rateTries === 1) { log('已把播放倍速设为 ' + state.rate + 'x'); }
            if (rateTries === 3 && v.playbackRate !== state.rate) { log('这门课似乎不允许倍速，就不再改它了'); }
        } catch (e) { }
    }

    // 给当前 video 挂事件：播完立刻处理（不用等轮询），倍速被改回去就纠正
    function bindVideo(v) {
        if (!v || v === boundVideo) { return; }
        boundVideo = v;
        rateTries = 0;
        try {
            v.addEventListener('ended', function () {
                if (Date.now() - endedHookAt < 5000) { return; }
                endedHookAt = Date.now();
                tick();
            });
            v.addEventListener('ratechange', function () { applyRate(v); });
        } catch (e) { }
    }

    function fmtTime(s) {
        s = Math.max(0, Math.floor(s || 0));
        var m = Math.floor(s / 60);
        var ss = s % 60;
        return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
    }

    // 读一次视频状态：找到没有、在不在播、播到哪、播完没有
    function probeVideo() {
        var v = findVideo();
        if (!v) { videoNote = '没找到 video 元素'; return { found: false }; }
        bindVideo(v);
        applyRate(v);
        var dur = 0, cur = 0, ended = false, playing = false;
        try {
            dur = (isFinite(v.duration) && v.duration > 0) ? v.duration : 0;
            cur = v.currentTime || 0;
            ended = !!v.ended || (dur > 2 && cur >= dur - 1);
            playing = !v.paused && !v.ended;
        } catch (e) { }
        if (ended) { videoNote = '视频已播完 ' + fmtTime(cur); }
        else if (dur) { videoNote = fmtTime(cur) + ' / ' + fmtTime(dur) + '（剩 ' + fmtTime(dur - cur) + '）'; }
        else { videoNote = '播放中 ' + fmtTime(cur); }
        return { found: true, el: v, dur: dur, cur: cur, ended: ended, playing: playing };
    }

    // 没在播就催一下：先 play()，没权限就静音重试，再不行点画面上的播放键
    function ensurePlaying(p) {
        if (!p || !p.found) { clickBigPlay(); return; }
        if (p.playing || p.ended) { return; }
        try {
            var v = p.el;
            var pr = v.play();
            if (pr && pr.catch) {
                pr.catch(function () {
                    try { v.muted = true; weMuted = true; v.play(); videoNote = '自动播放被拦，已静音重试'; } catch (e) { }
                });
            }
        } catch (e) { }
    }

    function clickBigPlay() {
        var hit = null;
        eachDoc(function (d) {
            if (hit) { return; }
            Array.prototype.slice.call(d.querySelectorAll('[class*="play"],[class*="Play"],[id*="play"]')).forEach(function (el) {
                if (hit) { return; }
                var c = String(el.className || '') + ' ' + String(el.id || '');
                if (!/bigplay|big-play|playbutton|playbtn|play-btn|videoplay|prism-play|vjs-big-play/i.test(c)) { return; }
                var r = el.getBoundingClientRect();
                if (r.width < 30 || r.height < 30) { return; }
                hit = el;
            });
        });
        if (hit) { try { hit.click(); videoNote = '已点击画面上的播放键'; return true; } catch (e) { } }
        return false;
    }

    // ---------------- 状态 ----------------
    var state = load();
    var tickTimer = null;

    function defaults() {
        return {
            running: false,
            skipDone: true,
            timeoutMin: 45,
            heartbeat: 0,
            currentId: '',
            currentSince: 0,
            justClicked: 0,
            stuck: {},
            doneIds: {},
            refreshMode: 'balanced',   // full=每节都整页刷新 / balanced=跑完刷新一次 / local=从不刷新
            watchdog: true,            // 卡住保护：视频不动了自动重试，救不回来就提醒
            rate: 1,                   // 倍速：1 / 1.25 / 1.5 / 2
            panelPos: null,
            reloading: false,
            owner: '',                 // 哪个标签页在开车（多标签互斥用）
            ownerAt: 0,
            skips: {},                 // 本轮跳过统计：manual / timeout / stuck
        };
    }

    function load() {
        var d = defaults();
        try {
            var raw = JSON.parse(localStorage.getItem(STORE) || '{}') || {};
            for (var k in d) { if (raw[k] !== undefined) { d[k] = raw[k]; } }
        } catch (e) { }
        return d;
    }

    function save() {
        try {
            state.heartbeat = Date.now();
            localStorage.setItem(STORE, JSON.stringify(state));
        } catch (e) { }
    }

    // 声明"我在开车"，并刷新心跳（只有真正在跑的那个标签页才调它）
    function beat() {
        state.owner = TAB_ID;
        state.ownerAt = Date.now();
        save();
    }

    // 有没有别的标签页正在跑（心跳 10 秒内算活着）
    function otherTabAlive() {
        try {
            var raw = JSON.parse(localStorage.getItem(STORE) || '{}') || {};
            return !!raw.owner && raw.owner !== TAB_ID && (Date.now() - (raw.ownerAt || 0) < 10000);
        } catch (e) {
            return false;
        }
    }

    // ---------------- 面板 ----------------
    var elStatus, elLog, elStart, elPause;
    var logLines = [];

    function log(s) {
        logLines.push(new Date().toTimeString().slice(0, 8) + '  ' + s);
        if (logLines.length > 300) { logLines.shift(); }
        if (elLog) { elLog.textContent = logLines.slice(-12).join('\n'); elLog.scrollTop = elLog.scrollHeight; }
        try { console.log('[挂机器] ' + s); } catch (e) { }
    }

    // ---------------- 提醒：系统通知 + 标题闪烁 ----------------
    var titleOrig = document.title;
    var flashTimer = null;
    var flashState = false;

    function flashTitle(on) {
        if (on) {
            if (flashTimer) { return; }
            titleOrig = document.title;
            flashTimer = window.setInterval(function () {
                flashState = !flashState;
                document.title = flashState ? '⚠ 需要处理 —— 学习通挂机器' : titleOrig;
            }, 900);
        } else if (flashTimer) {
            window.clearInterval(flashTimer);
            flashTimer = null;
            document.title = titleOrig;
        }
    }

    function notify(title, body) {
        try {
            if (window.Notification && Notification.permission === 'granted') {
                new Notification(title, { body: body, tag: 'cxap' });
            }
        } catch (e) { }
    }

    // 需要你处理的时候统一走这里：状态行 + 日志 + 系统通知 + 标题闪烁
    function alarm(title, body) {
        status('⚠ ' + body);
        log('⚠ ' + title + '：' + body);
        notify(title, body);
        if (document.hidden) { flashTitle(true); }   // 你正在看这个页面就不闪，免得烦
    }

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { flashTitle(false); }   // 你切回来就停止闪烁
    });

    function status(s) {
        if (elStatus) { elStatus.textContent = s; }
    }

    // 顶部一闪而过的提示条：用来一眼确认"脚本到底跑了没有"
    function toast(text, ms) {
        try {
            var d = document.createElement('div');
            d.textContent = text;
            d.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;' +
                'background:#17457a;color:#fff;padding:8px 16px;border-radius:8px;max-width:80vw;' +
                'font:13px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.35)';
            (document.body || document.documentElement).appendChild(d);
            window.setTimeout(function () {
                if (d.parentNode) { d.parentNode.removeChild(d); }
            }, ms || 5000);
        } catch (e) { }
    }

    function buildPanel() {
        if (document.getElementById('cxap-panel')) { return; }

        var css = document.createElement('style');
        css.textContent =
            '#cxap-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:330px;' +
            'background:#1e2430;color:#e8edf5;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45);' +
            'font:12px/1.6 "Microsoft YaHei",sans-serif;overflow:hidden}\n' +
            '#cxap-panel .h{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#17457a}\n' +
            '#cxap-panel .h b{font-weight:600}\n' +
            '#cxap-panel .b{padding:8px 10px}\n' +
            '#cxap-panel button{margin-right:6px;padding:4px 10px;border:0;border-radius:5px;cursor:pointer;' +
            'background:#2f6fb3;color:#fff;font:12px/1.6 "Microsoft YaHei",sans-serif}\n' +
            '#cxap-panel button:disabled{opacity:.45;cursor:default}\n' +
            '#cxap-panel .r{margin:6px 0}\n' +
            '#cxap-panel label{cursor:pointer}\n' +
            '#cxap-panel input[type=number]{width:52px;background:#121722;color:#e8edf5;border:1px solid #3a4457;border-radius:4px}\n' +
            '#cxap-status{padding:6px 8px;background:#121722;border-radius:6px;min-height:32px;color:#cfe3ff}\n' +
            '#cxap-log{margin:6px 0 0;max-height:120px;overflow:auto;white-space:pre-wrap;color:#9fb3cc;font-size:11px}\n';
        document.head.appendChild(css);

        var p = document.createElement('div');
        p.id = 'cxap-panel';
        p.innerHTML =
            '<div class="h" id="cxap-head"><b>学习通网页版视频挂机器 v3.0</b>' +
            '<span title="按住这条标题栏可以拖动面板"><button id="cxap-min">收起</button></span></div>' +
            '<div class="b" id="cxap-body">' +
            '  <div class="r">' +
            '    <button id="cxap-start">开始</button>' +
            '    <button id="cxap-pause">暂停</button>' +
            '    <button id="cxap-next">跳过这一节</button>' +
            '    <button id="cxap-clear">清空本轮记录</button>' +
            '  </div>' +
            '  <div class="r"><label><input type="checkbox" id="cxap-skip"> 跳过已刷完的课时（目录有绿勾的）</label></div>' +
            '  <div class="r"><label title="打开后：脚本每 30 秒看一眼视频进度；连续 2 分钟没往前走，' +
            '就先自己重试播放（最多 2 次），还不行就暂停并通知你。防的是“挂了一晚上其实一直卡在原地等”。">' +
            '<input type="checkbox" id="cxap-wd"> 卡住保护（看门狗）：视频停在原地时自动重试，救不回来就提醒我</label></div>' +
            '  <div class="r">刷新方式：<select id="cxap-mode">' +
            '    <option value="full">整体模式（每节切完都整页刷新）</option>' +
            '    <option value="balanced">均衡模式（切节不刷新，跑完刷一次）</option>' +
            '    <option value="local">局部模式（从不刷新）</option>' +
            '  </select></div>' +
            '  <div class="r">播放倍速：<select id="cxap-rate">' +
            '    <option value="1">1.0x（正常）</option>' +
            '    <option value="1.25">1.25x</option>' +
            '    <option value="1.5">1.5x</option>' +
            '    <option value="2">2.0x</option>' +
            '  </select> <span style="color:#8fa6c0">（有些课程不允许倍速，不允许时脚本会自己放弃）</span></div>' +
            '  <div class="r">单节最多等 <input type="number" id="cxap-to" min="1" max="300"> 分钟（视频还不播完就跳过）</div>' +
            '  <div id="cxap-status">就绪</div>' +
            '  <pre id="cxap-log"></pre>' +
            '</div>';
        (document.body || document.documentElement).appendChild(p);

        elStatus = document.getElementById('cxap-status');
        elLog = document.getElementById('cxap-log');
        elStart = document.getElementById('cxap-start');
        elPause = document.getElementById('cxap-pause');

        elStatus.textContent = '脚本已启动 ✓（如果看到这行，说明脚本装好并在运行）';
        elLog.textContent = '（日志会显示在这里）';

        document.getElementById('cxap-skip').checked = !!state.skipDone;
        document.getElementById('cxap-wd').checked = !!state.watchdog;
        document.getElementById('cxap-mode').value = state.refreshMode || 'balanced';
        document.getElementById('cxap-rate').value = String(state.rate || 1);
        document.getElementById('cxap-to').value = state.timeoutMin;

        document.getElementById('cxap-min').onclick = function () {
            var b = document.getElementById('cxap-body');
            var hidden = b.style.display === 'none';
            b.style.display = hidden ? 'block' : 'none';
            this.textContent = hidden ? '收起' : '展开';
        };
        document.getElementById('cxap-start').onclick = function () { start(); };
        document.getElementById('cxap-pause').onclick = function () { pause(); };
        document.getElementById('cxap-next').onclick = function () {
            var c = currentLesson();
            if (c) {
                state.skips.manual = (state.skips.manual || 0) + 1;
                save();
                log('手动跳过《' + titleOf(c) + '》');
                advance(c);
            }
        };
        document.getElementById('cxap-skip').onchange = function () { state.skipDone = this.checked; save(); refreshButtons(); };
        document.getElementById('cxap-wd').onchange = function () {
            state.watchdog = this.checked;
            save();
            log(this.checked ? '卡住保护已打开（视频卡住会自动重试，救不回来提醒你）' : '卡住保护已关闭');
        };
        document.getElementById('cxap-rate').onchange = function () {
            state.rate = parseFloat(this.value) || 1;
            rateTries = 0;
            save();
            log(state.rate === 1 ? '播放倍速已改回 1.0x' : ('播放倍速已设为 ' + state.rate + 'x'));
            ensurePlaying(probeVideo());
        };
        document.getElementById('cxap-clear').onclick = function () {
            var n = Object.keys(state.doneIds || {}).length;
            var ok = window.confirm('确定要清空本轮记录吗？\n\n' +
                '会清掉：本轮"已播完"的记录（' + n + ' 节）、卡住次数、当前节状态。\n' +
                '不会动你的设置（刷新方式、倍速、超时、跳过已完成、面板位置）。\n\n' +
                '清空后：所有课时都会重新处理；目录里已经有绿勾的，仍按"跳过已刷完的课时"这个勾决定要不要跳过。');
            if (!ok) { log('已取消清空。'); return; }
            state.doneIds = {};
            state.stuck = {};
            state.skips = {};
            state.currentId = '';
            state.currentSince = 0;
            beat();
            log('本轮记录已清空（现在所有课时都会重新处理）');
        };
        document.getElementById('cxap-mode').onchange = function () {
            state.refreshMode = this.value;
            save();
            log('刷新方式已改为：' + (this.value === 'full' ? '整体模式' : (this.value === 'local' ? '局部模式' : '均衡模式')));
        };
        document.getElementById('cxap-to').onchange = function () { state.timeoutMin = Math.max(1, Math.min(300, parseInt(this.value, 10) || 45)); save(); };

        // 面板位置：上次拖到哪就放哪，并且可以按住标题栏拖动
        if (state.panelPos && typeof state.panelPos.x === 'number') {
            var x = Math.max(0, Math.min(window.innerWidth - 120, state.panelPos.x));
            var y = Math.max(0, Math.min(window.innerHeight - 40, state.panelPos.y));
            p.style.left = x + 'px';
            p.style.top = y + 'px';
            p.style.right = 'auto';
            p.style.bottom = 'auto';
        }
        makeDraggable(p, document.getElementById('cxap-head'));

        refreshButtons();
    }

    // 按住标题栏拖动面板，松手后记住位置
    function makeDraggable(panel, handle) {
        var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        handle.style.cursor = 'move';
        handle.addEventListener('mousedown', function (e) {
            if (e.target && e.target.tagName === 'BUTTON') { return; }
            var r = panel.getBoundingClientRect();
            dragging = true;
            sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
            panel.style.left = r.left + 'px';
            panel.style.top = r.top + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) { return; }
            var x = ox + (e.clientX - sx);
            var y = oy + (e.clientY - sy);
            x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, x));
            y = Math.max(0, Math.min(window.innerHeight - 40, y));
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
        });
        document.addEventListener('mouseup', function () {
            if (!dragging) { return; }
            dragging = false;
            var r = panel.getBoundingClientRect();
            state.panelPos = { x: Math.round(r.left), y: Math.round(r.top) };
            save();
        });
    }

    function refreshButtons() {
        if (!elStart) { return; }
        elStart.disabled = !!state.running;
        elPause.disabled = !state.running;
        if (elLog && logLines.length === 0) { elLog.textContent = '（日志会显示在这里）'; }
    }

    // ---------------- 主流程 ----------------
    function start() {
        if (!tree()) {
            log('当前页面没有目录（#coursetree），请到上课的章节页面再按开始');
            status('当前页面没有目录，请到带「目录/讨论/笔记/标注」的上课页面');
            return;
        }
        if (otherTabAlive()) {
            log('另一个标签页正在运行，这个标签页不动手');
            status('⚠ 另一个标签页正在运行本脚本，这里保持待命');
            return;
        }
        try {
            if (window.Notification && Notification.permission === 'default') { Notification.requestPermission(); }
        } catch (e) { }
        beat();
        state.running = true;
        state.currentSince = state.currentSince || Date.now();
        wdLastCur = -1; wdLastAt = 0; wdRescues = 0;   // 重新开始时卡住保护也重新计数
        save();
        refreshButtons();
        log('开始运行');
        var c = currentLesson();
        if (c && !skippable(c)) {
            status('继续《' + titleOf(c) + '》');
            ensurePlaying(probeVideo());
        } else {
            advance(c);
        }
    }

    function pause() {
        state.running = false;
        save();
        refreshButtons();
        status('已暂停');
        log('已暂停');
    }

    // 找 curEl 之后第一个要做的课时；必要时从头再扫一遍
    function nextTarget(curEl) {
        var all = lessons();
        if (!all.length) { return null; }
        var startAt = curEl ? all.indexOf(curEl) + 1 : 0;
        var i;
        for (i = startAt; i < all.length; i++) {
            if (!state.skipDone || !skippable(all[i])) { return all[i]; }
        }
        if (curEl) {
            for (i = 0; i < startAt - 1; i++) {
                if (!state.skipDone || !skippable(all[i])) { return all[i]; }
            }
        }
        return null;
    }

    function advance(curEl) {
        var all = lessons();
        var done = all.filter(skippable).length;
        var t = nextTarget(curEl);
        if (!t) {
            state.running = false;
            save();
            refreshButtons();
            var willReload = (state.refreshMode === 'balanced');

            // ---- 结束汇总 ----
            var green = all.filter(isDone).length;
            var mine = Object.keys(state.doneIds || {}).length;
            var sk = state.skips || {};
            var skipTotal = (sk.manual || 0) + (sk.timeout || 0) + (sk.stuck || 0);
            log('—— 本轮汇总 ——');
            log('总课时 ' + all.length + ' · 目录已有绿勾 ' + green + ' · 本轮播完 ' + mine +
                ' · 跳过 ' + skipTotal + (skipTotal ? '（手动 ' + (sk.manual || 0) + '／超时 ' + (sk.timeout || 0) +
                '／卡住 ' + (sk.stuck || 0) + '）' : ''));
            if (skipTotal) { log('被跳过的节请往上翻日志看《…》那几行，里面写了原因'); }
            status('全部跑完：共 ' + all.length + ' 节，本轮播完 ' + mine + ' 节' +
                (skipTotal ? ('，跳过 ' + skipTotal + ' 节') : '') +
                (willReload ? '（3 秒后刷新页面给你看最新绿勾）' : ''));
            log('没有待做的课时了，已停止' + (willReload ? '；3 秒后刷新页面让你看最新绿勾' : ''));
            notify('挂机器跑完了', '共 ' + all.length + ' 节，本轮播完 ' + mine + ' 节' +
                (skipTotal ? ('，跳过 ' + skipTotal + ' 节') : ''));
            if (document.hidden) { flashTitle(true); }
            if (willReload) {
                state.reloading = true;
                save();
                window.setTimeout(function () { location.reload(); }, 3000);
            }
            return;
        }
        clickLesson(t);
    }

    function clickLesson(el) {
        var n = nameEl(el);
        var id = idOf(el);
        state.currentId = id;
        state.currentSince = Date.now();
        state.justClicked = Date.now();
        wdLastCur = -1; wdLastAt = 0; wdRescues = 0;   // 换节了，卡住保护重新计数
        save();
        log('→ 进入《' + titleOf(el) + '》');
        try {
            n.click();
        } catch (e) {
            log('点击出错：' + e.message);
        }
        // 兜底：如果页面自己的跳转函数在，直接调一次
        window.setTimeout(function () {
            var c = currentLesson();
            if (c && idOf(c) === id) {
                ensurePlaying(probeVideo());
                window.setTimeout(function () { ensurePlaying(probeVideo()); }, 3000);
                return;
            }
            var oc = n.getAttribute('onclick') || '';
            var m = oc.match(/getTeacherAjax\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/);
            if (m && typeof window.getTeacherAjax === 'function') {
                log('页面没反应，直接调用跳转函数');
                try { window.getTeacherAjax(m[1], m[2], m[3]); } catch (e) { log('跳转失败：' + e.message); }
            }
        }, 6000);
        window.setTimeout(function () { ensurePlaying(probeVideo()); }, 2000);
        window.setTimeout(function () { ensurePlaying(probeVideo()); }, 5000);
    }

    function tick() {
        if (state.reloading) { return; }   // 整体模式下正在等刷新，别再动
        if (otherTabAlive()) {
            status('⚠ 另一个标签页正在运行本脚本，这里待命（它关掉后我会自动接管）');
            return;
        }
        if (!state.running) { return; }
        if (Date.now() - (state.ownerAt || 0) > 3000) { beat(); }   // 刷新"我在开车"的心跳
        if (!tree()) { status('还没找到目录（#coursetree），请把右边「目录」标签打开'); return; }

        var all = lessons();
        if (!all.length) { status('目录里没读到课时行'); return; }
        var done = all.filter(skippable).length;
        var cur = currentLesson();

        if (!cur) {
            // 刚点完一节、页面正在切换时，当前节可能短暂消失，这时先等，不要乱跳
            if (state.justClicked && (Date.now() - state.justClicked) < 20000) {
                var pw = probeVideo();
                ensurePlaying(pw);
                status('正在切换到下一节… ' + videoNote);
                return;
            }
            advance(null);
            return;
        }

        var cid = idOf(cur);

        // 目录里有绿勾（以前刷完的）或本轮已播完 → 下一节
        if (skippable(cur)) {
            state.justClicked = 0;
            state.currentId = '';
            state.currentSince = 0;
            save();
            advance(cur);
            return;
        }

        // ---- 核心：以"视频播完"作为进入下一节的触发，不再等目录里的绿勾 ----
        var p = probeVideo();
        if (p.found && p.ended) {
            state.doneIds[cid] = 1;
            state.justClicked = 0;
            state.currentSince = 0;
            save();
            if (state.refreshMode === 'full') {
                // 整体模式：留几秒让平台把最后的进度上报完，再整页刷新
                state.reloading = true;
                save();
                log('《' + titleOf(cur) + '》视频已播完（' + fmtTime(p.cur) + '）→ 5 秒后整页刷新（整体模式）');
                status('视频已播完，5 秒后刷新页面…（整体模式）');
                window.setTimeout(function () { location.reload(); }, 5000);
                return;
            }
            // 均衡/局部模式：不刷新，改成过一会儿在后台悄悄核对一次平台进度
            log('《' + titleOf(cur) + '》视频已播完（' + fmtTime(p.cur) + '），进入下一节');
            advance(cur);
            return;
        }
        ensurePlaying(p);

        // ---- 卡住保护（看门狗）：进度连续 2 分钟没往前走，就先自动抢救，救不回来才提醒你 ----
        if (state.watchdog && p.found) {
            if (Math.abs(p.cur - wdLastCur) >= 0.5) {
                wdLastCur = p.cur;
                wdLastAt = Date.now();
                wdRescues = 0;
            } else if (!wdLastAt) {
                wdLastAt = Date.now();
            } else if (Date.now() - wdLastAt > 120000) {
                if (wdRescues < 2) {
                    wdRescues++;
                    wdLastAt = Date.now();
                    log('卡住保护：视频停在 ' + fmtTime(p.cur) + ' 两分钟没动，正在重试播放（第 ' + wdRescues + ' 次）');
                    status('视频卡住了，正在自动重试…（第 ' + wdRescues + ' 次）');
                    try {
                        var pv = p.el;
                        if (pv) {
                            if (weMuted) { pv.muted = false; weMuted = false; log('（顺带取消了静音——静音的后台视频有可能被浏览器挂起）'); }
                            var pr2 = pv.play();
                            if (pr2 && pr2.catch) { pr2.catch(function () { }); }
                        }
                    } catch (e) { }
                    clickBigPlay();
                } else {
                    state.skips.stuck = (state.skips.stuck || 0) + 1;
                    pause();
                    alarm('视频卡住了（已暂停）',
                        '《' + titleOf(cur) + '》在 ' + fmtTime(p.cur) + ' 处停了 2 分钟，自动重试 2 次仍没恢复。' +
                        '已暂停。你可以手动点一下播放键后按「开始」继续，或按「跳过这一节」。');
                    return;
                }
            }
        }

        var mins = state.currentSince ? (Date.now() - state.currentSince) / 60000 : 0;
        if (mins > state.timeoutMin) {
            state.stuck[cid] = (state.stuck[cid] || 0) + 1;
            var n = state.stuck[cid];
            state.skips.timeout = (state.skips.timeout || 0) + 1;
            log('《' + titleOf(cur) + '》等了 ' + Math.round(mins) + ' 分钟视频还没播完，先跳过（第 ' + n + ' 次）');
            state.currentSince = Date.now();
            save();
            if (n >= 3) { pause(); status('这一节反复卡住，已暂停，请你手动看看'); return; }
            advance(cur);
            return;
        }

        status('正在《' + titleOf(cur) + '》 · 已处理 ' + done + '/' + all.length + ' 节 · ' +
            (p.found ? videoNote : '没找到视频（可能还在加载）'));
    }

    function boot() {
        buildPanel();
        if (state.reloading) { state.reloading = false; save(); }
        if (!state.running) { toast('学习通网页版视频挂机器 v3.0 已就绪：面板可拖动'); }

        log('脚本已载入 ✓ 当前页面：' + location.host + location.pathname +
            (ON_STUDY_PAGE ? '' : '（这不是上课页面，面板不会干活）'));
        if (otherTabAlive()) {
            log('检测到另一个标签页正在运行本脚本：这边只待命，不动手（它关掉后我会自动接管）');
        }

        var fresh = state.running && (Date.now() - (state.heartbeat || 0) < 3 * 60 * 1000);
        if (fresh) {
            log('检测到上次还在运行（页面刚刷新/跳转），自动继续');
        } else if (state.running) {
            state.running = false;
            save();
        }
        refreshButtons();
        if (!tree()) {
            status('这个页面没有目录（#coursetree）——请到上课的章节页面');
        } else if (state.running) {
            status('运行中…');
        } else {
            status('就绪（按「开始」）· 目录里有 ' + lessons().length + ' 个课时 · ' +
                (state.refreshMode === 'full' ? '整体模式' : (state.refreshMode === 'local' ? '局部模式' : '均衡模式')));
        }
        log('面板已就绪，目录里有 ' + lessons().length + ' 个课时');

        tickTimer = window.setInterval(tick, 2000);
        tick();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        window.setTimeout(boot, 1500);
    } else {
        window.addEventListener('DOMContentLoaded', function () { window.setTimeout(boot, 1500); });
    }
})();
