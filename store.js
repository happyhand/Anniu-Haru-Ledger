/*
 * store.js —— 記帳資料的讀寫，**全部集中在這裡**（畫面只透過 LedgerStore 拿資料、改資料）。
 *
 * 帳目先存這台手機的瀏覽器（localStorage），再同步到使用者自己的 Google 試算表（段 E）：
 *   pending＝本機改過、還沒送到試算表的編號（每次改動都會記進去）；settingsPending＝預算還沒送。
 *   同步＝①pending 的帳 POST {op:'sync'} ②預算 POST {op:'settings'} ③GET 讀全部、合併（同編號以更新時間新的為準）。
 *   判斷（拿掉哪些待送、怎麼合併）全在 lib/core.js 的 ldg* 純函式；本檔只管網路、存檔、通知畫面。
 *
 * 🔴 手機裡的資料看不懂（壞掉或比較新的版本）⇒ 唯讀、⛔ 不覆蓋，原字串另存一份備份；唯讀時也 ⛔ 不同步。
 * 🔴 試算表網址與密碼只存在這台手機（另一個 localStorage 鍵）；⛔ 不印進 console、⛔ 不放進錯誤訊息。
 * ⚠️ POST ⛔ 不設 Content-Type（瀏覽器送 text/plain，不會觸發跨來源預檢；設成 application/json 會被擋，段 B 實測）。
 * ⚠️ 瀏覽器約兩成請求會卡超過 20 秒（段 B 實測，原因未查明）⇒ 逾時就放棄、留在待送下次再送；重送是安全的（same／stale 不會多一列）。
 *    逾時分兩種：讀 20 秒、寫 45 秒。寫入試算表本來就慢（段 B 用 Node 量到 7.6～12.6 秒，一次改好幾筆更久）；
 *    原本一律 15 秒，使用者 2026-11-20 手機試用回報「刪除同步不上去」——其實試算表收到了、是網頁先放棄 ⇒ 寫入放寬。
 */
