/*
 * 安妞哈嚕記帳 ♡ —— 網頁的判斷邏輯（由 tools/build-web.js 拼出，⛔ 不要直接改這裡，改來源再重建）。
 * 來源：shared/contract.js、shared/ledger.js
 */

// ═══════════════════ shared/contract.js ═══════════════════
/*
 * contract.js —— 試算表格式合約（純函式、⛔ 零相依、⛔ 不碰試算表、⛔ 不碰網路）。
 *
 * 同一份程式兩處用：
 *   ① 拼進 dist/Code.gs 給 Apps Script（膠水層 apps-script/glue.js 只搬運：讀格子、寫格子、上鎖、回 JSON）
 *   ② 記帳網頁（段 C 起）用來驗證、產生編號、算時間
 * 🔴 Apps Script 在本機跑不起來 ⇒ 所有「會判斷」的程式都寫在這裡、在 Node 自驗。
 *
 * 拼檔規矩（tools/build-gas.js）：頂層只用 var／function、名字一律 lgr 前綴，Node 專用段包 @node-only 標記。
 *
 * 兩種資料樣子：
 *   線上（網頁 ↔ Apps Script 的 JSON）：英文鍵 { id, date, amount, note, deco, house, slot, hidden, deletedAt, createdAt, updatedAt }
 *     date＝'YYYY-MM-DD'；amount＝正整數；deco＝sprout｜toy｜balloon｜cloud｜''；house＝anniu｜haru；
 *     slot＝整數或 null；hidden＝true／false；三個時間＝'YYYY-MM-DD HH:mm:ss +08:00'（手機當地時間＋時差）或 deletedAt＝''
 *   試算表：中文欄名、中文值（讓人直接開試算表也看得懂）
 * 讀：膠水層給「顯示值」二維陣列（getDisplayValues，全是字串）。
 * 寫：日期寫成試算表序號（1899-12-30 起算的天數）＋ yyyy/mm/dd 格式；文字格先設成純文字格式再寫（時間字串不會被試算表自作主張轉成日期）。
 *
 * 同步規則（小葛預設）：
 *   - 一筆一列、⛔ 永不刪列；刪除＝填「刪除時間」（垃圾桶），還原＝清掉它並更新「更新時間」
 *   - 同一個編號：更新時間**比較新**才覆蓋；一樣新或比較舊就不動（回 same／stale）⇒ 重送不會多一列、不會倒退
 */

var LGR_LEDGER = '帳目';
var LGR_SETTINGS = '設定';

/** 帳目分頁的欄位（順序＝新建分頁時的表頭順序）。key＝線上 JSON 的鍵。 */
var LGR_COLUMNS = [
  { name: '編號', key: 'id' },
  { name: '日期', key: 'date' },
  { name: '金額', key: 'amount' },
  { name: '花在什麼', key: 'note' },
  { name: '裝飾', key: 'deco' },
  { name: '狗屋', key: 'house' },
  { name: '位置', key: 'slot' },
  { name: '是否收起', key: 'hidden' },
  { name: '刪除時間', key: 'deletedAt' },
  { name: '建立時間', key: 'createdAt' },
  { name: '更新時間', key: 'updatedAt' },
];
var LGR_FIND = ['編號', '日期', '金額', '更新時間'];

/** 設定分頁：三欄「項目／值／更新時間」，一個項目一列。 */
var LGR_SETTING_HEADERS = ['項目', '值', '更新時間'];
var LGR_SETTING_ITEMS = [{ name: '每月預算', key: 'budget' }];

var LGR_DECO = { sprout: '芽芽', toy: '玩具', balloon: '氣球', cloud: '雲朵' };
var LGR_HOUSE = { anniu: '安妞', haru: '哈嚕' };
var LGR_YES = '是';
var LGR_NO = '否';
var LGR_MAX_AMOUNT = 10000000;
var LGR_MAX_NOTE = 200;
var LGR_MAX_SLOT = 99;
var LGR_MAX_BATCH = 200;
var LGR_EPOCH_UTC = Date.UTC(1899, 11, 30);
var LGR_DAY_MS = 86400000;

function lgrTrim(v) { return v === null || v === undefined ? '' : String(v).trim(); }

/** 分頁不存在（null）或整張空白 ⇒ true。空白分頁的 getDataRange 會給 [['']]，要當成「還沒建表頭」，⛔ 不是格式錯。 */
function lgrGridEmpty(grid) {
  if (grid === null || grid === undefined) return true;
  return !grid.some(function (line) { return (line || []).some(function (v) { return lgrTrim(v) !== ''; }); });
}
function lgrPad(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }

/** 解析日期字串 ⇒ 'YYYY-MM-DD'；認 2026/11/23、2026/1/5、2026-11-23、2026.11.23。不合法回 null（含 2026/02/30）。 */
function lgrParseDate(v) {
  var m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(lgrTrim(v));
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  var t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return y + '-' + lgrPad(mo) + '-' + lgrPad(d);
}

/** 'YYYY-MM-DD' ⇒ 試算表日期序號。不合法回 null。 */
function lgrYmdToSerial(ymd) {
  var norm = lgrParseDate(ymd);
  if (!norm) return null;
  var p = norm.split('-');
  return Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - LGR_EPOCH_UTC) / LGR_DAY_MS);
}

/** 時間字串 ⇒ 毫秒（UTC 基準）。認 'YYYY-MM-DD HH:mm:ss +08:00'、'+0800'、'Z'、中間用 T 也行。不合法回 null。 */
function lgrParseTime(v) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s*(Z|[+\-]\d{2}:?\d{2})$/.exec(lgrTrim(v));
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
  if (!lgrParseDate(m[1] + '-' + m[2] + '-' + m[3]) || h > 23 || mi > 59 || s > 59) return null;
  var ms = m[7] ? +(m[7] + '00').slice(0, 3) : 0;
  var off = 0;
  if (m[8] !== 'Z') {
    var z = m[8].replace(':', '');
    off = (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(3, 5));
    if (+z.slice(1, 3) > 14 || +z.slice(3, 5) > 59) return null;
  }
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - off * 60000;
}

/** 毫秒 ⇒ 'YYYY-MM-DD HH:mm:ss +08:00'。offsetMin＝當地比 UTC 快幾分鐘（台灣 480；瀏覽器是 -getTimezoneOffset()）。 */
function lgrFormatTime(ms, offsetMin) {
  var off = typeof offsetMin === 'number' && isFinite(offsetMin) ? Math.round(offsetMin) : 0;
  var t = new Date(Math.floor(ms / 1000) * 1000 + off * 60000);
  var a = Math.abs(off);
  return t.getUTCFullYear() + '-' + lgrPad(t.getUTCMonth() + 1) + '-' + lgrPad(t.getUTCDate()) + ' ' +
    lgrPad(t.getUTCHours()) + ':' + lgrPad(t.getUTCMinutes()) + ':' + lgrPad(t.getUTCSeconds()) + ' ' +
    (off < 0 ? '-' : '+') + lgrPad(Math.floor(a / 60)) + ':' + lgrPad(a % 60);
}

