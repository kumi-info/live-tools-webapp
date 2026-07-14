# 基本設計書（機能設計） — LIVE Tools Webアプリ版

**バージョン**: v1.0.0 ／ **作成日**: 2026-07-14
**上位**: [requirements.md](requirements.md) ／ **下位**: [detailed-design.md](detailed-design.md)

本書は「何を・どう分割して実現するか」（アーキテクチャ・モジュール責務・データ・通信）を定義する。個々の関数仕様・アルゴリズムは詳細設計書に記す。

---

## 1. システム構成

```
                      ┌──────────────────────── 1台のPC（配信者） ────────────────────────┐
                      │                                                                    │
   TikTok LIVE ──────►│  tiktok-live-connector ─► lib/tiktok.js（ブリッジ・共有1本）        │
                      │        │  like/coins/giftBatch を io.emit（全体配信）               │
                      │        └─► lib/analytics.js（配信データ集計）                      │
                      │                                                                    │
   OBS ブラウザソース ─┼─ HTTP/Socket.IO ─► server.js（HTTPルーティング＋Socket.IO＋起動）  │
   ブラウザ（管理/設定）│        ├─ lib/profiles.js（設定ストア）─► data/*.json             │
   TikFinity/STE ────►│        └─ lib/pavlok.js ─► Pavlok Cloud API                       │
                      └────────────────────────────────────────────────────────────────┘
```

- **単一プロセス**。`server.js` が HTTP サーバーと Socket.IO サーバーを1つの `httpServer` に相乗りさせ、`lib/*.js` を統括する。
- **TikTok接続は全プロファイル共有の1本**（配信者は1人）。データイベントは全オーバーレイへグローバル配信し、設定・WIN等はプロファイルID単位のルームへ限定配信する。

---

## 2. モジュール責務一覧

| モジュール | 責務 | 主な依存 | 永続先 |
|---|---|---|---|
| `server.js` | HTTPルーティング・Socket.IO・ページ配信・メディア配信/アップロード・ホットキー送信・起動/ポート引き継ぎ | 全 lib | — |
| `lib/log.js` | エラーログ集約（source/level/detail・連発集約・`/debug` 表示・io通知） | — | メモリ（最大300件） |
| `lib/profiles.js` | オーバーレイ設定ストア（プロファイルCRUD・設定/WIN/アプリ状態） | log | `profiles.json`/`state.json` |
| `lib/tiktok.js` | TikTok LIVE 接続ブリッジ・イベント正規化・再接続・データ配信 | analytics/followers | — |
| `lib/analytics.js` | 配信データ集計（視聴者別いいね/コイン/視聴時間・セッション管理・復帰） | log/profiles | `broadcasts.json` |
| `lib/pavlok.js` | Pavlok中継（設定・送信キュー・安全上限） | log/profiles | `pavlok.json` |
| `lib/followers.js` | フォロー済み記録（リフォロー除外） | profiles | `followers_seen.json` |

- **1ファイル1責務**。肥大化しやすい `server.js` はルーティングを機能別ハンドラ（`routePavlok`/`routeApi`）へ分割している。

---

## 3. 画面・エンドポイント設計

### 3.1 ページ（HTML）
`public/` に静的HTMLを置き、配信時に `APP_VERSION` とブート情報（ID・保存済み設定）を注入して返す（no-cache）。

| パス | ファイル | 用途 |
|---|---|---|
| `/` | admin.html | 管理画面（接続・プロファイル一覧） |
| `/help` `/news` | help/news.html | 使い方・お知らせ |
| `/analytics` | analytics.html | 配信分析 |
| `/overlay/<id>/<type>` | overlay/win/alert.html | OBS表示（ブート注入） |
| `/edit/<id>/<type>` | 同上 | 設定編集（戻るボタン注入） |
| `/pavlok` `/debug` | サーバー生成HTML | Pavlok設定・デバッグ |

