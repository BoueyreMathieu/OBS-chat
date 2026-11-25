#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "ERREUR: Node.js 20+ est requis."
  exit 1
fi
APP_VERSION="$(node -p "require('./package.json').version")"
echo "=== OBS Chat Prototype V${APP_VERSION} ==="
if [ ! -f node_modules/@grpc/grpc-js/package.json ]; then
  npm install
fi
npm run build
npm start
