@echo off
chcp 65001 >nul
title stock-lens intraday monitor
cd /d %~dp0
echo ============================================
echo  stock-lens intraday monitor started (60s per tick)
echo  Buy-point hits will BEEP and print a banner here
echo  Close this window to stop monitoring
echo ============================================
node monitor.js --loop
pause
