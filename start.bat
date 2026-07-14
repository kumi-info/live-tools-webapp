@echo off
rem LIVE Tools Webアプリ版 起動用（ダブルクリックでOK）
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js が見つかりません。https://nodejs.org から LTS 版をインストールしてください。 & pause & exit /b 1)
if not exist node_modules (
  echo 初回セットアップ中です（1～2分かかります）...
  call npm install --omit=dev --no-audit --no-fund || (echo セットアップに失敗しました。ネット接続を確認してください。 & pause & exit /b 1)
)
node server.js
pause