/**
 * 下一個「更新時間」：至少比上一次晚 1 秒。
 * 為什麼：時間只記到秒，同一秒內改兩次會變成「一樣新」⇒ 第二次被當成 same 不寫進試算表（改的東西就不見了）。
 */
function lgrNextUpdatedMs(prevMs, nowMs) {
  var now = Math.floor(nowMs / 1000) * 1000;
  if (typeof prevMs === 'number' && isFinite(prevMs) && now <= prevMs) return Math.floor(prevMs / 1000) * 1000 + 1000;
  return now;
}

/** 產生一筆的編號：'YYYYMMDD-HHmmss-xxxx'（當地時間＋4 碼亂數）。rand＝Math.random 之類（自驗可注入）。 */
function lgrMakeId(nowMs, offsetMin, rand) {
  var t = lgrFormatTime(nowMs, offsetMin);
  var chars = 'abcdefghijkmnpqrstuvwxyz23456789', tail = '';
  for (var i = 0; i < 4; i++) tail += chars.charAt(Math.floor(rand() * chars.length) % chars.length);
  return t.slice(0, 10).replace(/-/g, '') + '-' + t.slice(11, 19).replace(/:/g, '') + '-' + tail;
}

/** 金額顯示值 ⇒ 整數；認 1200、1,200、NT$1,200。不合法回 null。 */
function lgrParseAmount(v) {
  var s = lgrTrim(v).replace(/^NT\$\s*/i, '').replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+$/.test(s)) return null;
  var n = +s;
  return n >= 1 && n <= LGR_MAX_AMOUNT ? n : null;
}

function lgrKeyOf(map, label) {
  for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k) && map[k] === label) return k;
  return null;
}

/** 驗一筆線上 JSON。回問題清單（空陣列＝合法）。 */
function lgrValidateRecord(r) {
  var p = [];
  if (!r || typeof r !== 'object') return ['不是一筆資料'];
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9\-]{6,40}$/.test(r.id)) p.push('編號不合法');
  if (lgrParseDate(r.date) !== r.date) p.push('日期不合法（要 YYYY-MM-DD）');
  if (typeof r.amount !== 'number' || Math.floor(r.amount) !== r.amount || r.amount < 1 || r.amount > LGR_MAX_AMOUNT) p.push('金額要是 1～' + LGR_MAX_AMOUNT + ' 的整數');
  if (typeof r.note !== 'string' || r.note.length > LGR_MAX_NOTE || /[\r\n]/.test(r.note)) p.push('花在什麼要是一行、' + LGR_MAX_NOTE + ' 字以內');
  if (r.deco !== '' && !LGR_DECO[r.deco]) p.push('裝飾不認得');
  if (!LGR_HOUSE[r.house]) p.push('狗屋不認得');
  if (r.slot !== null && (typeof r.slot !== 'number' || Math.floor(r.slot) !== r.slot || r.slot < 0 || r.slot > LGR_MAX_SLOT)) p.push('位置要是 0～' + LGR_MAX_SLOT + ' 的整數或空白');
  if (typeof r.hidden !== 'boolean') p.push('是否收起要是 true／false');
  if (r.deletedAt !== '' && lgrParseTime(r.deletedAt) === null) p.push('刪除時間不合法');
  if (lgrParseTime(r.createdAt) === null) p.push('建立時間不合法');
  if (lgrParseTime(r.updatedAt) === null) p.push('更新時間不合法');
  return p;
}

/** 在顯示值二維陣列裡找表頭列：第一個含全部 find 欄名的列。回 {row(0 起), cols:{欄名:欄索引}} 或 {error}。 */
function lgrFindHeader(grid, names, find) {
  for (var r = 0; r < grid.length; r++) {
    var cells = (grid[r] || []).map(lgrTrim);
    if (!find.every(function (h) { return cells.indexOf(h) >= 0; })) continue;
    var cols = {}, missing = [], dup = [];
    names.forEach(function (h) {
      var first = cells.indexOf(h);
      if (first < 0) { missing.push(h); return; }
      if (cells.indexOf(h, first + 1) >= 0) dup.push(h);
      cols[h] = first;
    });
    if (dup.length) return { error: '表頭重複：' + dup.join('、') };
    if (missing.length) return { error: '表頭列（第 ' + (r + 1) + ' 列）缺欄位：' + missing.join('、'), row: r };
    return { row: r, cols: cols };
  }
  return { error: '找不到表頭列（要有：' + find.join('、') + '）' };
}

/** 試算表一列（{欄名:顯示值}）⇒ { rec } 或 { problems }。 */
function lgrRowToRecord(d) {
  var p = [];
  var rec = { id: d['編號'], date: lgrParseDate(d['日期']), amount: lgrParseAmount(d['金額']), note: d['花在什麼'] };
  if (!/^[A-Za-z0-9\-]{6,40}$/.test(rec.id)) p.push('編號不合法');
  if (!rec.date) p.push('日期看不懂');
  if (rec.amount === null) p.push('金額看不懂');
  rec.deco = d['裝飾'] === '' ? '' : lgrKeyOf(LGR_DECO, d['裝飾']);
  if (rec.deco === null) p.push('裝飾不認得：' + d['裝飾']);
  rec.house = lgrKeyOf(LGR_HOUSE, d['狗屋']);
  if (rec.house === null) p.push('狗屋不認得：' + d['狗屋']);
  if (d['位置'] === '') rec.slot = null;
  else if (/^\d+$/.test(d['位置']) && +d['位置'] <= LGR_MAX_SLOT) rec.slot = +d['位置'];
  else p.push('位置看不懂');
  if (d['是否收起'] === LGR_YES) rec.hidden = true;
  else if (d['是否收起'] === LGR_NO || d['是否收起'] === '') rec.hidden = false;
  else p.push('是否收起要填「是」或「否」');
  rec.deletedAt = d['刪除時間'];
  if (rec.deletedAt !== '' && lgrParseTime(rec.deletedAt) === null) p.push('刪除時間看不懂');
  rec.createdAt = d['建立時間'];
  if (lgrParseTime(rec.createdAt) === null) p.push('建立時間看不懂');
  rec.updatedAt = d['更新時間'];
  if (lgrParseTime(rec.updatedAt) === null) p.push('更新時間看不懂');
  return p.length ? { problems: p } : { rec: rec };
}

/**
 * 解析帳目分頁。grid＝顯示值二維陣列（第 0 列＝試算表第 1 列）；分頁不存在傳 null。
 * 回 { ok, exists, header, rows:[{rowNumber(1 起), rec}], warnings }，或 { ok:false, error }。
 * 全空的列略過；看不懂的列 ⇒ 不收、寫進 warnings（⛔ 不靜默丟掉）；同一個編號出現兩列 ⇒ 用更新時間新的那列、另一列寫 warnings。
 */
