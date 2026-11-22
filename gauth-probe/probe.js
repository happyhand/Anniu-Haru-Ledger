'use strict';
/*
 * probe.js —— #2 Google 登入試作（只試作、不是產品）。前半是純函式（tools/gauth-probe/probetest.js 用手寫 fixture 驗），後半是畫面。
 *
 * 兩種登入：(a) Google 登入元件（彈出視窗，token model）(b) 整頁轉址（implicit flow，回來時通行證在網址 # 後面）。
 * 🔴 通行證只放在記憶體變數裡：⛔ 不印在畫面或 console、⛔ 不存 localStorage／sessionStorage；轉址回來後馬上把網址的 # 清掉。
 * 🔴 權限只要 drive.file：只碰得到這個試作自己建的檔。localStorage 只存試算表編號、最後寫入的那一列、記錄、帳號提示、轉址暗號（都不是通行證）。
 * 用戶端 ID 由 config.js 提供（匯出工具寫入，來源在 local/，不進版控）。
 */
(function (root) {
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  var GIS_URL = 'https://accounts.google.com/gsi/client';
  var SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  var DRIVE = 'https://www.googleapis.com/drive/v3/files';
  var ABOUT = 'https://www.googleapis.com/drive/v3/about';
  var REVOKE = 'https://oauth2.googleapis.com/revoke';
  var TITLE = '記帳試作（可刪）';
  var TAB = '帳目';

  /** 重新導向 URI＝目前網址去掉查詢與 #，結尾的 index.html 換成資料夾（要跟主控台登記的那筆一字不差）。 */
  function redirectUriOf(loc) {
    return loc.origin + loc.pathname.replace(/index\.html$/, '');
  }

  /** 轉址登入的網址。prompt：''＝第一次才問、'none'＝完全不顯示畫面（不行就回錯誤）、'select_account'、'consent'。 */
  function buildAuthUrl(o) {
    var p = [['client_id', o.clientId], ['redirect_uri', o.redirectUri], ['response_type', 'token'],
      ['scope', SCOPE], ['state', o.state], ['include_granted_scopes', 'true']];
    if (o.prompt) p.push(['prompt', o.prompt]);
    if (o.loginHint) p.push(['login_hint', o.loginHint]);
    return AUTH_URL + '?' + p.map(function (kv) { return kv[0] + '=' + encodeURIComponent(kv[1]); }).join('&');
  }

  /** 解析轉址回來的 #。回傳 null（不是登入回來的）或 {token, expiresIn, state, scope, error}。 */
  function parseFragment(hash) {
    var h = String(hash || '').replace(/^#/, '');
    if (!h) return null;
    var o = {};
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i <= 0) return;
      try { o[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); } catch (e) { /* 壞掉的那段略過 */ }
    });
    if (!('access_token' in o) && !('error' in o)) return null;
    return {
      token: o.access_token || null,
      expiresIn: o.expires_in && /^\d+$/.test(o.expires_in) ? Number(o.expires_in) : null,
      state: o.state || null,
      scope: o.scope || '',
      error: o.error || null,
    };
  }

  /** 讀回來的最後一列是不是剛剛寫的那一列（試算表回的都是字串，數字比字串）。 */
  function sameRow(written, got) {
    if (!Array.isArray(written) || !Array.isArray(got) || written.length !== got.length) return false;
    for (var i = 0; i < written.length; i++) if (String(written[i]) !== String(got[i])) return false;
    return true;
  }

  /** Drive 搜尋條件：這個試作建的、名字是 TITLE、沒丟進垃圾桶的試算表。名字裡的 ' 與 \ 要跳脫。 */
  function driveQuery(title) {
    var t = String(title).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return "mimeType='application/vnd.google-apps.spreadsheet' and name='" + t + "' and trashed=false";
  }

  /** 通行證還剩幾秒（沒有通行證回 null；過期回 0）。 */
  function secondsLeft(tok, now) {
    if (!tok || !tok.expAt) return null;
    return Math.max(0, Math.round((tok.expAt - now) / 1000));
  }

  var api = { SCOPE: SCOPE, TITLE: TITLE, redirectUriOf: redirectUriOf, buildAuthUrl: buildAuthUrl, parseFragment: parseFragment, sameRow: sameRow, driveQuery: driveQuery, secondsLeft: secondsLeft };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GP = api;
  if (typeof document === 'undefined') return;

  // ───────────── 以下是畫面 ─────────────
  var $ = function (id) { return document.getElementById(id); };
  var CLIENT_ID = (root.GAUTH_PROBE_CONFIG || {}).clientId || '';
  var tok = null;            // { value, expAt, via }：⛔ 只在記憶體
  var gisClient = null, gisPending = null;
  var LOG_KEY = 'gauth-probe-log', SHEET_KEY = 'gauth-probe-sheet', LAST_KEY = 'gauth-probe-last', REDIR_KEY = 'gauth-probe-redirect';
  // 帳號提示（login_hint）：登入成功後向 Drive 問「這是誰」（⛔ 不顯示在畫面上，只顯示有／沒有）。
  // 為什麼要：瀏覽器同時登入多個 Google 帳號時，prompt=none 不知道選哪個會回 interaction_required（2026-11-22 桌機實測）。
  var HINT_KEY = 'gauth-probe-hint';
  // 記錄、帳號提示、轉址暗號一律存 localStorage（整個網站共用）：Android 實測（2026-11-22）轉址回來落在另一個視窗，
  // sessionStorage 是每個視窗各一份 ⇒ 暗號對不上、記錄也不見。WIN＝這個視窗的代號（存 sessionStorage），每行記錄標上，看得出有沒有換窗。
  var WIN_KEY = 'gauth-probe-win';

  function store(kind) { try { return kind === 's' ? root.sessionStorage : root.localStorage; } catch (e) { return null; } }
  function get(kind, k) { try { var s = store(kind); return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function put(kind, k, v) { try { var s = store(kind); if (s) { if (v === null) s.removeItem(k); else s.setItem(k, v); } } catch (e) { /* 存不了就算了 */ } }
  var WIN = get('s', WIN_KEY) || (function () { var w = Math.random().toString(36).slice(2, 5); put('s', WIN_KEY, w); return w; })();

  function hhmmss(d) { return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return (n < 10 ? '0' : '') + n; }).join(':'); }
  function readLog() { try { return JSON.parse(get('l', LOG_KEY) || '[]'); } catch (e) { return []; } }
  function log(step, ok, ms, note) {
    var list = readLog();
    list.push({ t: hhmmss(new Date()) + ' 窗' + WIN, step: step, ok: ok, ms: ms, note: note || '' });
    put('l', LOG_KEY, JSON.stringify(list.slice(-80)));
    drawLog();
  }
  function drawLog() {
    var ul = $('log'); ul.textContent = '';
    readLog().slice().reverse().forEach(function (e) {
      var li = document.createElement('li');
      li.className = e.ok === true ? 'ok' : e.ok === false ? 'bad' : 'info';
      li.textContent = e.t + '  ' + (e.ok === true ? '✓' : e.ok === false ? '✕' : '・') + ' ' + e.step + (e.ms != null ? '（' + (e.ms / 1000).toFixed(1) + ' 秒）' : '') + (e.note ? ' —— ' + e.note : '');
      ul.appendChild(li);
    });
  }

  function drawStatus() {
    var left = secondsLeft(tok, Date.now());
    $('tok').textContent = !tok ? '沒有（還沒登入，或已丟掉）' : left === 0 ? '已過期（' + tok.via + '）' : '有，約剩 ' + Math.ceil(left / 60) + ' 分鐘（' + tok.via + '）';
    var id = get('l', SHEET_KEY);
    $('sheet').textContent = id ? '有（編號末 6 碼 …' + id.slice(-6) + '）' : '還沒有';
    $('hint').textContent = get('l', HINT_KEY) ? '有（不動手重拿時會告訴 Google 用這個帳號）' : '沒有（登入成功後自動取得）';
  }

  function setToken(value, expiresIn, via) {
    tok = { value: value, expAt: expiresIn ? Date.now() + expiresIn * 1000 : null, via: via };
    drawStatus();
    if (!get('l', HINT_KEY)) {
      call('GET', ABOUT + '?fields=' + encodeURIComponent('user(emailAddress)')).then(function (r) {
        var em = r.ok && r.body && r.body.user && r.body.user.emailAddress;
        if (em) { put('l', HINT_KEY, em); drawStatus(); log('取得帳號提示', true, r.ms); }
        else log('取得帳號提示', false, r.ms, 'HTTP ' + r.status + ' ' + r.msg);
      });
    }
  }

  /** 打 Google API：帶通行證、20 秒逾時、回 {ok, status, body, ms}。⛔ 錯誤訊息只取 Google 回的 message。 */
  function call(method, url, body) {
    if (!tok) return Promise.resolve({ ok: false, status: 0, body: null, ms: 0, msg: '沒有通行證，先登入' });
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : null;
    var t0 = performance.now();
    var init = { method: method, headers: { Authorization: 'Bearer ' + tok.value }, signal: ctl ? ctl.signal : undefined };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        var j = null; try { j = JSON.parse(text); } catch (e) { /* 不是 JSON */ }
        var msg = j && j.error ? (j.error.status || '') + ' ' + (j.error.message || '') : '';
        return { ok: res.ok, status: res.status, body: j, ms: Math.round(performance.now() - t0), msg: msg.trim() };
      });
    }, function (e) {
      return { ok: false, status: 0, body: null, ms: Math.round(performance.now() - t0), msg: e && e.name === 'AbortError' ? '20 秒沒回應，放棄' : '連不上（' + (e && e.message || e) + '）' };
    }).then(function (r) { if (timer) clearTimeout(timer); return r; });
  }

  // ── (a) Google 登入元件 ──
  function loadGis() {
    var t0 = performance.now();
    var done = false;
    var s = document.createElement('script');
    s.src = GIS_URL; s.async = true;
    var timer = setTimeout(function () { if (!done) { done = true; log('載入 Google 登入元件', false, Math.round(performance.now() - t0), '10 秒沒載到（頁面其他按鈕照常可用）'); } }, 10000);
    s.onload = function () {
      if (done) return; done = true; clearTimeout(timer);
      try {
        gisClient = root.google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID, scope: SCOPE,
          callback: function (r) {
            var p = gisPending; gisPending = null;
            var ms = p ? Math.round(performance.now() - p.t0) : null;
            if (r && r.access_token) { setToken(r.access_token, Number(r.expires_in) || null, '元件'); log((p ? p.label : '元件登入'), true, ms, 'Google 給的有效秒數 ' + r.expires_in); }
            else log((p ? p.label : '元件登入'), false, ms, 'Google 回錯誤：' + ((r && (r.error + ' ' + (r.error_description || ''))) || '不明'));
          },
          error_callback: function (e) {
            var p = gisPending; gisPending = null;
            log((p ? p.label : '元件登入'), false, p ? Math.round(performance.now() - p.t0) : null, '視窗問題：' + (e && e.type || '不明') + (e && e.type === 'popup_failed_to_open' ? '（彈出視窗被擋）' : e && e.type === 'popup_closed' ? '（視窗被關掉）' : ''));
          },
        });
        $('gisState').textContent = '已載入';
        log('載入 Google 登入元件', true, Math.round(performance.now() - t0));
      } catch (e) { log('載入 Google 登入元件', false, Math.round(performance.now() - t0), '初始化失敗：' + (e && e.message || e)); }
    };
    s.onerror = function () { if (done) return; done = true; clearTimeout(timer); $('gisState').textContent = '載不到'; log('載入 Google 登入元件', false, Math.round(performance.now() - t0), '載不到（沒網路或被擋；頁面其他按鈕照常可用）'); };
    document.head.appendChild(s);
  }
  function gisRequest(prompt, label) {
    if (!gisClient) { log(label, false, null, 'Google 登入元件還沒載入'); return; }
    gisPending = { t0: performance.now(), label: label };
    var hint = prompt === 'none' ? get('l', HINT_KEY) : null;
    log(label, null, null, '已按下，等 Google 回應…' + (hint ? '（帶帳號提示）' : ''));
    var o = { prompt: prompt };
    if (hint) o.login_hint = hint;
    try { gisClient.requestAccessToken(o); } catch (e) { gisPending = null; log(label, false, null, '呼叫失敗：' + (e && e.message || e)); }
  }

  // ── (b) 整頁轉址 ──
  function redirectLogin(prompt, label) {
    var state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    put('l', REDIR_KEY, JSON.stringify({ state: state, label: label, at: Date.now(), win: WIN }));
    var hint = prompt === 'none' ? get('l', HINT_KEY) : null;
    log(label, null, null, '轉去 Google…' + (hint ? '（帶帳號提示）' : ''));
    location.href = buildAuthUrl({ clientId: CLIENT_ID, redirectUri: redirectUriOf(location), state: state, prompt: prompt, loginHint: hint });
  }
  function handleReturn() {
    var f = parseFragment(location.hash);
    if (!f) return;
    // 先把網址的 # 清掉：通行證 ⛔ 不留在網址列與瀏覽紀錄
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
    var pend = null; try { pend = JSON.parse(get('l', REDIR_KEY) || 'null'); } catch (e) { pend = null; }
    put('l', REDIR_KEY, null);
    var label = pend ? pend.label : '轉址登入';
    var ms = pend ? Date.now() - pend.at : null;
    if (pend && pend.win && pend.win !== WIN) log('轉址回來換了視窗', null, null, '出發 窗' + pend.win + ' → 回來 窗' + WIN + '（' + envText() + '）');
    if (!pend || pend.state !== f.state) { log(label, false, ms, 'state 對不上，不收這張通行證' + (pend ? '' : '（找不到出發時存的暗號）')); return; }
    if (f.error) { log(label, false, ms, 'Google 回錯誤：' + f.error); return; }
    setToken(f.token, f.expiresIn, '轉址');
    log(label, true, ms, 'Google 給的有效秒數 ' + f.expiresIn + '（秒數含在 Google 畫面停留的時間）');
  }

  // ── 試算表 ──
  function createSheet() {
    call('POST', SHEETS, { properties: { title: TITLE }, sheets: [{ properties: { title: TAB } }] }).then(function (r) {
      if (r.ok && r.body && r.body.spreadsheetId) { put('l', SHEET_KEY, r.body.spreadsheetId); drawStatus(); log('建試算表「' + TITLE + '」', true, r.ms); }
      else log('建試算表', false, r.ms, 'HTTP ' + r.status + ' ' + r.msg);
    });
  }
  function writeRow() {
    var id = get('l', SHEET_KEY);
    if (!id) { log('寫一列', false, null, '還沒有試算表，先建或找回'); return; }
    var row = [new Date().toISOString(), String(100 + Math.floor(Math.random() * 900)), '試作，可刪'];
    var url = SHEETS + '/' + id + '/values/' + encodeURIComponent(TAB + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
    call('POST', url, { values: [row] }).then(function (r) {
      if (r.ok) { put('l', LAST_KEY, JSON.stringify(row)); log('寫一列', true, r.ms, '金額 ' + row[1]); }
      else log('寫一列', false, r.ms, 'HTTP ' + r.status + ' ' + r.msg);
    });
  }
  function readBack() {
    var id = get('l', SHEET_KEY);
    if (!id) { log('讀回', false, null, '還沒有試算表，先建或找回'); return; }
    call('GET', SHEETS + '/' + id + '/values/' + encodeURIComponent(TAB + '!A:C')).then(function (r) {
      if (!r.ok) { log('讀回', false, r.ms, 'HTTP ' + r.status + ' ' + r.msg); return; }
      var rows = (r.body && r.body.values) || [];
      var last = null; try { last = JSON.parse(get('l', LAST_KEY) || 'null'); } catch (e) { last = null; }
      var tail = rows[rows.length - 1];
      if (!last) log('讀回', true, r.ms, '共 ' + rows.length + ' 列（這台還沒寫過，無從比對）');
      else log('讀回', sameRow(last, tail), r.ms, '共 ' + rows.length + ' 列；最後一列' + (sameRow(last, tail) ? '跟剛寫的一樣' : '跟剛寫的不一樣'));
    });
  }
  function findSheet() {
    var url = DRIVE + '?q=' + encodeURIComponent(driveQuery(TITLE)) + '&orderBy=createdTime%20desc&fields=' + encodeURIComponent('files(id,name,createdTime)') + '&spaces=drive';
    call('GET', url).then(function (r) {
      if (!r.ok) { log('找回試算表', false, r.ms, 'HTTP ' + r.status + ' ' + r.msg); return; }
      var files = (r.body && r.body.files) || [];
      var mine = get('l', SHEET_KEY);
      if (files.length) {
        var had = mine && files.some(function (f) { return f.id === mine; });
        if (!had) put('l', SHEET_KEY, files[0].id);
        drawStatus();
        log('找回試算表', true, r.ms, '找到 ' + files.length + ' 份' + (had ? '（含這台記得的那份）' : '，改用最新建的那份（建於 ' + files[0].createdTime + '）'));
      } else log('找回試算表', false, r.ms, '找到 0 份（drive.file 看不到，或還沒建過）');
    });
  }

  function forget() { tok = null; drawStatus(); log('丟掉通行證（模擬過期）', null, null, '只是忘掉，Google 那邊沒撤銷；帳號提示留著'); }
  function revoke() {
    if (!tok) { log('撤銷授權', false, null, '沒有通行證'); return; }
    var t0 = performance.now();
    var v = tok.value; tok = null; drawStatus();
    fetch(REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(v) })
      .then(function (res) { log('撤銷授權', res.ok, Math.round(performance.now() - t0), res.ok ? '下次登入會重新問同意' : 'HTTP ' + res.status); },
        function (e) { log('撤銷授權', false, Math.round(performance.now() - t0), '連不上（' + (e && e.message || e) + '）'); });
  }

  function envText() {
    var standalone = (root.matchMedia && root.matchMedia('(display-mode: standalone)').matches) || root.navigator.standalone === true;
    return standalone ? '主畫面版（全螢幕）' : '瀏覽器分頁';
  }
  function env() {
    $('env').textContent = envText() + '｜窗' + WIN + '｜' + (navigator.onLine ? '有網路' : '沒網路') + '｜' + navigator.userAgent;
  }

  function wire(id, fn) { $(id).addEventListener('click', fn); }
  document.addEventListener('DOMContentLoaded', function () {
    env(); drawLog(); drawStatus();
    if (!CLIENT_ID) { log('設定', false, null, 'config.js 沒有用戶端 ID（要用匯出工具產生）'); }
    handleReturn();
    $('redirectUri').textContent = redirectUriOf(location);
    loadGis();
    wire('gisLogin', function () { gisRequest('', '元件登入'); });
    wire('gisPick', function () { gisRequest('select_account', '元件登入（重選帳號）'); });
    wire('gisSilent', function () { gisRequest('none', '元件不動手重拿（prompt=none）'); });
    wire('rdLogin', function () { redirectLogin('', '轉址登入'); });
    wire('rdSilent', function () { redirectLogin('none', '轉址不動手重拿（prompt=none）'); });
    wire('create', createSheet); wire('write', writeRow); wire('read', readBack); wire('find', findSheet);
    wire('forget', forget); wire('revoke', revoke);
    wire('clear', function () { put('l', LOG_KEY, null); put('l', HINT_KEY, null); drawLog(); drawStatus(); });
    root.addEventListener('online', env); root.addEventListener('offline', env);
    setInterval(drawStatus, 10000);
  });
})(this);
