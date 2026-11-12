#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "=== Comprobando servicios necesarios ==="

# 1. Asegurar Docker
if ! docker info >/dev/null 2>&1; then
  echo "Iniciando servicio Docker..."
  sudo -n systemctl start docker 2>/dev/null || sudo -n service docker start 2>/dev/null || true
  sleep 2
fi

# 2. Asegurar contenedor Ollama
if ! docker ps --filter "name=^/generador-apuntes-ollama$" --format "{{.Names}}" | grep -q "^generador-apuntes-ollama$"; then
  echo "Iniciando contenedor Ollama (generador-apuntes-ollama)..."
  docker start generador-apuntes-ollama 2>/dev/null || \
  docker compose -f "$DIR/docker/composicion.yaml" up -d ollama 2>/dev/null || true
  sleep 2
else
  echo "[✓] Contenedor Ollama activo."
fi

# 3. Detectar IP de Ollama y actualizar .env si cambió
OLLAMA_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' generador-apuntes-ollama 2>/dev/null || true)
if [ -n "$OLLAMA_IP" ]; then
  sed -i "s|^DIRECCION_OLLAMA=.*|DIRECCION_OLLAMA=http://${OLLAMA_IP}:11434|" "$DIR/.env"
  echo "[✓] Ollama configurado en http://${OLLAMA_IP}:11434"
fi

# 4. Detener proceso anterior en el puerto 8002
PID=$(lsof -ti tcp:8002 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "Deteniendo proceso anterior en puerto 8002 (PID $PID)..."
  kill -9 $PID 2>/dev/null || true
  sleep 1
fi

# 5. Localizar Node.js
NODE_BIN="/home/natalia/.nvm/versions/node/v26.13.0/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || echo "node")
fi

echo "[✓] Iniciando servidor en puerto 8002..."
# Abrir el navegador automáticamente en cuanto el servidor responda
(
  for i in {1..40}; do
    if curl -s -o /dev/null http://localhost:8002/ ; then
      xdg-open "http://localhost:8002/" 2>/dev/null || sensible-browser "http://localhost:8002/" 2>/dev/null || true
      break
    fi
    sleep 0.5
  done
) &

exec "$NODE_BIN" --env-file=.env js/servidor.js
