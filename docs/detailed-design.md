# 詳細設計書 — LIVE Tools Webアプリ版

**バージョン**: v1.0.2 ／ **作成日**: 2026-07-14
**上位**: [basic-design.md](basic-design.md) ／ [requirements.md](requirements.md)

本書はモジュールごとの内部仕様（主要関数・アルゴリズム・データ構造・エラー処理）を定義する。関数シグネチャは各 `lib/*.js` の JSDoc を正とする。

---

## 1. server.js（HTTP・Socket.IO・起動）

### 1.1 ルーティング
- `http.createServer` のハンドラは全体を try-catch で囲み、例外時は `logError`＋500 JSON を返す（プロセスは落とさない）。
- `route(req,res)` が `pathname` をセグメント分割し、画面／デバッグ／Pavlok／メディア／`/api` へ振り分ける。
- 機能別ハンドラ: `routePavlok` / `routeApi`。設定・発動系（Pavlok）は先頭で `isLoopback()` を検査し、ローカル外は 403。
- `GET /api/features` はベータ機能の同梱状況 `{gamebeta,gachabeta,levelbeta}` を返す（[§7](#7-ベータ機能の任意読込)）。

### 1.2 ページ配信
- `serveOverlayPage(res,id,type,edit)`: `TYPES[type]` と `ID_RE`・`hasProfile` を検証 → HTML を読み、`</head>` 直前に `window.__LT_BOOT`（id/type/mode/sync/settings/version）を注入。JSON内 `<` は `<` へエスケープしてスクリプト破壊を防ぐ。編集時は戻るボタンCSSを注入。
- `servePublicHtml`: `APP_VERSION` を置換して配信。読込失敗は 500＋ログ。

### 1.3 ホットキー送信 `sendHotkey(combo,times)`（Windowsのみ）
- `comboToVks` が `ctrl+shift+a` 等を仮想キーコード列へ変換（修飾キー・名前付きキー・F1-12・テンキー対応）。
- PowerShell `keybd_event` を Base64（UTF-16LE）エンコードで実行。**finally で全修飾キーを必ず解放**（押しっぱなし防止）。`hkBusy` で多重注入抑止＋タイムアウトガード。

### 1.4 WIN／マイクラ同期
- `winGoalOf(pid)`: WIN設定 `goal`（未設定は既定10）。
- `emitWinCount(pid,extra)`: `win` と `alerts` 両ルームへ `{total,goal,...extra}`。`via:"add"` のみ演出発火、`via:"set"` は目標達成判定のみ。
- マイクラ同期: プロファイルごとに `mcSync[pid]={wins,up,ok,inflight}`。1秒間隔で `<url>/wins`（`{wins,goal,seq,up}`）を GET（timeout 1500ms・受信10KB上限）。`ECONNREFUSED`/timeout を日本語メッセージ化して `mcStatus` 配信。
  - **基準合わせ（delta=0）**: webapp起動直後の初回同期（`st.wins==null`）と、プラグイン再起動検知時。
  - **プラグイン再起動検知**: 前回の起動エポック `up` を `profiles.getMcUp/setMcUp`（`profiles.json` に永続）と突き合わせる。メモリではなくファイルに持つため、**webapp とマイクラを同時に再起動しても検知できる**。
  - **リセット検知**: 再起動でも初回でもないのに `st.wins>0 → j.wins===0` に落ちた＝マイクラ側 `/win reset`。
  - 再起動・リセットのときは差分ではなく `setWins(id,0)`＋`via:"set"`（±WIN演出は鳴らさず目標達成判定のみ）。それ以外は差分を `addWins`＋`via:"add"`。差分方式のままだと webapp とプラグインの累計がずれている場合に0へそろわないため。
  - **目標WIN数の追従**: `j.goal>=1` が現在の WIN設定 `goal` と違えば `putSettings` して `ov:<id>:win` へ `settings` を emit（`via:"goal"` の `winCount` も配信）。`goal=0`（未設定）は webapp 側の設定を尊重して上書きしない。
- **起動時のWINリセット**: `httpServer.listen` のコールバックで `profiles.resetAllWins()` を呼び、アプリ再起動ごとに累計WINを0から始める。socket再接続だけ（OBS/ブラウザのリロード）ではここを通らないため「リロードでは消えない」は保たれる。

### 1.5 起動・ポート引き継ぎ
- `EADDRINUSE` 時、Windows なら `takeOverPort()`（最大2回）: PowerShell で当該ポートを Listen する **node プロセスのみ** `Stop-Process`（他アプリは触らない）→ 1.5s 後に再 listen。
- `uncaughtException`/`unhandledRejection`/`SIGINT` を捕捉（SIGINT は analytics 確定＋設定保存後に終了）。

---

## 2. lib/profiles.js（設定ストア）

- `resolveDataDir()`: `LT_DATA_DIR` → `./data`（書込プローブ）→ `%LOCALAPPDATA%\LiveTools\webapp` の優先フォールバック。
- `genId()`: 紛らわしい文字を除く31文字アルファベットで8桁。最大20回衝突回避、失敗時は例外。
- 保存: `saveSoon()`（300ms debounce）→ `saveNow()`（tmp→rename のアトミック書込）。
- `TYPES`: URL type → `{sync, mode, rankMode, title, page}` 対応表。`sync` 文字列は **exe版クライアントと一致**させ HTML/JS を無改変で使う。
- WIN: `getWins`/`setWins`（±99999クランプ）/`addWins`/`resetAllWins()`（全プロファイルを0に。サーバー起動時に呼ぶ）。
- マイクラ同期の状態: `getMcUp(id)`/`setMcUp(id,up)` がプラグイン起動エポックをプロファイルに永続化（再起動検知用）。
- 状態: `loadState()`（欠損/破損時も既定値）/`saveState(patch)`（現在値にマージ）。

---

## 3. lib/tiktok.js（TikTokブリッジ）

- **フィールド正規化**: `giftValue`/`giftRepeat`/`giftType`/`giftId`/`giftName`/`giftUser`/`userNick`/`userAvatar`/`giftImage` がライブラリのバージョン差（camel/snake・ネスト差）を吸収。
- **高頻度イベントまとめ**: `EMIT_MS=150` 間隔で `flushEmits`。`like` は `pendingTaps`（上限4000）、`giftBatch` は `pendingGifts`（上限800）にためて1回で emit。
- **接続ループ** `connectLoop(myGen,username)`: `gen`（世代番号）で二重接続を防止。各イベントは `myGen!==gen` で無視。切断/配信終了/エラーは `retry()` で `RETRY_SEC`（既定20s）後に再試行、`MAX_RETRY`（既定5）超過で停止。TikTokエラーの連発は10秒同一内容抑制。
- **連打ギフト**: `giftType===1 && !repeatEnd` はストリーク中として無視し、確定時のみ集計（二重計上防止）。
- 各イベントで `analytics`（集計）へフックする（ベータ機能が同梱されていれば併せてフックするが、非同梱時は `null` ガードでスキップ＝[§7](#7-ベータ機能の任意読込)）。
- 制御: `switchUser`（別ユーザー切替で前配信を確定）/`restart`/`stopConnect`（分析確定・自動接続OFF）/`startFresh`。

---

## 4. lib/analytics.js（配信データ）

- 起動時、`live:true` のまま保存された配信＝異常終了とみなし `resumable:true` にする。あわせて `endedAt` が未設定/開始時刻のままのレコード（＝`finalize()` を通らず終わり「0分」表示になっていたもの）を、在室記録 `seen[].last` の最大値（`lastActivity(b)`）で補正する＝既存の壊れたデータも起動時に自動修復。
- `onConnected(user,title)`: ①同一ユーザー継続 ②`resumable` かつ同一ユーザーかつ20分以内→復帰 ③新規、のいずれか。
- 集計: `touch`（在室 first/last）/`onLike`/`onGift`/`onFollow`。`seen` は `SEEN_MAX=5000` で頭打ち。保存は `saveHistorySoon()`（5s debounce）。
- 表示整形: `broadcastSummary`（一覧用）/`broadcastDetail`（視聴者別いいね/コイン/watchMs をマージし coins→likes 降順）。
- `finalize()`: データ皆無の空配信は履歴から除去。`setOn(false)` で確定して停止。

---

## 5. lib/pavlok.js（Pavlok中継）

- 設定は mtime 監視で手編集も反映。安全上限: 強さ100・回数5・間隔下限1000ms・backlog上限200。
- 送信キュー `pump()`: `intervalMs` 間隔で1発ずつ。API v5 は `stimulusType/stimulusValue` 必須（旧 `type/value` も併送し互換確保）。401/403・timeout を日本語化。
- `trigger(type,value,count)`: 未設定トークンは即エラー。まとめ投げは backlog 空き分まで受け付け超過は破棄。

---

## 6. lib/log.js / lib/followers.js

### 6.1 log
- `logError(source,level,message,detail)`: 2秒以内の同一メッセージ連発は件数集約。最大300件（超過は古い順に破棄）。`errToStr`/`errDetail` で `[object Object]` を防ぐ。`setNotify` で `io.emit("errorCount")` を注入。

### 6.2 followers
- `isNewFollow(user)`: 初フォローのみ true（記録追加）。`MAX=50000` で古い順に破棄。保存は3s debounce。

---

## 7. ベータ機能の任意読込
`ゲーム連携β`・`ガチャβ`・`メンバーレベルβ` は開発中のため公開配布版には同梱しない。`server.js`・`lib/tiktok.js` は `optionalRequire(rel)`（`require.resolve` でファイル存在のみ判定・読込エラーは表面化）で該当モジュールを読み込み、無ければ `null` にする。

- ルート（`/gamebeta` `/gachabeta` `/levelbeta` `/game`）は該当モジュールが `null` なら 404。
- 起動時の `init()` 呼び出し、TikTokイベントのフック（`onGift`/`onLike`/`onFollow`/`onComment`/`onUser`）は `if (mod)` ガードでスキップ。
- `GET /api/features` が `{gamebeta:!!gamebeta, gachabeta:!!gachabeta, levelbeta:!!levelbeta}` を返し、`admin.html` が☰メニュー内のβ項目の表示可否に使う。
- メンバーレベルβ向けに `lib/tiktok.js` の `teamLevel(u)` が `user.fansClubInfo.fansLevel`（文字列）と `user.fansClub.data.level`（数値）の2系統からチームレベルを拾い、有効な方を採用する（配信・ライブラリのバージョンでどちらが載るか変わるため）。

これにより **同一コードのまま、β同梱環境＝機能あり／公開clone＝機能なし**で正常起動する。

---

## 8. エラーハンドリング方針（横断）
- **ファイルI/Oは常に try-catch**。読込失敗は既定値、書込失敗は `logError` して継続。
- **外部通信（TikTok/Pavlok/マイクラ同期）は timeout＋エラーの日本語化**。1件の失敗が全体を止めない。
- **プロセス全体**の想定外例外（`uncaughtException`/`unhandledRejection`）も捕捉して `/debug` に残す。
