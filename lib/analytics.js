/**
 * lib/analytics.js — 配信データ（分析）: 配信ごとに視聴者別のいいね/コインを集計して永続化
 *
 * exe版 tiktok-bridge.js の配信履歴機能（newSession, finalizeSession, sessAddLike,
 * sessAddCoin, touchSeen, broadcastSummary, broadcastDetail）を移植。保存先は data/broadcasts.json。
 * 取得ON/OFF（analyticsOn）は data/state.json に保存（OFFなら集計・保存しない＝軽量）。
 */

const fs = require("fs");
const path = require("path");
const { logError } = require("./log");
const profiles = require("./profiles");

const HISTORY_FILE = path.join(profiles.DATA_DIR, "broadcasts.json");
const HISTORY_MAX = 50;    // 直近50配信ぶんを保持
const SEEN_MAX = 5000;     // 在室記録の上限（巨大配信でメモリ/保存が膨らみ過ぎないように）
const RESUME_MS = 20 * 60 * 1000;   // クラッシュ復帰時、20分以内なら同じ配信の続きとして再開

let analyticsOn = profiles.loadState().analyticsOn;

// 在室記録から「最後に観測したアクティビティ時刻」を推定（いいね/コメント/ギフト/フォローで更新される seen[].last の最大）。
// finalize() を通らず終わった配信（クラッシュ/強制終了）の終了時刻の代替に使う。無ければ 0。
function lastActivity(b) {
  let t = 0;
  const s = b && b.seen;
  if (s) for (const u in s) { const e = s[u]; if (e && e.last > t) t = e.last; }
  return t;
}

// live=true のまま保存されている＝異常終了 → 「再開可能」として復帰対象にする。
// また、終了時刻が未設定/開始時刻のまま（＝クラッシュで finalize を通らず 0分表示になった）レコードは、
// 最終アクティビティ時刻から終了時刻を補正する（既存の壊れたデータも起動時に自動修復）。
let broadcasts = (function () {
  try {
    const a = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (Array.isArray(a)) {
      a.forEach((b) => {
        if (!b) return;
        if (b.live) { b.live = false; b.resumable = true; }
        const est = lastActivity(b);
        if (!b.endedAt || (est && est > b.endedAt)) b.endedAt = est || b.startedAt;
      });
      return a;
    }
  } catch (e) { if (e && e.code !== "ENOENT") logError("server", "warn", "broadcasts.json の読込に失敗（新規作成します）: " + e.message, e); }
  return [];
})();
let session = null;   // 進行中の配信セッション（broadcasts[0] と同一参照）
let _saveT = null;

function saveHistory() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(broadcasts.slice(0, HISTORY_MAX)));
  } catch (e) { logError("server", "warn", "broadcasts.json の保存に失敗: " + (e && e.message), e); }
}
// 連続更新は5秒ごとにまとめて保存（クラッシュ時も直前約5秒前まで復元可。I/Oは間引いて軽量）
function saveHistorySoon() { if (_saveT) return; _saveT = setTimeout(() => { _saveT = null; saveHistory(); }, 5000); }

// ===== セッション管理 =====
/**
 * 新しい配信セッションを開始する（進行中があれば先に確定する）。
 *
 * @param {string} user 配信者のユーザー名
 * @param {string} [title] 配信タイトル（取得できていれば）
 */
function newSession(user, title) {
  finalize();
  session = { id: "b" + Date.now(), user: user || "", title: title || "", startedAt: Date.now(), endedAt: null, live: true, totalLikes: 0, totalCoins: 0, follows: 0, likes: {}, coins: {}, seen: {} };
  broadcasts.unshift(session);
  if (broadcasts.length > HISTORY_MAX) broadcasts.length = HISTORY_MAX;
  saveHistory();
}
function finalize() {
  if (!session) return;
  session.live = false; session.endedAt = Date.now(); session.resumable = false;   // 正常終了＝再開しない（クラッシュ時のみ再開対象）
  const empty = !(session.totalLikes > 0 || session.totalCoins > 0 || Object.keys(session.likes).length || Object.keys(session.coins).length);
  if (empty) { const i = broadcasts.indexOf(session); if (i >= 0) broadcasts.splice(i, 1); }   // データ無しの空配信は残さない
  session = null; saveHistory();
}
// 別ユーザーへの切替時＝前の配信を確定
function finalizeIfOtherUser(username) {
  if (session && session.user && session.user !== username) finalize();
}
/**
 * TikTok接続成功時に呼ぶ。状況に応じてセッションを継続 / クラッシュ復帰（20分以内なら再開） /
 * 新規開始のいずれかを選ぶ。取得OFF時は何もしない。
 *
 * @param {string} username 配信者のユーザー名
 * @param {string} [title] 配信タイトル
 */
