import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../modulos/configuracion.js";
import { comprobarModelo } from "../modulos/modelo.js";
import { rutaAsincrona } from "../modulos/consultas-ia.js";

const directorioActual = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

router.post("/api/reiniciar-servidor", async (_request, respuesta) => {
  respuesta.json({ ok: true, mensaje: "Reiniciando servidor..." });
  setTimeout(async () => {
    try {
      const { spawn } = await import("node:child_process");
      const rutaLanzar = path.join(directorioActual, "..", "..", "lanzar.sh");
      const hijo = spawn("bash", [rutaLanzar], {
        detached: true,
        stdio: "ignore",
      });
      hijo.unref();
      setTimeout(() => process.exit(0), 400);
    } catch (e) {
      console.error("Error al reiniciar servidor:", e);
      process.exit(1);
    }
  }, 200);
});

router.get("/api/health", async (request, respuesta) => {
  const modeloSolicitado = request.query.model || config.model;
  let model = { connected: false, modelAvailable: false };
  let error;
  try {
    model = await comprobarModelo(modeloSolicitado);
  } catch (issue) {
    error = issue.message;
  }
  respuesta.json({
    provider: "ollama local",
    model: modeloSolicitado,
    ...model,
    ...(error ? { error } : {}),
  });
});

router.get(
  "/api/log",
  rutaAsincrona(async (_solicitud, respuesta) => {
    const rutaEnApuntes = path.join(config.notesRoot, "generacion.log");
    const contenido = await readFile(rutaEnApuntes, "utf8").catch(
      () => "Sin registros disponibles todavía.",
    );
    respuesta.type("text/plain; charset=utf-8").send(contenido);
  }),
);

export default router;
