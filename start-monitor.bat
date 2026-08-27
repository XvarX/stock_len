@echo off
chcp 65001 >nul
title stock-lens 盘中监控哨兵
cd /d %~dp0
echo ============================================
echo  stock-lens 盘中监控已启动 (每60秒一轮)
echo  触发买点时本窗口会弹出强提醒并蜂鸣
echo  关闭本窗口即停止监控
echo ============================================
node monitor.js --loop
pause
