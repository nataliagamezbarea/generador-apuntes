import { appendFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./configuracion.js";

export const seguimientosGeneracion = new Map();
export const controladoresGeneracion = new Map();
export const generacionesPendientes = new Map();
export const trabajosEtapasActivos = new Set();
export const maxReintentosTemporalesEtapas = 5;

export function actualizarProgreso(id, datos) {
  if (!/^[\da-f-]{36}$/i.test(id)) return;
  if (
    seguimientosGeneracion.get(id)?.fase === "cancelado" &&
    datos.fase !== "cancelado"
  )
    return;
  for (const [anteriorId, anterior] of seguimientosGeneracion) {
    if (Date.now() - anterior.actualizado > 30 * 60 * 1000) {
      seguimientosGeneracion.delete(anteriorId);
    }
  }
  seguimientosGeneracion.set(id, {
    ...datos,
    actualizado: Date.now(),
  });
  while (seguimientosGeneracion.size > 100) {
    seguimientosGeneracion.delete(seguimientosGeneracion.keys().next().value);
  }
}

export async function registrarLogGeneracion(id, mensaje, nivel = "INFO") {
  const timestamp = new Date().toLocaleTimeString("es-ES", { hour12: false });
  const etiqueta = id ? `[${id.slice(0, 8)}]` : "[GENERAL]";
  const linea = `[${timestamp}] ${nivel} ${etiqueta} ${mensaje}\n`;
  try {
    const rutaEnApuntes = path.join(config.notesRoot, "generacion.log");
    await appendFile(rutaEnApuntes, linea, "utf8").catch(() => {});
    if (id) {
      const rutaEnTrabajo = path.join(
        config.generationReportsRoot,
        ".procesamiento",
        id,
        "generacion.log",
      );
      await appendFile(rutaEnTrabajo, linea, "utf8").catch(() => {});
    }
  } catch {}
}
