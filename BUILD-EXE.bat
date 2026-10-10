@echo off
chcp 65001 >nul
title Soft^&Deep Sound - сборка
cd /d "%~dp0"

echo.
echo   Soft^&Deep Sound - сборка программы
echo   ----------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 goto :installnode
goto :build

:installnode
echo Node.js не найден - устанавливаю автоматически через winget...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto :nodefail
set "PATH=%PATH%;%ProgramFiles%\nodejs"
where node >nul 2>nul
if errorlevel 1 goto :nodefail

:build
echo [1/2] Скачиваю компоненты - это займёт пару минут...
call npm install
if errorlevel 1 goto :fail
echo.
echo [2/2] Собираю установщик и portable-версию...
call npm run dist
if errorlevel 1 goto :fail
echo.
echo   ГОТОВО! Открываю папку dist:
echo   SoftDeepSound-Setup-...exe     - установщик с ярлыком на рабочем столе
echo   SoftDeepSound-Portable-...exe  - один файл, запускается без установки
echo.
start "" "%~dp0dist"
pause
exit /b 0

:nodefail
echo.
echo Не получилось установить Node.js автоматически.
echo Откроется сайт - скачайте версию LTS, установите и запустите build.bat ещё раз.
start "" https://nodejs.org
pause
exit /b 1

:fail
echo.
echo Ошибка сборки. Сделайте скриншот этого окна и пришлите его.
pause
exit /b 1
