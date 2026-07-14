/**
 * lib/pavlok.js — Pavlok（ビリビリデバイス）連携
 *
 * TikFinity・STE 等のローカルツールから GET/POST /pavlok/<強さ>_<回数> を叩くと、
 * Pavlok クラウドAPI（POST https://api.pavlok.com/api/v5/stimulus/send）へ中継して
 * スマホの Pavlok アプリ経由でデバイスを作動させる。
 *
 * トークン等の設定は data/pavlok.json（配布zip・GitHubには含まれないフォルダー）:
 *   { "token": "...", "maxValue": 100, "maxCount": 5, "intervalMs": 1500, "maxBacklog": 50, "allowLan": false, "presets": [...] }
 *
 * 安全対策:
 *   - 強さ 1〜100 / 1回のリクエストの回数 1〜5 を強制（設定で下げられるが上げられない）
 *   - 連続送信は intervalMs（既定1.5秒・下限1秒）間隔のキュー処理
 *   - キュー滞留の上限は maxBacklog（既定50・最大200。ギフトのまとめ投げも順番に全部発動し、超えた分だけ捨てる）
 *   - 既定ではループバック（同じPC）からのみ受け付け（判定は server.js 側）
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { logError } = require("./log");
const profiles = require("./profiles");

const CONFIG_FILE = path.join(profiles.DATA_DIR, "pavlok.json");
const TYPES = ["zap", "beep", "vibe"];
const HARD_MAX_VALUE = 100;   // 強さの絶対上限
const HARD_MAX_COUNT = 5;     // 1リクエストの回数の絶対上限
const MIN_INTERVAL = 1000;    // 送信間隔の下限(ms)
const HARD_MAX_BACKLOG = 200; // キュー滞留の絶対上限（まとめ投げ対応でも無限には溜めない）

const MAX_PRESETS = 12;
const DEFAULT_PRESETS = [
  { name: "弱め", type: "zap", value: 20, count: 1 },
  { name: "ふつう", type: "zap", value: 30, count: 1 },
  { name: "強め", type: "zap", value: 50, count: 1 },
  { name: "最強", type: "zap", value: 100, count: 1 },
  { name: "連発", type: "zap", value: 30, count: 3 }
];
const DEFAULTS = { token: "", maxValue: 100, maxCount: 5, intervalMs: 1500, maxBacklog: 50, allowLan: false, presets: DEFAULT_PRESETS };

// プリセット（名前つきパターン）を安全な形に整える
function sanitizePresets(arr) {
  if (!Array.isArray(arr)) return DEFAULT_PRESETS.slice();
  return arr.slice(0, MAX_PRESETS).map((p) => ({
    name: String((p && p.name) || "").slice(0, 30),
    type: TYPES.includes(p && p.type) ? p.type : "zap",
    value: clamp(p && p.value, 1, HARD_MAX_VALUE, 30),
    count: clamp(p && p.count, 1, HARD_MAX_COUNT, 1)
  }));
}

// ===== 設定（毎回mtimeを見て変更があれば読み直す＝手動編集も反映） =====
let cache = null, cacheMtime = 0;
function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    if (!cache || st.mtimeMs !== cacheMtime) {
      // BOM付きで保存されたファイル（メモ帳・PowerShell等で手編集）でも読めるように除去
      let raw = fs.readFileSync(CONFIG_FILE, "utf8");
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);   // BOM除去
      cache = Object.assign({}, DEFAULTS, JSON.parse(raw));
      cacheMtime = st.mtimeMs;
    }
  } catch (e) {
    if (!cache) cache = Object.assign({}, DEFAULTS);
  }
  return cache;
}
function saveConfig(patch) {
  const cur = loadConfig();
  const next = Object.assign({}, cur);
  if (patch && typeof patch === "object") {
    if (typeof patch.token === "string") next.token = patch.token.trim().replace(/^Bearer\s+/i, "");
    if (patch.maxValue != null) next.maxValue = clamp(patch.maxValue, 1, HARD_MAX_VALUE, DEFAULTS.maxValue);
    if (patch.maxCount != null) next.maxCount = clamp(patch.maxCount, 1, HARD_MAX_COUNT, DEFAULTS.maxCount);
    if (patch.intervalMs != null) next.intervalMs = clamp(patch.intervalMs, MIN_INTERVAL, 10000, DEFAULTS.intervalMs);
    if (patch.maxBacklog != null) next.maxBacklog = clamp(patch.maxBacklog, 1, HARD_MAX_BACKLOG, DEFAULTS.maxBacklog);
    if (patch.allowLan != null) next.allowLan = !!patch.allowLan;
    if (patch.presets != null) next.presets = sanitizePresets(patch.presets);
  }
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
    cache = next;
    try { cacheMtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch (_) {}
    return true;
  } catch (e) {
    logError("server", "error", "Pavlok設定の保存に失敗: " + CONFIG_FILE, e);
    return false;
  }
}
function clamp(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// トークン(JWT)の有効期限を取り出す（表示用。壊れていても落とさない）
function tokenExp(token) {
  try {
    const mid = String(token).split(".")[1];
    const j = JSON.parse(Buffer.from(mid.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return (typeof j.exp === "number") ? j.exp * 1000 : null;
  } catch (_) { return null; }
}

// ===== 送信キュー（連打されても intervalMs 間隔で1発ずつ送る） =====
const queue = [];
let sending = false;
let lastResult = null;   // {t, ok, code, msg, type, value}

function sendOne(type, value, cb) {
  const cfg = loadConfig();
  // API v5 は stimulusType/stimulusValue を要求（旧 type/value は 2026-07 時点で 422 になる。両方送って互換確保）
  const body = JSON.stringify({ stimulus: { stimulusType: type, stimulusValue: value, type, value } });
  const req = https.request({
    hostname: "api.pavlok.com",
    path: "/api/v5/stimulus/send",
    method: "POST",
    headers: {
      "Authorization": "Bearer " + cfg.token,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    },
    timeout: 8000
  }, (res) => {
    let buf = "";
    res.on("data", (c) => { buf += c; if (buf.length > 10000) req.destroy(); });
    res.on("end", () => cb(null, res.statusCode, buf));
    res.on("error", (e) => cb(e));
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => cb(e));
  req.end(body);
}

function pump() {
  if (sending) return;
  const item = queue.shift();
  if (!item) return;
  sending = true;
  sendOne(item.type, item.value, (err, code, resBody) => {
    const ok = !err && code >= 200 && code < 300;
    let msg = "";
    if (err) msg = (err.message === "timeout") ? "応答がありません（タイムアウト）" : (err.message || "送信エラー");
    else if (code === 401 || code === 403) msg = "認証エラー（トークンが無効か期限切れです）";
    else if (!ok) msg = "APIエラー HTTP " + code + (resBody ? "：" + String(resBody).slice(0, 200) : "");
    lastResult = { t: Date.now(), ok, code: code || 0, msg, type: item.type, value: item.value };
    if (ok) console.log("⚡ Pavlok送信: " + item.type + " 強さ" + item.value);
    else logError("server", "warn", "Pavlok送信に失敗: " + (msg || "HTTP " + code));
    const cfg = loadConfig();
    const wait = Math.max(MIN_INTERVAL, parseInt(cfg.intervalMs, 10) || DEFAULTS.intervalMs);
    setTimeout(() => { sending = false; pump(); }, wait);
  });
}

/**
 * 発動する。type: zap/beep/vibe、value: 強さ、count: 回数。
 * 返り値 {ok, type, value, count} または {ok:false, error}
 */