function lgrParseLedger(grid) {
  if (lgrGridEmpty(grid)) return { ok: true, exists: false, header: null, rows: [], warnings: [] };
  var names = LGR_COLUMNS.map(function (c) { return c.name; });
  var h = lgrFindHeader(grid, names, LGR_FIND);
  if (h.error) return { ok: false, error: LGR_LEDGER + '：' + h.error };
  var rows = [], warnings = [], byId = {};
  for (var r = h.row + 1; r < grid.length; r++) {
    var line = grid[r] || [], d = {}, blank = true;
    names.forEach(function (n) { var v = lgrTrim(line[h.cols[n]]); if (v !== '') blank = false; d[n] = v; });
    if (blank) continue;
    var got = lgrRowToRecord(d);
    if (got.problems) { warnings.push(LGR_LEDGER + ' 第 ' + (r + 1) + ' 列：' + got.problems.join('；')); continue; }
    var item = { rowNumber: r + 1, rec: got.rec };
    var prev = byId[got.rec.id];
    if (prev) {
      var newer = lgrParseTime(got.rec.updatedAt) > lgrParseTime(prev.rec.updatedAt);
      warnings.push(LGR_LEDGER + '：編號 ' + got.rec.id + ' 重複（第 ' + prev.rowNumber + '、' + (r + 1) + ' 列），用第 ' + (newer ? r + 1 : prev.rowNumber) + ' 列');
      if (newer) { rows[rows.indexOf(prev)] = item; byId[got.rec.id] = item; }
      continue;
    }
    byId[got.rec.id] = item;
    rows.push(item);
  }
  return { ok: true, exists: true, header: h, rows: rows, warnings: warnings };
}

/**
 * 文字格要寫進去的值。= + - @ 開頭的前面加單引號：試算表把單引號當「這是文字」的記號、顯示值不含它。
 * 🔴 為什麼：真站台實測（2026-11-19）先設純文字格式（'@'）再 setValue('=1+1')，照樣被算成公式、顯示 2。
 */