function onConnected(username, title) {
  if (!analyticsOn) return;
  try {
    if (session && session.user === username) {
      if (title && !session.title) session.title = title;   // 同一接続の継続
    } else {
      const last = broadcasts[0];
      if (last && last.resumable && last.user === username && (Date.now() - (last.endedAt || last.startedAt)) < RESUME_MS) {
        finalize();                       // 念のため別セッションがあれば確定（通常 session は null）
        session = last; session.live = true; session.endedAt = null;   // 直前の配信データを引き継いで再開
        if (title && !session.title) session.title = title;
        console.log(`↩️ 直前の配信データを引き継いで再開しました（@${username}）`);
        saveHistory();
      } else {
        newSession(username, title);
      }
    }
  } catch (e) { logError("server", "warn", "配信データの記録開始に失敗: " + ((e && e.message) || e), e && e.stack); }
}
// roomInfo は接続直後に未取得のことがあるため、少し後の再取得ぶんを反映
function maybeSetTitle(username, title) {
  try {
    if (session && session.user === username && !session.title && title) { session.title = String(title).slice(0, 120); saveHistorySoon(); }
  } catch (_) {}
}

// ===== 集計（TikTokイベントから呼ばれる。OFF時・セッション無し時は何もしない） =====
/**
 * 視聴者の在室を記録する（最初/最後に観測した時刻＝視聴時間の近似＋名前/アイコン）。
 * いいね・コメント・入室など「観測できた」すべての契機から呼ばれる。
 *
 * @param {string} user ユーザーID
 * @param {string} [nick] ニックネーム
 * @param {string} [avatar] アイコンURL
 */
function touch(user, nick, avatar) {
  if (!analyticsOn || !session || !user) return;
  const now = Date.now();
  let e = session.seen[user];
  if (!e) { if (Object.keys(session.seen).length >= SEEN_MAX) return; e = session.seen[user] = { first: now, last: now, nick: nick || user, avatar: avatar || "" }; }
  e.last = now;
  if (nick) e.nick = nick;
  if (avatar) e.avatar = avatar;
}
/**
 * いいねイベントを集計する（配信全体の総数＋視聴者別の内訳）。
 *
 * @param {string} user ユーザーID
 * @param {string} nick ニックネーム
 * @param {string} avatar アイコンURL
 * @param {number} cnt 今回のいいね数
 * @param {?number} totalLikes 配信全体の総いいね数（取れたときのみ）
 */
function onLike(user, nick, avatar, cnt, totalLikes) {
  if (!analyticsOn || !session) return;
  if (totalLikes != null) session.totalLikes = totalLikes;
  touch(user, nick, avatar);
  if (!user || !(cnt > 0)) return;
  const e = session.likes[user] || (session.likes[user] = { nick: nick || user, avatar: avatar || "", count: 0 });
  if (nick) e.nick = nick; if (avatar) e.avatar = avatar; e.count += cnt; saveHistorySoon();
}
/**
 * ギフト（コイン）イベントを集計する（配信全体の総コイン＋視聴者別の内訳）。
 *
 * @param {string} user ユーザーID
 * @param {string} nick ニックネーム
 * @param {string} avatar アイコンURL
 * @param {number} coins 今回のコイン数（ダイヤ×個数）
 * @param {?number} totalCoins 配信全体の総コイン数（増えたときのみ）
 */
function onGift(user, nick, avatar, coins, totalCoins) {
  if (!analyticsOn || !session) return;
  if (totalCoins != null) session.totalCoins = totalCoins;
  touch(user, nick, avatar);
  if (!user || !(coins > 0)) return;
  const e = session.coins[user] || (session.coins[user] = { nick: nick || user, avatar: avatar || "", count: 0 });
  if (nick) e.nick = nick; if (avatar) e.avatar = avatar; e.count += coins; saveHistorySoon();
}
function onFollow(user, nick, avatar) {
  if (!analyticsOn || !session) return;
  session.follows = (session.follows || 0) + 1;
  touch(user, nick, avatar);
  saveHistorySoon();
}

