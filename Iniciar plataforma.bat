@echo off
title BusinessCool IA - Portal
cd /d "%~dp0"
echo ============================================
echo   BusinessCool IA - Portal seguro
echo ============================================
echo.
echo Iniciando servidor... NO cierres esta ventana
echo mientras uses la plataforma.
echo.
echo Abre en tu navegador:  http://localhost:3000
echo.
echo (Para detener el servidor, cierra esta ventana
echo  o presiona Ctrl + C)
echo ============================================
echo.
node src/server.js
echo.
echo El servidor se detuvo.
pause
