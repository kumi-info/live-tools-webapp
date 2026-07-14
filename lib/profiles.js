/**
 * lib/profiles.js — オーバーレイのプロファイル管理（短いIDごとにサーバー側で設定を保存）
 *
 * - URLは http://localhost:PORT/overlay/<id>/<type> の形で不変。設定変更はここに保存され
 *   Socket.IO ルーム経由で開いているOBSソースへ即時反映される（URL貼り直し不要）。
 * - 保存先は webapp/data/（配布時に自己完結）。書込不可なら %LOCALAPPDATA%\LiveTools\webapp\ へ自動フォールバック。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { logError } = require("./log");

// ===== データフォルダーの決定（書込プローブ付き） =====
function resolveDataDir() {
  if (process.env.LT_DATA_DIR) return process.env.LT_DATA_DIR;
  const local = path.join(__dirname, "..", "data");
  try {
    fs.mkdirSync(local, { recursive: true });
    const probe = path.join(local, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return local;
  } catch (e) {
    const fallback = path.join(process.env.LOCALAPPDATA || os.homedir(), "LiveTools", "webapp");
    console.warn("⚠ data/ に書き込めないため設定の保存先を変更します: " + fallback);
    return fallback;
  }
}
const DATA_DIR = resolveDataDir();
const MEDIA_DIR = path.join(DATA_DIR, "media");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { logError("server", "error", "mediaフォルダーを作成できません: " + MEDIA_DIR, e); }

// ===== URLの type セグメント → 設定チャンネル(SYNC_MODE)・表示モードの対応表 =====
// SYNC_MODE 文字列は exe版（coin-meter.html 側の判定）と同一にして、クライアント側コードを無改変で使う。
const TYPES = {
  coin:     { sync: "coin",         mode: "coin",    rankMode: null,   title: "コインメーター",   page: "overlay.html" },
  like:     { sync: "like",         mode: "like",    rankMode: null,   title: "いいねメーター",   page: "overlay.html" },
  gift:     { sync: "gift",         mode: "gift",    rankMode: null,   title: "ギフトカウンター", page: "overlay.html" },
  ranking:  { sync: "ranking_like", mode: "ranking", rankMode: "like", title: "いいねランキング", page: "overlay.html" },
  coinrank: { sync: "ranking_coin", mode: "ranking", rankMode: "coin", title: "コインランキング", page: "overlay.html" },
  win:      { sync: "win",          mode: "win",     rankMode: null,   title: "WINカウンター",   page: "win.html" },
  alert:    { sync: "alerts",       mode: "alerts",  rankMode: null,   title: "演出オーバーレイ", page: "alert.html" }
};
const ID_RE = /^[a-z0-9]{6,10}$/;

// ===== プロファイル本体（data/profiles.json） =====
let store = (function () {
  try {
    const o = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
    if (o && typeof o === "object" && o.profiles && typeof o.profiles === "object") return o;
  } catch (e) { if (e && e.code !== "ENOENT") logError("server", "warn", "profiles.json の読込に失敗（新規作成します）: " + e.message, e); }
  return { profiles: {} };
})();

// 書込は300msデバウンス＋アトミック（tmp→rename）。クラッシュしても壊れたJSONを残さない。
let _saveT = null;
function saveSoon() {
  if (_saveT) return;
  _saveT = setTimeout(() => { _saveT = null; saveNow(); }, 300);
}
function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = PROFILES_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, PROFILES_FILE);
  } catch (e) { logError("server", "error", "profiles.json の保存に失敗: " + (e && e.message), e); }
}

// ===== ID生成（紛らわしい文字 0/1/o/l/i を除いた32文字・8桁） =====
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
/**
 * 未使用のプロファイルIDを1つ生成する（8桁・紛らわしい文字を除外）。
 *
 * @return {string} 既存と衝突しない新規ID
 * @throws {Error} 20回試しても衝突が解消しないとき
 */
function genId() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const buf = crypto.randomBytes(8);
    let id = "";
    for (let i = 0; i < 8; i++) id += ID_ALPHABET[buf[i] % ID_ALPHABET.length];
    if (!store.profiles[id]) return id;
  }
  throw new Error("IDの生成に失敗しました（衝突が多すぎます）");
}

// ===== CRUD =====
/** 全プロファイルの要約リストを作成順（古い順）で返す。 @return {Array<object>} summary()の配列 */
function listProfiles() {
  return Object.keys(store.profiles).map((id) => summary(id)).sort((a, b) => a.createdAt - b.createdAt);
}
/**
 * プロファイル1件の要約（ID・名前・作成時刻・各typeのオーバーレイURL）を返す。
 *
 * @param {string} id プロファイルID
 * @return {?object} {id, name, createdAt, urls} / 存在しなければ null
 */
function summary(id) {
  const p = store.profiles[id];
  if (!p) return null;
  const urls = {};
  for (const t of Object.keys(TYPES)) urls[t] = "/overlay/" + id + "/" + t;
  return { id, name: p.name || "", createdAt: p.createdAt || 0, urls };
}
/**
 * 新しいプロファイルを作成して永続化する（保存は300msデバウンス）。
 *
 * @param {string} [name] 表示名（省略時は連番の既定名。60文字に丸める）
 * @return {object} 作成したプロファイルの summary()
 */
