#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "=== Reiniciando Generador de Apuntes (Puerto 8002) ==="
PID=$(lsof -ti tcp:8002 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "Deteniendo proceso anterior en puerto 8002 (PID $PID)..."
  kill -9 $PID 2>/dev/null || true
  sleep 1
fi

echo "Iniciando servidor..."
exec /home/natalia/.nvm/versions/node/v26.13.0/bin/node --env-file=.env js/servidor.js
