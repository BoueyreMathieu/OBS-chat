@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo ERREUR: Node.js n'est pas installe ou n'est pas dans le PATH.
  echo Installe Node.js 20+ puis relance ce fichier.
  pause
  exit /b 1
)

for /f "delims=" %%V in ('node -p "require('./package.json').version"') do set "APP_VERSION=%%V"
echo === OBS Chat Prototype V%APP_VERSION% ===

if not exist node_modules\@grpc\grpc-js\package.json (
  echo Installation / mise a jour des dependances...
  call npm install
  if errorlevel 1 goto :error
)

echo Compilation TypeScript...
call npm run build
if errorlevel 1 goto :error

echo.
echo Dashboard: http://127.0.0.1:4242/
echo Console:   http://127.0.0.1:4242/chat
echo Overlay:   http://127.0.0.1:4242/overlay/feed
echo Persist:   http://127.0.0.1:4242/overlay/feed?persist=1

echo.
echo Laisse cette fenetre ouverte pendant le test.
echo.
call npm start
exit /b %errorlevel%

:error
echo.
echo Une erreur est survenue.
pause
exit /b 1