// ===== 表示用（分析画面へ渡す形） =====
function broadcastSummary(b) { return { id: b.id, user: b.user, title: b.title, startedAt: b.startedAt, endedAt: b.endedAt, live: !!b.live, totalLikes: b.totalLikes || 0, totalCoins: b.totalCoins || 0, follows: b.follows || 0, likeUsers: Object.keys(b.likes || {}).length, coinUsers: Object.keys(b.coins || {}).length }; }
function broadcastDetail(b) {
  const map = {};
  const merge = (src, key) => { Object.keys(src || {}).forEach((u) => { const e = src[u]; const m = map[u] || (map[u] = { user: u, nick: e.nick || u, avatar: e.avatar || "", likes: 0, coins: 0, watchMs: 0 }); if (e.nick) m.nick = e.nick; if (e.avatar) m.avatar = e.avatar; m[key] = e.count || 0; }); };
  merge(b.likes, "likes"); merge(b.coins, "coins");
  // 在室記録（入室・コメント等のみで いいね/コインが無い視聴者も一覧に含める）＋視聴時間を付与
  Object.keys(b.seen || {}).forEach((u) => {
    const s = b.seen[u];
    if (!map[u]) map[u] = { user: u, nick: s.nick || u, avatar: s.avatar || "", likes: 0, coins: 0, watchMs: 0 };
    map[u].watchMs = Math.max(0, (s.last || 0) - (s.first || 0));
    if ((!map[u].nick || map[u].nick === u) && s.nick) map[u].nick = s.nick;
    if (!map[u].avatar && s.avatar) map[u].avatar = s.avatar;
  });
  const participants = Object.keys(map).map((u) => map[u]).sort((a, c) => (c.coins - a.coins) || (c.likes - a.likes));
  return { id: b.id, user: b.user, title: b.title, startedAt: b.startedAt, endedAt: b.endedAt, live: !!b.live, totalLikes: b.totalLikes || 0, totalCoins: b.totalCoins || 0, follows: b.follows || 0, participants };
}
/** 全配信の要約リスト（分析画面の一覧用）を返す。 @return {Array<object>} */
function summaries() { return broadcasts.map(broadcastSummary); }
/**
 * 1配信の詳細（視聴者ごとのいいね/コイン/視聴時間）を返す。
 * @param {string} id 配信ID @return {?object} 見つからなければ null
 */
function detail(id) { const b = broadcasts.find((x) => x.id === id); return b ? broadcastDetail(b) : null; }

// ===== 編集・削除 =====
function setTitle(id, title) {
  const b = broadcasts.find((x) => x.id === id);
  if (!b) return false;
  b.title = String(title || "").slice(0, 120).trim();
  saveHistory();
  return true;
}
function deleteOne(id) {
  const i = broadcasts.findIndex((x) => x.id === id);
  if (i < 0) return false;
  if (session && broadcasts[i] === session) session = null;   // 進行中セッションを消したらセッション解除
  broadcasts.splice(i, 1);
  saveHistory();
  return true;
}
function resetAll() {
  broadcasts = []; session = null;
  try { if (_saveT) { clearTimeout(_saveT); _saveT = null; } } catch (_) {}
  saveHistory();
}

// ===== 取得ON/OFF =====
/** 配信データ取得が有効か。 @return {boolean} */
function isOn() { return analyticsOn; }
/**
 * 配信データ取得のON/OFFを切り替えて state.json に永続化する。
 * OFFにすると進行中セッションを確定して集計を止める（軽量・プライバシー）。
 *
 * @param {boolean} on 有効にするなら true
 */
function setOn(on) {
  analyticsOn = !!on;
  profiles.saveState({ analyticsOn: analyticsOn });
  if (!analyticsOn) finalize();   // OFFにしたら進行中セッションを確定して止める
}

module.exports = {
  isOn, setOn,
  onConnected, maybeSetTitle, finalize, finalizeIfOtherUser,
  touch, onLike, onGift, onFollow,
  summaries, detail, setTitle, deleteOne, resetAll
};