var LedgerStore = (function () {
  'use strict';
  var KEY = 'anniu-haru-ledger-v1';
  var SYNC_KEY = 'anniu-haru-ledger-sync';
  var READ_TIMEOUT_MS = 20000, WRITE_TIMEOUT_MS = 45000;
  var MAX_ROUNDS = 5;              // 一次同步最多送幾批（每批 200 筆）
  var records = [], pending = [], settings = { budget: null, budgetUpdatedAt: '' }, settingsPending = false, problems = [], readOnly = false, listeners = [];
  var link = { url: '', token: '', lastOkAt: '' };
  var run = { running: false, again: false, lastAttemptMs: 0, lastFailed: false, error: '', invalid: [], warnings: [], promise: null };
  var syncListeners = [], debounce = null;

  function ctx() {
    var now = Date.now();
    return { nowMs: now, offsetMin: -new Date(now).getTimezoneOffset(), rand: Math.random };
  }
  function today() { return ldgToday(ctx()); }
  function nowText() { var c = ctx(); return lgrFormatTime(c.nowMs, c.offsetMin); }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); }
    catch (e) { problems = ['這個瀏覽器不讓網頁存資料（可能是無痕模式），記的帳關掉就會不見。']; return; }
    var got = ldgParseStored(raw);
    records = got.records; pending = got.pending; settings = got.settings; settingsPending = got.settingsPending; problems = got.problems;
    if (got.broken) {
      readOnly = true;
      try { localStorage.setItem(KEY + '-backup-' + Date.now(), raw); } catch (e) { /* 存不了備份也不覆蓋原資料 */ }
    }
    try {
      var l = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
      if (l && typeof l.url === 'string' && typeof l.token === 'string') link = { url: l.url, token: l.token, lastOkAt: typeof l.lastOkAt === 'string' ? l.lastOkAt : '' };
    } catch (e) { /* 看不懂就當沒設定（不影響帳目） */ }
  }

  function save() {
    if (readOnly) return false;
    try { localStorage.setItem(KEY, ldgSerialize(records, pending, settings, settingsPending)); return true; }
    catch (e) { problems = ['存不進這台手機（空間滿了或瀏覽器不讓存）。']; return false; }
  }
  function saveLink() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(link)); return true; } catch (e) { return false; }
  }
  function tell(result) { listeners.forEach(function (fn) { fn(result); }); }
  function tellSync() { var s = syncState(); syncListeners.forEach(function (fn) { fn(s); }); }

  /** 套用一個 ldg* 改動的結果：成功就換掉資料、記進待送、存檔、通知畫面、排一次同步。回原結果（加上 saved）。 */
  function apply(result) {
    if (readOnly) return { ok: false, message: '手機裡的帳目資料看不懂，為了不弄壞它，現在只能看、不能改。' };
    if (!result.ok || result.same) return result;
    records = result.records;
    if (pending.indexOf(result.rec.id) < 0) pending.push(result.rec.id);
    result.saved = save();
    tell(result);
    soon();
    return result;
  }

  /* ───────── 同步 ───────── */

  function configured() { return link.url !== '' && link.token !== ''; }

  /** 打一次 Apps Script。body＝null ⇒ GET 讀全部；否則 POST。回 JSON；失敗丟 { kind:'timeout'|'network'|'notjson', reply? }。 */
  function request(url, token, body) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null, timer = null;
    var limit = body ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
    var opts = ctrl ? { signal: ctrl.signal } : {};
    if (body) { opts.method = 'POST'; opts.body = JSON.stringify(Object.assign({ token: token }, body)); }   // ⛔ 不設 Content-Type
    var go = fetch(body ? url : url + '?token=' + encodeURIComponent(token), opts)
      .then(function (res) { return res.text(); })
      .then(function (text) {
        try { return JSON.parse(text); } catch (e) { throw { kind: 'notjson', reply: text }; }
      }, function (e) { if (e && e.kind) throw e; throw { kind: 'network' }; });
    var late = new Promise(function (resolve, reject) {
      timer = setTimeout(function () { if (ctrl) ctrl.abort(); reject({ kind: 'timeout', ms: limit }); }, limit);
    });
    return Promise.race([go, late]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }
  function describeFailure(e) {
    if (e && e.kind === 'timeout') return '連不上（等了 ' + e.ms / 1000 + ' 秒沒回應）';
    if (e && e.kind === 'network') return typeof navigator !== 'undefined' && navigator.onLine === false ? '沒有網路' : '連不上（沒有網路或網址不對）';
    if (e && e.kind === 'notjson') return ldgDescribeReply(e.reply);
    if (e && e.kind === 'reply') return e.message;
    return '同步失敗：' + String(e && e.message || e);
  }

  async function cycle() {
    var url = link.url, token = link.token;
    var stillHere = function () { return link.url === url && link.token === token && !readOnly; };   // 途中改了設定 ⇒ 結果不算
    // ① 送帳
    for (var round = 0; round < MAX_ROUNDS; round++) {
      var batch = ldgSyncBatch(records, pending);
      if (!batch.length) break;
      var reply = await request(url, token, { op: 'sync', records: batch });
      if (!stillHere()) return;
      var ap = ldgApplySyncResults(records, pending, batch, reply);
      if (!ap.ok) throw { kind: 'reply', message: ap.message };
      pending = ap.pending; run.invalid = ap.invalid;
      save();
      if (ap.invalid.length || ap.unknown) break;   // 送不進去的會一直在待送裡，⛔ 不在同一次裡一直重送
    }
    if (round === 0) run.invalid = [];
    // ② 送預算
    if (settingsPending && settings.budgetUpdatedAt !== '') {
      var at = settings.budgetUpdatedAt;
      var sr = await request(url, token, { op: 'settings', budget: settings.budget, updatedAt: at });
      if (!stillHere()) return;
      var as = ldgApplySettingsResult(settings, at, sr);
      if (!as.ok) throw { kind: 'reply', message: as.message };
      settingsPending = as.settingsPending;
      save();
    }
    // ③ 讀回、合併
    var got = await request(url, token, null);
    if (!stillHere()) return;
    if (!got || got.ok !== true || !Array.isArray(got.records)) throw { kind: 'reply', message: ldgDescribeReply(got) };
    var mg = ldgMergeRemote(records, pending, got.records);
    var ms = ldgMergeRemoteSettings(settings, settingsPending, got.settings);
    records = mg.records; pending = mg.pending; settings = ms.settings; settingsPending = ms.settingsPending;
    run.warnings = (Array.isArray(got.warnings) ? got.warnings : []).concat(mg.problems);
    var saved = save();
    if (mg.changed || ms.changed) tell({ ok: true, sync: true, saved: saved });
    if (mg.requeued) run.again = true;   // 試算表沒有、手機比較新的 ⇒ 馬上補送
    link.lastOkAt = nowText(); saveLink();
  }

  /** 現在同步一次（同一時間只跑一個；跑的時候又被叫 ⇒ 跑完再來一次）。回 Promise<true 成功｜false>。 */
  function syncNow() {
    if (!configured() || readOnly) return Promise.resolve(false);
    if (run.running) { run.again = true; return run.promise; }
    run.running = true; run.again = false; run.lastAttemptMs = Date.now();
    tellSync();
    run.promise = cycle().then(function () { run.error = ''; run.lastFailed = false; return true; },
      function (e) { run.error = describeFailure(e); run.lastFailed = true; return false; })
      .then(function (okay) {
        run.running = false;
        tellSync();
        if (run.again && okay) { run.again = false; soon(300); }
        return okay;
      });
    return run.promise;
  }
  /** 改動之後稍等一下再同步（連續記好幾筆只送一次）。 */
  function soon(ms) {
    if (!configured() || typeof setTimeout !== 'function') return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(function () { debounce = null; syncNow(); }, ms === undefined ? 1500 : ms);
  }
  function tick() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;   // 切走就不定時讀（省電、省 Apps Script 配額）
    if (ldgSyncDue({ configured: configured(), running: run.running, readOnly: readOnly, pendingCount: pending.length + (settingsPending ? 1 : 0),
      lastAttemptMs: run.lastAttemptMs, lastFailed: run.lastFailed }, Date.now())) syncNow();
  }
  /** 開始自動同步（畫面載入後叫一次）：開網頁、恢復連線、切回網頁、每 15 秒看一下該不該跑。 */
  function startAuto() {
    setTimeout(tick, 800);
    setInterval(tick, 15000);
    window.addEventListener('online', function () { syncNow(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') tick(); });
  }

  function syncState() {
    return {
      configured: configured(), running: run.running, pendingCount: pending.length, settingsPending: settingsPending,
      lastOkAt: link.lastOkAt, error: run.error, invalidCount: run.invalid.length,
      invalid: run.invalid.slice(), warnings: run.warnings.slice(), readOnly: readOnly,
    };
  }

  /** 設定頁存網址＋密碼。密碼留空 ⇒ 沿用這台手機原本存的。換了網址 ⇒ 上次同步時間歸零，馬上同步。 */
  function setEndpoint(url, token) {
    var t = String(token || '').trim() === '' && link.token ? link.token : token;
    var chk = ldgCheckEndpoint(url, t);
    if (!chk.ok) return chk;
    var changed = chk.url !== link.url || chk.token !== link.token;
    if (chk.url !== link.url) link.lastOkAt = '';
    link.url = chk.url; link.token = chk.token;
    if (!saveLink()) return { ok: false, field: 'url', message: '這個瀏覽器不讓網頁存資料，網址密碼存不起來。' };
    if (changed) { run.error = ''; run.lastFailed = false; run.invalid = []; run.warnings = []; }
    tellSync();
    syncNow();
    return { ok: true, changed: changed };
  }
  /** 中斷連線：只清掉網址密碼，手機裡的帳與待送都留著。 */
  function clearEndpoint() {
    link = { url: '', token: '', lastOkAt: '' };
    try { localStorage.removeItem(SYNC_KEY); } catch (e) { /* 沒有就算了 */ }
    run.error = ''; run.invalid = []; run.warnings = [];
    tellSync();
  }
  /** 測試連線（設定頁的按鈕）：GET 讀一次，⛔ 不存、不合併。回 Promise<{ ok, message, count?, budget? }>。 */
  function testEndpoint(url, token) {
    var t = String(token || '').trim() === '' && link.token ? link.token : token;
    var chk = ldgCheckEndpoint(url, t);
    if (!chk.ok) return Promise.resolve(chk);
    return request(chk.url, chk.token, null).then(function (got) {
      if (!got || got.ok !== true || !Array.isArray(got.records)) return { ok: false, message: ldgDescribeReply(got) };
      var live = got.records.filter(function (r) { return r && r.deletedAt === ''; }).length;
      return { ok: true, count: live, budget: got.settings ? got.settings.budget : null, warnings: Array.isArray(got.warnings) ? got.warnings.length : 0 };
    }, function (e) { return { ok: false, message: describeFailure(e) }; });
  }

  load();
  return {
    today: today,
    records: function () { return records; },
    pending: function () { return pending.slice(); },
    problems: function () { return problems.slice(); },
    readOnly: function () { return readOnly; },
    find: function (id) { for (var i = 0; i < records.length; i++) if (records[i].id === id) return records[i]; return null; },
    onChange: function (fn) { listeners.push(fn); },
    add: function (value) { var r = ldgAdd(records, value, ctx()); r.ok = true; return apply(r); },
    edit: function (id, changes) { return apply(ldgEdit(records, id, changes, ctx())); },
    remove: function (id) { return apply(ldgRemove(records, id, ctx())); },
    restore: function (id) { return apply(ldgRestore(records, id, ctx())); },
    setHidden: function (id, hidden) { return apply(ldgSetHidden(records, id, hidden, ctx())); },
    /** 每月預算（也會同步到試算表）。settingsPending＝本機改過、還沒送。 */
    settings: function () { return settings; },
    settingsPending: function () { return settingsPending; },
    setBudget: function (input) {
      if (readOnly) return { ok: false, message: '手機裡的帳目資料看不懂，為了不弄壞它，現在只能看、不能改。' };
      var r = ldgSetBudget(settings, input, ctx());
      if (!r.ok || r.same) return r;
      settings = r.settings; settingsPending = true;
      r.saved = save();
      tell(r);
      soon();
      return r;
    },
    /** 試算表同步。網址本身 ⛔ 不給畫面以外的人看；畫面只拿得到「有沒有設定」與網址（設定頁要顯示給本人改）。 */
    endpoint: function () { return { configured: configured(), url: link.url, hasToken: link.token !== '' }; },
    setEndpoint: setEndpoint,
    clearEndpoint: clearEndpoint,
    testEndpoint: testEndpoint,
    syncNow: syncNow,
    syncState: syncState,
    onSync: function (fn) { syncListeners.push(fn); },
    startAuto: startAuto,
  };
})();
