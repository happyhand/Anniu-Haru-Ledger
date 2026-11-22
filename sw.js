/*
 * 安妞哈嚕記帳 ♡ —— service worker（離線開得起來；段 F）。
 * 由 tools/build-sw.js 從 tools/sw-template.js 產生：預存清單與版本號是掃 web/ 的實際檔案算的，⛔ 不要直接改 web/sw.js。
 *
 * 🔴 隱私線：只接「同來源、在本網頁範圍內、GET、網址不帶 token」的請求，其他一律不碰（不 respondWith）。
 *    試算表讀取是 GET …/exec?token=密碼 —— 網址裡就是密碼；一旦存進快取，密碼就落地在另一個地方，同步也會讀到舊資料。
 *    Google Fonts 也不碰（拍板：離線退回系統字型）。快取裡只會有下面 FILES 這份清單，執行時 ⛔ 不額外存任何回應。
 * 換版：新版整批預存好才換上；⛔ 不 skipWaiting —— 新版等下次打開才生效，不會在使用者記帳打字到一半時換掉頁面。
 *    換上後只刪「本網頁自己的舊快取」（名字開頭是 PREFIX）：同一個網域底下可能還有使用者的其他網頁（GitHub Pages 同帳號共用網域）。
 */
'use strict';
var PREFIX = 'anniu-haru-ledger-';
var VERSION = "01f3add8cbbb";
var CACHE = PREFIX + VERSION;
var FILES = [
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-192.png",
  "icons/icon-maskable-512.png",
  "img/anniu-mood.png",
  "img/anniu.png",
  "img/balloons-anniu.png",
  "img/balloons-haru.png",
  "img/bowls.png",
  "img/clouds.png",
  "img/dragonfly.png",
  "img/haru-mood.png",
  "img/haru.png",
  "img/houses-winter.png",
  "img/houses.png",
  "img/lamps.png",
  "img/leaves.png",
  "img/petals.png",
  "img/scene-autumn-day.jpg",
  "img/scene-autumn-night.jpg",
  "img/scene-day.jpg",
  "img/scene-night.jpg",
  "img/scene-spring-day.jpg",
  "img/scene-spring-night.jpg",
  "img/scene-summer-day.jpg",
  "img/scene-summer-night.jpg",
  "img/scene-winter-day.jpg",
  "img/scene-winter-night.jpg",
  "img/sprouts.png",
  "img/stars.png",
  "img/toys.png",
  "img/trees.png",
  "index.html",
  "lib/core.js",
  "manifest.webmanifest",
  "store.js"
];
var SCOPE = new URL('./', self.location).pathname;

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(['./'].concat(FILES)); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/** 這個請求歸不歸我管。⛔ 放寬任何一條之前先讀檔頭的隱私線。 */
function mine(req) {
  if (req.method !== 'GET') return false;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.indexOf(SCOPE) !== 0) return false;
  if (/(^|[?&])token=/i.test(url.search)) return false;
  return true;
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (!mine(req)) return;
  event.respondWith(caches.open(CACHE).then(function (cache) {
    // 打開網頁（navigate）時網址可能帶 ?season=1 之類的預覽參數，仍回同一份 index
    return cache.match(req, { ignoreSearch: req.mode === 'navigate' }).then(function (hit) {
      return hit || fetch(req);
    });
  }));
});
