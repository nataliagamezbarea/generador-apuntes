import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import { config } from "./configuracion.js";
import { componenteSeguro } from "./apuntes.js";

// Aislar la carpeta temporal por usuario para evitar colisiones y permisos
// heredados de ejecuciones anteriores (por ejemplo, contenedores root).
const identificadorUsuario =
  typeof process.getuid === "function" ? process.getuid() : "usuario";
export const subidaTemporal = path.join(
  os.tmpdir(),
  `generador-apuntes-subidas-${identificadorUsuario}`,
);
await mkdir(subidaTemporal, { recursive: true }).catch(() => {});

export const subida = multer({
  storage: multer.diskStorage({
    destination: (_solicitud, _archivo, callback) =>
      callback(null, subidaTemporal),
    filename: (_solicitud, archivo, callback) =>
      callback(
        null,
        `subida-${randomUUID()}-${componenteSeguro(archivo.originalname)}`,
      ),
  }),
  limits: {
    fileSize:
      config.maxUploadBytes === Infinity ? undefined : config.maxUploadBytes,
    files:
      config.maxUploadFiles === Infinity ? undefined : config.maxUploadFiles,
  },
});