function lgrSheetText(v) {
  var s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** 一筆 ⇒ 要寫的格子 [{name, kind:'text'|'date'|'number', value}]（kind 告訴膠水層要設什麼格式；text 的值已過 lgrSheetText）。 */
function lgrRecordToCells(rec) {
  return [
    { name: '編號', kind: 'text', value: rec.id },
    { name: '日期', kind: 'date', value: lgrYmdToSerial(rec.date) },
    { name: '金額', kind: 'number', value: rec.amount },
    { name: '花在什麼', kind: 'text', value: lgrSheetText(rec.note) },
    { name: '裝飾', kind: 'text', value: rec.deco === '' ? '' : LGR_DECO[rec.deco] },
    { name: '狗屋', kind: 'text', value: LGR_HOUSE[rec.house] },
    { name: '位置', kind: 'number', value: rec.slot === null ? '' : rec.slot },
    { name: '是否收起', kind: 'text', value: rec.hidden ? LGR_YES : LGR_NO },
    { name: '刪除時間', kind: 'text', value: rec.deletedAt },
    { name: '建立時間', kind: 'text', value: rec.createdAt },
    { name: '更新時間', kind: 'text', value: rec.updatedAt },
  ];
}

/**
 * 規劃一批同步。parsed＝lgrParseLedger 的結果；incoming＝線上 JSON 陣列。
 * 回 { ok, needHeader, writes:[{kind:'append'|'update', rowNumber?, id, cells}], results:[{id, result, problems?}] }
 *   result：inserted（新的一列）｜updated（覆蓋）｜same（一樣新，不動）｜stale（試算表比較新，不動）｜invalid（不合法，不動）
 * 同一批裡同一個編號出現多次 ⇒ 只用更新時間最新的那一筆（其他回 stale）。
 * ⛔ 不刪列。append 的列號由膠水層決定（寫在最後一列之後）。
 */
function lgrPlanSync(parsed, incoming) {
  if (!parsed || !parsed.ok) return { ok: false, error: 'sheet_error', message: parsed ? parsed.error : '沒有帳目資料' };
  if (!Array.isArray(incoming)) return { ok: false, error: 'bad_request', message: 'records 要是陣列' };
  if (incoming.length > LGR_MAX_BATCH) return { ok: false, error: 'too_many', message: '一次最多 ' + LGR_MAX_BATCH + ' 筆' };
  var existing = {};
  parsed.rows.forEach(function (x) { existing[x.rec.id] = x; });
  var results = [], best = {}, order = [];
  incoming.forEach(function (r, i) {
    var problems = lgrValidateRecord(r);
    if (problems.length) { results[i] = { id: r && typeof r.id === 'string' ? r.id : '', result: 'invalid', problems: problems }; return; }
    var b = best[r.id];
    if (b === undefined) { best[r.id] = i; order.push(r.id); return; }
    if (lgrParseTime(r.updatedAt) > lgrParseTime(incoming[b].updatedAt)) { results[b] = { id: r.id, result: 'stale' }; best[r.id] = i; }
    else results[i] = { id: r.id, result: 'stale' };
  });
  var writes = [];
  order.forEach(function (id) {
    var i = best[id], r = incoming[i], ex = existing[id];
    if (!ex) { writes.push({ kind: 'append', id: id, cells: lgrRecordToCells(r) }); results[i] = { id: id, result: 'inserted' }; return; }
    var a = lgrParseTime(r.updatedAt), b = lgrParseTime(ex.rec.updatedAt);
    if (a > b) { writes.push({ kind: 'update', rowNumber: ex.rowNumber, id: id, cells: lgrRecordToCells(r) }); results[i] = { id: id, result: 'updated' }; }
    else results[i] = { id: id, result: a === b ? 'same' : 'stale' };
  });
  return { ok: true, needHeader: !parsed.exists, writes: writes, results: results };
}

/** 解析設定分頁。回 { ok, exists, header, items:{key:{value, updatedAt, rowNumber}}, warnings } 或 { ok:false, error }。 */
function lgrParseSettings(grid) {
  if (lgrGridEmpty(grid)) return { ok: true, exists: false, header: null, items: {}, warnings: [] };
  var h = lgrFindHeader(grid, LGR_SETTING_HEADERS, ['項目', '值']);
  if (h.error) return { ok: false, error: LGR_SETTINGS + '：' + h.error };
  var items = {}, warnings = [];
  for (var r = h.row + 1; r < grid.length; r++) {
    var line = grid[r] || [];
    var name = lgrTrim(line[h.cols['項目']]);
    if (name === '') continue;
    var item = null;
    LGR_SETTING_ITEMS.forEach(function (it) { if (it.name === name) item = it; });
    if (!item) { warnings.push(LGR_SETTINGS + ' 第 ' + (r + 1) + ' 列：不認得的項目「' + name + '」（略過）'); continue; }
    if (items[item.key]) { warnings.push(LGR_SETTINGS + '：「' + name + '」重複，用第 ' + items[item.key].rowNumber + ' 列'); continue; }
    var raw = lgrTrim(line[h.cols['值']]);
    var value = raw === '' ? null : lgrParseAmount(raw);
    if (raw !== '' && value === null) warnings.push(LGR_SETTINGS + ' 第 ' + (r + 1) + ' 列：每月預算看不懂（當成沒填）');
    var up = lgrTrim(line[h.cols['更新時間']]);
    items[item.key] = { value: value, updatedAt: lgrParseTime(up) === null ? '' : up, rowNumber: r + 1 };
  }
  return { ok: true, exists: true, header: h, items: items, warnings: warnings };
}

/**
 * 規劃寫設定。req＝{ budget: 正整數或 null（null＝清掉）, updatedAt }。
 * 回 { ok, needHeader, write:{kind:'append'|'update', rowNumber?, cells}|null, result:'updated'|'inserted'|'same'|'stale' } 或 { ok:false, … }。
 * 試算表那格沒有合法的更新時間（人手改過）⇒ 當成比較舊、照寫。
 */
function lgrPlanSettings(parsed, req) {
  if (!parsed || !parsed.ok) return { ok: false, error: 'sheet_error', message: parsed ? parsed.error : '沒有設定資料' };
  if (!req || typeof req !== 'object') return { ok: false, error: 'bad_request', message: '缺設定內容' };
  var b = req.budget;
  if (b !== null && (typeof b !== 'number' || Math.floor(b) !== b || b < 1 || b > LGR_MAX_AMOUNT)) return { ok: false, error: 'invalid', message: '每月預算要是 1～' + LGR_MAX_AMOUNT + ' 的整數，或 null' };
  if (lgrParseTime(req.updatedAt) === null) return { ok: false, error: 'invalid', message: '更新時間不合法' };
  var cells = [
    { name: '項目', kind: 'text', value: '每月預算' },
    { name: '值', kind: 'number', value: b === null ? '' : b },
    { name: '更新時間', kind: 'text', value: req.updatedAt },
  ];
  var ex = parsed.items.budget;
  if (!ex) return { ok: true, needHeader: !parsed.exists, write: { kind: 'append', cells: cells }, result: 'inserted' };
  var a = lgrParseTime(req.updatedAt), e = ex.updatedAt === '' ? -Infinity : lgrParseTime(ex.updatedAt);
  if (a > e) return { ok: true, needHeader: false, write: { kind: 'update', rowNumber: ex.rowNumber, cells: cells }, result: 'updated' };
  return { ok: true, needHeader: false, write: null, result: a === e ? 'same' : 'stale' };
}

/** 讀取的回應。 */
function lgrBuildRead(ledger, settings) {
  if (!ledger.ok) return { ok: false, error: 'sheet_error', message: ledger.error };
  if (!settings.ok) return { ok: false, error: 'sheet_error', message: settings.error };
  var b = settings.items.budget;
  return {
    ok: true,
    records: ledger.rows.map(function (x) { return x.rec; }),
    settings: { budget: b ? b.value : null, budgetUpdatedAt: b ? b.updatedAt : '' },
    warnings: ledger.warnings.concat(settings.warnings),
  };
}

/** 比對密碼。試算表沒設密碼 ⇒ 一律拒絕（⛔ 不當成「不用密碼」）。 */
function lgrCheckToken(given, expected) {
  if (!expected) return { ok: false, error: 'no_token_set', message: '這份 Apps Script 還沒設定密碼（專案設定 → 指令碼屬性 → TOKEN）' };
  var g = typeof given === 'string' ? given : '';
  var diff = g.length ^ expected.length;
  for (var i = 0; i < Math.max(g.length, expected.length); i++) diff |= (g.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return diff === 0 ? { ok: true } : { ok: false, error: 'bad_token', message: '密碼不對' };
}


// ═══════════════════ shared/ledger.js ═══════════════════
/*
 * ledger.js —— 記帳網頁的判斷邏輯（純函式、⛔ 不碰畫面、⛔ 不碰 localStorage、⛔ 不碰網路）。
 *
 * 跟 contract.js 一樣的拼檔規矩：頂層只用 var／function、名字一律 ldg 前綴、Node 專用段包 @node-only。
 * 網頁載入的是 tools/build-web.js 拼出的 web/lib/core.js（contract.js ＋ 本檔、剝掉 @node-only），
 * 所以本檔可以直接叫 contract.js 的 lgr* 函式（瀏覽器裡是全域；Node 裡由檔尾的 @node-only 段 require 進來）。
 *
 * 資料形狀＝段 B 的線上格式（contract.js 開頭註解）：
 *   { id, date:'YYYY-MM-DD', amount, note, deco:sprout|toy|balloon|cloud|'', house:anniu|haru,
 *     slot:整數|null, hidden:bool, deletedAt:''|時間, createdAt:時間, updatedAt:時間 }
 *
 * 時間一律用「手機當地時間」：ctx＝{ nowMs, offsetMin, rand }，offsetMin＝-new Date().getTimezoneOffset()。
 * ⛔ 不用 UTC 算日期 —— 台灣 11/30 晚上 8 點以後的 UTC 已經是 12/1（月份界線會錯一整晚）。
 *
 * 院子的規則（照原型，art/原型README.md〈已拍板的方向〉）：
 *   - 只顯示**本月**、沒刪除、沒收起、有裝飾的帳；每間狗屋每一區（地上／天空／高空）各有固定幾個位置
 *   - 每筆記住自己的位置（slot），收起一個不會讓其他的跳位
 *   - 兩筆搶同一格（例如兩台手機各自記了一筆）⇒ 建立時間早的拿到；晚的換一格空的
 *   - 地上的新裝飾從空位裡**隨機**挑（依編號固定）；天空、高空照順序排
 *   - 位置滿了還記帳 ⇒ 帳照記、那筆直接收起（hidden=true），⛔ 不擠掉別人
 */

var LDG_ZONE = { sprout: 'ground', toy: 'ground', balloon: 'sky', cloud: 'high' };
/** 每區的位置數（＝原型 SLOTS 各區的長度；改這裡要一起改 web/index.html 的 SLOTS）。 */
var LDG_SLOTS = { ground: 12, sky: 6, high: 6 };

/** 原型的字串雜湊（31 進位）。 */
function ldgHash(s) {
  var h = 0, str = String(s);
  for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
/** 打散過的雜湊：編號是連續時間，直接用 ldgHash 取餘數會偏向同一個。 */
function ldgMixHash(s) {
  var h = ldgHash(s) ^ 0x9E3779B9;
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  return (h ^ (h >>> 16)) >>> 0;
}

/* ───────── 日期與月份 ───────── */

/** 毫秒＋當地時差 ⇒ 當地日期 'YYYY-MM-DD'。 */
function ldgLocalYmd(ms, offsetMin) {
  return lgrFormatTime(ms, offsetMin).slice(0, 10);
}
/** 'YYYY-MM-DD' ⇒ 'YYYY-MM'。 */
function ldgMonthOf(ymd) { return String(ymd).slice(0, 7); }
/** 'YYYY-MM' 加減幾個月。 */
function ldgShiftMonth(month, delta) {
  var y = +month.slice(0, 4), m = +month.slice(5, 7) - 1 + delta;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return y + '-' + lgrPad(m + 1);
}
/** ctx ⇒ 今天（當地）。 */
function ldgToday(ctx) { return ldgLocalYmd(ctx.nowMs, ctx.offsetMin); }

/* ───────── 清單 ───────── */

function ldgLive(r) { return r.deletedAt === ''; }
function ldgTimeOf(t) { var v = lgrParseTime(t); return v === null ? 0 : v; }
/** 建立先後：建立時間，同一秒再比編號。 */
function ldgByCreated(a, b) {
  var d = ldgTimeOf(a.createdAt) - ldgTimeOf(b.createdAt);
  return d !== 0 ? d : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 某個月（'YYYY-MM'）的帳：沒刪除的、新的在上（日期新→建立時間新→在陣列裡比較後面）。
 * 為什麼最後比陣列位置、不比編號：同一秒記好幾筆時建立時間一樣，編號尾巴是亂數 ⇒ 會亂跳（段 C 截圖抓到）。
 */
function ldgMonthRecords(records, month) {
  return records.map(function (r, i) { return { r: r, i: i }; })
    .filter(function (x) { return ldgLive(x.r) && ldgMonthOf(x.r.date) === month; })
    .sort(function (a, b) {
      if (a.r.date !== b.r.date) return a.r.date < b.r.date ? 1 : -1;
      return (ldgTimeOf(b.r.createdAt) - ldgTimeOf(a.r.createdAt)) || (b.i - a.i);
    })
    .map(function (x) { return x.r; });
}
/** 某個月的合計與筆數。 */
function ldgMonthSummary(records, month) {
  var list = ldgMonthRecords(records, month), total = 0;
  list.forEach(function (r) { total += r.amount; });
  return { count: list.length, total: total };
}
/** 垃圾桶：刪除過的、最近刪的在上。 */
function ldgTrash(records) {
  return records.filter(function (r) { return !ldgLive(r); })
    .sort(function (a, b) { return ldgTimeOf(b.deletedAt) - ldgTimeOf(a.deletedAt) || ldgByCreated(b, a); });
}

/* ───────── 院子的位置 ───────── */

function ldgOnYard(r, month) { return ldgLive(r) && !r.hidden && r.deco !== '' && !!LDG_ZONE[r.deco] && ldgMonthOf(r.date) === month; }
function ldgGroup(r) { return r.house + ':' + LDG_ZONE[r.deco]; }
function ldgValidSlot(r) { var n = LDG_SLOTS[LDG_ZONE[r.deco]]; return typeof r.slot === 'number' && Math.floor(r.slot) === r.slot && r.slot >= 0 && r.slot < n; }
/** 從空位裡挑一格：地上依編號隨機、其他照順序。沒空位回 null。 */
function ldgPick(r, taken) {
  var zone = LDG_ZONE[r.deco], free = [];
  for (var i = 0; i < LDG_SLOTS[zone]; i++) if (!taken[i]) free.push(i);
  if (!free.length) return null;
  return zone === 'ground' ? free[ldgMixHash(r.id + ':spot') % free.length] : free[0];
}

/**
 * 算院子要掛哪些、各在哪一格。⛔ 不改 records。
 * 回 { placed:[{id, zone, slot, rec}], crowded:[id] }（crowded＝該掛但沒位置，正常操作不會發生，兩台手機同時記滿才會）。
 */
function ldgPlanYard(records, month) {
  var cand = records.filter(function (r) { return ldgOnYard(r, month); }).sort(ldgByCreated);
  var taken = {}, slotOf = {}, placed = [], crowded = [];
  cand.forEach(function (r) {   // 第一輪：有記住位置的先坐好（先建立的先坐）
    var g = taken[ldgGroup(r)] || (taken[ldgGroup(r)] = {});
    if (ldgValidSlot(r) && !g[r.slot]) { g[r.slot] = true; slotOf[r.id] = r.slot; }
  });
  cand.forEach(function (r) {   // 第二輪：沒位置或位置被搶走的，挑空位
    if (slotOf[r.id] !== undefined) return;
    var g = taken[ldgGroup(r)], s = ldgPick(r, g);
    if (s === null) { crowded.push(r.id); return; }
    g[s] = true; slotOf[r.id] = s;
  });
  cand.forEach(function (r) { if (slotOf[r.id] !== undefined) placed.push({ id: r.id, zone: LDG_ZONE[r.deco], slot: slotOf[r.id], rec: r }); });
  return { placed: placed, crowded: crowded };
}

/** 幫 r 在 month 的院子找一格（不算 r 自己原本的位置）。回 slot 或 null。 */
function ldgFreeSlot(records, r, month) {
  var others = records.filter(function (x) { return x.id !== r.id; });
  var taken = {};
  ldgPlanYard(others, month).placed.forEach(function (p) {
    if (p.rec.house === r.house && p.zone === LDG_ZONE[r.deco]) taken[p.slot] = true;
  });
  if (ldgValidSlot(r) && !taken[r.slot]) return r.slot;   // 原本的位置還空著就坐回去
  return ldgPick(r, taken);
}

/** 依目前狀態決定這筆的 slot／hidden：本月、要掛 ⇒ 找位置（滿了就收起）；不是本月或不掛 ⇒ 不佔位置。回 {slot, hidden, full}。 */
function ldgSeat(records, r, today) {
  var month = ldgMonthOf(today);
  if (!ldgLive(r) || r.hidden || r.deco === '' || ldgMonthOf(r.date) !== month) return { slot: r.hidden || r.deco === '' ? null : r.slot, hidden: r.hidden, full: false };
  var s = ldgFreeSlot(records, r, month);
  return s === null ? { slot: null, hidden: true, full: true } : { slot: s, hidden: false, full: false };
}

/* ───────── 輸入檢查 ───────── */

/**
 * 表單 ⇒ 乾淨的值。input＝{ amount:字串, note, date, deco, house }。
 * 回 { ok:true, value:{amount, note, date, deco, house} } 或 { ok:false, field, message }。
 */
function ldgCheckInput(input, today) {
  var amount = lgrParseAmount(input.amount);
  if (amount === null) return { ok: false, field: 'amount', message: '金額要填 1～' + LGR_MAX_AMOUNT.toLocaleString('en-US') + ' 的整數，例如 120。' };
  var note = lgrTrim(input.note).replace(/[\r\n]+/g, ' ');
  if (note.length > LGR_MAX_NOTE) return { ok: false, field: 'note', message: '花在什麼最多 ' + LGR_MAX_NOTE + ' 個字。' };
  var date = lgrParseDate(input.date);
  if (!date) return { ok: false, field: 'date', message: '日期看不懂，要像 2026-11-19。' };
  if (date > today) return { ok: false, field: 'date', message: '日期不能是未來（今天是 ' + today + '）。' };
  if (input.deco !== undefined && !LGR_DECO[input.deco]) return { ok: false, field: 'deco', message: '請選一個裝飾。' };
  if (input.house !== undefined && !LGR_HOUSE[input.house]) return { ok: false, field: 'house', message: '請選一間狗屋。' };
  return { ok: true, value: { amount: amount, note: note, date: date, deco: input.deco, house: input.house } };
}

/* ───────── 改動（全部回新陣列、⛔ 不改傳進來的 records） ───────── */

function ldgStamp(prev, ctx) {
  return lgrFormatTime(lgrNextUpdatedMs(prev ? lgrParseTime(prev) : null, ctx.nowMs), ctx.offsetMin);
}
function ldgReplace(records, rec) { return records.map(function (x) { return x.id === rec.id ? rec : x; }); }
function ldgCopy(r) { var o = {}; for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) o[k] = r[k]; return o; }
function ldgFind(records, id) { for (var i = 0; i < records.length; i++) if (records[i].id === id) return records[i]; return null; }

/**
 * 記一筆。value＝ldgCheckInput 的 value。回 { records, rec, hung, full }。
 *   hung＝有掛在本月院子；full＝本月、該掛但位置滿了（帳照記、那筆收起）。
 */
function ldgAdd(records, value, ctx) {
  var now = lgrFormatTime(ctx.nowMs, ctx.offsetMin), id;
  do { id = lgrMakeId(ctx.nowMs, ctx.offsetMin, ctx.rand); } while (ldgFind(records, id));
  var rec = { id: id, date: value.date, amount: value.amount, note: value.note, deco: value.deco, house: value.house,
    slot: null, hidden: false, deletedAt: '', createdAt: now, updatedAt: now };
  var seat = ldgSeat(records, rec, ldgToday(ctx));
  rec.slot = seat.slot; rec.hidden = seat.hidden;
  var hung = !rec.hidden && rec.slot !== null;
  return { records: records.concat([rec]), rec: rec, hung: hung, full: seat.full };
}

/**
 * 改金額／用途／日期。changes＝{ amount, note, date }（ldgCheckInput 的 value 裡這三個）。
 * 日期換月份：搬進本月 ⇒ 重新找位置（滿了就收起）；搬出本月 ⇒ 放掉位置。回 { ok, records, rec, full } 或 { ok:false, message }。
 */
function ldgEdit(records, id, changes, ctx) {
  var old = ldgFind(records, id);
  if (!old) return { ok: false, message: '找不到這筆帳。' };
  if (!ldgLive(old)) return { ok: false, message: '這筆在垃圾桶裡，先還原才能改。' };
  var rec = ldgCopy(old);
  rec.amount = changes.amount; rec.note = changes.note; rec.date = changes.date;
  var full = false;
  if (ldgMonthOf(rec.date) !== ldgMonthOf(old.date)) {
    rec.slot = null;
    var seat = ldgSeat(records, rec, ldgToday(ctx));
    rec.slot = seat.slot; rec.hidden = seat.hidden; full = seat.full;
  }
  if (rec.amount === old.amount && rec.note === old.note && rec.date === old.date) return { ok: true, records: records, rec: old, full: false, same: true };
  rec.updatedAt = ldgStamp(old.updatedAt, ctx);
  return { ok: true, records: ldgReplace(records, rec), rec: rec, full: full };
}

/** 刪除＝丟進垃圾桶（填刪除時間、⛔ 不真的拿掉）。 */
function ldgRemove(records, id, ctx) {
  var old = ldgFind(records, id);
  if (!old) return { ok: false, message: '找不到這筆帳。' };
  if (!ldgLive(old)) return { ok: true, records: records, rec: old, same: true };
  var rec = ldgCopy(old);
  rec.deletedAt = lgrFormatTime(ctx.nowMs, ctx.offsetMin);
  rec.updatedAt = ldgStamp(old.updatedAt, ctx);
  return { ok: true, records: ldgReplace(records, rec), rec: rec };
}

/** 從垃圾桶還原。本月、有掛的 ⇒ 原位置還空著就坐回去，被佔了換一格，滿了就收起（full）。 */
function ldgRestore(records, id, ctx) {
  var old = ldgFind(records, id);
  if (!old) return { ok: false, message: '找不到這筆帳。' };
  if (ldgLive(old)) return { ok: true, records: records, rec: old, same: true, full: false };
  var rec = ldgCopy(old);
  rec.deletedAt = '';
  var seat = ldgSeat(records, rec, ldgToday(ctx));
  rec.slot = seat.slot; rec.hidden = seat.hidden;
  rec.updatedAt = ldgStamp(old.updatedAt, ctx);
  return { ok: true, records: ldgReplace(records, rec), rec: rec, full: seat.full };
}

/**
 * 收起／掛回去。收起 ⇒ 放掉位置。掛回去 ⇒ 要有空位，滿了回 { ok:false, reason:'full' }（⛔ 不改資料）；
 * 不是本月的帳也能掛回去（hidden=false），只是本月院子不會出現。
 */
function ldgSetHidden(records, id, hidden, ctx) {
  var old = ldgFind(records, id);
  if (!old) return { ok: false, reason: 'missing', message: '找不到這筆帳。' };
  if (!ldgLive(old)) return { ok: false, reason: 'deleted', message: '這筆在垃圾桶裡。' };
  if (old.deco === '') return { ok: false, reason: 'no_deco', message: '這筆沒有裝飾。' };
  if (!!old.hidden === !!hidden) return { ok: true, records: records, rec: old, same: true };
  var rec = ldgCopy(old);
  if (hidden) { rec.hidden = true; rec.slot = null; }
  else {
    rec.hidden = false;
    var month = ldgMonthOf(ldgToday(ctx));
    if (ldgMonthOf(rec.date) === month) {
      var s = ldgFreeSlot(records, rec, month);
      if (s === null) return { ok: false, reason: 'full', message: '這間狗屋這一區的位置滿了，先收起一個再掛。' };
      rec.slot = s;
    }
  }
  rec.updatedAt = ldgStamp(old.updatedAt, ctx);
  return { ok: true, records: ldgReplace(records, rec), rec: rec };
}

/* ───────── 預算（功能 5、6） ───────── */

/**
 * 預算連動的表情（使用者拍板）：本月花到預算 80% ⇒ 擔心；超過 100% ⇒ 垂頭喪氣。沒設預算 ⇒ 平常。
 * 剛好 80% 算擔心、剛好 100% 還是擔心（「超過」才垂頭喪氣）。用整數比、⛔ 不用小數（0.8 會有誤差）。
 */
function ldgMood(total, budget) {
  if (typeof budget !== 'number' || !(budget > 0)) return 'normal';
  if (total > budget) return 'sad';
  if (total * 5 >= budget * 4) return 'worried';
  return 'normal';
}
/** 預算條要畫的東西。沒預算回 null（只顯示總計）。fill＝條的長度 0～1（超過也只畫滿）。 */
function ldgBudgetBar(total, budget) {
  if (typeof budget !== 'number' || !(budget > 0)) return null;
  return { budget: budget, total: total, fill: Math.min(1, total / budget), percent: Math.floor(total * 100 / budget),
    left: Math.max(0, budget - total), over: Math.max(0, total - budget), mood: ldgMood(total, budget) };
}
/** 改每月預算。input＝輸入框的字串（空白＝清掉）。回 { ok, settings } 或 { ok:false, message }；沒變回 same。 */
function ldgSetBudget(settings, input, ctx) {
  var raw = lgrTrim(input), budget = null;
  if (raw !== '') {
    budget = lgrParseAmount(raw);
    if (budget === null) return { ok: false, message: '每月預算要填 1～' + LGR_MAX_AMOUNT.toLocaleString('en-US') + ' 的整數；不設就留空白。' };
  }
  if (budget === settings.budget) return { ok: true, settings: settings, same: true };
  return { ok: true, settings: { budget: budget, budgetUpdatedAt: ldgStamp(settings.budgetUpdatedAt || null, ctx) } };
}

/* ───────── 試算表同步（功能 7、8；段 E） ─────────
 * 網路那一段（fetch、逾時、重送）在 web/store.js；這裡只做「拿到回應之後怎麼算」，全部回新值、⛔ 不改傳進來的東西。
 *
 * 規則（格式定案時的規則＋段 E 施工者的決定，見 待決事項.md〈段 E 實作的決定〉）：
 *   - 送出：pending 裡的帳一批最多 LGR_MAX_BATCH 筆。回 inserted／updated／same／stale ⇒ 送到了、拿掉；
 *     invalid ⇒ 留著、讓畫面說明（⛔ 不靜默丟掉）；送出途中又改過（更新時間跟送出時不同）⇒ 留著下次再送。
 *   - 讀回：同一個編號以更新時間新的為準。試算表比較新 ⇒ 用試算表的；一樣新 ⇒ 也用試算表的
 *     （人在試算表手改格子不會動更新時間，部署說明承諾手機下次讀取看得到）；手機比較新 ⇒ 留手機的、排進待送。
 *   - 手機有、試算表沒有 ⇒ 留著、排進待送（⛔ 不因為「試算表沒有」就刪手機的帳：換了一份試算表、或有人刪了列，都補回去）。
 */

/** 這一批要送的帳（pending 的順序、最多 max 筆）。 */
function ldgSyncBatch(records, pending, max) {
  var byId = {}, out = [];
  records.forEach(function (r) { byId[r.id] = r; });
  for (var i = 0; i < pending.length && out.length < (max || LGR_MAX_BATCH); i++) if (byId[pending[i]]) out.push(byId[pending[i]]);
  return out;
}

/**
 * 套用 POST {op:'sync'} 的回應。records＝現在的帳（可能在送出途中又改過）；sent＝送出去的那批（送出當下的樣子）。
 * 回 { ok, pending, done, invalid:[{id, problems}], unknown } 或 { ok:false, pending（原樣）, message }。
 */
function ldgApplySyncResults(records, pending, sent, reply) {
  if (!reply || reply.ok !== true || !Array.isArray(reply.results)) return { ok: false, pending: pending.slice(), message: ldgDescribeReply(reply) };
  var now = {}, drop = {}, invalid = [], done = 0, unknown = 0;
  records.forEach(function (r) { now[r.id] = r; });
  sent.forEach(function (r, i) {
    var x = reply.results[i];
    if (!x || x.id !== r.id) { unknown++; return; }
    if (x.result === 'invalid') { invalid.push({ id: r.id, problems: Array.isArray(x.problems) ? x.problems : [] }); return; }
    if (x.result !== 'inserted' && x.result !== 'updated' && x.result !== 'same' && x.result !== 'stale') { unknown++; return; }
    done++;
    if (!now[r.id] || now[r.id].updatedAt === r.updatedAt) drop[r.id] = true;   // 途中又改過 ⇒ 留著
  });
  return { ok: true, pending: pending.filter(function (id) { return !drop[id]; }), done: done, invalid: invalid, unknown: unknown };
}

/**
 * 合併 GET 讀回來的帳。回 { records, pending, changed, added, updated, requeued, problems }。
 * ⛔ 不改傳進來的陣列；手機原本的順序不動，新的接在後面。
 */
function ldgMergeRemote(records, pending, remote) {
  var out = records.slice(), idx = {}, inPending = {}, seen = {}, problems = [], added = 0, updated = 0, requeued = 0;
  var nextPending = pending.slice();
  out.forEach(function (r, i) { idx[r.id] = i; });
  pending.forEach(function (id) { inPending[id] = true; });
  function queue(id) { if (!inPending[id]) { inPending[id] = true; nextPending.push(id); requeued++; } }
  function unqueue(id) { if (inPending[id]) { inPending[id] = false; nextPending = nextPending.filter(function (x) { return x !== id; }); } }
  (Array.isArray(remote) ? remote : []).forEach(function (r, n) {
    var p = lgrValidateRecord(r);
    if (p.length) { problems.push('試算表第 ' + (n + 1) + ' 筆：' + p.join('；')); return; }
    if (seen[r.id]) { problems.push('試算表的編號 ' + r.id + ' 重複（用第一筆）'); return; }
    seen[r.id] = true;
    var i = idx[r.id];
    if (i === undefined) { idx[r.id] = out.length; out.push(r); added++; return; }
    var mine = out[i], a = ldgTimeOf(r.updatedAt), b = ldgTimeOf(mine.updatedAt);
    if (a >= b) {
      unqueue(r.id);
      if (JSON.stringify(mine) !== JSON.stringify(r)) { out[i] = r; updated++; }
    } else queue(r.id);
  });
  out.forEach(function (r) { if (!seen[r.id]) queue(r.id); });
  return { records: out, pending: nextPending, changed: added + updated > 0, added: added, updated: updated, requeued: requeued, problems: problems };
}

/**
 * 合併讀回來的每月預算。remote＝{ budget, budgetUpdatedAt }（試算表沒有那一列 ⇒ budget null、時間 ''）。
 * 規則同帳目；時間是 '' 的一方當成最舊。回 { settings, settingsPending, changed }。
 */
function ldgMergeRemoteSettings(settings, settingsPending, remote) {
  var keep = { settings: settings, settingsPending: settingsPending, changed: false };
  if (!remote || typeof remote !== 'object') return keep;
  var b = remote.budget, okBudget = b === null || (typeof b === 'number' && Math.floor(b) === b && b >= 1 && b <= LGR_MAX_AMOUNT);
  var up = typeof remote.budgetUpdatedAt === 'string' ? remote.budgetUpdatedAt : '';
  if (!okBudget || (up !== '' && lgrParseTime(up) === null)) return keep;
  var noRow = b === null && up === '';
  var a = up === '' ? -Infinity : lgrParseTime(up), mine = settings.budgetUpdatedAt === '' ? -Infinity : lgrParseTime(settings.budgetUpdatedAt);
  if (noRow) return { settings: settings, settingsPending: settingsPending || settings.budgetUpdatedAt !== '', changed: false };
  if (a >= mine) {
    var same = settings.budget === b && settings.budgetUpdatedAt === up;
    return { settings: same ? settings : { budget: b, budgetUpdatedAt: up }, settingsPending: false, changed: !same };
  }
  return { settings: settings, settingsPending: true, changed: false };
}

/** 套用 POST {op:'settings'} 的回應。sentUpdatedAt＝送出時的更新時間；途中又改過 ⇒ 還是待送。回 { ok, settingsPending } 或 { ok:false, message }。 */
function ldgApplySettingsResult(settings, sentUpdatedAt, reply) {
  if (!reply || reply.ok !== true) return { ok: false, settingsPending: true, message: ldgDescribeReply(reply) };
  if (['inserted', 'updated', 'same', 'stale'].indexOf(reply.result) < 0) return { ok: false, settingsPending: true, message: '試算表回了看不懂的結果' };
  return { ok: true, settingsPending: settings.budgetUpdatedAt !== sentUpdatedAt };
}

/** Apps Script 的失敗回應 ⇒ 給人看的一句話（⛔ 不含網址、密碼）。 */
function ldgDescribeReply(reply) {
  if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') return '回應看不懂：網址可能不是記帳的 Apps Script（或部署的是舊版）';
  if (reply.ok) return '';
  if (reply.error === 'bad_token') return '密碼不對';
  if (reply.error === 'no_token_set') return '這份 Apps Script 還沒設密碼（專案設定 → 指令碼屬性 → TOKEN）';
  if (reply.error === 'sheet_error') return '試算表格式有問題：' + lgrTrim(reply.message);
  if (reply.error === 'bad_op') return 'Apps Script 是舊版、不認得這個動作（要更新部署）';
  return 'Apps Script 回錯誤：' + lgrTrim(reply.message || reply.error);
}

/**
 * 設定頁填的網址＋密碼 ⇒ { ok, url, token } 或 { ok:false, field, message }。
 * 網址要是 Apps Script 的網頁應用程式網址（script.google.com、/macros/…/s/…/exec；公司帳號會多一段 /a/macros/網域）。
 */
function ldgCheckEndpoint(url, token) {
  var u = lgrTrim(url), t = lgrTrim(token);
  if (u === '') return { ok: false, field: 'url', message: '請貼上 Apps Script 的部署網址。' };
  if (!/^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.\-]+|macros)\/s\/[A-Za-z0-9_\-]{20,}\/exec$/.test(u)) {
    if (/\/dev$/.test(u)) return { ok: false, field: 'url', message: '這是測試用的 /dev 網址，請改貼「網頁應用程式」那個 /exec 結尾的網址。' };
    return { ok: false, field: 'url', message: '網址看起來不是 Apps Script 的部署網址：要是 https://script.google.com 開頭、/exec 結尾。' };
  }
  if (t === '') return { ok: false, field: 'token', message: '請填密碼（Apps Script 指令碼屬性 TOKEN 的值）。' };
  return { ok: true, url: u, token: t };
}

var LDG_SYNC_RETRY_MS = 60000;      // 上次失敗、還有沒送的 ⇒ 1 分鐘後再試
/* 都送完了 ⇒ 每 1 分鐘讀一次（另一台手機改的才看得到；只在網頁開在前面時跑，切走就停）。
   原本 5 分鐘：使用者 2026-11-20 手機試用回報「另一台看不到」，5 分鐘太久 ⇒ 改 1 分鐘。 */
var LDG_SYNC_REFRESH_MS = 60000;

/**
 * 現在該不該自動同步。st＝{ configured, running, readOnly, pendingCount, lastAttemptMs(0＝這次開網頁還沒試過), lastFailed }。
 * （開網頁、記帳、恢復連線、切回網頁另外直接觸發，不經過這裡。）
 */
function ldgSyncDue(st, nowMs) {
  if (!st.configured || st.running || st.readOnly) return false;
  if (!st.lastAttemptMs) return true;
  var gap = nowMs - st.lastAttemptMs;
  if (st.pendingCount > 0 && gap >= (st.lastFailed ? LDG_SYNC_RETRY_MS : 0)) return true;
  return gap >= LDG_SYNC_REFRESH_MS;
}

/**
 * 同步狀態 ⇒ 給人看的一行。st＝{ configured, running, pendingCount, settingsPending, lastOkAt(時間字串或 ''), error, invalidCount }。
 * 回 { level: 'off'|'busy'|'ok'|'wait'|'bad', text }。
 */
function ldgSyncSummary(st) {
  var when = st.lastOkAt ? '（上次同步 ' + st.lastOkAt.slice(5, 16).replace('-', '/') + '）' : '（還沒同步成功過）';
  var waiting = st.pendingCount + (st.settingsPending ? 1 : 0);
  var left = st.pendingCount ? st.pendingCount + ' 筆帳' + (st.settingsPending ? '和預算' : '') : st.settingsPending ? '預算' : '';
  if (!st.configured) return { level: 'off', text: '還沒接試算表：帳只存在這台手機。' };
  if (st.running) return { level: 'busy', text: '同步中…' + (left ? '（' + left + '還沒送）' : '') };
  if (st.invalidCount) return { level: 'bad', text: '有 ' + st.invalidCount + ' 筆試算表不收，留在手機裡。' + when };
  if (st.error) return { level: 'bad', text: (left ? left + '還沒送・' : '') + st.error + when };
  if (waiting) return { level: 'wait', text: left + '還沒送，等一下自動補送。' + when };
  return { level: 'ok', text: '已同步' + when };
}

/* ───────── 手機上存的資料 ───────── */

var LDG_STORE_VERSION = 1;

/**
 * 讀回手機存的資料（JSON 字串或 null）。回 { records, pending, problems }。
 * 壞掉的筆數 ⇒ 不收、寫進 problems（⛔ 不靜默丟掉）；整包看不懂 ⇒ 全空＋problems，並設 broken:true（呼叫端要保留原字串，⛔ 不可覆蓋）。
 * 版本號比自己新 ⇒ broken（新版程式存的，舊版看不懂就別碰）。
 */
function ldgParseStored(text) {
  var out = { records: [], pending: [], settings: { budget: null, budgetUpdatedAt: '' }, settingsPending: false, problems: [], broken: false };
  if (text === null || text === undefined || text === '') return out;
  var data;
  try { data = JSON.parse(text); } catch (e) { out.problems.push('手機裡的帳目資料看不懂（不是 JSON）'); out.broken = true; return out; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.records)) { out.problems.push('手機裡的帳目資料格式不對'); out.broken = true; return out; }
  if (data.v !== LDG_STORE_VERSION) {
    out.problems.push('手機裡的帳目資料是第 ' + data.v + ' 版，這個網頁只看得懂第 ' + LDG_STORE_VERSION + ' 版');
    out.broken = true; return out;
  }
  var seen = {};
  data.records.forEach(function (r, i) {
    var p = lgrValidateRecord(r);
    if (p.length) { out.problems.push('第 ' + (i + 1) + ' 筆：' + p.join('；')); return; }
    if (seen[r.id]) { out.problems.push('第 ' + (i + 1) + ' 筆：編號 ' + r.id + ' 重複（略過）'); return; }
    seen[r.id] = true;
    out.records.push(r);
  });
  (Array.isArray(data.pending) ? data.pending : []).forEach(function (id) { if (seen[id] && out.pending.indexOf(id) < 0) out.pending.push(id); });
  // 設定（段 D 起；舊資料沒有這欄 ⇒ 用預設值，⛔ 不算壞掉）
  var s = data.settings;
  if (s !== undefined) {
    var b = s && s.budget, okBudget = b === null || (typeof b === 'number' && Math.floor(b) === b && b >= 1 && b <= LGR_MAX_AMOUNT);
    var up = s && s.budgetUpdatedAt, okUp = up === '' || lgrParseTime(up) !== null;
    if (s && typeof s === 'object' && okBudget && okUp) { out.settings = { budget: b, budgetUpdatedAt: up }; out.settingsPending = data.settingsPending === true; }
    else out.problems.push('手機裡存的每月預算看不懂（當成沒設）');
  }
  return out;
}
/** 要存進手機的 JSON 字串。 */
function ldgSerialize(records, pending, settings, settingsPending) {
  var o = { v: LDG_STORE_VERSION, records: records, pending: pending };
  if (settings) { o.settings = settings; o.settingsPending = !!settingsPending; }
  return JSON.stringify(o);
}


