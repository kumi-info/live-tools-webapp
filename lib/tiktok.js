/**
 * lib/tiktok.js — TikTok LIVE 接続（tiktok-bridge.js の接続ループを移植）
 *
 * - 接続は全プロファイル共有の1本（配信者は1人）。like/coins/giftBatch 等のデータは全接続へ配信。
 * - createBridge({ io, log, state }) で生成。io.emit を直接使う（データイベントはグローバル配信）。
 * - 配信データ（分析）は lib/analytics.js へフック（ON時のみ集計。exe版と同じ挙動）。
 */

const { logError, errToStr, errDetail } = require("./log");
const analytics = require("./analytics");
// ベータ機能（ゲーム連携β/ガチャβ）は任意同梱。公開配布版には含めないため、無ければ null にして
// 各イベントのフックをスキップする（require.resolve でファイル存在のみ判定）。
function optionalRequire(rel) { try { require.resolve(rel); } catch (_) { return null; } return require(rel); }
const gamebeta = optionalRequire("./gamebeta");
const gachabeta = optionalRequire("./gachabeta");
const levelbeta = optionalRequire("./levelbeta");
const followers = require("./followers");

let TikTokLiveConnection, WebcastEvent, ControlEvent;
try {
  const lib = require("tiktok-live-connector");
  TikTokLiveConnection = lib.TikTokLiveConnection || lib.WebcastPushConnection;
  WebcastEvent = lib.WebcastEvent || {};
  ControlEvent = lib.ControlEvent || {};
} catch (e) {
  console.error("tiktok-live-connector が見つかりません。先に `npm install` を実行してください。");
  process.exit(1);
}

const RETRY_SEC = parseInt(process.env.RETRY_SEC || "20", 10);
const MAX_RETRY = parseInt(process.env.MAX_RETRY || "5", 10);
const SIGN_API_KEY = process.env.SIGN_API_KEY;
// ギフト1個の価値(diamond_count)→コイン換算。既定1。実表示とずれる場合は set COIN_FACTOR=2 等で調整。
const COIN_FACTOR = Number(process.env.COIN_FACTOR || 1);