### 3.2 REST API（`/api/*` ほか）
- `GET /api/version` `GET /api/features` `GET /api/status` — 状態・機能同梱状況
- `POST /api/connect` `POST /api/disconnect` — 接続制御
- `GET/POST/PATCH/DELETE /api/profiles[/:id]` — プロファイルCRUD
- `GET/PUT /api/overlay/:id/:type/settings` — 設定取得/保存
- `POST /api/media?name=` `DELETE /api/media/:file` — メディア
- `/pavlok/*` — Pavlok中継（**設定・発動系は既定ループバック限定**）

### 3.3 Socket.IO イベント（抜粋）
- 受信ページ→サーバー: `setUser`/`stopConnect`/`setSettings`/`getSettings`/`winAdd`/`winSet`/`sendHotkey`/`clientError` 等
- サーバー→ページ: `status`/`like`/`coins`/`giftBatch`/`giftList`/`settings`/`winCount`/`errorCount`/`appVersion`/`broadcasts` 等
- **ルーム設計**: `ov:<id>:<sync>`（オーバーレイのプロファイル×種類）。

---

## 4. データ設計（`data/`）

| ファイル | 内容 | 公開 |
|---|---|---|
| `profiles.json` | プロファイル・メーター設定・WIN数 | ✗（.gitignore） |
| `state.json` | 接続先ユーザー・自動接続・分析ON/OFF | ✗ |
| `broadcasts.json` | 配信データ（直近50・視聴者別） | ✗ |
| `pavlok.json` | Pavlokトークン・設定 | ✗ |
| `followers_seen.json` | フォロー済みID | ✗ |
| `media/` | アップロード済み演出メディア | ✗ |

- **書込方針**: 設定はデバウンス（300ms〜5s）＋アトミック書込（tmp→rename）でクラッシュ耐性を持たせる。書込不可時は `%LOCALAPPDATA%\LiveTools\webapp\` へフォールバック。

---

## 5. 主要データフロー

### 5.1 設定変更の即時反映（URL不変）
1. `/edit/<id>/<type>` で設定変更 → Socket `setSettings`（または `PUT settings`）
2. `profiles.putSettings` が保存 → 同一 `ov:<id>:<sync>` ルームへ `settings` 配信
3. 開いている OBS ソースが受信して即時反映（URLは貼り直さない）

### 5.2 いいね／ギフトの集計・配信
1. TikTokイベント → `lib/tiktok.js` が正規化（バージョン差吸収）
2. `analytics.onLike`/`onGift`（取得ON時のみ集計）＋ 約150ms間隔で `like`/`coins`/`giftBatch` を全オーバーレイへ emit

### 5.3 コイン目標達成 → WIN → 演出
1. コインメーターが目標到達 → `winAdd`
2. `profiles.addWins` → `emitWinCount`（win/alertsルーム両方へ `via:"add"`）
3. WINカウンターが更新、演出オーバーレイが ＋WIN/目標達成トリガーで演出

### 5.4 マイクラ WIN の自動反映
- 1秒ごとに CommonWIN プラグインの `<url>/wins` をポーリングし、`up`（プラグイン再起動）変化は基準合わせ、以降の差分を `addWins` して配信。

---

## 6. セキュリティ設計（要点）
- 設定・発動系エンドポイント（Pavlok等）は `isLoopback()` で既定ローカル限定（`allowLan` で明示解放）。
- メディア配信/削除は `safeBase()`＋ベースディレクトリ一致でパストラバーサルを防止。
- リクエストボディは1MB（メディアは50MB）上限。
- 視聴者データ・トークン等の秘密情報は端末外へ送信せず、公開リポジトリからは `.gitignore` で除外。

---

## 7. ベータ機能について
`ゲーム連携β`・`ガチャβ` は開発中のベータ機能のため、**公開配布版（本リポジトリ）には同梱していない**。`server.js`・`lib/tiktok.js` は該当モジュールが存在しなくても起動できるよう任意読込＋ガードで実装しており、`GET /api/features` が同梱状況（`{gamebeta,gachabeta}`）を返す。管理画面はこの値でβボタンの表示可否を切り替える。
