@echo off
rem KUNIUMI をローカルサーバーで開く
cd /d %~dp0
start "" http://localhost:5194/
py -m http.server 5194 || python -m http.server 5194
