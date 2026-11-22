#!/usr/bin/env bash
set -e
DIR="/home/natalia/Escritorio/generador-apuntes"
cd "$DIR"

# 1. Asegurar Docker activo
if ! docker info >/dev/null 2>&1; then
  sudo -n systemctl start docker 2>/dev/null || sudo -n service docker start 2>/dev/null || true
  sleep 2
fi

# 2. Asegurar contenedor Ollama corriendo
if ! docker ps --filter "name=^/generador-apuntes-ollama$" --format "{{.Names}}" | grep -q "^generador-apuntes-ollama$"; then
  docker start generador-apuntes-ollama 2>/dev/null || \
  docker compose -f "$DIR/docker/composicion.yaml" up -d ollama 2>/dev/null || true
  sleep 2
fi

# 3. Detectar IP de Ollama y actualizar .env si cambió
OLLAMA_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' generador-apuntes-ollama 2>/dev/null || true)
if [ -n "$OLLAMA_IP" ]; then
  sed -i "s|^DIRECCION_OLLAMA=.*|DIRECCION_OLLAMA=http://${OLLAMA_IP}:11434|" "$DIR/.env"
fi

# 4. Detener proceso anterior en el puerto 8002
PID=$(lsof -ti tcp:8002 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PID" ]; then
  kill -9 $PID 2>/dev/null || true
  sleep 1
fi

# 5. Localizar Node.js
NODE_BIN="/home/natalia/.nvm/versions/node/v26.13.0/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || echo "node")
fi

# 6. Iniciar servidor en segundo plano
nohup "$NODE_BIN" --env-file=.env js/servidor.js > "$DIR/servidor.log" 2>&1 &

# 7. Esperar a que el servidor responda
LISTO=0
for i in {1..40}; do
  if curl -s -o /dev/null http://localhost:8002/ ; then
    LISTO=1
    break
  fi
  sleep 0.5
done

# 8. Notificar y abrir navegador
if [ $LISTO -eq 1 ]; then
  notify-send -i accessories-text-editor "Generador de Apuntes (WEC)" "Iniciado correctamente en http://localhost:8002/" 2>/dev/null || true
  xdg-open "http://localhost:8002/" 2>/dev/null || sensible-browser "http://localhost:8002/" 2>/dev/null || true
else
  notify-send -u critical -i dialog-error "Generador de Apuntes" "Error al iniciar el servidor en el puerto 8002. Revisa servidor.log" 2>/dev/null || true
fi