function createProfile(name) {
  const id = genId();
  store.profiles[id] = { name: String(name || "オーバーレイ " + (Object.keys(store.profiles).length + 1)).slice(0, 60), createdAt: Date.now(), settings: {} };
  saveSoon();
  return summary(id);
}
/**
 * プロファイル名を変更する。
 *
 * @param {string} id プロファイルID
 * @param {string} name 新しい名前（60文字に丸める）
 * @return {boolean} 成功したら true / IDが無ければ false
 */
function renameProfile(id, name) {
  const p = store.profiles[id];
  if (!p) return false;
  p.name = String(name || "").slice(0, 60);
  saveSoon();
  return true;
}
/**
 * プロファイルを削除する（保存済み設定・WIN数も一緒に消える）。
 *
 * @param {string} id プロファイルID
 * @return {boolean} 成功したら true / IDが無ければ false
 */
function deleteProfile(id) {
  if (!store.profiles[id]) return false;
  delete store.profiles[id];
  saveSoon();
  return true;
}
/** 指定IDのプロファイルが存在するか。 @param {string} id @return {boolean} */
function hasProfile(id) { return !!store.profiles[id]; }

// ===== 設定の取得・保存（SYNC_MODE 単位） =====
/**
 * 保存済みのメーター設定を取得する。
 *
 * @param {string} id プロファイルID
 * @param {string} syncMode 設定チャンネル（TYPES[*].sync。例 "coin"/"win"/"alerts"）
 * @return {?object} 保存済み設定オブジェクト / 無ければ null
 */
function getSettings(id, syncMode) {
  const p = store.profiles[id];
  if (!p || !p.settings) return null;
  return p.settings[syncMode] || null;
}
/**
 * メーター設定を上書き保存する（保存は300msデバウンス）。
 *
 * @param {string} id プロファイルID
 * @param {string} syncMode 設定チャンネル（TYPES[*].sync）
 * @param {object} data 保存する設定オブジェクト
 * @return {boolean} 保存できたら true / ID不在・data不正なら false
 */
function putSettings(id, syncMode, data) {
  const p = store.profiles[id];
  if (!p || !data || typeof data !== "object") return false;
  if (!p.settings) p.settings = {};
  p.settings[syncMode] = data;
  saveSoon();
  return true;
}

// ===== WINカウンター累計（プロファイル単位。コイン目標達成や手動操作で増減） =====
/** 現在の累計WIN数を返す。 @param {string} id @return {number} 存在しなければ 0 */
function getWins(id) {
  const p = store.profiles[id];
  return p ? (p.wins | 0) : 0;
}
/**
 * 累計WIN数を指定値に設定する（-99999〜99999にクランプ）。
 *
 * @param {string} id プロファイルID
 * @param {number|string} n 設定するWIN数
 * @return {number} 設定後のWIN数（ID不在なら 0）
 */
function setWins(id, n) {
  const p = store.profiles[id];
  if (!p) return 0;
  p.wins = Math.max(-99999, Math.min(99999, parseInt(n, 10) || 0));
  saveSoon();
  return p.wins;
}
/**
 * 累計WIN数を n だけ加算する（負数で減算）。
 *
 * @param {string} id プロファイルID
 * @param {number|string} n 加算量
 * @return {number} 加算後のWIN数
 */
function addWins(id, n) { return setWins(id, getWins(id) + (parseInt(n, 10) || 0)); }

// ===== アプリ状態（接続先ユーザー・配信データ取得ON/OFF等。data/state.json） =====
/**
 * アプリ状態を読み込む。ファイルが無い/壊れていても既定値で返す（クラッシュしない）。
 *
 * @return {{lastUser:string, autoConnect:boolean, analyticsOn:boolean}}
 */
function loadState() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {};
    return { lastUser: String(o.lastUser || "").trim(), autoConnect: o.autoConnect !== false, analyticsOn: o.analyticsOn !== false };
  } catch (e) { return { lastUser: "", autoConnect: true, analyticsOn: true }; }
}
/**
 * アプリ状態を部分更新して保存する（現在値にpatchをマージ）。
 *
 * @param {object} patch 更新するフィールド（lastUser/autoConnect/analyticsOn）
 */
function saveState(patch) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const next = Object.assign(loadState(), patch || {});
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastUser: next.lastUser || "", autoConnect: next.autoConnect !== false, analyticsOn: next.analyticsOn !== false }));
  } catch (e) { logError("server", "warn", "state.json の保存に失敗: " + (e && e.message), e); }
}

module.exports = {
  DATA_DIR, MEDIA_DIR, TYPES, ID_RE,
  listProfiles, summary, createProfile, renameProfile, deleteProfile, hasProfile,
  getSettings, putSettings, saveNow,
  getWins, setWins, addWins,
  loadState, saveState
};
