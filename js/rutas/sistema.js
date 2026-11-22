import { Router } from "express";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { config } from "../modulos/configuracion.js";
import { comprobarModelo } from "../modulos/modelo.js";
import { rutaAsincrona } from "../modulos/consultas-ia.js";

const execFileAsync = promisify(execFile);
const subidaPdf = multer({ limits: { fileSize: 50 * 1024 * 1024 } });
const directorioActual = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

router.post("/api/extraer-pdf", subidaPdf.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Falta archivo PDF" });
  const tmpPath = path.join(os.tmpdir(), `pdf-extraer-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    await writeFile(tmpPath, req.file.buffer);
    const { stdout } = await execFileAsync("pdftotext", [tmpPath, "-"]);
    res.json({ ok: true, texto: stdout });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
});

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

router.get("/api/configuracion", (_solicitud, respuesta) => {
  respuesta.json({
    urlTests: config.urlTests,
    model: config.model,
    notesRoot: config.notesRoot,
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
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
