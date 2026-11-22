import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./modulos/configuracion.js";
import {
  controladoresGeneracion,
  actualizarProgreso,
} from "./modulos/estado-trabajos.js";
import { reanudarTrabajosEtapasAlArrancar } from "./modulos/motor-etapas.js";

// Importar rutas modulares
import sistemaRutas from "./rutas/sistema.js";
import apuntesRutas from "./rutas/apuntes.js";
import generacionRutas from "./rutas/generacion.js";

const aplicacion = express();
const directorioActual = path.dirname(fileURLToPath(import.meta.url));

aplicacion.disable("x-powered-by");
aplicacion.use(express.json({ limit: "3mb" }));
aplicacion.use(
  "/interfaz",
  express.static(path.join(directorioActual, "..", "interfaz")),
);
aplicacion.use("/css", express.static(path.join(directorioActual, "..", "css")));
aplicacion.use("/js", express.static(directorioActual));

aplicacion.get("/", (_request, respuesta) =>
  respuesta.sendFile(
    path.join(directorioActual, "..", "interfaz", "generador.html"),
  ),
);
aplicacion.get("/mejorar", (_request, respuesta) =>
  respuesta.sendFile(
    path.join(directorioActual, "..", "interfaz", "revisar.html"),
  ),
);

// Registrar módulos de rutas
aplicacion.use(sistemaRutas);
aplicacion.use(apuntesRutas);
aplicacion.use(generacionRutas);

// Manejador centralizado de errores
aplicacion.use((error, solicitud, respuesta, _next) => {
  const idProgreso = String(solicitud.body?.progress_id ?? "");
  const cancelada =
    error.status === 499 ||
    (error.message === "Request aborted" && !Number.isInteger(error.status)) ||
    (Boolean(idProgreso) &&
      controladoresGeneracion.get(idProgreso)?.signal.aborted);
  if (cancelada) {
    actualizarProgreso(idProgreso, {
      fase: "cancelado",
      mensaje: "Generación detenida",
      detalle:
        "La petición y las llamadas activas se han cancelado. No se guardaron apuntes.",
    });
  } else {
    actualizarProgreso(idProgreso, {
      fase: "error",
      mensaje: "No se pudo completar esta etapa",
      detalle: error.message || "Error inesperado durante la generación.",
    });
  }
  if (error instanceof multer.MulterError) {
    const detail =
      error.code === "LIMIT_FILE_SIZE"
        ? `Los archivos superan MAX_MB_SUBIDA (${config.maxUploadBytes / 1024 / 1024} MB).`
        : error.message;
    return respuesta
      .status(
        error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FILE_COUNT"
          ? 413
          : 400,
      )
      .json({ detail });
  }
  const status = cancelada
    ? 499
    : Number.isInteger(error.status)
      ? error.status
      : 500;
  if (status >= 500) console.error("Error en el servidor:", error);
  respuesta.status(status).json({
    detail:
      status < 500
        ? error.message
        : "Error interno. Consulta el registro de Docker.",
  });
});

const servidorHttp = aplicacion.listen(config.port, "0.0.0.0", () => {
  console.log(`Generador de apuntes listo en el puerto ${config.port}.`);
  console.log(`Carpeta de apuntes: ${config.notesRoot}`);
  console.log(
    `Modelo visión/texto: ${config.model} · Modelo código: ${config.codeModel}`,
  );
  void reanudarTrabajosEtapasAlArrancar();
});
servidorHttp.timeout = 0;
servidorHttp.keepAliveTimeout = 0;
servidorHttp.headersTimeout = 0;
servidorHttp.requestTimeout = 0;

export default aplicacion;
