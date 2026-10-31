@echo off
rem Put the Voice Agent flow library online (Cloudflare). Needs Node.js 18+.
cd /d "%~dp0"
call npm install
node deploy.mjs
pause