function trigger(type, value, count) {
  const cfg = loadConfig();
  if (!cfg.token) return { ok: false, error: "トークンが未設定です。設定ページ（/pavlok）で保存してください。" };
  type = TYPES.includes(String(type)) ? String(type) : "zap";
  const v = clamp(value, 1, Math.min(HARD_MAX_VALUE, cfg.maxValue || HARD_MAX_VALUE), 30);
  let c = clamp(count, 1, Math.min(HARD_MAX_COUNT, cfg.maxCount || HARD_MAX_COUNT), 1);
  // まとめ投げ（短時間に大量リクエスト）はキューに積んで順番に全部発動する。
  // 上限（maxBacklog）を超えた分だけ受け付けない。
  const backlog = clamp(cfg.maxBacklog, 1, HARD_MAX_BACKLOG, DEFAULTS.maxBacklog);
  const room = backlog - queue.length;
  if (room <= 0) return { ok: false, error: "待機中の送信が上限（" + backlog + "件）に達しています" };
  c = Math.min(c, room);
  for (let i = 0; i < c; i++) queue.push({ type, value: v });
  pump();
  return { ok: true, type, value: v, count: c };
}

function status() {
  const cfg = loadConfig();
  const exp = cfg.token ? tokenExp(cfg.token) : null;
  return {
    configured: !!cfg.token,
    tokenExp: exp,
    tokenExpired: (exp != null) ? (exp < Date.now()) : false,
    maxValue: Math.min(HARD_MAX_VALUE, cfg.maxValue || HARD_MAX_VALUE),
    maxCount: Math.min(HARD_MAX_COUNT, cfg.maxCount || HARD_MAX_COUNT),
    intervalMs: Math.max(MIN_INTERVAL, cfg.intervalMs || DEFAULTS.intervalMs),
    maxBacklog: clamp(cfg.maxBacklog, 1, HARD_MAX_BACKLOG, DEFAULTS.maxBacklog),
    allowLan: !!cfg.allowLan,
    presets: sanitizePresets(cfg.presets),
    queue: queue.length + (sending ? 1 : 0),
    last: lastResult,
    configFile: CONFIG_FILE
  };
}

module.exports = { loadConfig, saveConfig, trigger, status, TYPES };