// ===== ギフトのフィールド正規化（tiktok-live-connector のバージョン差を吸収） =====
function giftValue(d) {
  if (!d) return 0;
  if (d.diamondCount != null) return Number(d.diamondCount);
  if (d.diamond_count != null) return Number(d.diamond_count);
  if (d.giftDetails) {
    if (d.giftDetails.diamondCount != null) return Number(d.giftDetails.diamondCount);
    if (d.giftDetails.diamond_count != null) return Number(d.giftDetails.diamond_count);
  }
  if (d.gift && d.gift.diamond_count != null) return Number(d.gift.diamond_count);
  if (d.extendedGiftInfo && d.extendedGiftInfo.diamond_count != null) return Number(d.extendedGiftInfo.diamond_count);
  return 0;
}
function giftRepeat(d) {
  if (!d) return 1;
  if (d.repeatCount != null) return Number(d.repeatCount);
  if (d.repeat_count != null) return Number(d.repeat_count);
  if (d.gift && d.gift.repeat_count != null) return Number(d.gift.repeat_count);
  return 1;
}
function giftType(d) {
  if (!d) return undefined;
  if (d.giftType != null) return d.giftType;
  if (d.giftDetails && d.giftDetails.giftType != null) return d.giftDetails.giftType;
  if (d.gift) return d.gift.gift_type != null ? d.gift.gift_type : d.gift.type;
  return undefined;
}
function giftId(d) {
  if (!d) return null;
  if (d.giftId != null) return d.giftId;
  if (d.giftDetails && d.giftDetails.giftId != null) return d.giftDetails.giftId;
  if (d.gift && d.gift.id != null) return d.gift.id;
  return null;
}
function giftName(d) {
  if (!d) return "";
  if (d.giftName != null) return d.giftName;
  if (d.giftDetails && d.giftDetails.giftName != null) return d.giftDetails.giftName;
  if (d.gift && d.gift.name != null) return d.gift.name;
  return "";
}
function giftUser(d) {
  if (!d) return "";
  if (d.user && d.user.uniqueId) return d.user.uniqueId;
  if (d.uniqueId) return d.uniqueId;
  if (d.user && d.user.userId != null) return String(d.user.userId);
  if (d.userId != null) return String(d.userId);
  return "";
}
function userNick(d) {
  if (!d) return "";
  if (d.user && d.user.nickname) return d.user.nickname;
  if (d.nickname) return d.nickname;
  return giftUser(d);
}
function imgUrl(img) {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (Array.isArray(img.url_list) && img.url_list.length) return img.url_list[img.url_list.length - 1];
  if (Array.isArray(img.urlList) && img.urlList.length) return img.urlList[img.urlList.length - 1];
  if (Array.isArray(img.urls) && img.urls.length) return img.urls[img.urls.length - 1];
  if (img.url) return img.url;
  return "";
}
function userAvatar(d) {
  const u = d && d.user;
  if (!u) return "";
  return imgUrl(u.profilePictureMedium) || imgUrl(u.profilePicture) || imgUrl(u.profilePictureLarge) || imgUrl(u.avatarThumb) || "";
}
// メンバーレベルβ: 各イベントの user からチームレベル（ファンチームの団結レベル）を取り出して levelbeta に供給する。
// TikTokにはレベルアップ専用イベントが無いため、各イベントに載る現在レベルの増加を監視する方式。
//
// レベルの在り処は tiktok-live-connector のデータ上で2系統ある（配信・バージョンでどちらが載るか変わる）:
//   ① user.fansClubInfo.fansLevel（文字列）           … 旧来のフィールド
//   ② user.fansClub.data.level（数値）                … 新しめのフィールド。実データではこちらだけ載ることが多い
// 片方しか来ないと「取得できない」ように見えるため、両方から拾って有効な方を採用する。
function teamLevel(u) {
  const out = { level: null, name: "", score: null };
  if (!u) return out;
  const fi = u.fansClubInfo;
  if (fi) {
    const n = parseInt(String(fi.fansLevel == null ? "" : fi.fansLevel).trim(), 10);
    if (isFinite(n)) out.level = n;
    if (fi.fansClubName) out.name = fi.fansClubName;
    if (fi.fansScore != null) out.score = fi.fansScore;
  }
  // ②の方が値を持っていれば優先（①が空/0のときの取りこぼしを防ぐ）
  const fc = u.fansClub && u.fansClub.data;
  if (fc) {
    const n2 = parseInt(String(fc.level == null ? "" : fc.level).trim(), 10);
    if (isFinite(n2) && (out.level == null || n2 > out.level)) out.level = n2;
    if (!out.name && fc.clubName) out.name = fc.clubName;
  }
  return out;
}
function feedLevel(d) {
  if (!levelbeta) return;
  try {
    const u = d && d.user;
    const t = teamLevel(u);
    levelbeta.onUser({
      user: giftUser(d),
      nick: userNick(d),
      avatar: userAvatar(d),
      fansLevel: t.level,
      fansClubName: t.name,
      fansScore: t.score
    });
  } catch (_) {}
}
// ギフトギャラリーの点灯情報（送られたギフトに付随）
function gallerySponsorship(d) {
  const arr = d && (d.sponsorshipInfo || (d.giftDetails && d.giftDetails.sponsorshipInfo));
  if (!Array.isArray(arr) || !arr.length) return null;
  const gid = String(giftId(d));
  const s = arr.find((x) => String(x.giftId) === gid) || arr[0];
  if (!s) return null;
  return {
    lit: !!s.lightGiftUp,
    allDone: !!s.becomeAllSponsored,
    unlitIcon: imgUrl(s.unlightedGiftIcon) || s.unlightedGiftIcon || "",
    url: s.giftGalleryDetailPageSchemeUrl || ""
  };
}
function giftImage(g) {
  if (!g) return "";
  const cand = g.image || g.icon || (g.giftDetails && (g.giftDetails.image || g.giftDetails.icon));
  if (!cand) return "";
  if (typeof cand === "string") return cand;
  if (Array.isArray(cand.url_list) && cand.url_list.length) return cand.url_list[0];
  if (Array.isArray(cand.urlList) && cand.urlList.length) return cand.urlList[0];
  if (cand.url) return cand.url;
  return "";
}
// 配信タイトルを色々な経路から取得（tiktok-live-connector のバージョン差・形状差を吸収）
function pickRoomTitle(c, state) {
  try {
    const cands = [];
    const ri = (c && c.roomInfo) || (state && state.roomInfo);
    if (ri) cands.push(ri.title, ri.room_info && ri.room_info.title, ri.data && ri.data.title);
    if (state) cands.push(state.title, state.roomInfo && state.roomInfo.title);
    if (c) cands.push(c.title, c.roomData && c.roomData.title, c._roomInfo && c._roomInfo.title);
    for (const t of cands) { if (t && String(t).trim()) return String(t).trim(); }
  } catch (_) {}
  return "";
}

