/**
 * lib/log.js — エラーログの集約（/debug で一覧確認できる）
 * tiktok-bridge.js のエラーログ機構を移植。io への通知は setNotify() で注入する。
 */

const errorLog = [];
const MAX_ERRLOG = 300;
let notify = null;   // (count) => void。io.emit("errorCount", n) を server.js から注入

function setNotify(fn) { notify = fn; }

// エラー値を読める文字列に（[object Object]を防ぐ）。message優先→主要フィールド→JSON。
function errToStr(e) {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  const parts = [];
  for (const k of ["name", "code", "type", "statusCode", "reason", "description", "error"]) {
    if (e[k] != null && typeof e[k] !== "object") parts.push(k + "=" + e[k]);
  }
  if (parts.length) return parts.join(" ");
  try { const s = JSON.stringify(e); if (s && s !== "{}") return s; } catch (_) {}
  if (typeof e === "object") return "(" + ((e.constructor && e.constructor.name) || "Object") + "型のエラー・詳細なし)";
  return String(e);
}

// 詳細（スタック or 全フィールドのJSON）
function errDetail(e) {
  if (!e || typeof e !== "object") return "";
  if (e.stack) return String(e.stack);
  try { return JSON.stringify(e, Object.getOwnPropertyNames(e), 2); } catch (_) {}
  try { return JSON.stringify(e); } catch (_) { return ""; }
}

function logError(source, level, message, detail) {
  const e = {
    t: Date.now(), source: source || "server", level: level || "error",
    message: typeof message === "string" ? message : errToStr(message),
    detail: detail ? (typeof detail === "string" ? detail : errDetail(detail)) : ""
  };
  // 直近と同一メッセージの連発はまとめる（件数のみ加算）。ログ肥大・負荷を防ぐ。
  const last = errorLog[errorLog.length - 1];
  if (last && last.message === e.message && last.source === e.source && (e.t - last.t) < 2000) {
    last.t = e.t; last.n = (last.n || 1) + 1;
    try { if (notify) notify(errorLog.length); } catch (_) {}
    return;
  }
  errorLog.push(e);
  if (errorLog.length > MAX_ERRLOG) errorLog.shift();
  try { (e.level === "warn" ? console.warn : console.error)("🐞[" + e.source + "] " + e.message + (e.detail ? " | " + e.detail.split("\n")[0] : "")); } catch (_) {}
  try { if (notify) notify(errorLog.length); } catch (_) {}
}

function clearErrors() {
  errorLog.length = 0;
  try { if (notify) notify(0); } catch (_) {}
}

module.exports = { errorLog, errToStr, errDetail, logError, clearErrors, setNotify };
