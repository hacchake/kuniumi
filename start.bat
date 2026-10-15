@echo off
rem KUNIUMI を開く（初回は部品を取り込むので少し時間がかかる）
cd /d %~dp0
if not exist node_modules (
  echo 部品を取り込んでいます...
  call npm install --no-fund --no-audit
)
start "" http://localhost:5194/
call npm run dev
