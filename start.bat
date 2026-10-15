@echo off
rem KUNIUMI をローカルサーバーで開く
cd /d %~dp0
start "" http://localhost:5194/
py serve.py 5194 || python serve.py 5194
