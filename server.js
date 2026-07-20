/**
 * server.js — LIVE Tools Webアプリ版（ブラウザ操作・exe不要）
 *
 * 使い方: node server.js （または start.bat をダブルクリック）
 *   → ブラウザで http://localhost:21216/ が開く → プロファイル作成 → URLコピー → OBSブラウザソースへ
 *
 * URLの形（StreamToEarn風・短い・設定を変えてもURL不変）:
 *   http://localhost:21216/overlay/<id>/coin   … OBS用（表示専用）
 *   http://localhost:21216/edit/<id>/coin      … 設定編集（歯車UI）
 * 設定はサーバー側（data/profiles.json）にID単位で保存され、変更は開いているOBSソースへ
 * Socket.IO ルーム経由で即時反映される（URL貼り直し不要）。
 *
 * ポート変更: set PORT=21217 && node server.js（既定 21216。exe版 21214/21215 と同時起動可）
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { Server } = require("socket.io");

const { errorLog, errToStr, errDetail, logError, clearErrors, setNotify } = require("./lib/log");
const profiles = require("./lib/profiles");
const pavlok = require("./lib/pavlok");
// ベータ機能（ゲーム連携β/ガチャβ）は任意同梱。公開配布版にはファイルを含めないため、
// 無ければ null にして機能を無効化したまま起動する。require.resolve でファイル存在のみ判定し、
// 「ファイルはあるが読込エラー」のときは握り潰さず表面化させる（本物のバグを隠さない）。
function optionalRequire(rel) { try { require.resolve(rel); } catch (_) { return null; } return require(rel); }
const gamebeta = optionalRequire("./lib/gamebeta");
const gachabeta = optionalRequire("./lib/gachabeta");
const levelbeta = optionalRequire("./lib/levelbeta");
const analytics = require("./lib/analytics");
const { createBridge } = require("./lib/tiktok");

const PORT = process.env.PORT || 21216;
const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(__dirname, "assets");
const VERSION = (function () { try { return String(require("./package.json").version || "0.0.0"); } catch (_) { return "0.0.0"; } })();
let bootTime = null;

// ===== メディア配信（音/動画/画像） =====
const MEDIA_MIME = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg", ".gif": "image/gif", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".apng": "image/apng", ".svg": "image/svg+xml" };
function safeBase(name) { return String(name || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\.\.+/g, ".").slice(-120); }
function mediaTypeOf(ext) { const e = String(ext || "").toLowerCase(); if ([".mp4", ".webm", ".mov", ".ogv"].includes(e)) return "video"; if ([".mp3", ".wav", ".ogg", ".m4a", ".aac"].includes(e)) return "audio"; return "image"; }
// バイナリを配信。baseDir配下のファイルのみ（ディレクトリトラバーサル防止）。
function serveMediaFile(res, baseDir, name) {
  let dec = name; try { dec = decodeURIComponent(name); } catch (e) {}
  const file = path.join(baseDir, safeBase(dec));
  if (path.dirname(file) !== path.resolve(baseDir)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("not found"); return; }
    const ct = MEDIA_MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
    res.end(buf);
  });
}

// ===== 既定ブラウザでURLを開く（起動で完結させるため） =====
function openBrowser(u) {
  try {
    if (process.platform === "win32") exec('cmd /c start "" "' + u + '"');
    else if (process.platform === "darwin") exec('open "' + u + '"');
    else exec('xdg-open "' + u + '"');
  } catch (e) {}
}

// ===== ホットキー送信（目標達成→外部アプリ STE 等へキー入力を注入。tiktok-bridge.js から移植） =====
function comboToVks(combo) {
  const MOD = { ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b, cmd: 0x5b };
  const NAMED = {
    "-": 0xbd, minus: 0xbd, "=": 0xbb, plus: 0xbb, equal: 0xbb,
    space: 0x20, enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b,
    up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    numsub: 0x6d, "numpad-": 0x6d, numadd: 0x6b, nummul: 0x6a, numdiv: 0x6f, numdec: 0x6e,
    ";": 0xba, ",": 0xbc, ".": 0xbe, "/": 0xbf, "`": 0xc0, "[": 0xdb, "\\": 0xdc, "]": 0xdd, "'": 0xde
  };
  const toks = String(combo || "").toLowerCase().split("+").map((s) => s.trim()).filter((s) => s.length);
  const mods = [], keys = [];
  for (const t of toks) {
    if (MOD[t] != null) { mods.push(MOD[t]); continue; }
    if (NAMED[t] != null) { keys.push(NAMED[t]); continue; }
    if (/^num[0-9]$/.test(t)) { keys.push(0x60 + (t.charCodeAt(3) - 48)); continue; }
    if (/^[a-z]$/.test(t)) { keys.push(t.toUpperCase().charCodeAt(0)); continue; }
    if (/^[0-9]$/.test(t)) { keys.push(t.charCodeAt(0)); continue; }
    if (/^f([1-9]|1[0-2])$/.test(t)) { keys.push(0x6f + parseInt(t.slice(1), 10)); continue; }
  }
  return { mods, keys };
}
const ALL_MODS = [0x12, 0x11, 0x10, 0x5b, 0x5c, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5];
let hkBusy = false;
function sendHotkey(combo, times) {
  if (process.platform !== "win32") return;
  if (hkBusy) return;   // 多重注入を防止（Alt等の押しっぱなし対策）
  const { mods, keys } = comboToVks(combo);
  if (!keys.length) return;
  times = Math.max(1, Math.min(50, parseInt(times, 10) || 1));
  const down = mods.concat(keys);
  const up = keys.slice().reverse().concat(mods.slice().reverse());
  const ps =
    'Add-Type -Name K -Namespace W -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);\'\n' +
    "function D($v){[W.K]::keybd_event([byte]$v,0,0,[UIntPtr]::Zero)}\n" +
    "function U($v){[W.K]::keybd_event([byte]$v,0,2,[UIntPtr]::Zero)}\n" +
    "try{\n" +
    "for($i=0;$i -lt " + times + ";$i++){\n" +
    down.map((v) => "D(" + v + ")").join(";") + "\n" +
    "Start-Sleep -Milliseconds 30\n" +
    up.map((v) => "U(" + v + ")").join(";") + "\n" +
    "Start-Sleep -Milliseconds 110\n}\n" +
    "}finally{\n" +
    ALL_MODS.map((v) => "U(" + v + ")").join(";") + "\n" +   // ★失敗しても修飾キーを必ず解放
    "}";
  try {
    hkBusy = true;
    const guard = setTimeout(() => { hkBusy = false; }, times * 250 + 4000);
    const b64 = Buffer.from(ps, "utf16le").toString("base64");
    exec('powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + b64, () => { clearTimeout(guard); hkBusy = false; });
    console.log("⌨️  ホットキー送信: " + combo + " ×" + times);
  } catch (e) { hkBusy = false; }
}

// ===== HTML配信（no-cache＝OBS/ブラウザに古いページをキャッシュさせない） =====
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0" };
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" };
// 編集モードで差し込む「← メニュー」戻りボタン＋メーター内の接続UI非表示（接続は管理画面で行う）
const BACK_BUTTON =
  '<a href="/" id="__back" title="メニューに戻る">← メニュー</a>' +
  '<style>#__back{position:fixed;top:12px;left:12px;z-index:99999;background:#16222a;border:1px solid #1ab5ba;' +
  'color:#1ab5ba;padding:8px 12px;border-radius:10px;font:600 13px system-ui,sans-serif;text-decoration:none;' +
  'box-shadow:0 4px 14px rgba(0,0,0,.4)}#__back:hover{background:#1ab5ba;color:#06343a}' +
  'body:not(.edit) #__back{display:none}' +
  '#connBtn{display:none!important}</style>';

function json(res, code, obj) { res.writeHead(code, JSON_HEADERS); res.end(JSON.stringify(obj)); }
function notFound(res, msg) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end(msg || "not found"); }

// リクエストボディ（JSON）を読む。上限1MB。
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(new Error("JSONの形式が不正です")); }
    });
    req.on("error", reject);
  });
}

// ===== オーバーレイ/編集ページ配信（ブート注入＝IDと保存済み設定を埋め込む） =====
function serveOverlayPage(res, id, type, edit) {
  const t = profiles.TYPES[type];
  if (!t || !profiles.ID_RE.test(id)) { notFound(res, "ページが見つかりません"); return; }
  if (!profiles.hasProfile(id)) { notFound(res, "このオーバーレイID（" + id + "）は存在しません。管理画面（http://localhost:" + PORT + "/）で作成してください。"); return; }
  let html;
  try { html = fs.readFileSync(path.join(PUBLIC_DIR, t.page), "utf8"); }
  catch (e) { logError("server", "error", "ページの読込に失敗: " + t.page, e); res.writeHead(500, HTML_HEADERS); res.end("ページの読込に失敗しました: " + t.page); return; }
  const boot = {
    id, type,
    mode: t.mode, rankMode: t.rankMode, sync: t.sync,
    edit: !!edit, title: t.title, version: VERSION,
    settings: profiles.getSettings(id, t.sync)
  };
  // JSON内の "</script>" でHTMLが壊れないよう < をエスケープ
  const bootJs = "<script>window.__LT_BOOT=" + JSON.stringify(boot).replace(/</g, "\\u003c") + ";</script>";
  html = html.replace("</head>", bootJs + "\n</head>");
  html = html.replace(/<title>[^<]*<\/title>/, "<title>" + t.title + (edit ? "（編集）" : "") + "</title>");
  html = html.replace(/const APP_VERSION='[^']*'/, "const APP_VERSION='" + VERSION + "'");
  if (edit) html = html.replace("</body>", BACK_BUTTON + "</body>");
  res.writeHead(200, HTML_HEADERS);
  res.end(html);
}

// ===== 静的ページ配信（admin.html 等。APP_VERSION を注入） =====
function servePublicHtml(res, fileName) {
  try {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, fileName), "utf8");
    html = html.replace(/const APP_VERSION='[^']*'/, "const APP_VERSION='" + VERSION + "'");
    res.writeHead(200, HTML_HEADERS);
    res.end(html);
  } catch (e) {
    logError("server", "error", "ページの読込に失敗: " + fileName, e);
    res.writeHead(500, HTML_HEADERS);
    res.end("ページが見つかりません: " + fileName);
  }
}

// ===== /overlay/:id ランディング（そのプロファイルの全URL一覧。人間用） =====
function landingPage(id) {
  const p = profiles.summary(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const rows = Object.keys(profiles.TYPES).map((type) => {
    const t = profiles.TYPES[type];
    return '<div class="row"><div class="nm">' + esc(t.title) + '</div>' +
      '<code>/overlay/' + esc(id) + '/' + esc(type) + '</code>' +
      '<button class="sm" data-copy="/overlay/' + esc(id) + '/' + esc(type) + '">📋 URLコピー</button>' +
      '<a class="sm ghost" href="/edit/' + esc(id) + '/' + esc(type) + '">⚙ 編集</a></div>';
  }).join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name)} - LIVE Tools</title>
<style>
  body{font-family:system-ui,"Segoe UI",sans-serif;background:#0f171c;color:#e7eef0;margin:0;padding:24px;display:flex;justify-content:center}
  .card{background:#16222a;border:2px solid #1ab5ba;border-radius:16px;padding:18px 20px;width:min(640px,94vw)}
  h1{font-size:18px;margin:0 0 4px;color:#1ab5ba}
  .sub{font-size:12px;color:#8aa0a8;margin-bottom:14px}
  .row{display:flex;align-items:center;gap:10px;background:#0f171c;border:1px solid #2a3a42;border-radius:11px;padding:9px 12px;margin-bottom:8px;flex-wrap:wrap}
  .nm{font-weight:800;font-size:13.5px;color:#bfe9ea;flex:0 0 130px}
  code{flex:1;min-width:0;font-size:11.5px;color:#9fd8ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  button,.sm{background:#1ab5ba;color:#06343a;font-weight:800;border:0;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;text-decoration:none}
  .ghost{background:#1b2a31;color:#bfe9ea;border:1px solid #2a3a42}
  a.back{display:inline-block;margin-top:12px;color:#8aa0a8;font-size:12px;text-decoration:none}
</style></head><body>
<div class="card">
  <h1>📺 ${esc(p.name)}</h1>
  <div class="sub">OBSのブラウザソースに「URLコピー」のURLを貼り付けてください（推奨 1920×1080）。設定は「⚙ 編集」から。<b>設定を変えてもURLはそのまま</b>で自動反映されます。</div>
  ${rows}
  <a class="back" href="/">← メニューに戻る</a>
</div>
<script>
  document.addEventListener('click',function(e){
    var b=e.target.closest('button[data-copy]'); if(!b) return;
    var u=location.origin+b.getAttribute('data-copy');
    (navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).catch(function(){
      var t=document.createElement('textarea'); t.value=u; document.body.appendChild(t); t.select();
      try{document.execCommand('copy');}catch(_){ } document.body.removeChild(t);
    });
    var o=b.textContent; b.textContent='✓ コピーしました'; setTimeout(function(){b.textContent=o;},1300);
  });
</script>
</body></html>`;
}

// ===== デバッグページ（tiktok-bridge.js から移植） =====
function debugInfo() {
  let clients = 0;
  try { clients = io.engine.clientsCount; } catch (_) {}
  return {
    port: PORT, user: bridge.currentUser, live: bridge.live, stopped: bridge.stopped, errors: errorLog.length,
    clients, node: process.version, platform: process.platform, pid: process.pid,
    started: bootTime, now: Date.now(), version: VERSION, dataDir: profiles.DATA_DIR
  };
}
function debugPage() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>デバッグ / エラーログ</title>
<style>
  body{font-family:system-ui,"Segoe UI",sans-serif;background:#0f171c;color:#e7eef0;margin:0;padding:16px}
  h1{font-size:18px;margin:0 0 4px;color:#ff6b6b}
  .sub{font-size:12px;color:#8aa0a8;margin-bottom:12px}
  .bar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
  button{background:#1f2a31;color:#e7eef0;border:1px solid #2a3a42;border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer}
  button:hover{border-color:#5fd0d3}
  button.danger{color:#ff9aab;border-color:rgba(216,85,106,.5)}
  .env{font-size:12px;color:#9fb1b8;background:#16222a;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-family:monospace;white-space:pre-wrap}
  .empty{color:#6dd36d;padding:24px;text-align:center;font-weight:700}
  .err{background:#16222a;border-left:3px solid #ff6b6b;border-radius:6px;padding:8px 10px;margin-bottom:8px}
  .err.warn{border-left-color:#fbbf24}
  .err .meta{font-size:11px;color:#8aa0a8;margin-bottom:3px}
  .err .msg{font-size:13px;font-weight:700;white-space:pre-wrap;word-break:break-word}
  .err .det{font-size:11px;color:#9fb1b8;white-space:pre-wrap;word-break:break-word;margin-top:4px;font-family:monospace;max-height:160px;overflow:auto}
  .src{display:inline-block;font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;background:#2a3a42;margin-right:5px}
  .src.overlay{background:#143447;color:#9fd8ff}.src.bridge{background:#3a2a14;color:#ffd9a0}.src.server{background:#232a3a;color:#b9c4ff}
</style></head><body>
<h1>🐞 デバッグ / エラーログ</h1>
<div class="sub">不具合が起きるとここに記録されます。配信に出るOBSのURLには表示されません。</div>
<div class="env" id="env">読み込み中...</div>
<div class="bar">
  <button onclick="load()">🔄 更新</button>
  <button onclick="copyAll()">📋 全部コピー</button>
  <button class="danger" onclick="clr()">🗑 クリア</button>
  <label style="font-size:12px;color:#8aa0a8"><input type="checkbox" id="auto" checked> 自動更新</label>
</div>
<div id="list"></div>
<script>
  function p2(n){return(n<10?'0':'')+n}
  function fmt(t){var d=new Date(t);return p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds())}
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  var DATA=[];
  function render(j){
    DATA=(j&&j.errors)||[]; var e=(j&&j.info)||{};
    document.getElementById('env').textContent='ポート: '+e.port+'   ユーザー: @'+(e.user||'-')+'   受信中: '+(e.live?'はい':'いいえ')+'   接続中のソース数: '+(e.clients!=null?e.clients:'?')+'\\nバージョン: '+e.version+'   データ保存先: '+e.dataDir+'\\nNode: '+e.node+'   OS: '+e.platform+'   PID: '+e.pid+'   エラー件数: '+(e.errors||0);
    var L=document.getElementById('list');
    if(!DATA.length){L.innerHTML='<div class="empty">✓ エラーはありません</div>';return}
    L.innerHTML=DATA.slice().reverse().map(function(x){
      return '<div class="err '+(x.level==='warn'?'warn':'')+'"><div class="meta"><span class="src '+(x.source||'')+'">'+(x.source||'?')+'</span>'+fmt(x.t)+' ・ '+(x.level||'error')+(x.n>1?' ・ ×'+x.n+'回':'')+'</div><div class="msg">'+esc(x.message)+'</div>'+(x.detail?'<div class="det">'+esc(x.detail)+'</div>':'')+'</div>';
    }).join('');
  }
  function load(){fetch('/debug.json').then(function(r){return r.json()}).then(render).catch(function(){})}
  function copyAll(){var t=DATA.map(function(x){return fmt(x.t)+' ['+x.source+'/'+x.level+'] '+x.message+(x.detail?'\\n  '+x.detail:'')}).join('\\n');try{navigator.clipboard.writeText(t)}catch(_){}}
  function clr(){fetch('/debug/clear',{method:'POST'}).then(load).catch(function(){})}
  load(); setInterval(function(){if(document.getElementById('auto').checked)load()},2000);
</script>
</body></html>`;
}

// ===== Pavlok（ビリビリ）連携 =====
// ループバック（同じPC）からのアクセスか（既定では発動・設定ともにローカル限定）
function isLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
function pavlokPage() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pavlok（ビリビリ）連携 — LIVE Tools Web</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%2310262a'/><text x='50' y='68' font-size='52' text-anchor='middle'>⚡</text></svg>">
<style>
  body{font-family:system-ui,"Segoe UI",sans-serif;background:#0f171c;color:#e7eef0;margin:0;padding:24px;display:flex;justify-content:center}
  .card{background:#16222a;border:2px solid #fbbf24;border-radius:16px;padding:18px 20px;width:min(640px,94vw)}
  .hdr{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .hdr h1{flex:1;margin:0}
  h1{font-size:18px;margin:0 0 4px;color:#fbbf24}
  a.back{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:800;color:#cdeeee;background:#13343a;border:1px solid #1ab5ba;border-radius:9px;padding:7px 12px;text-decoration:none;white-space:nowrap;transition:.15s}
  a.back:hover{background:#1ab5ba;color:#06343a}
  .hbtn{background:#1b2a31;color:#ffe9a8;border:1px solid #fbbf2466;border-radius:9px;padding:7px 12px;font-size:12px;font-weight:800;cursor:pointer;white-space:nowrap}
  .hbtn:hover{border-color:#fbbf24}
  .helpbox{display:none;background:#0f171c;border:1px solid #fbbf2444;border-radius:10px;padding:12px 14px;font-size:12.5px;color:#cdd9dd;line-height:1.8;margin-bottom:12px}
  .helpbox.open{display:block}
  .helpbox b{color:#ffe9a8}
  h2{font-size:14px;margin:18px 0 6px;color:#bfe9ea;border-bottom:1px solid #2a3a42;padding-bottom:4px}
  .sub{font-size:12px;color:#8aa0a8;margin-bottom:10px;line-height:1.6}
  .st{font-size:12.5px;background:#0f171c;border:1px solid #2a3a42;border-radius:10px;padding:10px 12px;line-height:1.8;font-family:monospace;white-space:pre-wrap;word-break:break-all}
  .st b.ok{color:#6dd36d}.st b.ng{color:#ff6b6b}
  label{display:block;font-size:12px;color:#9fb1b8;margin:8px 0 3px}
  input[type=text],input[type=number],select{background:#0f171c;border:1px solid #2a3a42;color:#e7eef0;border-radius:8px;padding:8px 10px;font-size:13px;width:100%;box-sizing:border-box}
  input[type=range]{width:100%}
  .row{display:flex;gap:8px;align-items:center}
  button{background:#fbbf24;color:#3a2a00;font-weight:800;border:0;border-radius:9px;padding:9px 14px;font-size:13px;cursor:pointer}
  button.ghost{background:#1b2a31;color:#bfe9ea;border:1px solid #2a3a42;font-weight:700}
  button:disabled{opacity:.5;cursor:default}
  code{background:#0f171c;border:1px solid #2a3a42;border-radius:6px;padding:2px 6px;font-size:11.5px;color:#9fd8ff}
  .urlrow{display:flex;gap:8px;align-items:center;background:#0f171c;border:1px solid #2a3a42;border-radius:10px;padding:8px 10px;margin:6px 0}
  .urlrow code{flex:1;border:0;background:transparent;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .prow{display:flex;gap:6px;align-items:center;background:#0f171c;border:1px solid #2a3a42;border-radius:10px;padding:7px 9px;margin:6px 0;flex-wrap:wrap}
  .prow input.pn{flex:0 0 96px;width:96px}
  .prow select.pt{flex:0 0 90px;width:90px}
  .prow input.pv{flex:0 0 62px;width:62px}
  .prow select.pc{flex:0 0 58px;width:58px}
  .prow code.pu{flex:1;min-width:140px;border:0;background:transparent;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .prow button{padding:7px 10px;font-size:12px}
  .warn{font-size:11.5px;color:#fbbf24;background:#3a2f1233;border:1px solid #fbbf2444;border-radius:8px;padding:8px 10px;margin-top:10px;line-height:1.6}
  .res{font-size:12px;margin-top:8px;min-height:18px}
  .res.ok{color:#6dd36d}.res.ng{color:#ff6b6b}
  .vv{font-weight:800;color:#fbbf24;font-size:15px;min-width:34px;text-align:right}
</style></head><body>
<div class="card">
  <div class="hdr">
    <h1>⚡ Pavlok（ビリビリ）連携</h1>
    <button class="hbtn" id="howto">❓ 使い方</button>
    <a class="back" href="/">← メニューへ戻る</a>
  </div>
  <div class="sub">LIVE Tools が起動していれば、URLを叩くだけで Pavlok アプリへ信号を送れます（このPCの中からのみ受け付け）。</div>
  <div class="helpbox" id="help">
    <b>発動URLの形式</b><br>
    ・<code>/pavlok/強さ_回数</code> ＝ ザップ（例 <code>/pavlok/30_1</code>）<br>
    ・ビープは <code>/pavlok/beep/強さ_回数</code>、バイブは <code>/pavlok/vibe/強さ_回数</code><br>
    ・GET/POSTどちらでもOK ＝ STE・TikFinity のURL欄に貼るだけで動きます<br><br>
    <b>パターン</b><br>
    ・よく使う組み合わせを最大12件登録でき、「📋 URL」でそのパターンの発動URLだけをコピーできます<br>
    ・名前・種類・強さ・回数を変えたら「💾 パターンを保存」を押してください<br><br>
    <b>まとめ投げ</b><br>
    ・一気にリクエストが来ても、順番待ちに積んで全部発動します（送信間隔1.5秒）<br>
    ・順番待ちできるのは「まとめ投げの上限」の件数まで。超えた分は捨てられます（50件なら約75秒で消化）<br><br>
    <b>安全上限</b><br>
    ・強さ100・回数5・送信間隔1.5秒を超える設定はできません
  </div>

  <h2>状態</h2>
  <div class="st" id="st">読み込み中...</div>

  <h2>テスト送信</h2>
  <div class="row" style="margin-bottom:6px">
    <select id="ty" style="flex:0 0 130px">
      <option value="vibe">バイブ</option>
      <option value="beep">ビープ</option>
      <option value="zap">⚡ ザップ</option>
    </select>
    <input type="range" id="v" min="1" max="100" value="30" oninput="document.getElementById('vv').textContent=this.value">
    <span class="vv" id="vv">30</span>
    <select id="c" style="flex:0 0 74px">
      <option value="1">×1</option><option value="2">×2</option><option value="3">×3</option><option value="4">×4</option><option value="5">×5</option>
    </select>
    <button id="go">送信</button>
  </div>
  <div class="res" id="res"></div>

  <h2>パターン（URLをコピーして STE / TikFinity に設定）</h2>
  <div class="sub">「📋 URL」でそのパターンの発動URLをコピー。変更したら<b>「💾 パターンを保存」</b>。</div>
  <div id="plist"></div>
  <div class="row" style="margin-top:8px">
    <button class="ghost" id="padd">＋ パターンを追加</button>
    <button id="psave">💾 パターンを保存</button>
    <span class="res" id="res3" style="margin-top:0"></span>
  </div>

  <h2>設定</h2>
  <label>Pavlok APIトークン（Bearer は不要・トークン本体のみ）</label>
  <input type="text" id="tk" placeholder="eyJhbGciOi..." autocomplete="off">
  <div class="row" style="margin-top:8px">
    <div style="flex:1"><label style="margin-top:0">強さの上限（1〜100）</label><input type="number" id="mv" min="1" max="100"></div>
    <div style="flex:1"><label style="margin-top:0">回数の上限（1〜5）</label><input type="number" id="mc" min="1" max="5"></div>
    <div style="flex:1"><label style="margin-top:0">送信間隔（ms・1000以上）</label><input type="number" id="iv" min="1000" max="10000" step="100"></div>
    <div style="flex:1"><label style="margin-top:0">まとめ投げの上限（1〜200件）</label><input type="number" id="mb" min="1" max="200"></div>
  </div>
  <div class="row" style="margin-top:10px"><button id="save">💾 設定を保存</button><span class="res" id="res2" style="margin-top:0"></span></div>

  <div class="warn">⚠ トークンが漏れると他人にビリビリされます。このページのURLを配信画面に映さないでください。</div>
</div>
<script>
'use strict';
function $(id){return document.getElementById(id)}
function fmtT(t){var d=new Date(t);function p(n){return(n<10?'0':'')+n}return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())}
var TYJ={zap:'ザップ',beep:'ビープ',vibe:'バイブ'};
var loadedCfg=false;
function render(s){
  var exp=s.tokenExp?new Date(s.tokenExp):null;
  var lines=[];
  lines.push('トークン: '+(s.configured?(s.tokenExpired?'<b class="ng">期限切れ</b>':'<b class="ok">設定済み</b>')+(exp?'（期限 '+exp.getFullYear()+'/'+(exp.getMonth()+1)+'/'+exp.getDate()+'）':''):'<b class="ng">未設定</b>'));
  lines.push('上限: 強さ'+s.maxValue+' / 回数'+s.maxCount+' / 間隔'+s.intervalMs+'ms / まとめ投げ'+s.maxBacklog+'件');
  lines.push('待機中の送信: '+s.queue+'件');
  if(s.last) lines.push('最後の送信: '+fmtT(s.last.t)+' '+(TYJ[s.last.type]||s.last.type)+' 強さ'+s.last.value+' → '+(s.last.ok?'<b class="ok">成功</b>':'<b class="ng">失敗</b>'+(s.last.msg?'（'+s.last.msg+'）':'')));
  $('st').innerHTML=lines.join('\\n');
  if(!loadedCfg){ loadedCfg=true; $('mv').value=s.maxValue; $('mc').value=s.maxCount; $('iv').value=s.intervalMs; $('mb').value=s.maxBacklog; P=(s.presets||[]).slice(); drawPresets(); }
}
/* ===== パターン（プリセット） ===== */
var P=[];
var MAXP=12;
function escA(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function purl(p){return location.origin+'/pavlok/'+(p.type==='zap'?'':p.type+'/')+p.value+'_'+p.count}
function drawPresets(){
  var box=$('plist');
  if(!P.length){ box.innerHTML='<div class="sub" style="margin:6px 0">パターンがありません。「＋ パターンを追加」で作成してください。</div>'; return; }
  box.innerHTML=P.map(function(p,i){
    var tyOpts=['zap','beep','vibe'].map(function(t){return '<option value="'+t+'"'+(p.type===t?' selected':'')+'>'+(t==='zap'?'⚡ ザップ':TYJ[t])+'</option>'}).join('');
    var cOpts=[1,2,3,4,5].map(function(c){return '<option value="'+c+'"'+(p.count===c?' selected':'')+'>×'+c+'</option>'}).join('');
    return '<div class="prow" data-i="'+i+'">'
      +'<input type="text" class="pn" value="'+escA(p.name)+'" placeholder="名前" maxlength="30">'
      +'<select class="pt">'+tyOpts+'</select>'
      +'<input type="number" class="pv" min="1" max="100" value="'+p.value+'">'
      +'<select class="pc">'+cOpts+'</select>'
      +'<code class="pu">'+escA(purl(p))+'</code>'
      +'<button class="pcopy">📋 URL</button>'
      +'<button class="ghost pdel" title="削除">✕</button>'
      +'</div>';
  }).join('');
}
$('plist').addEventListener('input',function(e){
  var row=e.target.closest('.prow'); if(!row) return;
  var i=+row.getAttribute('data-i'), p=P[i]; if(!p) return;
  if(e.target.classList.contains('pn')) p.name=e.target.value;
  if(e.target.classList.contains('pt')) p.type=e.target.value;
  if(e.target.classList.contains('pv')) p.value=Math.max(1,Math.min(100,parseInt(e.target.value,10)||1));
  if(e.target.classList.contains('pc')) p.count=parseInt(e.target.value,10)||1;
  row.querySelector('.pu').textContent=purl(p);
});
$('plist').addEventListener('click',function(e){
  var row=e.target.closest('.prow'); if(!row) return;
  var i=+row.getAttribute('data-i');
  if(e.target.classList.contains('pdel')){ P.splice(i,1); drawPresets(); return; }
  if(e.target.classList.contains('pcopy')){
    var t=purl(P[i]);
    (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).catch(function(){
      var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();
      try{document.execCommand('copy')}catch(_){}document.body.removeChild(ta);
    });
    var b=e.target,o=b.textContent;b.textContent='✓ コピー';setTimeout(function(){b.textContent=o},1200);
  }
});
$('padd').onclick=function(){
  if(P.length>=MAXP){ var r=$('res3'); r.className='res ng'; r.textContent='✗ パターンは最大'+MAXP+'件です'; return; }
  P.push({name:'',type:'zap',value:30,count:1}); drawPresets();
};
$('psave').onclick=function(){
  var r=$('res3');
  fetch('/pavlok/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({presets:P})})
    .then(function(x){return x.json()}).then(function(j){
      r.className='res '+(j.ok?'ok':'ng'); r.textContent=j.ok?'✓ 保存しました':('✗ '+(j.error||'保存に失敗しました'));
    }).catch(function(){r.className='res ng';r.textContent='✗ 保存できませんでした'});
};
function load(){fetch('/pavlok/status').then(function(r){return r.json()}).then(render).catch(function(){})}
$('go').onclick=function(){
  var ty=$('ty').value,v=$('v').value,c=$('c').value;
  var r=$('res'); r.className='res'; r.textContent='送信中...';
  fetch('/pavlok/'+ty+'/'+v+'_'+c).then(function(x){return x.json()}).then(function(j){
    r.className='res '+(j.ok?'ok':'ng');
    r.textContent=j.ok?('✓ 送信しました（'+(TYJ[j.type]||j.type)+' 強さ'+j.value+' ×'+j.count+'）結果は上の「最後の送信」で確認できます'):('✗ '+(j.error||'失敗しました'));
    setTimeout(load,2500);
  }).catch(function(){r.className='res ng';r.textContent='✗ 送信できませんでした'});
};
$('save').onclick=function(){
  var b={maxValue:+$('mv').value,maxCount:+$('mc').value,intervalMs:+$('iv').value,maxBacklog:+$('mb').value};
  var tk=$('tk').value.trim(); if(tk) b.token=tk;
  var r=$('res2');
  fetch('/pavlok/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})
    .then(function(x){return x.json()}).then(function(j){
      r.className='res '+(j.ok?'ok':'ng'); r.textContent=j.ok?'✓ 保存しました':('✗ '+(j.error||'保存に失敗しました'));
      $('tk').value=''; loadedCfg=false; load();
    }).catch(function(){r.className='res ng';r.textContent='✗ 保存できませんでした'});
};
$('howto').onclick=function(){ $('help').classList.toggle('open'); };
load(); setInterval(load,3000);
</script>
</body></html>`;
}
function routePavlok(req, res, seg, method) {
  // 既定はループバック限定（data/pavlok.json の allowLan:true で同一LANも許可）
  if (!pavlok.loadConfig().allowLan && !isLoopback(req)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden: このPCの中からのみアクセスできます");
    return;
  }
  // 設定・テストページ
  if (seg.length === 1 && method === "GET") { res.writeHead(200, HTML_HEADERS); res.end(pavlokPage()); return; }
  // 状態
  if (seg[1] === "status" && method === "GET") { json(res, 200, pavlok.status()); return; }
  // 設定保存
  if (seg[1] === "config" && method === "POST") {
    readJsonBody(req).then((b) => {
      const ok = pavlok.saveConfig(b);
      json(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: "保存に失敗しました" });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // 発動: /pavlok/<強さ>_<回数>（zap） / /pavlok/<zap|beep|vibe>/<強さ>_<回数>
  // GET（TikFinity・ブラウザ）と POST（STE等）の両方を受け付ける
  let type = "zap", spec = null;
  if (seg.length === 2) spec = seg[1];
  else if (seg.length === 3 && pavlok.TYPES.includes(seg[1])) { type = seg[1]; spec = seg[2]; }
  if (spec != null && (method === "GET" || method === "POST")) {
    const m = /^(\d{1,3})(?:[_x](\d{1,2}))?$/.exec(spec);
    if (!m) { json(res, 400, { ok: false, error: "URLの形式は /pavlok/強さ_回数 です（例 /pavlok/30_1）" }); return; }
    const r = pavlok.trigger(type, m[1], m[2] || 1);
    if (r.ok) console.log("⚡ Pavlok発動リクエスト: " + r.type + " 強さ" + r.value + " ×" + r.count);
    json(res, r.ok ? 200 : 400, r);
    return;
  }
  notFound(res);
}

// ===== ゲーム連携（プリセット式）。ページと設定APIはループバック限定 =====
function routeGameBeta(req, res, seg, method) {
  if (!gamebeta.loadConfig().allowLan && !isLoopback(req)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden: このPCの中からのみアクセスできます");
    return;
  }
  if (seg.length === 1 && method === "GET") { servePublicHtml(res, "gamebeta.html"); return; }
  if (seg[1] === "status" && method === "GET") { json(res, 200, gamebeta.status()); return; }
  // ギフト一覧オーバーレイ（OBSブラウザソース用。アクティブプロファイルのギフトトリガーを表示）
  if (seg[1] === "overlay" && method === "GET") { servePublicHtml(res, "gamebeta-overlay.html"); return; }
  if (seg[1] === "overlaydata" && method === "GET") { json(res, 200, gamebeta.overlayData(bridge.giftCatalog || [])); return; }
  // オーバーレイ上のドラッグ＆ドロップ並び替え（レコードid配列を受け取り、その順に並べ替える）
  if (seg[1] === "reorder" && method === "POST") {
    readJsonBody(req).then((b) => {
      const ok = gamebeta.reorderRecords(b && b.ids);
      json(res, ok ? 200 : 400, ok ? { ok: true } : { ok: false, error: "並び替えに失敗しました" });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // ギフト一覧（TikTokの一覧＋手動登録ギフトをまとめて返す）
  if (seg[1] === "gifts" && method === "GET") {
    const custom = gamebeta.loadConfig().customGifts.map((g) => ({ id: g.id, name: g.name, diamond: null, custom: true }));
    const ids = new Set(custom.map((g) => Number(g.id)));
    const cat = (bridge.giftCatalog || []).filter((g) => !ids.has(Number(g.id)));
    json(res, 200, { gifts: cat.concat(custom) });
    return;
  }
  if (seg[1] === "config" && method === "POST") {
    readJsonBody(req).then((b) => {
      const ok = gamebeta.saveConfig(b);
      json(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: "保存に失敗しました" });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // RCONコマンドの単発テスト
  if (seg[1] === "test" && method === "POST") {
    readJsonBody(req).then((b) => {
      const cmd = String((b && b.command) || "").trim();
      if (!cmd) { json(res, 400, { ok: false, error: "コマンドを入れてください" }); return; }
      gamebeta.testCommand(cmd, (r) => json(res, r.ok ? 200 : 400, r));
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // レコードのテスト実行（サンプル値でキューに流す）
  if (seg[1] === "testrecord" && method === "POST") {
    readJsonBody(req).then((b) => {
      const ok = gamebeta.testRecord(String((b && b.recordId) || ""));
      json(res, ok ? 200 : 400, ok ? { ok: true } : { ok: false, error: "レコードが見つからないか、アクションが空です（先に保存してください）" });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // プロファイルの部分更新（自動取得の結果保存など）
  if (seg[1] === "profilepatch" && method === "POST") {
    readJsonBody(req).then((b) => {
      const ok = gamebeta.updateProfile(String((b && b.profileId) || ""), b || {});
      json(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: "保存に失敗しました" });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // ゲームルール: 現在値の読み取り / 書き換え
  if (seg[1] === "gamerules" && method === "POST") {
    readJsonBody(req).then((b) => {
      if (b && b.action === "set") { gamebeta.setGamerule(b.name, b.value, (r) => json(res, r.ok ? 200 : 400, r)); return; }
      gamebeta.readGamerules((r) => json(res, r.ok ? 200 : 400, r));
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // server.properties のファイル選択ダイアログを開く（このPCの画面に表示される）
  if (seg[1] === "pickfolder" && method === "POST") {
    gamebeta.pickServerFile((r) => json(res, r.ok ? 200 : 400, r));
    return;
  }
  // server.properties からRCON設定を読む
  if (seg[1] === "fetchprops" && method === "POST") {
    readJsonBody(req).then((b) => {
      const r = gamebeta.fetchProps((b && b.dir) || "");
      json(res, r.ok ? 200 : 400, r);
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // server.properties へRCON有効化を書き込む（バックアップ作成・要マイクラ再起動）
  if (seg[1] === "enablercon" && method === "POST") {
    readJsonBody(req).then((b) => {
      const r = gamebeta.enableRcon((b && b.dir) || "");
      if (r.ok) console.log("🎮β server.properties にRCON設定を書き込みました: " + r.file);
      json(res, r.ok ? 200 : 400, r);
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // server.properties のRCONを無効に戻す（バックアップ作成・要マイクラ再起動）
  if (seg[1] === "disablercon" && method === "POST") {
    readJsonBody(req).then((b) => {
      const r = gamebeta.disableRcon((b && b.dir) || "");
      if (r.ok) console.log("🎮β server.properties のRCONを無効に戻しました: " + r.file);
      json(res, r.ok ? 200 : 400, r);
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // オーバーレイで鳴っている音声をすべて止める
  if (seg[1] === "soundstop" && method === "POST") {
    json(res, 200, { ok: true, screens: gamebeta.soundStop() });
    return;
  }
  // 起動時ルールを今すぐ適用（サーバー起動中に手動で流し込む）
  if (seg[1] === "applyrules" && method === "POST") {
    const n = gamebeta.applyAutoRules("manual");
    json(res, 200, { ok: true, count: n });
    return;
  }
  // 自分のマイクラユーザーへOP付与
  if (seg[1] === "op" && method === "POST") {
    gamebeta.grantOp((r) => json(res, r.ok ? 200 : 400, r));
    return;
  }
  notFound(res);
}

// ===== 🎲 ガチャβ（ゲーム連携βとは独立）。ページと設定APIはループバック限定 =====
function routeGachaBeta(req, res, seg, method) {
  if (!isLoopback(req)) { notFound(res); return; }
  if (seg.length === 1 && method === "GET") { servePublicHtml(res, "gachabeta.html"); return; }
  if (seg[1] === "status" && method === "GET") { json(res, 200, gachabeta.status()); return; }
  // 演出専用オーバーレイ（OBSブラウザソース用・全画面）
  if (seg[1] === "overlay" && method === "GET") { servePublicHtml(res, "gachabeta-overlay.html"); return; }
  // ギフト一覧（TikTokの一覧＋手動登録ギフト）
  if (seg[1] === "gifts" && method === "GET") {
    const custom = gachabeta.loadConfig().customGifts.map((g) => ({ id: g.id, name: g.name, diamond: null, custom: true }));
    const ids = new Set(custom.map((g) => Number(g.id)));
    const cat = (bridge.giftCatalog || []).filter((g) => !ids.has(Number(g.id)));
    json(res, 200, { gifts: cat.concat(custom) });
    return;
  }
  if (seg[1] === "save" && method === "POST") {
    readJsonBody(req).then((b) => {
      const ok = gachabeta.saveConfig(b);
      json(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: "保存に失敗しました" });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // ガチャのテスト（tier指定=狙い撃ち演出のみ / 無指定=試し引き）
  if (seg[1] === "testgacha" && method === "POST") {
    readJsonBody(req).then((b) => {
      const tier = (b && ["miss", "win", "premium"].includes(b.tier)) ? b.tier : null;
      const side = (b && (b.side === "obstruct" || b.side === "rescue")) ? b.side : null;
      const opts = tier ? { forceTier: tier, forceSide: side || undefined } : {};
      const ok = gachabeta.testGacha(String((b && b.gachaId) || ""), opts);
      json(res, ok ? 200 : 400, ok ? { ok: true } : { ok: false, error: "ガチャが見つかりません（先に保存してください）" });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // HR（プレミア）当選ログ
  if (seg[1] === "log" && method === "GET") { json(res, 200, { ok: true, entries: gachabeta.getLog(200) }); return; }
  if (seg[1] === "log" && method === "POST") {
    readJsonBody(req).then((b) => {
      if (b && b.action === "clear") { gachabeta.clearLog(); json(res, 200, { ok: true }); return; }
      json(res, 400, { ok: false, error: "不明な操作です" });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  notFound(res);
}

// ===== 💗 メンバーレベルβ（チームレベルのアップで演出）。ページと設定APIはループバック限定 =====
function routeLevelBeta(req, res, seg, method) {
  if (!isLoopback(req)) { notFound(res); return; }
  if (seg.length === 1 && method === "GET") { servePublicHtml(res, "levelbeta.html"); return; }
  if (seg[1] === "status" && method === "GET") { json(res, 200, levelbeta.status()); return; }
  // 演出専用オーバーレイ（OBSブラウザソース用・全画面）
  if (seg[1] === "overlay" && method === "GET") { servePublicHtml(res, "levelbeta-overlay.html"); return; }
  if (seg[1] === "save" && method === "POST") {
    readJsonBody(req).then((b) => {
      const ok = levelbeta.saveConfig(b);
      json(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: "保存に失敗しました" });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // 演出のテスト（設定した演出を1回出す）
  if (seg[1] === "test" && method === "POST") {
    const ok = levelbeta.testTrigger();
    json(res, ok ? 200 : 400, ok ? { ok: true } : { ok: false, error: "演出を出せませんでした" });
    return;
  }
  // レベルアップ・ログ（誰が・いつ・何レベルに上がったか）
  if (seg[1] === "log" && method === "GET") { json(res, 200, { ok: true, entries: levelbeta.getLog(200), broadcasts: (levelbeta.getSessions ? levelbeta.getSessions() : []) }); return; }
  if (seg[1] === "log" && method === "POST") {
    readJsonBody(req).then((b) => {
      if (b && b.action === "clear") { levelbeta.clearLog(); json(res, 200, { ok: true }); return; }
      if (b && b.action === "delete") { const removed = levelbeta.deleteLog(b.keys || []); json(res, 200, { ok: true, removed }); return; }
      json(res, 400, { ok: false, error: "不明な操作です" });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  notFound(res);
}

// ===== メディアアップロード（ブラウザから。Electron File.path 依存を廃止） =====
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;   // 50MB上限
function handleMediaUpload(req, res, rawName) {
  const orig = safeBase(rawName || "media");
  const ext = (path.extname(orig) || "").toLowerCase();
  if (!MEDIA_MIME[ext]) { json(res, 400, { ok: false, error: "対応していないファイル形式です（" + (ext || "拡張子なし") + "）" }); return; }
  const base = safeBase(orig.replace(/\.[^.]+$/, "") || "media");
  const fname = Date.now().toString(36) + "-" + base + ext;
  const dest = path.join(profiles.MEDIA_DIR, fname);
  const ws = fs.createWriteStream(dest);
  let size = 0, aborted = false;
  const fail = (code, msg) => {
    if (aborted) return; aborted = true;
    try { ws.destroy(); } catch (_) {}
    fs.unlink(dest, () => {});
    json(res, code, { ok: false, error: msg });
  };
  req.on("data", (c) => {
    size += c.length;
    if (size > MEDIA_MAX_BYTES) { fail(413, "ファイルが大きすぎます（上限50MB）"); req.destroy(); }
  });
  req.on("error", () => fail(500, "アップロードが中断されました"));
  ws.on("error", (e) => { logError("server", "warn", "メディア保存に失敗: " + errToStr(e), e); fail(500, "保存に失敗しました"); });
  ws.on("finish", () => {
    if (aborted) return;
    if (!size) { fail(400, "ファイルが空です"); return; }
    const item = { id: "m" + Date.now().toString(36), name: orig, type: mediaTypeOf(ext), url: "/media/" + fname };
    json(res, 200, { ok: true, item });
  });
  req.pipe(ws);
}

// ===== HTTPルーティング =====
const httpServer = http.createServer((req, res) => {
  try { route(req, res); }
  catch (e) { logError("server", "error", "リクエスト処理に失敗: " + errToStr(e), e); try { json(res, 500, { ok: false, error: "サーバー内部エラー" }); } catch (_) {} }
});

function route(req, res) {
  const u = new URL(req.url || "/", "http://localhost");
  const url = u.pathname;
  const seg = url.split("/").filter(Boolean);   // 例: /overlay/abc123/coin → ["overlay","abc123","coin"]
  const method = (req.method || "GET").toUpperCase();

  // ---- 画面 ----
  if (url === "/" || url === "/index.html") { servePublicHtml(res, "admin.html"); return; }
  if (url === "/help.html" || url === "/help") { servePublicHtml(res, "help.html"); return; }
  if (url === "/news.html" || url === "/news") { servePublicHtml(res, "news.html"); return; }
  if (url === "/analytics.html" || url === "/analytics") { servePublicHtml(res, "analytics.html"); return; }
  if (seg[0] === "overlay" && seg.length === 2 && method === "GET") {
    if (!profiles.ID_RE.test(seg[1]) || !profiles.hasProfile(seg[1])) { notFound(res, "このオーバーレイIDは存在しません。"); return; }
    res.writeHead(200, HTML_HEADERS); res.end(landingPage(seg[1])); return;
  }
  if (seg[0] === "overlay" && seg.length === 3 && method === "GET") { serveOverlayPage(res, seg[1], seg[2], false); return; }
  if (seg[0] === "edit" && seg.length === 3 && method === "GET") { serveOverlayPage(res, seg[1], seg[2], true); return; }

  // ---- デバッグ ----
  if (url === "/debug") { res.writeHead(200, HTML_HEADERS); res.end(debugPage()); return; }
  if (url === "/debug.json") { json(res, 200, { info: debugInfo(), errors: errorLog }); return; }
  if (url === "/debug/clear") { clearErrors(); json(res, 200, { ok: true }); return; }

  // ---- Pavlok（ビリビリ）連携 ----
  if (seg[0] === "pavlok") { routePavlok(req, res, seg, method); return; }

  // ---- ゲーム連携（プリセット式：RCON/HTTP/Pavlok/キー送信/音声） ----
  if (seg[0] === "gamebeta") { if (gamebeta) { routeGameBeta(req, res, seg, method); } else { notFound(res); } return; }
  if (seg[0] === "gachabeta") { if (gachabeta) { routeGachaBeta(req, res, seg, method); } else { notFound(res); } return; }
  if (seg[0] === "levelbeta") { if (levelbeta) { routeLevelBeta(req, res, seg, method); } else { notFound(res); } return; }
  // 旧「ゲーム連携（現行版）」のURLはβへ転送（v0.16.0で一本化。β非同梱時は404）
  if (seg[0] === "game") { if (gamebeta) { res.writeHead(302, { Location: "/gamebeta" }); res.end(); } else { notFound(res); } return; }

  // ---- メディア ----
  if (url.indexOf("/demo/") === 0) { serveMediaFile(res, ASSETS_DIR, url.slice("/demo/".length)); return; }
  if (url.indexOf("/media/") === 0 && method === "GET") { serveMediaFile(res, profiles.MEDIA_DIR, url.slice("/media/".length)); return; }

  // ---- API ----
  if (seg[0] === "api") { routeApi(req, res, u, seg, method); return; }

  if (url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("live tools webapp running\n");
}

function routeApi(req, res, u, seg, method) {
  // GET /api/version
  if (seg[1] === "version" && method === "GET") { json(res, 200, { version: VERSION }); return; }
  // GET /api/features — ベータ機能の同梱状況（admin.html がβボタンの表示可否に使う）
  if (seg[1] === "features" && method === "GET") { json(res, 200, { gamebeta: !!gamebeta, gachabeta: !!gachabeta, levelbeta: !!levelbeta }); return; }
  // GET /api/status
  if (seg[1] === "status" && method === "GET") { json(res, 200, bridge.statusObj()); return; }
  // POST /api/connect {user}
  if (seg[1] === "connect" && method === "POST") {
    readJsonBody(req).then((b) => {
      const user = String((b && b.user) || "").trim().replace(/^@+/, "");
      if (!user) { json(res, 400, { ok: false, error: "ユーザー名を入れてください" }); return; }
      bridge.switchUser(user, "API接続");
      json(res, 200, { ok: true });
    }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
    return;
  }
  // POST /api/disconnect
  if (seg[1] === "disconnect" && method === "POST") { bridge.stopConnect(); json(res, 200, { ok: true }); return; }

  // /api/profiles ...
  if (seg[1] === "profiles") {
    if (seg.length === 2 && method === "GET") { json(res, 200, { profiles: profiles.listProfiles() }); return; }
    if (seg.length === 2 && method === "POST") {
      readJsonBody(req).then((b) => {
        try { json(res, 200, { ok: true, profile: profiles.createProfile(b && b.name) }); }
        catch (e) { logError("server", "error", "プロファイル作成に失敗: " + errToStr(e), e); json(res, 500, { ok: false, error: errToStr(e) }); }
      }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
      return;
    }
    if (seg.length === 3 && profiles.ID_RE.test(seg[2])) {
      const id = seg[2];
      if (method === "GET") { const p = profiles.summary(id); if (!p) { json(res, 404, { ok: false, error: "見つかりません" }); return; } json(res, 200, { ok: true, profile: p }); return; }
      if (method === "PATCH") {
        readJsonBody(req).then((b) => {
          if (!profiles.renameProfile(id, b && b.name)) { json(res, 404, { ok: false, error: "見つかりません" }); return; }
          json(res, 200, { ok: true });
        }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
        return;
      }
      if (method === "DELETE") {
        if (!profiles.deleteProfile(id)) { json(res, 404, { ok: false, error: "見つかりません" }); return; }
        json(res, 200, { ok: true });
        return;
      }
    }
    json(res, 404, { ok: false, error: "not found" });
    return;
  }

  // GET/PUT /api/overlay/:id/:type/settings
  if (seg[1] === "overlay" && seg.length === 5 && seg[4] === "settings") {
    const id = seg[2], type = seg[3], t = profiles.TYPES[type];
    if (!t || !profiles.ID_RE.test(id) || !profiles.hasProfile(id)) { json(res, 404, { ok: false, error: "見つかりません" }); return; }
    if (method === "GET") { json(res, 200, { ok: true, mode: t.sync, data: profiles.getSettings(id, t.sync) }); return; }
    if (method === "PUT") {
      readJsonBody(req).then((b) => {
        const data = (b && typeof b === "object" && b.data && typeof b.data === "object") ? b.data : b;
        if (!data || typeof data !== "object" || Array.isArray(data)) { json(res, 400, { ok: false, error: "設定データが不正です" }); return; }
        profiles.putSettings(id, t.sync, data);
        // 開いているOBSソースへ即時反映（HTTP経由の保存はソケット送信元が無いためルーム全員へ）
        try { io.to("ov:" + id + ":" + t.sync).emit("settings", { mode: t.sync, data }); } catch (_) {}
        json(res, 200, { ok: true });
      }).catch((e) => json(res, 400, { ok: false, error: errToStr(e) }));
      return;
    }
  }

  // POST /api/media?name=xxx（生ボディアップロード） / DELETE /api/media/:file
  if (seg[1] === "media") {
    if (seg.length === 2 && method === "POST") { handleMediaUpload(req, res, u.searchParams.get("name")); return; }
    if (seg.length === 3 && method === "DELETE") {
      const f = path.join(profiles.MEDIA_DIR, safeBase(decodeURIComponent(seg[2])));
      if (path.dirname(f) !== path.resolve(profiles.MEDIA_DIR)) { json(res, 403, { ok: false, error: "forbidden" }); return; }
      fs.unlink(f, (err) => { json(res, err ? 404 : 200, err ? { ok: false, error: "見つかりません" } : { ok: true }); });
      return;
    }
  }

  json(res, 404, { ok: false, error: "not found" });
}

// ===== Socket.IO =====
const io = new Server(httpServer, { cors: { origin: "*" } });
setNotify((n) => { try { io.emit("errorCount", n); } catch (_) {} });

// TikTokブリッジ（全プロファイル共有の1本）
const bridge = createBridge({
  io,
  saveLastUser: (user) => profiles.saveState({ lastUser: user }),
  loadAutoConnect: () => profiles.loadState().autoConnect,
  setAutoConnect: (on) => profiles.saveState({ autoConnect: !!on })
});

const VALID_SYNC = new Set(Object.keys(profiles.TYPES).map((k) => profiles.TYPES[k].sync));

// ゲーム連携β: キー送信用 sendHotkey・音声/スピナー配信用 io・スピナー画像用ギフト一覧を注入
// （β非同梱の公開版では gamebeta/gachabeta が null のためスキップ）
if (gamebeta) gamebeta.init({ sendHotkey, io, getGiftCatalog: () => bridge.giftCatalog });
if (gachabeta) gachabeta.init({ io, getGiftCatalog: () => bridge.giftCatalog });
if (levelbeta) levelbeta.init({ io });

// ===== WINカウンターの配信 =====
// win ルーム（カウンター表示）と alerts ルーム（演出オーバーレイのWINトリガー）の両方へ届ける。
// goal はWIN設定の目標値（演出オーバーレイの「目標達成」判定に使う）。
function winGoalOf(pid) {
  const ws = profiles.getSettings(pid, "win");
  const g = ws ? parseInt(ws.goal, 10) : 0;
  return (g > 0) ? Math.min(99999, g) : 10;   // 未設定時は win.html の既定値と同じ 10
}
function emitWinCount(pid, extra) {
  const payload = Object.assign({ total: profiles.getWins(pid), goal: winGoalOf(pid) }, extra || {});
  io.to("ov:" + pid + ":win").emit("winCount", payload);
  io.to("ov:" + pid + ":alerts").emit("winCount", payload);
}

// ===== マイクラ連携（CommonWINプラグインのオーバーレイAPIをポーリング） =====
// WIN設定 mc:{on,url} が有効なプロファイルごとに <url>/wins（{wins,goal,seq,up}）を1秒ごとに読む。
// 初回（webapp起動直後）は基準合わせのみ。以降は差分を addWins → via:"add" で配信
// （＝WINカウンターの表示更新と、演出オーバーレイの ＋WIN/−WIN/目標達成 トリガーが両方動く）。
// リセット条件（URL側の累計も0にそろえる）：
//   ① マイクラ側サーバー（プラグイン）の再起動＝up変化を検知したとき（前回upは profiles に永続。webapp同時再起動でも判定可）。
//   ② プラグインが「>0 → 0」に落ちたとき＝ /win reset（WINダッシュボードのリセットも内部でこれを呼ぶ）。
const mcSync = {};   // pid -> {wins,up,ok,inflight}
function setMcStatus(pid, st, ok, wins, error) {
  st.ok = ok;
  try { io.to("ov:" + pid + ":win").emit("mcStatus", { ok, wins: (wins != null ? wins : null), error: error || "" }); } catch (_) {}
}
setInterval(() => {
  for (const p of profiles.listProfiles()) {
    const id = p.id;
    const ws = profiles.getSettings(id, "win");
    const mc = ws && ws.mc;
    if (!mc || !mc.on) { delete mcSync[id]; continue; }
    const st = mcSync[id] || (mcSync[id] = { wins: null, up: null, ok: null, inflight: false });
    if (st.inflight) continue;
    let base = String(mc.url || "http://localhost:8765").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    let lib;
    try { lib = new URL(base).protocol === "https:" ? https : http; } catch (_) { setMcStatus(id, st, false, null, "URLの形式が正しくありません"); continue; }
    st.inflight = true;
    const req = lib.get(base + "/wins", { timeout: 1500 }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; if (buf.length > 10000) req.destroy(); });
      res.on("end", () => {
        st.inflight = false;
        try {
          const j = JSON.parse(buf);
          if (typeof j.wins !== "number") throw new Error("bad payload");
          const savedUp = profiles.getMcUp(id);          // 前回同期時に見たプラグイン起動エポック（永続）
          const restarted = (savedUp != null && j.up !== savedUp);  // マイクラ側サーバー（プラグイン）の再起動を検知
          const first = (st.wins == null);                // webapp起動直後 or mc有効化直後の初回同期
          // リセット検知：プラグイン側が「>0 → 0」に落ちたら /win reset（＝WinBoard reset も内部で /win reset を叩く）とみなす。
          // 差分方式だと webapp 累計とプラグイン累計がずれている場合に0へそろわない（マイナス値になる等）ため、
          // このときだけ差分ではなく絶対値0で URL 側の累計もリセットする。
          const isReset = (!first && !restarted && st.wins > 0 && j.wins === 0);
          const delta = (first || restarted) ? 0 : (j.wins - st.wins);
          st.wins = j.wins; st.up = j.up;
          if (j.up !== savedUp) profiles.setMcUp(id, j.up);   // 新しいプラグイン世代を記録
          setMcStatus(id, st, true, j.wins);
          // 目標WIN数もプラグイン側（/win goal・/winboard goal）に即時追従させる。
          // CommonWIN goal=0（＝目標未設定）のときは webapp 側の設定を尊重して上書きしない。
          const mcGoal = (typeof j.goal === "number" && j.goal >= 1) ? Math.min(99999, Math.floor(j.goal)) : null;
          if (mcGoal != null) {
            const curGoal = ws ? parseInt(ws.goal, 10) : NaN;
            if (mcGoal !== curGoal) {
              const nd = Object.assign({}, ws, { goal: mcGoal });
              profiles.putSettings(id, "win", nd);
              // OBSのWINオーバーレイへ即時反映（settingsで再描画）＋演出オーバーレイの目標達成判定も更新
              try { io.to("ov:" + id + ":win").emit("settings", { mode: "win", data: nd }); } catch (_) {}
              emitWinCount(id, { via: "goal", mc: true });
            }
          }
          if (restarted || isReset) {
            // サーバー再起動 or リセットコマンド → URL側の累計も0にそろえる。
            // via:"set"＝リセット扱い（±WIN演出は鳴らさない。目標達成のみ判定される）
            profiles.setWins(id, 0); emitWinCount(id, { via: "set", mc: true });
          } else if (delta) {
            profiles.addWins(id, delta); emitWinCount(id, { via: "add", n: delta, mc: true });
          }
        } catch (e) { setMcStatus(id, st, false, null, "応答が読み取れません（URLがCommonWINのオーバーレイか確認してください）"); }
      });
      res.on("error", () => { st.inflight = false; });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => {
      st.inflight = false;
      const msg = (e && e.code === "ECONNREFUSED") ? "接続できません（マイクラ側のプラグインが起動していません）"
        : (e && e.message === "timeout") ? "応答がありません（タイムアウト）"
        : ((e && e.message) || "接続エラー");
      setMcStatus(id, st, false, null, msg);
    });
  }
}, 1000);

io.on("connection", (socket) => {
  // オーバーレイ/編集ページは ?id=<プロファイルID>&ch=<SYNC_MODE> で接続してくる → ルームに入れる
  const q = socket.handshake.query || {};
  const id = String(q.id || "");
  const ch = String(q.ch || "");
  if (profiles.ID_RE.test(id) && VALID_SYNC.has(ch)) {
    socket.data.room = "ov:" + id + ":" + ch;
    socket.data.pid = id;
    socket.data.ch = ch;
    socket.join(socket.data.room);
  }
  // ゲーム連携βの音声受け取り（ギフト一覧オーバーレイと設定ページが参加する）
  if (String(q.gb || "") === "overlay") socket.join("gbov");
  // ガチャβ演出の受け取り（専用オーバーレイ /gachabeta/overlay が参加する）
  if (String(q.gb || "") === "gachabeta") socket.join("gachaov");
  // メンバーレベルβ演出の受け取り（専用オーバーレイ /levelbeta/overlay が参加する）
  if (String(q.gb || "") === "levelbeta") socket.join("levelov");

  // 接続してきたページに、まず現在の状態を渡す
  // appVersion: OBS内の古いページ（更新前にキャッシュされたHTML）が自分でリロードして最新化するための通知
  socket.emit("appVersion", VERSION);
  socket.emit("status", bridge.statusObj());
  socket.emit("like", { totalLikeCount: bridge.lastTotal, live: bridge.live });
  socket.emit("coins", { total: bridge.totalCoins, live: bridge.live });
  if (bridge.giftCatalog.length) socket.emit("giftList", bridge.giftCatalog);
  socket.emit("errorCount", errorLog.length);
  // ルーム参加者には保存済み設定も即渡す（ブート注入の保険。再接続時にも最新が届く）
  if (socket.data.pid) {
    const saved = profiles.getSettings(socket.data.pid, socket.data.ch);
    if (saved) socket.emit("settings", { mode: socket.data.ch, data: saved });
    // WINカウンター/演出オーバーレイのページには現在の累計も渡す（via なし＝基準合わせ。演出は鳴らない）
    if (socket.data.ch === "win" || socket.data.ch === "alerts") {
      socket.emit("winCount", { total: profiles.getWins(socket.data.pid), goal: winGoalOf(socket.data.pid) });
    }
  }

  // ===== 接続操作（管理画面から） =====
  socket.on("setUser", (d) => {
    const user = String((d && d.user) || "").trim().replace(/^@+/, "");
    if (user) bridge.switchUser(user, "接続");
  });
  socket.on("stopConnect", () => bridge.stopConnect());
  socket.on("retry", () => bridge.restart());
  socket.on("setAutoConnect", (d) => {
    const on = !!(d && d.on);
    profiles.saveState({ autoConnect: on });
    if (on) {
      const user = bridge.currentUser || profiles.loadState().lastUser;
      if (user && (bridge.stopped || !bridge.live)) bridge.switchUser(user, "自動接続ON");
    }
    io.emit("status", bridge.statusObj());
  });

  // ===== メーター設定のライブ同期（プロファイルID単位のルーム配信） =====
  // OBS側：現在の設定をくれ → 保存済みがあれば返す
  socket.on("getSettings", (d) => {
    const pid = (d && d.id) || socket.data.pid;
    const mode = (d && d.mode) || socket.data.ch;
    if (!pid || !profiles.ID_RE.test(String(pid)) || !VALID_SYNC.has(String(mode))) return;
    const saved = profiles.getSettings(String(pid), String(mode));
    if (saved) socket.emit("settings", { mode, data: saved });
  });
  // 編集側：設定が変わった → 保存して、同じプロファイル・同じ種類のOBSソースへだけ配信
  socket.on("setSettings", (d) => {
    if (!d || !d.data || typeof d.data !== "object") return;
    const pid = String(d.id || socket.data.pid || "");
    const mode = String(d.mode || socket.data.ch || "");
    if (!profiles.ID_RE.test(pid) || !VALID_SYNC.has(mode) || !profiles.hasProfile(pid)) return;
    profiles.putSettings(pid, mode, d.data);
    socket.to("ov:" + pid + ":" + mode).emit("settings", { mode, data: d.data });   // 送信元は除外（ループ防止）
  });

  // ===== テスト系の中継（同じプロファイル・同じ種類のソースへだけ届ける） =====
  // exe版は全体broadcastだったが、プロファイル制ではAのテストがBの演出を鳴らさないようルーム限定にする。
  const relay = (ev) => socket.on(ev, (d) => { try { if (socket.data.room) socket.to(socket.data.room).emit(ev === "triggerWinFx" ? "winFxNow" : ev, d || {}); } catch (_) {} });
  relay("triggerWinFx");
  relay("testGiftBump");
  relay("testRank");
  relay("manualCount");
  relay("testAlert");

  // 目標達成 → 外部アプリ(STE等)へホットキー送信（自動WIN）
  socket.on("sendHotkey", (d) => { try { sendHotkey(d && d.combo, d && d.times); } catch (e) {} });

  // ===== WINカウンター（プロファイル単位の累計。サーバーが保持＝リロードしても消えない） =====
  // winAdd: コインメーターの目標達成（編集ページ＝司令塔）や、WINカウンター編集画面の +1/−1 から
  socket.on("winAdd", (d) => {
    const pid = socket.data.pid;
    if (!pid || !profiles.hasProfile(pid)) return;
    const n = Math.max(-999, Math.min(999, parseInt(d && d.n, 10) || 0));
    if (!n) return;
    profiles.addWins(pid, n);
    // via:"add" のときだけ演出オーバーレイが ＋WIN/−WIN 演出を出す（初回同期は via なし）
    emitWinCount(pid, { via: "add", n });
  });
  // winSet: 数値の直接指定・リセット（送信元にも権威値を返すため io.to で全員へ）
  socket.on("winSet", (d) => {
    const pid = socket.data.pid;
    if (!pid || !profiles.hasProfile(pid)) return;
    profiles.setWins(pid, d && d.total);
    // via:"set"＝リセット/直接指定（±WIN演出は鳴らさない。目標達成のみ判定される）
    emitWinCount(pid, { via: "set" });
  });

  // ===== 配信データ（分析画面。exe版と同じイベント名） =====
  socket.emit("analyticsOn", analytics.isOn());
  socket.on("getBroadcasts", () => { try { socket.emit("analyticsOn", analytics.isOn()); socket.emit("broadcasts", analytics.summaries()); } catch (_) {} });
  socket.on("getBroadcast", (d) => { try { socket.emit("broadcastDetail", analytics.detail(d && d.id)); } catch (_) {} });
  // 配信データ取得 ON/OFF（OFFで集計・保存を止める＝軽量・プライバシー）
  socket.on("setAnalyticsOn", (d) => {
    analytics.setOn(!!(d && d.on));
    io.emit("analyticsOn", analytics.isOn());
  });
  // 配信データを全消去（リセット）
  socket.on("resetBroadcasts", () => { analytics.resetAll(); io.emit("broadcasts", []); });
  // 1件の配信タイトルを修正（取得できなかった/間違ったタイトルを手で直す）
  socket.on("setBroadcastTitle", (d) => {
    try { if (analytics.setTitle(d && d.id, d && d.title)) io.emit("broadcasts", analytics.summaries()); } catch (_) {}
  });
  // 1件の配信データを削除（リストから個別に消す）
  socket.on("deleteBroadcast", (d) => {
    try { if (analytics.deleteOne(d && d.id)) io.emit("broadcasts", analytics.summaries()); } catch (_) {}
  });

  // オーバーレイ側のエラー報告を集約（/debug で確認できる）
  socket.on("clientError", (d) => { try { logError("overlay", d && d.level, d && d.message, d && d.detail); } catch (_) {} });

  // 演出メディアの削除（アップロードは HTTP POST /api/media。削除はソケットでもAPIでも可）
  socket.on("deleteMedia", (d) => {
    try {
      const u2 = d && d.url;   // "/media/<file>" のみ削除可（同梱デモ /demo/ は消さない）
      if (typeof u2 === "string" && u2.indexOf("/media/") === 0) {
        const f = path.join(profiles.MEDIA_DIR, safeBase(u2.slice("/media/".length)));
        if (path.dirname(f) === path.resolve(profiles.MEDIA_DIR) && fs.existsSync(f)) fs.unlinkSync(f);
      }
      socket.emit("mediaDeleted", { ok: true, url: u2 });
    } catch (e) { socket.emit("mediaDeleted", { ok: false, error: (e && e.message) || String(e) }); }
  });
});

// ===== 起動 =====
// ポート使用中（＝更新前の古いサーバーがウィンドウなしで残っている等）は自動で引き継ぐ:
// ポートを掴んでいる「node」プロセスだけを終了して再試行する（他のアプリには触らない）。
let takeoverTried = 0;
function takeOverPort() {
  takeoverTried++;
  console.log(`⏳ ポート ${PORT} を古いサーバーが使用中です。自動で引き継ぎます…（${takeoverTried}回目）`);
  const ps =
    `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ` +
    `Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { ` +
    `$p = Get-Process -Id $_ -ErrorAction SilentlyContinue; ` +
    `if ($p -and $p.ProcessName -eq 'node' -and $_ -ne ${process.pid}) { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }`;
  const b64 = Buffer.from(ps, "utf16le").toString("base64");
  exec("powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand " + b64, () => {
    setTimeout(() => { try { httpServer.listen(PORT); } catch (_) {} }, 1500);
  });
}
httpServer.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    if (process.platform === "win32" && takeoverTried < 2) { takeOverPort(); return; }
    logError("server", "error", `ポート ${PORT} が使用中です。他のウィンドウ/アプリを閉じてから起動し直してください。`, err && err.stack);
    console.error("");
    console.error(`❌ ポート ${PORT} が使用中のため起動できませんでした。`);
    console.error(`   ほかのアプリがポート ${PORT} を使っています。そのアプリを終了してから、もう一度 start.bat を実行してください。`);
  } else {
    logError("server", "error", "サーバーエラー: " + (err && err.message ? err.message : err), err && err.stack);
  }
});
httpServer.listen(PORT, () => {
  bootTime = Date.now();
  // アプリ再起動ごとにWINを0から始める（要望）。
  // socket再接続だけ（OBS/ブラウザのリロード）ではここは通らないので「リロードでは消えない」は維持される。
  try { const r = profiles.resetAllWins(); if (r.length) console.log(`   WINカウンターを0にリセット（${r.length}プロファイル）`); } catch (_) {}
  const home = `http://localhost:${PORT}/`;
  console.log(`✅ LIVE Tools Webアプリ版 v${VERSION} 起動`);
  console.log(`   管理画面: ${home}`);
  console.log(`   データ保存先: ${profiles.DATA_DIR}`);
  console.log(`   （このウィンドウは開いたままにしてください）`);
  if (process.env.NO_OPEN !== "1") openBrowser(home);
  // 自動接続：起動時に、前回つないだユーザーへ自動でつなぎ直す（自動接続ONのときのみ。TT_USER 指定は常に優先）
  const envUser = String(process.env.TT_USER || "").trim().replace(/^@+/, "");
  const st = profiles.loadState();
  const auto = envUser || (st.autoConnect ? st.lastUser : "");
  if (auto) bridge.switchUser(auto, envUser ? "TT_USER" : "自動接続");
});

// プロセス全体の想定外エラーも記録（クラッシュせず /debug に残す）
process.on("uncaughtException", (err) => { try { logError("server", "error", "uncaughtException: " + (err && err.message ? err.message : err), err && err.stack); } catch (_) {} });
process.on("unhandledRejection", (reason) => { try { logError("server", "error", "unhandledRejection: " + (reason && reason.message ? reason.message : reason), reason && reason.stack); } catch (_) {} });
process.on("SIGINT", () => { console.log("\n終了します。"); try { analytics.finalize(); } catch (_) {} try { profiles.saveNow(); } catch (_) {} process.exit(0); });