// ===== ブリッジ本体 =====
/**
 * TikTok LIVE 接続ブリッジを生成する（全プロファイル共有の1本＝配信者は1人）。
 * like/coins/giftBatch 等のデータイベントは io.emit で全オーバーレイへグローバル配信し、
 * 同時に analytics（配信データ）・gamebeta / gachabeta（ゲーム連携）へフックする。
 *
 * @param {object} deps 依存注入
 * @param {object} deps.io Socket.IO サーバー（データイベントの配信先）
 * @param {function(string):void} deps.saveLastUser 接続先ユーザーを永続化する
 * @param {function():boolean} deps.loadAutoConnect 自動接続ONかを返す
 * @param {function(boolean):void} deps.setAutoConnect 自動接続ON/OFFを保存する
 * @return {object} 制御メソッド（switchUser/restart/stopConnect/statusObj）と読み取り専用ゲッター群
 */
function createBridge(deps) {
  const io = deps.io;

  let currentUser = null;
  let conn = null;
  let live = false;
  let lastTotal = 0;
  let totalCoins = 0;
  let gen = 0;
  let failCount = 0;
  let stopped = false;
  let giftCatalog = [];
  let lastTtErrMsg = "", lastTtErrAt = 0;

  // ===== 高頻度イベントの送信まとめ（1000人規模対策）。~150msごとにまとめて1回だけ送る =====
  const EMIT_MS = 150;
  let likeDirty = false, coinsDirty = false;
  let pendingTaps = [];
  let pendingGifts = [];
  const TAPS_CAP = 4000, GIFTS_CAP = 800;
  function flushEmits() {
    try {
      if (likeDirty) { io.emit("like", { totalLikeCount: lastTotal, live: true, taps: pendingTaps }); pendingTaps = []; likeDirty = false; }
      if (coinsDirty) { io.emit("coins", { total: totalCoins, live: true }); coinsDirty = false; }
      if (pendingGifts.length) { io.emit("giftBatch", pendingGifts); pendingGifts = []; }
    } catch (_) {}
  }
  setInterval(flushEmits, EMIT_MS);

  function statusObj() { return { live, user: currentUser, stopped, autoConnect: deps.loadAutoConnect() }; }

  // ギフト一覧を取得して全オーバーレイへ配信（liveでなくても試す）
  function loadGifts(c, myGen) {
    if (!c || typeof c.fetchAvailableGifts !== "function") return;
    c.fetchAvailableGifts().then((list) => {
      if (myGen !== gen || !Array.isArray(list)) return;
      const cat = list.map((g) => ({
        id: g.id != null ? g.id : g.giftId,
        name: g.name != null ? g.name : g.giftName,
        diamond: g.diamond_count != null ? g.diamond_count : (g.diamondCount != null ? g.diamondCount : 0),
        image: giftImage(g)
      })).filter((g) => g.id != null && g.name);
      if (cat.length) {
        giftCatalog = cat;
        io.emit("giftList", giftCatalog);
        console.log(`🎁 ギフト一覧 ${giftCatalog.length}件を配信`);
      }
    }).catch(() => {});
  }

  /**
   * 接続先ユーザーを切り替える（同一ユーザーで接続中なら何もしない）。
   * 別ユーザーへの切替時は前の配信データを確定し、自動接続ONで記憶する。
   *
   * @param {string} username 接続先のTikTokユーザー名（@なし）
   * @param {string} [why] ログ用の理由（例 "API接続"/"自動接続"）
   */
  function switchUser(username, why) {
    if (!username) return;
    if (username === currentUser && !stopped) return;
    console.log(`👤 接続先を @${username} に切り替えます（${why || ""}）`);
    analytics.finalizeIfOtherUser(username);   // 別ユーザーへ切替＝前の配信データを確定
    currentUser = username;
    deps.saveLastUser(username);
    deps.setAutoConnect(true);   // 接続したら自動接続ONで記憶
    startFresh();
  }
  function restart() {
    if (!currentUser) return;
    console.log(`🔄 @${currentUser} に再接続します`);
    startFresh();
  }
  /**
   * 「切断」。データ取得を停止して配信データを確定する（接続先ユーザーは保持し、
   * 接続ボタンで再開できる）。自動接続はOFFにする。
   */
  function stopConnect() {
    console.log(`⏸ 切断しました（@${currentUser || "-"}）`);
    analytics.finalize();                       // 配信データを確定保存
    if (levelbeta) try { levelbeta.endSession(); } catch (_) {}   // メンレベ履歴: 配信の終了時刻を確定
    deps.setAutoConnect(false);
    gen++;
    if (conn) { try { conn.disconnect(); } catch (e) {} conn = null; }
    live = false; stopped = true; lastTotal = 0; totalCoins = 0;
    io.emit("status", statusObj());
    io.emit("like", { totalLikeCount: 0, live: false });
    io.emit("coins", { total: 0, live: false });
  }
  function startFresh() {
    if (levelbeta) try { levelbeta.reset(); } catch (_) {}   // 再接続/切替時はチームレベルの基準を取り直す（誤爆防止）
    stopped = false; failCount = 0; live = false; lastTotal = 0; totalCoins = 0;
    io.emit("status", statusObj());
    io.emit("coins", { total: 0, live: false });
    gen++;
    if (conn) { try { conn.disconnect(); } catch (e) {} conn = null; }
    connectLoop(gen, currentUser);
  }

  function connectLoop(myGen, username) {
    if (myGen !== gen) return;

    const opts = { enableExtendedGiftInfo: true };
    if (SIGN_API_KEY) opts.signApiKey = SIGN_API_KEY;
    const c = new TikTokLiveConnection(username, opts);
    conn = c;
    loadGifts(c, myGen);

    const LIKE = WebcastEvent.LIKE || "like";
    c.on(LIKE, (data) => {
      if (myGen !== gen) return;
      feedLevel(data);   // メンバーレベルβ: いいねにもuser情報が載る
      const t = data && (data.totalLikeCount != null ? data.totalLikeCount : data.likeCount);
      const cnt = Number((data && (data.likeCount != null ? data.likeCount : data.count)) || 0);
      if (t != null) { lastTotal = Number(t); likeDirty = true; }
      if (cnt > 0 && pendingTaps.length < TAPS_CAP) {
        pendingTaps.push({ user: giftUser(data), nick: userNick(data), avatar: userAvatar(data), count: cnt });
      }
      analytics.onLike(giftUser(data), userNick(data), userAvatar(data), cnt, t != null ? lastTotal : null);   // 配信データ: 視聴者別いいね＋在室記録
      if (cnt > 0 && gamebeta) gamebeta.onLike({ user: giftUser(data), nick: userNick(data), count: cnt, total: lastTotal });   // ゲーム連携: Nいいねごとレコード
    });

    const GIFT = WebcastEvent.GIFT || "gift";
    c.on(GIFT, (data) => {
      if (myGen !== gen) return;
      feedLevel(data);   // メンバーレベルβ
      // 連打ギフト(giftType=1)はストリーク中(repeatEnd=false)を無視し、確定時のみ集計（二重計上防止）
      if (giftType(data) === 1 && !data.repeatEnd) return;
      const rep = giftRepeat(data);
      const val = giftValue(data);
      const add = val * rep * COIN_FACTOR;
      if (add > 0) { totalCoins += add; coinsDirty = true; }
      analytics.onGift(giftUser(data), userNick(data), userAvatar(data), add, add > 0 ? totalCoins : null);   // 配信データ: 視聴者別コイン＋在室記録
      // ゲーム連携: ギフトレコード（diamond=1個あたり・coins=ダイヤ×個数。COIN_FACTORはかけない素の値）
      if (gamebeta) gamebeta.onGift({ giftId: giftId(data), name: giftName(data), diamond: val, repeat: rep, coins: val * rep, user: giftUser(data), nick: userNick(data) });
      // ガチャβ（独立・ギフト起点）
      if (gachabeta) gachabeta.onGift({ giftId: giftId(data), name: giftName(data), diamond: val, repeat: rep, coins: val * rep, user: giftUser(data), nick: userNick(data) });
      if (pendingGifts.length < GIFTS_CAP) {
        pendingGifts.push({
          id: giftId(data),
          name: giftName(data),
          repeat: rep,
          diamond: val,
          user: giftUser(data),
          nick: userNick(data),
          avatar: userAvatar(data),
          image: giftImage(data) || (data.giftDetails && giftImage(data.giftDetails)) || (data.gift && giftImage(data.gift)) || "",
          gallery: gallerySponsorship(data)
        });
      }
    });

    const CHAT = WebcastEvent.CHAT || "chat";
    c.on(CHAT, (data) => {
      if (myGen !== gen) return;
      feedLevel(data);   // メンバーレベルβ: チャットは最も高頻度でuser情報が載る
      analytics.touch(giftUser(data), userNick(data), userAvatar(data));   // 在室記録（コメントも在室の証跡）
      if (gamebeta) gamebeta.onComment({ user: giftUser(data), nick: userNick(data), text: String((data && data.comment) || "") });   // ゲーム連携: キーワードレコード
      io.emit("comment", { user: giftUser(data) });
    });

    const FOLLOW = WebcastEvent.FOLLOW || "follow";
    c.on(FOLLOW, (data) => {
      if (myGen !== gen) return;
      feedLevel(data);   // メンバーレベルβ
      analytics.onFollow(giftUser(data), userNick(data), userAvatar(data));   // 配信データ: フォロー数＋在室記録（リフォローも記録）
      // リフォロー除外: 一度フォロー済みの人（followers_seen.json に記録）は演出・ゲーム連携を発動しない
      if (!followers.isNewFollow(giftUser(data))) return;
      if (gamebeta) gamebeta.onFollow({ user: giftUser(data), nick: userNick(data) });   // ゲーム連携: フォローレコード（初回のみ）
      io.emit("follow", { user: giftUser(data), nick: userNick(data), avatar: userAvatar(data) });
    });

    // 入室（視聴者の参加）。配信データのリスナー把握用に在室記録（接続後に入室した人のみ）
    const MEMBER = WebcastEvent.MEMBER || "member";
    c.on(MEMBER, (data) => {
      if (myGen !== gen) return;
      feedLevel(data);   // メンバーレベルβ: 入室時のuser情報にもチームレベルが載る
      analytics.touch(giftUser(data), userNick(data), userAvatar(data));
    });

    let retried = false;
    const retry = (reason) => {
      if (retried || myGen !== gen) return;
      retried = true;
      if (live) { live = false; io.emit("status", { live: false, user: username, stopped }); }
      failCount++;
      if (failCount >= MAX_RETRY) {
        stopped = true;
        analytics.finalize();   // 配信終了/再試行上限 → 配信データを確定保存
        if (levelbeta) try { levelbeta.endSession(); } catch (_) {}   // メンレベ履歴: 配信の終了時刻を確定
        io.emit("status", { live: false, user: username, stopped: true });
        logError("bridge", "warn", `@${username}: ${reason} が続いたため停止しました（${failCount}回）。配信中か、ユーザー名が正しいか確認してください。`);
        if (conn) { try { conn.disconnect(); } catch (e) {} conn = null; }
        return;
      }
      console.log(`⚠️  @${username}: ${reason} → ${RETRY_SEC}秒後に再試行（${failCount}/${MAX_RETRY}）`);
      setTimeout(() => connectLoop(myGen, username), RETRY_SEC * 1000);   // 予約時の myGen/username を使用（二重接続防止）
    };

    c.on(ControlEvent.DISCONNECTED || "disconnected", () => retry("切断"));
    c.on(WebcastEvent.STREAM_END || "streamEnd", () => { if (levelbeta) try { levelbeta.endSession(); } catch (_) {} retry("配信終了"); });
    c.on(ControlEvent.ERROR || "error", (err) => {
      const msg = errToStr(err);
      // 同じエラーの連発は抑制（直近10秒・同一内容はスキップ）してログが埋まらないように
      const now = Date.now();
      if (msg === lastTtErrMsg && now - lastTtErrAt < 10000) return;
      lastTtErrMsg = msg; lastTtErrAt = now;
      logError("bridge", "warn", "TikTok接続エラー: " + (msg || "(詳細なし)"), errDetail(err));
    });

    c.connect()
      .then((state) => {
        if (myGen !== gen) { try { c.disconnect(); } catch (e) {} return; }
        live = true; failCount = 0;
        // 配信データ: セッション開始（同一ユーザー継続/クラッシュ復帰の再開も analytics 側で判定）
        const title = pickRoomTitle(c, state);
        analytics.onConnected(username, title);
        if (levelbeta) try { levelbeta.onConnected(title); } catch (_) {}   // メンレベ履歴: 配信タイトルを記録（配信データOFFでも動く）
        // roomInfo は接続直後に未取得のことがあるため、少し後にもう一度タイトルを取りにいく
        if (!title) setTimeout(() => { try { if (myGen === gen) { const t = pickRoomTitle(c, null); analytics.maybeSetTitle(username, t); if (levelbeta) try { levelbeta.setSessionTitle(t); } catch (_) {} } } catch (_) {} }, 4000);
        io.emit("status", { live: true, user: username, stopped: false });
        console.log(`🔴 @${username} 配信中に接続しました`);
        loadGifts(c, myGen);
      })
      .catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        console.log(`⏳ @${username} はまだ配信していないようです: ${msg}`);
        retry("未配信");
      });
  }

  return {
    switchUser, restart, stopConnect, statusObj,
    get currentUser() { return currentUser; },
    get live() { return live; },
    get stopped() { return stopped; },
    get lastTotal() { return lastTotal; },
    get totalCoins() { return totalCoins; },
    get giftCatalog() { return giftCatalog; }
  };
}

module.exports = { createBridge };
