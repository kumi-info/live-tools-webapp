/**
 * lib/followers.js — フォロー済みユーザーの記録（リフォロー除外用）
 *
 * 一度フォローが検知されたユーザーIDを data/followers_seen.json に永続保存し、
 * 同じ人の再フォロー（外して付け直し）ではフォロー演出・ゲーム連携を発動させない。
 *
 * 使い方: followers.isNewFollow(user) — 初フォローなら true を返して記録する。
 * リセットしたいときは resetAll()（設定ページ等から）。
 */

const fs = require("fs");
const path = require("path");
const profiles = require("./profiles");

const FILE = path.join(profiles.DATA_DIR, "followers_seen.json");
const MAX = 50000;   // 記録の上限（超えたら古い順に捨てる）

let list = null;    // 順序維持（古い順）
let set = null;
let saveTimer = null;

function load() {
  if (set) return;
  list = []; set = new Set();
  try {
    let raw = fs.readFileSync(FILE, "utf8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : (Array.isArray(j.users) ? j.users : []);
    for (const u of arr) {
      const s = String(u || "");
      if (s && !set.has(s)) { set.add(s); list.push(s); }
    }
  } catch (_) {}
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify({ users: list }), "utf8");
    } catch (_) {}
  }, 3000);
}

/** 初フォローなら true（記録に追加）。既知＝リフォローなら false */
function isNewFollow(user) {
  const u = String(user || "");
  if (!u) return false;
  load();
  if (set.has(u)) return false;
  set.add(u); list.push(u);
  while (list.length > MAX) { const old = list.shift(); set.delete(old); }
  saveSoon();
  return true;
}

function count() { load(); return list.length; }
function resetAll() {
  list = []; set = new Set();
  try { fs.writeFileSync(FILE, JSON.stringify({ users: [] }), "utf8"); } catch (_) {}
}

module.exports = { isNewFollow, count, resetAll };
