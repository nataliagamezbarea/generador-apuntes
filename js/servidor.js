import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./modulos/configuracion.js";
import {
  comprobarModelo,
  consultarModeloIA,
  traducirLatexAEspanolConIA,
  detectarCatalanConIA,
  traducirTituloYNombreConIA,
} from "./modulos/modelo.js";
import {
  esBibliotecaTerceraParte,
  extraerMateriales,
  textoMaterial,
} from "./modulos/material.js";
import {
  obtenerInformeGeneracion,
  listarHistorialGeneraciones,
  eliminarInformeGeneracion,
  inspeccionarReemplazosGeneracion,
  listarApuntes,
  listarAsignaturas,
  normalizarResultadoIA,
  convertirMarkdownALatexWec,
  crearNombreArchivo,
  deducirSlugConceptual,
  leerApunte,
  componenteSeguro,
  limpiarLatex,
  guardarGeneracion,
  guardarApunte,
  crearCarpetaAsignatura,
  rutaInformeGeneracion,
  aplicarEstilosLatex,
  detectarCatalan,
  esTituloDePlantilla,
} from "./modulos/apuntes.js";
import {
  cargarReferenciaBiblioteca,
  dividirMaterial,
  dividirMaterialConImagenes,
  detectarApartadosEnTexto,
  dividirTextoPorApartados,
  dividirCodigoEnBloques,
  crearPromptCodigoPorTemas,
  procesarEnParalelo,
  crearPromptApuntes,
  sistemaApuntes,
  sistemaMejora,
  sistemaCodigoPorTemas,
  sistemaReescrituraDidactica,
  evaluarCoberturaMaterial,
} from "./modulos/instrucciones.js";
import {
  cargarExtraccionTrabajo,
  cargarTrabajoEtapas,
  crearTrabajoEtapas,
  pausarTrabajoEtapas,
  buscarTrabajoEtapasReutilizable,
  trabajoCoincideConArchivos,
  eliminarTrabajoEtapas,
  guardarExtraccionTrabajo,
  guardarExtraccionesPorTema,
  guardarTrabajoEtapas,
  limpiarFuentesTrabajo,
  leerFuenteTrabajo,
  listarTrabajosEtapas,
  reiniciarEtapaTrabajo,
} from "./modulos/trabajos-etapas.js";
import {
  buscarEnInternet,
  buscarFuentesOpcionales,
  crearConsultasInvestigacion,
} from "./modulos/investigacion.js";

const aplicacion = express();
const directorioActual = path.dirname(fileURLToPath(import.meta.url));
const seguimientosGeneracion = new Map();
const controladoresGeneracion = new Map();
const generacionesPendientes = new Map();
const trabajosEtapasActivos = new Set();
const maxReintentosTemporalesEtapas = 5;

export async function registrarLogGeneracion(id, mensaje, nivel = "INFO") {
  const timestamp = new Date().toLocaleTimeString("es-ES", { hour12: false });
  const etiqueta = id ? `[${id.slice(0, 8)}]` : "[GENERAL]";
  const linea = `[${timestamp}] ${nivel} ${etiqueta} ${mensaje}\n`;
  try {
    const rutaEnApuntes = path.join(config.notesRoot, "generacion.log");
    await appendFile(rutaEnApuntes, linea, "utf8").catch(() => {});
    if (id) {
      const rutaEnTrabajo = path.join(config.generationReportsRoot, ".procesamiento", id, "generacion.log");
      await appendFile(rutaEnTrabajo, linea, "utf8").catch(() => {});
    }
  } catch {}
}

// Aislar la carpeta temporal por usuario para evitar colisiones y permisos
// heredados de ejecuciones anteriores (por ejemplo, contenedores root).
const identificadorUsuario = typeof process.getuid === "function" ? process.getuid() : "usuario";
const subidaTemporal = path.join(os.tmpdir(), `generador-apuntes-subidas-${identificadorUsuario}`);
await mkdir(subidaTemporal, { recursive: true }).catch(() => {});

const subida = multer({
  storage: multer.diskStorage({
    destination: (_solicitud, _archivo, callback) => callback(null, subidaTemporal),
    filename: (_solicitud, archivo, callback) =>
      callback(null, `subida-${randomUUID()}-${componenteSeguro(archivo.originalname)}`),
  }),
  limits: {
    fileSize: config.maxUploadBytes === Infinity ? undefined : config.maxUploadBytes,
    files: config.maxUploadFiles === Infinity ? undefined : config.maxUploadFiles,
  },
});

aplicacion.disable("x-powered-by");
aplicacion.use(express.json({ limit: "3mb" }));
aplicacion.use("/interfaz", express.static(path.join(directorioActual, "..", "interfaz")));
aplicacion.use("/css", express.static(path.join(directorioActual, "..", "css")));
aplicacion.use("/js", express.static(directorioActual));

aplicacion.get("/", (_request, respuesta) =>
  respuesta.sendFile(path.join(directorioActual, "..", "interfaz", "generador.html")),
);
aplicacion.get("/mejorar", (_request, respuesta) =>
  respuesta.sendFile(path.join(directorioActual, "..", "interfaz", "revisar.html")),
);

aplicacion.get("/api/health", async (_request, respuesta) => {
  let model = { connected: false, modelAvailable: false };
  let error;
  try {
    model = await comprobarModelo();
  } catch (issue) {
    error = issue.message;
  }
  respuesta.json({
    provider: "ollama local",
    model: config.model,
    ...model,
    ...(error ? { error } : {}),
  });
});

aplicacion.get(
  "/api/log",
  rutaAsincrona(async (_solicitud, respuesta) => {
    const rutaEnApuntes = path.join(config.notesRoot, "generacion.log");
    const contenido = await readFile(rutaEnApuntes, "utf8").catch(() => "Sin registros disponibles todavía.");
    respuesta.type("text/plain; charset=utf-8").send(contenido);
  }),
);

aplicacion.get(
  "/api/progress/:id",
  rutaAsincrona(async (solicitud, respuesta) => {
    const seguimiento = seguimientosGeneracion.get(solicitud.params.id);
    if (!seguimiento) throw errorHttp(404, "No se encontró el progreso de esta generación.");
    respuesta.json(seguimiento);
  }),
);

aplicacion.post(
  "/api/progress/:id/cancel",
  rutaAsincrona(async (solicitud, respuesta) => {
    const id = solicitud.params.id;
    if (!/^[\da-f-]{36}$/i.test(id))
      throw errorHttp(400, "Identificador de generación no válido.");
    const seguimiento = seguimientosGeneracion.get(id);
    if (seguimiento?.fase === "completado" || seguimiento?.fase === "guardado")
      throw errorHttp(
        409,
        seguimiento.fase === "guardado"
          ? "Los apuntes ya se están guardando; deja que termine esta última etapa."
          : "La generación ya ha terminado.",
      );
    let trabajoEtapas = null;
    try {
      trabajoEtapas = await cargarTrabajoEtapas(id);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    controladoresGeneracion.get(id)?.abort();
    generacionesPendientes.delete(id);
    actualizarProgreso(id, {
      fase: "cancelado",
      mensaje: "Generación detenida",
      detalle:
        "Se ha detenido la generación. La caché de extracciones se ha conservado.",
    });
    if (trabajoEtapas) await pausarTrabajoEtapas(id);
    respuesta.json({ cancelado: true });
  }),
);

aplicacion.get(
  "/api/subjects",
  rutaAsincrona(async (_request, respuesta) => {
    respuesta.json({ asignaturas: await listarAsignaturas() });
  }),
);

aplicacion.post(
  "/api/subjects",
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = componenteSeguro(solicitud.body?.nombre);
    const creada = await crearCarpetaAsignatura(subject);
    respuesta.status(201).json({ nombre: creada.nombre });
  }),
);

aplicacion.get(
  "/api/notes",
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = componenteSeguro(solicitud.query.subject);
    respuesta.json({ archivos: await listarApuntes(subject) });
  }),
);

aplicacion.get(
  "/api/notes/content",
  rutaAsincrona(async (solicitud, respuesta) => {
    respuesta.json(await leerApunte(String(solicitud.query.path ?? "")));
  }),
);

aplicacion.put(
  "/api/notes/content",
  rutaAsincrona(async (solicitud, respuesta) => {
    const result = await guardarApunte({
      path: solicitud.body?.path,
      content: solicitud.body?.content,
      expectedSha256: solicitud.body?.expectedSha256,
    });
    respuesta.json(result);
  }),
);

aplicacion.get(
  "/api/history",
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = componenteSeguro(solicitud.query.subject);
    if (!solicitud.query.tema && !solicitud.query.subtema)
      return respuesta.json({
        historial: await listarHistorialGeneraciones(subject),
      });
    const theme = numeroPositivo(solicitud.query.tema, "tema");
    const subtheme = numeroPositivo(solicitud.query.subtema, "apartado");
    respuesta.json({
      ultima_generacion: await obtenerInformeGeneracion(subject, theme, subtheme),
    });
  }),
);

aplicacion.delete(
  "/api/history",
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = componenteSeguro(solicitud.query.subject);
    const todo =
      solicitud.query.todo === "true" ||
      (!solicitud.query.fingerprint &&
        !solicitud.query.tema &&
        !solicitud.query.subtema);
    const fingerprint = solicitud.query.fingerprint
      ? String(solicitud.query.fingerprint)
      : null;
    const theme = solicitud.query.tema ? Number(solicitud.query.tema) : null;
    const subtheme = solicitud.query.subtema
      ? Number(solicitud.query.subtema)
      : null;
    await eliminarInformeGeneracion(subject, {
      fingerprint,
      theme,
      subtheme,
      todo,
    });
    respuesta.json({ eliminado: true });
  }),
);

aplicacion.post(
  "/api/history/improve",
  express.json(),
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = componenteSeguro(solicitud.body.subject);
    const theme = numeroPositivo(solicitud.body.tema, "tema");
    const subtheme = numeroPositivo(solicitud.body.subtema, "apartado");
    const fingerprint = solicitud.body.fingerprint ? String(solicitud.body.fingerprint) : "";
    const archivosSeleccionados = Array.isArray(solicitud.body.archivos) ? solicitud.body.archivos : [];
    const instruccionUsuario = String(solicitud.body.instruccion ?? "").trim().slice(0, 2000);

    const historial = await listarHistorialGeneraciones(subject);
    const informeBase = historial.find(
      (item) =>
        item.asignatura === subject &&
        item.tema === theme &&
        item.subtema === subtheme &&
        (!fingerprint || item.fingerprint === fingerprint),
    ) || (await obtenerInformeGeneracion(subject, theme, subtheme));

    if (!informeBase) {
      throw errorHttp(404, "No se encontró el informe de generación en el historial.");
    }

    const archivosGenerados = informeBase.archivos_generados ?? [];
    if (!archivosGenerados.length) {
      throw errorHttp(400, "Esta generación no tiene archivos de apuntes generados.");
    }

    const archivosAMejorar = archivosSeleccionados.length
      ? archivosGenerados.filter((a) => archivosSeleccionados.includes(a.path))
      : archivosGenerados;

    if (!archivosAMejorar.length) {
      throw errorHttp(400, "Ninguno de los archivos seleccionados coincide con los apuntes generados.");
    }

    const archivosActualizados = [...archivosGenerados];
    const controlador = new AbortController();
    solicitud.once("aborted", () => controlador.abort());

    for (const archivoInfo of archivosAMejorar) {
      comprobarCancelacion(controlador.signal);
      let apunteActual;
      try {
        apunteActual = await leerApunte(archivoInfo.path);
      } catch (err) {
        console.warn(`No se pudo leer ${archivoInfo.path}: ${err.message}`);
        continue;
      }

      const prompt = `ASIGNATURA: ${subject}
TEMA: Tema ${theme}: ${informeBase.titulo_tema || ""}
APARTADO: Apartado ${theme}.${subtheme}: ${informeBase.titulo_subtema || ""}
ARCHIVO: ${archivoInfo.path}
INSTRUCCIÓN DEL ESTUDIANTE: ${instruccionUsuario || "Reescribir y perfeccionar la redacción docente para que sea exhaustiva, clara y de nivel 10 en examen."}

CONTENIDO ACTUAL EN LATEX:
<<<LATEX_ACTUAL
${apunteActual.content}
LATEX_ACTUAL>>>

Reescribe este apartado completo con explicaciones didácticas profundas y rigurosas, usando la estructura y macros de LaTeX (\\secciongrande, \\resumen, \\definicion, \\rectangulos, \\lista, \\nota, etc.). Devuelve únicamente el JSON con el formato solicitado.`;

      let resultadoIA;
      try {
        resultadoIA = await consultarModeloIA(
          sistemaReescrituraDidactica,
          prompt,
          [],
          controlador.signal,
        );
      } catch (err) {
        console.warn(`Error al mejorar ${archivoInfo.path} con IA: ${err.message}`);
        continue;
      }

      let nuevoLatex = resultadoIA.latex || "";
      if (!nuevoLatex.trim()) continue;

      nuevoLatex = aplicarEstilosLatex(nuevoLatex, subject);

      const guardado = await guardarApunte({
        path: archivoInfo.path,
        content: nuevoLatex,
        expectedSha256: apunteActual.sha256,
      });

      const indice = archivosActualizados.findIndex((a) => a.path === archivoInfo.path);
      if (indice >= 0) {
        archivosActualizados[indice] = {
          ...archivosActualizados[indice],
          sha256: guardado.sha256,
          titulo: resultadoIA.titulo || archivosActualizados[indice].titulo,
        };
      }
    }

    const nuevaHuella = createHash("sha256")
      .update(`${informeBase.fingerprint || "huella"}:${Date.now()}`)
      .digest("hex");
    const ahoraIso = new Date().toISOString();

    const nuevoInforme = {
      ...informeBase,
      generado: ahoraIso,
      fingerprint: nuevaHuella,
      archivos_generados: archivosActualizados,
      tipo_generacion: "redaccion_mejorada",
      nota_mejora: instruccionUsuario || "Redacción mejorada con IA",
    };

    const reportDirectory = path.dirname(
      await rutaInformeGeneracion(subject, theme, subtheme),
    );
    await mkdir(reportDirectory, { recursive: true });
    const reportText = `${JSON.stringify(nuevoInforme, null, 2)}\n`;
    await writeFile(path.join(reportDirectory, "ultima-generacion.json"), reportText, "utf8");
    const historyDirectory = path.join(reportDirectory, "historial");
    await mkdir(historyDirectory, { recursive: true });
    await writeFile(
      path.join(historyDirectory, `${Date.now()}-${nuevaHuella}.json`),
      reportText,
      "utf8",
    );

    respuesta.json({ ok: true, informe: nuevoInforme });
  }),
);

aplicacion.get(
  "/api/staged-generations",
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = solicitud.query.subject
      ? componenteSeguro(solicitud.query.subject)
      : null;
    const incluirCompletados = solicitud.query.include_completed === "true";
    respuesta.json({
      trabajos: await listarTrabajosEtapas(subject, false, incluirCompletados),
    });
  }),
);

aplicacion.post(
  "/api/staged-generations/init",
  subida.none(),
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = solicitud.body.subject
      ? componenteSeguro(solicitud.body.subject)
      : "";
    const id = /^[\da-f-]{36}$/i.test(String(solicitud.body.progress_id ?? ""))
      ? String(solicitud.body.progress_id)
      : randomUUID();

    const trabajo = await crearTrabajoEtapas({
      id,
      subject,
      opciones: {
        tema: numeroOpcional(solicitud.body.tema, "tema"),
        tituloTema: etiquetaAcotada(solicitud.body.tema_nombre, ""),
        apartado: numeroOpcional(solicitud.body.subtema, "apartado"),
        tituloApartado: etiquetaAcotada(solicitud.body.subtema_nombre, ""),
        instruccionEstudiante: String(solicitud.body.user_prompt ?? "").slice(0, 4000),
        investigacionHabilitada: solicitud.body.research_enabled === "true",
        analisisCodigoHabilitado:
          solicitud.body.code_analysis_enabled === undefined ||
          solicitud.body.code_analysis_enabled === "true",
        compararApuntesHabilitado:
          solicitud.body.compare_notes_enabled === undefined ||
          solicitud.body.compare_notes_enabled === "true",
        sustituirExistentes: solicitud.body.replace_existing === "true",
      },
      archivos: [],
    });
    respuesta.status(201).json({ id: trabajo.id, estado: trabajo.estado });
  }),
);

aplicacion.post(
  "/api/staged-generations/:id/batch-upload",
  subida.array("files"),
  rutaAsincrona(async (solicitud, respuesta) => {
    const trabajo = await cargarTrabajoEtapas(solicitud.params.id);
    const directory = path.join(config.generationReportsRoot, ".procesamiento", trabajo.id);
    await mkdir(path.join(directory, "fuentes"), { recursive: true });
    const fuentesNuevas = [];
    let indice = trabajo.fuentes.length;
    for (const archivo of solicitud.files ?? []) {
      indice += 1;
      const nombreInterno = `fuente-${String(indice).padStart(4, "0")}.bin`;
      const rutaDestino = path.join(directory, "fuentes", nombreInterno);
      if (archivo.path) {
        await copyFile(archivo.path, rutaDestino);
        await rm(archivo.path, { force: true }).catch(() => {});
      } else if (archivo.buffer) {
        await writeFile(rutaDestino, archivo.buffer);
      }
      fuentesNuevas.push({
        archivo: nombreInterno,
        nombre: archivo.originalname,
        bytes: archivo.size,
      });
    }
    trabajo.fuentes.push(...fuentesNuevas);
    await guardarTrabajoEtapas(trabajo);
    respuesta.json({
      id: trabajo.id,
      totalFuentes: trabajo.fuentes.length,
      subidos: fuentesNuevas.length,
    });
  }),
);

aplicacion.post(
  "/api/staged-generations/:id/start",
  subida.none(),
  rutaAsincrona(async (solicitud, respuesta) => {
    const trabajo = await cargarTrabajoEtapas(solicitud.params.id);
    const textoPegado = String(solicitud.body?.source_text ?? "");
    if (textoPegado.trim()) {
      const indice = trabajo.fuentes.length + 1;
      const nombreInterno = `fuente-${String(indice).padStart(4, "0")}.bin`;
      const directory = path.join(config.generationReportsRoot, ".procesamiento", trabajo.id);
      await writeFile(
        path.join(directory, "fuentes", nombreInterno),
        Buffer.from(textoPegado, "utf8"),
      );
      trabajo.fuentes.push({
        archivo: nombreInterno,
        nombre: "texto-pegado.txt",
        bytes: Buffer.byteLength(textoPegado, "utf8"),
      });
    }
    if (!trabajo.fuentes.length)
      throw errorHttp(400, "No se subieron archivos para procesar.");
    trabajo.estado = "pendiente";
    trabajo.fase = "extraccion";
    trabajo.error = "";
    await guardarTrabajoEtapas(trabajo);
    iniciarTrabajoEtapas(trabajo.id);
    respuesta.status(202).json({ id: trabajo.id, estado: trabajo.estado });
  }),
);

aplicacion.post(
  "/api/staged-generations",
  subida.array("files"),
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = solicitud.body.subject
      ? componenteSeguro(solicitud.body.subject)
      : "";
    const archivos = [...(solicitud.files ?? [])].map((archivo) => ({
      originalname: archivo.originalname,
      size: archivo.size,
      path: archivo.path,
      buffer: archivo.buffer,
    }));
    const textoPegado = String(solicitud.body.source_text ?? "");
    if (textoPegado.trim()) {
      archivos.push({
        originalname: "texto-pegado.txt",
        buffer: Buffer.from(textoPegado, "utf8"),
        size: Buffer.byteLength(textoPegado, "utf8"),
      });
    }
    if (!archivos.length)
      throw errorHttp(400, "Selecciona archivos, una carpeta o pega texto.");
    if (
      config.maxUploadBytes !== Infinity &&
      archivos.reduce((total, archivo) => total + archivo.size, 0) >
      config.maxUploadBytes
    )
      throw errorHttp(
        413,
        `Los archivos superan MAX_MB_SUBIDA (${config.maxUploadBytes / 1024 / 1024} MB).`,
      );
    const trabajosExistentes = await listarTrabajosEtapas(subject);
    const trabajoActivo = trabajosExistentes.find(
      (trabajo) =>
        trabajo.estado === "procesando" ||
        trabajo.estado === "pendiente" ||
        trabajo.estado === "confirmacion",
    );
    const trabajoExistente =
      trabajoActivo && (await cargarTrabajoEtapas(trabajoActivo.id));
    const coincideExistente =
      trabajoExistente &&
      (await trabajoCoincideConArchivos(trabajoExistente, archivos));
    if (trabajoExistente && !coincideExistente) {
      // Hay un trabajo activo de la misma asignatura pero con otro material:
      // se pausa para no ejecutar dos generaciones a la vez y no reanudar
      // por error el trabajo antiguo.
      controladoresGeneracion.get(trabajoExistente.id)?.abort();
      await pausarTrabajoEtapas(trabajoExistente.id);
    }
    const trabajoReutilizable = coincideExistente
      ? trabajoExistente
      : await buscarTrabajoEtapasReutilizable(subject, archivos);
    if (trabajoReutilizable) {
      if (trabajoReutilizable.estado !== "confirmacion")
        iniciarTrabajoEtapas(trabajoReutilizable.id);
      respuesta.status(202).json({
        id: trabajoReutilizable.id,
        estado: trabajoReutilizable.estado,
        reutilizado: true,
      });
      return;
    }
    const trabajo = await crearTrabajoEtapas({
      id: /^[\da-f-]{36}$/i.test(String(solicitud.body.progress_id ?? ""))
        ? String(solicitud.body.progress_id)
        : undefined,
      subject,
      opciones: {
        tema: numeroOpcional(solicitud.body.tema, "tema"),
        tituloTema: etiquetaAcotada(solicitud.body.tema_nombre, ""),
        apartado: numeroOpcional(solicitud.body.subtema, "apartado"),
        tituloApartado: etiquetaAcotada(solicitud.body.subtema_nombre, ""),
        instruccionEstudiante: String(solicitud.body.user_prompt ?? "").slice(0, 4000),
        investigacionHabilitada: solicitud.body.research_enabled === "true",
        analisisCodigoHabilitado:
          solicitud.body.code_analysis_enabled === undefined ||
          solicitud.body.code_analysis_enabled === "true",
        compararApuntesHabilitado:
          solicitud.body.compare_notes_enabled === undefined ||
          solicitud.body.compare_notes_enabled === "true",
        sustituirExistentes: solicitud.body.replace_existing === "true",
      },
      archivos,
    });
    iniciarTrabajoEtapas(trabajo.id);
    respuesta.status(202).json({ id: trabajo.id, estado: trabajo.estado });
  }),
);

aplicacion.get(
  "/api/staged-generations/:id",
  rutaAsincrona(async (solicitud, respuesta) => {
    const trabajo = await cargarTrabajoEtapas(solicitud.params.id);
    const unidadesPdf = trabajo.unidadesPdf.length;
    let logsRecientes = [];
    try {
      const rutaEnTrabajo = path.join(config.generationReportsRoot, ".procesamiento", trabajo.id, "generacion.log");
      const rutaEnApuntes = path.join(config.notesRoot, "generacion.log");
      const contenido = await readFile(rutaEnTrabajo, "utf8").catch(async () => {
        return await readFile(rutaEnApuntes, "utf8").catch(() => "");
      });
      logsRecientes = contenido.trim().split("\n").filter(Boolean).slice(-40);
    } catch {}

    let unidadActivaInfo = null;
    try {
      const listaUnidades = trabajo.fase === "codigo" ? trabajo.unidadesCodigo : trabajo.unidadesPdf;
      const u = listaUnidades?.[trabajo.unidadActual];
      if (u) {
        unidadActivaInfo = {
          id: u.id,
          documento: u.documento?.name || "documento",
          extractoTexto: (u.texto || "").slice(0, 280).replace(/\s+/g, " "),
          numCaracteres: (u.texto || "").length,
          numImagenes: (u.imagenes || []).length,
        };
      }
    } catch {}

    const ultimosResultados = (trabajo.guardados || []).slice(-10).map((r) => ({
      titulo: r.titulo || r.nombre || "Apartado",
      tema: r.titulo_tema || (r.tema ? `Tema ${r.tema}` : ""),
      resumen: r.resumen || "",
      conceptos: r.conceptos_clave || r.conceptos || [],
    }));

    respuesta.json({
      id: trabajo.id,
      asignatura: trabajo.asignatura,
      estado: trabajo.estado,
      fase: trabajo.fase,
      unidadActual:
        trabajo.fase === "codigo"
          ? unidadesPdf + trabajo.unidadActual
          : trabajo.unidadActual,
      totalUnidades: unidadesPdf + trabajo.unidadesCodigo.length,
      compararApuntesHabilitado:
        trabajo.opciones?.compararApuntesHabilitado === true,
      error: trabajo.error ?? "",
      archivosASustituir: trabajo.archivosASustituir ?? [],
      resultados: trabajo.guardados,
      logsRecientes,
      unidadActivaInfo,
      ultimosResultados,
    });
  }),
);

aplicacion.delete(
  "/api/staged-generations/:id",
  rutaAsincrona(async (solicitud, respuesta) => {
    try {
      const trabajo = await cargarTrabajoEtapas(solicitud.params.id);
      if (trabajo?.asignatura) {
        for (const guardado of trabajo.guardados ?? []) {
          if (guardado.fingerprint) {
            await eliminarInformeGeneracion(trabajo.asignatura, {
              fingerprint: guardado.fingerprint,
              theme: guardado.tema,
              subtheme: guardado.subtema,
            }).catch(() => {});
          }
        }
      }
    } catch {}
    await eliminarTrabajoEtapas(solicitud.params.id);
    respuesta.json({ eliminado: true });
  }),
);

aplicacion.post(
  "/api/staged-generations/:id/resume",
  rutaAsincrona(async (solicitud, respuesta) => {
    const trabajo = await cargarTrabajoEtapas(solicitud.params.id);
    if (trabajosEtapasActivos.has(trabajo.id)) {
      respuesta.status(202).json({ id: trabajo.id, estado: "procesando" });
      return;
    }
    if (trabajo.estado === "confirmacion") {
      respuesta.status(202).json({ id: trabajo.id, estado: trabajo.estado });
      return;
    }
    if (trabajo.estado === "completado")
      throw errorHttp(409, "Esta generación ya está completada.");
    trabajo.estado = "pendiente";
    trabajo.error = "";
    await guardarTrabajoEtapas(trabajo);
    iniciarTrabajoEtapas(trabajo.id);
    respuesta.status(202).json({ id: trabajo.id, estado: "pendiente" });
  }),
);

aplicacion.post(
  "/api/staged-generations/:id/repeat-stage",
  rutaAsincrona(async (solicitud, respuesta) => {
    const etapa = solicitud.body?.etapa || solicitud.body?.stage || "reescribir";
    const controladorAnterior = controladoresGeneracion.get(solicitud.params.id);
    if (controladorAnterior) {
      controladorAnterior.abort();
    }
    const trabajo = await reiniciarEtapaTrabajo(solicitud.params.id, etapa);
    iniciarTrabajoEtapas(trabajo.id);
    respuesta.status(202).json({
      id: trabajo.id,
      estado: trabajo.estado,
      fase: trabajo.fase,
      repetida: etapa,
    });
  }),
);

aplicacion.post(
  "/api/staged-generations/:id/save",
  rutaAsincrona(async (solicitud, respuesta) => {
    const trabajo = await cargarTrabajoEtapas(solicitud.params.id);
    if (trabajo.estado !== "confirmacion")
      throw errorHttp(409, "Esta generación no está esperando confirmación.");
    await guardarResultadosTrabajo(
      trabajo,
      solicitud.body?.replace_existing === true,
    );
    respuesta.json({
      id: trabajo.id,
      estado: trabajo.estado,
      resultados: trabajo.guardados,
    });
  }),
);

aplicacion.post(
  "/api/generate",
  subida.array("files"),
  rutaAsincrona(async (solicitud, respuesta) => {
    const idProgreso = String(solicitud.body.progress_id ?? "");
    const controlador = new AbortController();
    if (/^[\da-f-]{36}$/i.test(idProgreso)) {
      controladoresGeneracion.set(idProgreso, controlador);
      respuesta.once("finish", () => controladoresGeneracion.delete(idProgreso));
      solicitud.once("aborted", () => controlador.abort());
      if (seguimientosGeneracion.get(idProgreso)?.fase === "cancelado")
        controlador.abort();
      else if (!seguimientosGeneracion.has(idProgreso))
        actualizarProgreso(idProgreso, {
          fase: "lectura",
          mensaje: "Leyendo tus archivos",
          detalle: `Procesando ${solicitud.files?.length ?? 0} archivo(s): extracción de texto, OCR de páginas escaneadas y lectura de código.`,
          inicio: Date.now(),
        });
    }
    comprobarCancelacion(controlador.signal);
    const asignatura = componenteSeguro(solicitud.body.subject);
    const tema = numeroOpcional(solicitud.body.tema, "tema");
    const apartado = numeroOpcional(solicitud.body.subtema, "apartado");
    const tituloTema =
      etiquetaAcotada(solicitud.body.tema_nombre, "") ||
      (tema ? `Tema ${tema}` : "");
    const tituloApartado =
      etiquetaAcotada(solicitud.body.subtema_nombre, "") ||
      (apartado ? `Apartado ${tema}.${apartado}` : "");
    const archivos = await Promise.all(
      [...(solicitud.files ?? [])].map(async (archivo) => ({
        originalname: archivo.originalname,
        size: archivo.size,
        path: archivo.path,
        buffer: archivo.buffer ?? (archivo.path ? await readFile(archivo.path) : Buffer.alloc(0)),
      })),
    );
    const textoPegado = String(solicitud.body.source_text ?? "");
    if (textoPegado.trim()) {
      archivos.push({
        originalname: "texto-pegado.txt",
        buffer: Buffer.from(textoPegado, "utf8"),
        size: Buffer.byteLength(textoPegado, "utf8"),
      });
    }
    if (!archivos.length)
      throw errorHttp(400, "Selecciona archivos, una carpeta o pega texto.");
    if (
      config.maxUploadBytes !== Infinity &&
      archivos.reduce((total, archivo) => total + archivo.size, 0) >
      config.maxUploadBytes
    ) {
      throw errorHttp(
        413,
        `Los archivos superan MAX_MB_SUBIDA (${config.maxUploadBytes / 1024 / 1024} MB).`,
      );
    }

    const material = await extraerMateriales(archivos, {
      signal: controlador.signal,
      onProgress: ({ archivo, archivos: total, nombre, pagina, paginas }) => {
        actualizarProgreso(idProgreso, {
          fase: "lectura",
          mensaje: pagina
            ? `Lectura · página ${pagina} de ${paginas}`
            : `Leyendo archivo ${archivo} de ${total}`,
          detalle: pagina
            ? `${nombre}: se procesan las páginas con imágenes; se conserva el texto y se aplica OCR si falta texto legible. Puedes detener el proceso en cualquier momento.`
            : `${nombre}: detectando el formato y extrayendo texto, código o imágenes.`,
          actual: pagina ?? archivo,
          total: paginas ?? total,
        });
      },
    });
    comprobarCancelacion(controlador.signal);
    if (!material.documents.length) {
      const hint = material.warnings.slice(0, 4).join(" ");
      throw errorHttp(
        422,
        `No se pudo extraer texto de los archivos seleccionados. ${hint}`.trim(),
      );
    }
    actualizarProgreso(idProgreso, {
      fase: "lectura",
      mensaje: "Material leído y preparado",
      detalle: `${material.documents.length} documento(s), ${textoMaterial(material).length.toLocaleString("es-ES")} caracteres, ${material.imagesOcr} página(s) con OCR y ${material.visuals.length} imagen(es) preparadas para interpretar.`,
    });
    const investigacionHabilitada = solicitud.body.research_enabled === "true";
    const compararApuntesHabilitado =
      solicitud.body.compare_notes_enabled === undefined ||
      solicitud.body.compare_notes_enabled === "true";
    const textoMaterialCompleto = textoMaterial(material);
    const consultasInvestigacion = investigacionHabilitada
      ? crearConsultasInvestigacion({
          asignatura,
          tituloTema,
          tituloApartado,
          material,
        })
      : [];
    const investigacion = investigacionHabilitada
      ? await buscarFuentesOpcionales(
          consultasInvestigacion,
          material.warnings,
          (consulta) => buscarEnInternet(consulta, 3, controlador.signal),
          (actual, total) =>
            actualizarProgreso(idProgreso, {
              fase: "internet",
              mensaje: "Buscando información en Internet",
              detalle: `Consulta ${actual} de ${total}: contrastando conceptos del material y recopilando enlaces.`,
              actual,
              total,
            }),
          controlador.signal,
        )
      : [];
    comprobarCancelacion(controlador.signal);

    let fingerprint;
    if (tema && apartado) {
      fingerprint = huellaSolicitud({
        asignatura,
        tema,
        tituloTema,
        apartado,
        tituloApartado,
        instruccionEstudiante: solicitud.body.user_prompt ?? "",
        investigacionHabilitada,
        compararApuntesHabilitado,
        archivos,
      });
      const informeAnterior = await obtenerInformeGeneracion(
        asignatura,
        tema,
        apartado,
      );
      if (informeAnterior?.fingerprint === fingerprint) {
        actualizarProgreso(idProgreso, {
          fase: "completado",
          mensaje: "Ya existía una generación idéntica",
          detalle: "He recuperado el informe y los apuntes guardados; no he vuelto a ejecutar la IA.",
          actual: 1,
          total: 1,
        });
        return respuesta.json(respuestaInforme(informeAnterior, null, true));
      }
    }
    comprobarCancelacion(controlador.signal);
    if (compararApuntesHabilitado) {
      actualizarProgreso(idProgreso, {
        fase: "comparacion",
        mensaje: "Organizando los temas",
        detalle: "La generación se basará en el material que acabas de aportar.",
      });
    }
    const catalogoAsignaturas = compararApuntesHabilitado
      ? await listarAsignaturas()
      : [];
    const temasDeAsignatura =
      catalogoAsignaturas.find((item) => item.nombre === asignatura)?.temas ?? [];
    const temasExistentes = temasDeAsignatura
      .map((item) => {
        const apartadosExistentes = item.apartados
          .map((apartadoExistente) =>
            `Apartado ${item.numero}.${apartadoExistente.numero}: ${apartadoExistente.nombre}`,
          )
          .join("; ");
        return `- Tema ${item.numero}: ${item.titulo}${apartadosExistentes ? ` (${apartadosExistentes})` : ""}`;
      })
      .join("\n");
    const textoWeb = investigacion
      .map(
        (fuente) =>
          `FUENTE: ${fuente.titulo}\nURL: ${fuente.url}\nRESUMEN: ${fuente.resumen}`,
      )
      .join("\n\n");
    let resultado;
    try {
      const apartadosDetectados = detectarApartadosEnTexto(textoMaterialCompleto);
      const bloquesMaterial =
        apartadosDetectados.length >= 2
          ? dividirTextoPorApartados(
              textoMaterialCompleto,
              material.visuals,
              apartadosDetectados,
            )
          : dividirMaterialConImagenes(
              textoMaterialCompleto,
              material.visuals,
            );
      const referenciaBiblioteca = await obtenerReferenciaBibliotecaSegura();
      const bloquesActivos = new Set();
      let bloquesCompletados = 0;
      const tiemposBloque = [];
      actualizarProgreso(idProgreso, {
        fase: "ia",
        mensaje: "Preparando el análisis de la IA local",
        detalle: `${bloquesMaterial.length} partes para analizar; hasta ${config.parallelRequests} llamadas simultáneas (máximo configurable: 50). El progreso y el tiempo restante se ajustarán cuando termine la primera parte.`,
        actual: 0,
        total: bloquesMaterial.length,
        segundosRestantes: Math.ceil(
          (45 * bloquesMaterial.length) / config.parallelRequests,
        ),
      });
      const resultados = await procesarEnParalelo(
        bloquesMaterial,
        config.parallelRequests,
        async (bloque, indiceBloque) => {
          comprobarCancelacion(controlador.signal);
          const inicioBloque = Date.now();
          bloquesActivos.add(indiceBloque);
          const detalleBloques = () => {
            const activos = [...bloquesActivos]
              .sort((izquierda, derecha) => izquierda - derecha)
              .map((indice) => `parte ${indice + 1}`)
              .join(", ");
            return `Partes completadas: ${bloquesCompletados} de ${bloquesMaterial.length}. En curso: ${activos || "preparando la siguiente"}. Hasta ${config.parallelRequests} llamadas simultáneas (máximo configurable: 50).`;
          };
          actualizarProgreso(idProgreso, {
            fase: "ia",
            mensaje: `La IA está procesando ${bloquesActivos.size} parte(s) en paralelo`,
            detalle: `${detalleBloques()} Esta parte contiene ${bloque.texto.length.toLocaleString("es-ES")} caracteres${bloque.imagenes[0] ? ` e interpreta ${bloque.imagenes[0].name}` : ""}.`,
            actual: bloquesCompletados,
            total: bloquesMaterial.length,
          });
          const subtemaEfectivo = bloque.apartadoNumero || apartado;
          const tituloApartadoEfectivo = bloque.apartadoTitulo || tituloApartado;
          const temaEfectivo = bloque.temaNumero || tema;
          const instruccion = crearPromptApuntes({
            asignatura,
            tema: temaEfectivo,
            tituloTema,
            apartado: subtemaEfectivo,
            tituloApartado: tituloApartadoEfectivo,
            instruccionEstudiante: solicitud.body.user_prompt ?? "",
            material: bloque.texto,
            temasExistentes,
            investigacion: textoWeb,
            referenciaBiblioteca,
            parteMaterial: [
              bloquesMaterial.length > 1
                ? `PARTE ${indiceBloque + 1} DE ${bloquesMaterial.length}: APARTADO ${subtemaEfectivo} (${tituloApartadoEfectivo}). OBLIGATORIO: traduce el título del tema, del apartado y todas las secciones al ESPAÑOL ESTÁNDAR en el JSON ("titulo_tema", "titulo_subtema", "archivos[].titulo", "archivos[].nombre", y en cada macro LaTeX \\secciongrande, \\subtituloA, \\subtituloB, \\resumen, \\definicion). NUNCA dejes palabras en catalán ni en otro idioma en los títulos, slugs o secciones. Explica todos los conceptos, arquitecturas, códigos y preguntas de examen con profundidad didáctica en español, sin omitir nada y sin resumir en esquemas telegráficos de 2 líneas.`
                : "",
              crearGuiaMaterialBreve(bloque.texto, bloque.imagenes),
            ]
              .filter(Boolean)
              .join("\n"),
          });
          console.log(`[Bloque ${indiceBloque + 1}] Prompt enviado a IA: ${instruccion.substring(0, 200)}... (tamaño estimado: ${Math.ceil(instruccion.length / 4)} tokens)`);
          try {
            return await consultarApuntesConReintento({
              instruccion,
              imagenes: bloque.imagenes,
              signal: controlador.signal,
              normalizar: (respuestaIA) => {
                comprobarCancelacion(controlador.signal);
                const normalizado = normalizarResultadoIA(respuestaIA, {
                  subject: asignatura,
                  theme: temaEfectivo,
                  subtheme: subtemaEfectivo,
                  themeTitle: tituloTema,
                  subthemeTitle: tituloApartadoEfectivo,
                });
                if (bloque.apartadoNumero && normalizado.archivos?.[0]) {
                  normalizado.archivos[0].subtema = bloque.apartadoNumero;
                  normalizado.subtema = bloque.apartadoNumero;
                }
                return normalizado;
              },
              contexto: `parte ${indiceBloque + 1}`,
              validar: (resultadoIA) =>
                evaluarCoberturaMaterial(resultadoIA, bloque.texto),
            });
          } finally {
            bloquesActivos.delete(indiceBloque);
            bloquesCompletados += 1;
            tiemposBloque.push(Date.now() - inicioBloque);
            const duracionMedia =
              tiemposBloque.length > 0
                ? tiemposBloque.reduce((suma, duracion) => suma + duracion, 0) /
                  tiemposBloque.length
                : 45_000;
            const segundosRestantes = Math.ceil(
              (duracionMedia *
                Math.max(0, bloquesMaterial.length - bloquesCompletados)) /
                (config.parallelRequests * 1000),
            );
            actualizarProgreso(idProgreso, {
              fase: "ia",
              mensaje: `La IA ha terminado ${bloquesCompletados} de ${bloquesMaterial.length} partes`,
              detalle: detalleBloques(),
              actual: bloquesCompletados,
              total: bloquesMaterial.length,
              segundosRestantes,
            });
          }
        },
      );
      comprobarCancelacion(controlador.signal);
      resultado = combinarResultadosParciales(resultados);
    } catch (fallo) {
      if (controlador.signal.aborted)
        throw errorHttp(499, "Generación detenida. No se guardaron apuntes.");
      console.error("Falló la generación de apuntes:", fallo);
      throw errorHttp(502, `No se pudieron generar apuntes: ${fallo.message}`);
    }

    if (resultado.archivos && resultado.archivos.length > 0) {
      if (resultado.titulo_tema || resultado.titulo_subtema) {
        try {
          const tradTema = await traducirTituloYNombreConIA(
            { titulo: resultado.titulo_tema, nombre: resultado.titulo_subtema },
            controlador.signal,
          );
          if (tradTema.titulo) resultado.titulo_tema = tradTema.titulo;
          if (tradTema.nombre) resultado.titulo_subtema = tradTema.nombre;
        } catch {}
      }
      for (const archivo of resultado.archivos) {
        if (apartado) {
          archivo.subtema = apartado;
          archivo.apartado = apartado;
        }
        archivo.titulo = String(archivo.titulo || "")
          .replace(/\\textbf\{([^}]+)\}/g, "$1")
          .replace(/[*#]/g, "")
          .trim();
        if (!archivo.titulo || esTituloDePlantilla(archivo.titulo)) {
          archivo.titulo = resultado.titulo_subtema || tituloApartadoEfectivo;
        }
        if (
          !archivo.nombre ||
          /^(?:apartado(?:-\d+)*|slug-(?:concepto|descriptivo)|seccion(?:-\d+)*)$/i.test(archivo.nombre) ||
          /fragmento/i.test(archivo.nombre)
        ) {
          archivo.nombre = deducirSlugConceptual(archivo.nombre, archivo.titulo);
        } else {
          archivo.nombre = crearNombreArchivo(archivo.nombre);
        }
        try {
          const trad = await traducirTituloYNombreConIA(
            { titulo: archivo.titulo, nombre: archivo.nombre },
            controlador.signal,
          );
          if (trad.titulo) archivo.titulo = trad.titulo;
          if (trad.nombre) archivo.nombre = crearNombreArchivo(trad.nombre);
        } catch (errTrad) {
          console.warn(`Verificación del título omitida: ${errTrad.message}`);
        }
        // La traducción del contenido no depende de que la traducción del título
        // haya funcionado; antes ambas operaciones compartían un único try/catch.
        try {
          if (archivo.latex) archivo.latex = await traducirLatexAEspanolConIA(archivo.latex, controlador.signal);
        } catch (errTrad) {
          console.warn(`Verificación del LaTeX omitida: ${errTrad.message}`);
        }
        archivo.latex = aplicarEstilosLatex(archivo.latex, asignatura);
      }
    }

    const destino = resolverDestinoGeneracion({
      temaSolicitado: tema,
      apartadoSolicitado: apartado,
      temaTituloSolicitado: tituloTema,
      apartadoTituloSolicitado: tituloApartado,
      temasExistentes: compararApuntesHabilitado ? temasDeAsignatura : [],
      resultado,
    });
    resultado.tema = destino.tema;
    resultado.subtema = destino.apartado;
    resultado.titulo_tema = destino.tituloTema || resultado.titulo_tema;
    resultado.titulo_subtema =
      destino.tituloApartado || resultado.titulo_subtema;
    delete resultado.tema_existente;
    if (!fingerprint) {
      fingerprint = huellaSolicitud({
        asignatura,
        tema: destino.tema,
        tituloTema: destino.tituloTema || resultado.titulo_tema,
        apartado: destino.apartado,
        tituloApartado: destino.tituloApartado || resultado.titulo_subtema,
        instruccionEstudiante: solicitud.body.user_prompt ?? "",
        investigacionHabilitada,
        compararApuntesHabilitado,
        archivos,
      });
      const informeAnterior = await obtenerInformeGeneracion(
        asignatura,
        destino.tema,
        destino.apartado,
      );
      if (informeAnterior?.fingerprint === fingerprint) {
        actualizarProgreso(idProgreso, {
          fase: "completado",
          mensaje: "Ya existía una generación idéntica",
          detalle: "He recuperado el informe y los apuntes guardados; no he vuelto a ejecutar la IA.",
          actual: 1,
          total: 1,
        });
        return respuesta.json(respuestaInforme(informeAnterior, null, true));
      }
    }
    resultado.fuentes = combinarFuentes(resultado.fuentes, investigacion);
    if (investigacion.length)
      resultado.archivos[0].latex += crearCitasLatex(investigacion);

    comprobarCancelacion(controlador.signal);
    actualizarProgreso(idProgreso, {
      fase: "guardado",
      mensaje: "Guardando los apuntes",
      detalle: "Guardando los apuntes en la carpeta seleccionada y los informes JSON dentro del proyecto Generador.",
    });
    const inputFiles = archivos.map((archivo) => ({
      originalname: archivo.originalname,
      size: archivo.size,
      buffer: archivo.buffer,
    }));
    const informesPrevios = await listarHistorialGeneraciones(asignatura);
    const archivosCambiados = compararArchivosProcesados(
      inputFiles,
      informesPrevios,
    );
    const opcionesGuardado = {
      result: resultado,
      fingerprint,
      subject: asignatura,
      theme: destino.tema,
      subtheme: destino.apartado,
      inputFiles,
      material,
      existingCount: (await listarApuntes(asignatura)).length,
      archivosCambiados,
    };
    const sustituirExistentes = solicitud.body.replace_existing === "true";
    if (sustituirExistentes) {
      const archivosAConfirmar = await inspeccionarReemplazosGeneracion({
        result: resultado,
        subject: asignatura,
        theme: destino.tema,
        subtheme: destino.apartado,
        fingerprint,
        inputFiles,
      });
      if (archivosAConfirmar.length) {
        generacionesPendientes.set(idProgreso, {
          opcionesGuardado,
          expectedExistingFiles: Object.fromEntries(
            archivosAConfirmar.map((archivo) => [archivo.path, archivo.sha256]),
          ),
          archivosAConfirmar,
          creado: Date.now(),
        });
        actualizarProgreso(idProgreso, {
          fase: "confirmacion",
          mensaje: "Confirma si quieres sustituir los apuntes existentes",
          detalle: `Hay ${archivosAConfirmar.length} archivo(s) con el mismo nombre que se sustituirían.`,
        });
        return respuesta.status(202).json({
          pendiente_confirmacion: true,
          id: idProgreso,
          archivos_a_sustituir: archivosAConfirmar.map((archivo) => archivo.path),
          archivos_cambiados: archivosCambiados,
        });
      }
    }
    const generacionGuardada = await guardarGeneracion({
      ...opcionesGuardado,
      replaceExisting: sustituirExistentes,
      expectedExistingFiles: {},
    });
    actualizarProgreso(idProgreso, {
      fase: "completado",
      mensaje: "Apuntes listos",
      detalle: `${generacionGuardada.salida.written.length} archivo(s) LaTeX guardado(s); generación y cobertura registradas.`,
      actual: 1,
      total: 1,
    });
    respuesta.json(
      respuestaInforme(
        generacionGuardada.report,
        generacionGuardada.salida,
        false,
      ),
    );
  }),
);

aplicacion.post(
  "/api/generate/:id/save",
  rutaAsincrona(async (solicitud, respuesta) => {
    const pendiente = generacionesPendientes.get(solicitud.params.id);
    if (!pendiente)
      throw errorHttp(404, "La confirmación de sustitución ya no está disponible.");
    const sustituirExistentes = solicitud.body?.replace_existing === true;
    const generacionGuardada = await guardarGeneracion({
      ...pendiente.opcionesGuardado,
      replaceExisting: sustituirExistentes,
      expectedExistingFiles: sustituirExistentes
        ? pendiente.expectedExistingFiles
        : {},
    });
    generacionesPendientes.delete(solicitud.params.id);
    actualizarProgreso(solicitud.params.id, {
      fase: "completado",
      mensaje: "Apuntes listos",
      detalle: `${generacionGuardada.salida.written.length} archivo(s) LaTeX guardado(s); generación y cobertura registradas.`,
      actual: 1,
      total: 1,
    });
    respuesta.json(
      respuestaInforme(generacionGuardada.report, generacionGuardada.salida, false),
    );
  }),
);

function combinarResultadosParciales(resultados) {
  if (resultados.length === 1) return resultados[0];
  const conceptos = new Map();
  const cobertura = new Map();
  const fuentes = new Map();
  for (const resultado of resultados) {
    for (const concepto of resultado.conceptos_clave ?? []) {
      conceptos.set(concepto.toLocaleLowerCase("es"), concepto);
    }
    for (const elemento of resultado.cobertura ?? []) {
      const clave = elemento.concepto.toLocaleLowerCase("es");
      const anterior = cobertura.get(clave);
      const prioridad = { pendiente: 0, ya_cubierto: 1, incluido: 2 };
      if (!anterior || prioridad[elemento.estado] > prioridad[anterior.estado])
        cobertura.set(clave, elemento);
    }
    for (const fuente of resultado.fuentes ?? []) {
      fuentes.set(fuente.url || `${fuente.titulo}:${fuente.consulta}`, fuente);
    }
  }
  return {
    ...resultados[0],
    resumen: resultados
      .map((resultado) => resultado.resumen)
      .filter(Boolean)
      .join("\n\n"),
    archivos: resultados.flatMap((resultado) => resultado.archivos),
    imagenes: resultados.flatMap((resultado) => resultado.imagenes),
    conceptos_clave: [...conceptos.values()],
    cobertura: [...cobertura.values()],
    fuentes: [...fuentes.values()],
  };
}

aplicacion.post(
  "/api/improve",
  subida.array("files"),
  rutaAsincrona(async (solicitud, respuesta) => {
    const controlador = new AbortController();
    solicitud.once("aborted", () => controlador.abort());
    const requestedPath = String(solicitud.body.path ?? "").trim();
    const subject = solicitud.body.subject
      ? componenteSeguro(solicitud.body.subject)
      : "";
    const topic = String(solicitud.body.topic ?? "").trim().slice(0, 100);
    const investigar = solicitud.body.research_enabled === "true";
    const selectedText = String(solicitud.body.selectedText ?? "").slice(
      0,
      6000,
    );
    const question = String(solicitud.body.question ?? "")
      .trim()
      .slice(0, 2500);
    if (!selectedText.trim() && !question)
      throw errorHttp(400, "Selecciona texto o escribe qué necesitas mejorar.");
    const candidates = requestedPath
      ? [{ path: requestedPath, content: (await leerApunte(requestedPath)).content }]
      : await Promise.all(
          (await listarApuntes(subject)).map(async ({ path: notePath }) => ({
            path: notePath,
            content: (await leerApunte(notePath)).content,
          })),
        );
    const candidatesForTopic = topic
      ? candidates.filter((candidate) => {
          const tema = topic.match(/^tema:(\d+)/)?.[1];
          const apartado = topic.match(/;apartado:(\d+)/)?.[1];
          if (!tema) return true;
          if (!new RegExp(`(?:^|/)Tema ${tema}/`).test(candidate.path))
            return false;
          return !apartado || new RegExp(`${tema}\\.${apartado}(?:[.-]|/)`).test(candidate.path);
        })
      : candidates;
    const candidatesToUse = candidatesForTopic.length ? candidatesForTopic : candidates;
    if (!candidates.length)
      throw errorHttp(404, "La asignatura no tiene apuntes LaTeX para revisar.");
    const candidatePaths = new Set(candidatesToUse.map((candidate) => candidate.path));
    const index = candidatesToUse
      .map(
        (candidate) =>
          `RUTA: ${candidate.path}\nCONTENIDO:\n${candidate.content.slice(0, 18000)}`,
      )
      .join("\n\n--- APARTADO SIGUIENTE ---\n\n");

    let sourceText = "";
    let visuals = [];
    let fuentesWeb = [];
    const files = solicitud.files ?? [];
    if (files.length) {
      const material = await extraerMateriales(files);
      sourceText = textoMaterial(material);
      visuals = material.visuals;
      if (visuals.length)
        sourceText += `\n\nSe adjuntan ${visuals.length} páginas o imágenes para interpretar visualmente.`;
    }
    if (investigar) {
      const consultaWeb = [subject, topic.replace(/[;:]/g, " "), question]
        .filter(Boolean)
        .join(" ")
        .slice(0, 300);
      fuentesWeb = await buscarFuentesOpcionales(
        [consultaWeb],
        [],
        buscarEnInternet,
        () => {},
        controlador.signal,
      );
      sourceText += `\n\nFUENTES WEB:\n${fuentesWeb
        .map((fuente) => `${fuente.titulo}\n${fuente.url}\n${fuente.resumen}`)
        .join("\n\n") || "(no se encontraron fuentes web)"}`;
    }
    const prompt = `ASIGNATURA: ${subject}
    TEMA O APARTADO ELEGIDO POR EL ESTUDIANTE: ${topic || "(detección automática)"}

ÍNDICE DE APUNTES DISPONIBLES:
<<<INDICE
${index}
INDICE>>>

APUNTE QUE SE ESTÁ REVISANDO: ${requestedPath || "(selecciona tú el apartado relacionado)"}

TEXTO SELECCIONADO:
<<<SELECCION
${selectedText || "(sin selección: el usuario describe una duda)"}
SELECCION>>>

QUÉ QUIERE ENTENDER, CAMBIAR O AÑADIR EL ESTUDIANTE:
${question || "(explicar la selección con palabras más sencillas)"}

FUENTE ADICIONAL SELECCIONADA POR EL ESTUDIANTE (PDF, código o texto):
<<<FUENTE
${sourceText || "(no se adjuntó material adicional)"}
FUENTE>>>

Devuelve una explicación sencilla y una propuesta de texto LaTeX mejorado. No escribas en disco: el estudiante revisará la propuesta y decidirá si la aplica. Usa ejemplos didácticos originales y atiende exactamente su duda. Si se adjuntaron páginas como imágenes, interprétalas también.`;
    try {
      const suggestion = await consultarModeloIA(
        sistemaMejora,
        prompt,
        visuals,
        controlador.signal,
      );
      const targetPath = String(suggestion.target_path || requestedPath).trim();
      if (!candidatePaths.has(targetPath))
        throw new Error(
          `La IA devolvió una ruta de apartado no válida: ${targetPath || "(vacía)"}`,
        );
      const note = await leerApunte(targetPath);
      respuesta.json({
        path: targetPath,
        selectedText,
        originalSha256: note.sha256,
        explicacion: String(suggestion.explicacion ?? ""),
        reemplazo_latex: limpiarLatex(
          String(suggestion.reemplazo_latex ?? ""),
        ),
        anadido_latex: limpiarLatex(String(suggestion.anadido_latex ?? "")),
        fuentes: fuentesWeb,
      });
    } catch (error) {
      console.error("Falló la mejora del apunte:", error);
      throw errorHttp(502, `No se pudo preparar la mejora: ${error.message}`);
    }
  }),
);

aplicacion.use((error, solicitud, respuesta, _next) => {
  const idProgreso = String(solicitud.body?.progress_id ?? "");
  const cancelada =
    error.status === 499 ||
    (error.message === "Request aborted" && !Number.isInteger(error.status)) ||
    (Boolean(idProgreso) && controladoresGeneracion.get(idProgreso)?.signal.aborted);
  if (cancelada) {
    actualizarProgreso(idProgreso, {
      fase: "cancelado",
      mensaje: "Generación detenida",
      detalle: "La petición y las llamadas activas se han cancelado. No se guardaron apuntes.",
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
  console.log(`Modelo visión/texto: ${config.model} · Modelo código: ${config.codeModel}`);
  void reanudarTrabajosEtapasAlArrancar();
});
servidorHttp.timeout = 0;
servidorHttp.keepAliveTimeout = 0;
servidorHttp.headersTimeout = 0;
servidorHttp.requestTimeout = 0;

async function reanudarTrabajosEtapasAlArrancar() {
  const trabajos = await listarTrabajosEtapas();
  for (const trabajo of trabajos) {
    if (
      trabajo.estado === "confirmacion" ||
      trabajo.estado === "cancelado" ||
      /aborted|cancelad|detenido por el usuario/i.test(trabajo.error)
    )
      continue;
    console.log(
      `Reanudando trabajo guardado ${trabajo.id} (${trabajo.unidadActual}/${trabajo.totalUnidades}).`,
    );
    iniciarTrabajoEtapas(trabajo.id);
  }
}

function iniciarTrabajoEtapas(id) {
  if (trabajosEtapasActivos.has(id)) return;
  const controlador = new AbortController();
  trabajosEtapasActivos.add(id);
  controladoresGeneracion.set(id, controlador);
  void ejecutarTrabajoEtapas(id, controlador)
    .catch(async (error) => {
      const pausado = error?.name === "AbortError" || error?.status === 499;
      console.error(`Falló el trabajo por etapas ${id}:`, error);
      try {
        const trabajo = await cargarTrabajoEtapas(id);
        trabajo.estado = "pendiente";
        trabajo.error = pausado
          ? ""
          : error.message || "Error inesperado durante la generación.";
        await guardarTrabajoEtapas(trabajo);
      } catch (errorEstado) {
        console.error(`No se pudo guardar el estado del trabajo ${id}:`, errorEstado);
      }
      if (!pausado)
        actualizarProgreso(id, {
          fase: "error",
          mensaje: "La generación se detuvo y puede reanudarse",
          detalle: error.message || "Error inesperado durante la generación.",
        });
    })
    .finally(() => {
      trabajosEtapasActivos.delete(id);
      if (controladoresGeneracion.get(id) === controlador)
        controladoresGeneracion.delete(id);
    });
}

async function ejecutarTrabajoEtapas(id, controlador) {
  const trabajo = await cargarTrabajoEtapas(id);
  if (trabajo.estado === "completado" || trabajo.estado === "confirmacion") return;
  trabajo.estado = "procesando";
  trabajo.error = "";
  await guardarTrabajoEtapas(trabajo);
  const fuentes = await Promise.all(
    trabajo.fuentes.map(async (fuente) => ({
      originalname: fuente.nombre,
      size: fuente.bytes,
      buffer: await leerFuenteTrabajo(trabajo, fuente),
    })),
  );
  const extracciones = [];
  for (let indice = 0; indice < fuentes.length; indice += 1) {
    comprobarCancelacion(controlador.signal);
    let extraido = await cargarExtraccionTrabajo(id, indice);
    if (!extraido) {
      actualizarProgreso(id, {
        fase: "lectura",
        mensaje: `Leyendo fuente ${indice + 1} de ${fuentes.length}`,
        detalle: `${fuentes[indice].originalname}: extrayendo texto, código y OCR.`,
        actual: indice + 1,
        total: fuentes.length,
      });
      extraido = await extraerMateriales([fuentes[indice]], {
        signal: controlador.signal,
      });
      await guardarExtraccionTrabajo(id, indice, extraido);
    }
    extracciones.push(extraido);
  }
  comprobarCancelacion(controlador.signal);
  const documentos = extracciones.flatMap((extraido) => extraido.documents);
  const avisos = extracciones.flatMap((extraido) => extraido.warnings);
  const imagenes = extracciones.flatMap((extraido) => extraido.visuals);
  const materialCompleto = {
    documents: documentos,
    warnings: [...avisos, ...(trabajo.avisos ?? [])],
    visuals: imagenes,
    imagesOcr: extracciones.reduce(
      (total, extraido) => total + extraido.imagesOcr,
      0,
    ),
  };
  if (!documentos.length)
    throw errorHttp(
      422,
      `No se pudo extraer texto de los archivos seleccionados. ${avisos.slice(0, 4).join(" ")}`,
    );

  const unidadesPdf = [];
  const unidadesCodigo = [];
  // Los trabajos nuevos agrupan los archivos pequeños de código/texto en una
  // sola llamada a la IA; los trabajos ya empezados conservan sus ids antiguos.
  const analizarCodigo =
    trabajo.opciones.analisisCodigoHabilitado !== false;
  const agruparCodigo = trabajo.agruparCodigo ?? !trabajo.unidadesPreparadas;
  trabajo.agruparCodigo = agruparCodigo;
  const bloquesCodigoSueltos = [];
  const bloquesTextoSueltos = [];
  const textosVistos = new Set();
  const documentosUnicos = [];
  for (const doc of documentos) {
    const textoDoc = (doc.text || "").trim();
    const clave = `${doc.kind}:${textoDoc}`;
    if (textoDoc && clave.length > 50 && textosVistos.has(clave)) continue;
    if (clave.length > 50) textosVistos.add(clave);
    documentosUnicos.push(doc);
  }
  for (const [indiceDocumento, documento] of documentosUnicos.entries()) {
    if (
      documento.kind === "code" &&
      esBibliotecaTerceraParte(documento.name)
    )
      continue;
    const bloquesCodigo =
      Array.isArray(documento.bloquesCodigo) && documento.bloquesCodigo.length
        ? documento.bloquesCodigo
        : [];
    const textoBase =
      documento.kind === "code"
        ? documento.text
        : bloquesCodigo.length
          ? `${documento.text}\n\n${bloquesCodigo
              .map((bloque) => `--- CÓDIGO ---\n${bloque}`)
              .join("\n\n")}`
          : documento.text;
    const textoDocumento = `--- ${documento.kind.toUpperCase()}: ${documento.name}${documento.language ? ` (${documento.language})` : ""} ---\n${textoBase}`;
    if (documento.kind === "pdf") {
      const visualesDocumento = imagenes.filter(
        (imagen) => imagen.name === documento.name || imagen.name.startsWith(`${documento.name} ·`),
      );
      // Prioridad texto puro: si el PDF ya contiene texto digital abundante (> 1000 caracteres),
      // no fragmentar por imágenes decorativas de diapositivas (fotos de stock, logos o iconos).
      // Conservar solo si son diagramas arquitectónicos relevantes o si el PDF tiene poco texto.
      const apartadosDetectados = detectarApartadosEnTexto(textoDocumento);
      if (apartadosDetectados.length >= 2) {
        const bloquesApartados = dividirTextoPorApartados(
          textoDocumento,
          visualesDocumento,
          apartadosDetectados,
        );
        for (const [indiceBloque, bloque] of bloquesApartados.entries()) {
          unidadesPdf.push({
            id: `pdf-${indiceDocumento}-apartado-${bloque.temaNumero}_${bloque.apartadoNumero}`,
            documento,
            texto: bloque.texto,
            imagenes: bloque.imagenes,
            apartadoNumero: bloque.apartadoNumero,
            apartadoTitulo: bloque.apartadoTitulo,
            temaNumero: bloque.temaNumero,
          });
        }
      } else {
        const visualesRelevantes =
          textoDocumento.length > 1000 && visualesDocumento.length > 4
            ? visualesDocumento.filter((img) => (img.ancho >= 400 && img.alto >= 250) || !img.ancho).slice(0, 4)
            : visualesDocumento;
        const tamanoBloque = config.contextSize >= 24000 ? 18000 : 8000;
        const maxImagenesBloque = config.contextSize >= 24000 ? 4 : 2;
        const bloques = dividirMaterialConImagenes(
          textoDocumento,
          visualesRelevantes,
          tamanoBloque,
          maxImagenesBloque,
        );
        for (const [indiceBloque, bloque] of bloques.entries()) {
          unidadesPdf.push({
            id: `pdf-${indiceDocumento}-${indiceBloque}`,
            documento,
            texto: bloque.texto,
            imagenes: bloque.imagenes,
          });
        }
      }
    } else if (documento.kind === "code") {
      // Procesar siempre los archivos de código y ZIPs aportados por el usuario
      const bloques = dividirCodigoEnBloques(
        textoDocumento,
        18000,
        documento.language === "JSON",
      );
      for (const [indiceBloque, texto] of bloques.entries()) {
        if (agruparCodigo) {
          bloquesCodigoSueltos.push({
            documento,
            texto:
              indiceBloque === 0
                ? texto
                : `--- ${documento.kind.toUpperCase()}: ${documento.name} (continuación) ---\n${texto}`,
          });
        } else {
          unidadesCodigo.push({
            id: `codigo-${indiceDocumento}-${indiceBloque}`,
            documento,
            texto,
          });
        }
      }
    } else {
      const tamanoBloque = config.contextSize >= 24000 ? 18000 : 6000;
      const bloques = dividirMaterial(textoDocumento, tamanoBloque);
      for (const [indiceBloque, texto] of bloques.entries()) {
        if (agruparCodigo) {
          bloquesTextoSueltos.push({
            documento,
            texto,
          });
        } else {
          unidadesPdf.push({
            id: `texto-${indiceDocumento}-${indiceBloque}`,
            documento,
            texto,
            imagenes: [],
          });
        }
      }
    }
  }
  if (agruparCodigo && bloquesTextoSueltos.length) {
    let grupo = [];
    let longitud = 0;
    const cerrarGrupoTexto = () => {
      if (!grupo.length) return;
      const nombres = [...new Set(grupo.map((bloque) => bloque.documento.name))];
      unidadesPdf.push({
        id: `texto-g${unidadesPdf.length}`,
        documento: {
          ...grupo[0].documento,
          name:
            nombres.length > 1
              ? `${nombres[0]} y ${nombres.length - 1} archivo(s) más`
              : nombres[0],
        },
        texto: grupo.map((bloque) => bloque.texto).join("\n\n"),
        imagenes: [],
      });
      grupo = [];
      longitud = 0;
    };
    for (const bloque of bloquesTextoSueltos) {
      if (grupo.length && longitud + bloque.texto.length > 18000) cerrarGrupoTexto();
      grupo.push(bloque);
      longitud += bloque.texto.length + 2;
    }
    cerrarGrupoTexto();
  }
  if (agruparCodigo) {
    let grupo = [];
    let longitud = 0;
    const cerrarGrupo = () => {
      if (!grupo.length) return;
      const nombres = [...new Set(grupo.map((bloque) => bloque.documento.name))];
      unidadesCodigo.push({
        id: `codigo-g${unidadesCodigo.length}`,
        documento: {
          ...grupo[0].documento,
          name:
            nombres.length > 1
              ? `${nombres[0]} y ${nombres.length - 1} archivo(s) más`
              : nombres[0],
        },
        texto: grupo.map((bloque) => bloque.texto).join("\n\n"),
      });
      grupo = [];
      longitud = 0;
    };
    for (const bloque of bloquesCodigoSueltos) {
      if (grupo.length && longitud + bloque.texto.length > 18000) cerrarGrupo();
      grupo.push(bloque);
      longitud += bloque.texto.length + 2;
    }
    cerrarGrupo();
  }
  if (!trabajo.unidadesPreparadas) {
    trabajo.unidadesPdf = unidadesPdf.map((unidad) => unidad.id);
    trabajo.unidadesCodigo = unidadesCodigo.map((unidad) => unidad.id);
    trabajo.unidadesPreparadas = true;
    trabajo.fase = unidadesPdf.length ? "pdf" : "codigo";
    trabajo.unidadActual = 0;
    await guardarTrabajoEtapas(trabajo);
  } else if (
    trabajo.fase === "pdf" ||
    (trabajo.unidadActual === 0 &&
      !(trabajo.resultadosPreparados ?? []).some((item) =>
        item.unidad.startsWith("codigo-"),
      ) &&
      !trabajo.bloquePendiente)
  ) {
    trabajo.unidadesPdf = unidadesPdf.map((unidad) => unidad.id);
    trabajo.unidadesCodigo = unidadesCodigo.map((unidad) => unidad.id);
    await guardarTrabajoEtapas(trabajo);
  }

  const referenciaBiblioteca = await obtenerReferenciaBibliotecaSegura();
  while (trabajo.fase === "pdf" || trabajo.fase === "codigo") {
    comprobarCancelacion(controlador.signal);
    const esPdf = trabajo.fase === "pdf";
    const unidades = esPdf ? unidadesPdf : unidadesCodigo;
    if (trabajo.unidadActual >= unidades.length) {
      if (esPdf && !trabajo.etapaPdfGuardada) {
        const pdfGuardados = await prepararGuardadoTrabajo(
          trabajo,
          fuentes,
          materialCompleto,
          "pdf",
          false,
        );
        if (!pdfGuardados) return;
        trabajo.etapaPdfGuardada = true;
        await guardarTrabajoEtapas(trabajo);
      }
      trabajo.fase = esPdf ? "codigo" : "guardado";
      trabajo.unidadActual = 0;
      await guardarTrabajoEtapas(trabajo);
      continue;
    }
    if (trabajo.bloquePendiente) {
      trabajo.resultadosPreparados ??= [];
      trabajo.resultadosPreparados.push(...trabajo.bloquePendiente);
      trabajo.bloquePendiente = null;
      trabajo.unidadActual += 1;
      await guardarTrabajoEtapas(trabajo);
      continue;
    }

    const concurrenciaEtapas = Math.min(config.parallelRequests, 2);
    const lote = unidades.slice(
      trabajo.unidadActual,
      trabajo.unidadActual + concurrenciaEtapas,
    );
    actualizarProgreso(id, {
      fase: "ia",
      mensaje: `Analizando ${esPdf ? "PDF" : "código"} (${lote.length} en paralelo)`,
      detalle: `${lote.map((unidad) => unidad.documento.name).join("; ")}. Se guardarán juntas estas partes antes de avanzar; las partes anteriores ya están conservadas.`,
      actual: trabajo.unidadActual + 1,
      total: unidades.length,
    });
    trabajo.resultadosPreparados ??= [];
    const resultadosLote = await Promise.allSettled(
      lote.map((unidad) =>
        generarUnidadEtapasConReintentos({
          trabajo,
          unidad,
          esPdf,
          referenciaBiblioteca,
          controlador,
        }),
      ),
    );
    const falloLote = resultadosLote.find(
      (resultado) => resultado.status === "rejected",
    );
    if (falloLote) throw falloLote.reason;
    for (const resultado of resultadosLote) {
      trabajo.resultadosPreparados.push(...resultado.value);
      // Escritura simultánea inmediata de los archivos LaTeX en disco
      for (const bloqueResultado of resultado.value) {
        if (bloqueResultado?.resultado?.archivos?.length) {
          try {
            await guardarGeneracion({
              result: bloqueResultado.resultado,
              fingerprint: createHash("sha256")
                .update(trabajo.id)
                .update(bloqueResultado.unidad)
                .digest("hex"),
              subject: trabajo.asignatura,
              theme: bloqueResultado.destino.tema,
              subtheme: bloqueResultado.destino.apartado,
              inputFiles: fuentes,
              material: materialCompleto,
              existingCount: 0,
              replaceExisting: true,
            });
          } catch (errGuardado) {
            console.warn("Aviso al guardar avance simultáneo:", errGuardado.message);
          }
        }
      }
    }
    trabajo.unidadActual += lote.length;
    await guardarExtraccionesPorTema(
      id,
      crearExtraccionesPorTema(trabajo, unidadesPdf, unidadesCodigo),
    );
    await guardarTrabajoEtapas(trabajo);
  }
  comprobarCancelacion(controlador.signal);
  if (trabajo.fase === "guardado")
    await prepararGuardadoTrabajo(
      trabajo,
      fuentes,
      materialCompleto,
      "codigo",
      true,
    );
}

// Un resumen por apartado en lugar de uno por cada trozo de PDF: así la
// petición de código no crece con cada PDF analizado ni agota el contexto.
function compactarTemarioPdf(resultados = [], maxCaracteres = 8000) {
  const grupos = new Map();
  for (const { unidad, destino, resultado } of resultados ?? []) {
    if (!unidad.startsWith("pdf-")) continue;
    const clave = `${destino.tema}.${destino.apartado}`;
    const grupo = grupos.get(clave) ?? {
      titulo: `Tema ${destino.tema}: ${destino.tituloTema} · Apartado ${clave}: ${destino.tituloApartado}`,
      conceptos: new Set(),
    };
    for (const concepto of resultado.conceptos_clave ?? [])
      grupo.conceptos.add(concepto);
    grupos.set(clave, grupo);
  }
  const texto = [...grupos.values()]
    .map(
      (grupo) =>
        `${grupo.titulo}\nConceptos: ${[...grupo.conceptos].slice(0, 15).join(", ")}`,
    )
    .join("\n\n");
  return texto.length > maxCaracteres
    ? `${texto.slice(0, maxCaracteres)}\n[...]`
    : texto;
}

async function generarUnidadEtapasConReintentos(opciones) {
  for (let reintento = 0; ; reintento += 1) {
    try {
      return await generarUnidadEtapasConDivision(opciones);
    } catch (error) {
      if (opciones.controlador.signal.aborted) throw error;
      if (
        !esFalloTransitorioIA(error) ||
        reintento >= maxReintentosTemporalesEtapas
      )
        throw error;

      const esperaMs = Math.min(15_000 * 2 ** reintento, 120_000);
      console.warn(
        `Fallo temporal en ${opciones.unidad.id}; reintento automático ${reintento + 1}/${maxReintentosTemporalesEtapas} en ${Math.ceil(esperaMs / 1000)} s: ${error.message}`,
      );
      actualizarProgreso(opciones.trabajo.id, {
        fase: "ia",
        mensaje: "Reintentando automáticamente esta parte",
        detalle: `${opciones.unidad.documento.name}: fallo temporal de Ollama. Reintento ${reintento + 1} de ${maxReintentosTemporalesEtapas}; las partes ya terminadas se conservan.`,
      });
      await esperarConCancelacion(esperaMs, opciones.controlador.signal);
    }
  }
}

function esFalloTransitorioIA(error) {
  if (error.retryable === true || error.name === "TimeoutError") return true;
  const codigosTransitorios = new Set([
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ]);
  for (let actual = error; actual; actual = actual.cause) {
    if (codigosTransitorios.has(actual.code)) return true;
  }
  return /fetch failed|headers timeout|agotó el tiempo disponible/i.test(
    error.message,
  );
}

function esperarConCancelacion(duracionMs, signal) {
  return new Promise((resolve, reject) => {
    const limpiar = () => signal.removeEventListener("abort", cancelar);
    const timer = setTimeout(() => {
      limpiar();
      resolve();
    }, duracionMs);
    const cancelar = () => {
      clearTimeout(timer);
      limpiar();
      reject(errorHttp(499, "Generación detenida durante el reintento."));
    };
    if (signal.aborted) cancelar();
    else signal.addEventListener("abort", cancelar, { once: true });
  });
}

function crearSeccionRespaldo(opciones) {
  const { trabajo, unidad } = opciones;
  const inferido = inferirTemaYApartadoDeDocumento(unidad.documento?.name, unidad.texto);
  const tema = inferido?.tema || trabajo.opciones.tema || 1;
  const apartado = inferido?.apartado || trabajo.opciones.apartado || 1;
  const tituloTema = inferido?.tituloTema || trabajo.opciones.tituloTema || `Tema ${tema}`;

  let tituloApartado = inferido?.tituloApartado;
  const lineas = unidad.texto.split("\n").map((l) => l.trim()).filter(Boolean);
  const lineaTitulo = lineas.find((l) => /^#+\s*|^[A-Za-z0-9\.\s\-]{4,60}$/.test(l) && !/contenido/i.test(l));
  if (lineaTitulo) {
    tituloApartado = lineaTitulo.replace(/^#+\s*/, "").slice(0, 80).trim();
  }
  tituloApartado ||= trabajo.opciones.tituloApartado || `Tema ${tema}.${apartado}`;

  const textoLimpio = unidad.texto
    .replace(/^---.*?---\n?/gm, "")
    .replace(/\r/g, "")
    .replace(/^[ \t]+/gm, "")
    .trim();

  const lineasTexto = textoLimpio.split("\n").filter(Boolean);
  const primerParrafo = lineasTexto.slice(0, 3).join(" ").slice(0, 350).replace(/[{}\\$%&#^_]/g, " ");

  let latexCuerpo = "";
  let enCodigo = false;
  let bloqueCodigo = [];
  for (const linea of lineasTexto.slice(3, 30)) {
    if (/```|function\s*\(|const |let |var |=>|\{|\}/.test(linea)) {
      enCodigo = true;
      bloqueCodigo.push(linea.replace(/```[a-z]*/g, ""));
    } else {
      if (enCodigo && bloqueCodigo.length) {
        latexCuerpo += `\n\\begin{codigo}[javascript]\n${bloqueCodigo.join("\n")}\n\\end{codigo}\n`;
        bloqueCodigo = [];
        enCodigo = false;
      }
      latexCuerpo += `${linea.replace(/[{}\\$%&#^_]/g, " ")}\n\n`;
    }
  }
  if (bloqueCodigo.length) {
    latexCuerpo += `\n\\begin{codigo}[javascript]\n${bloqueCodigo.join("\n")}\n\\end{codigo}\n`;
  }

  const slugBase = crearNombreArchivo(tituloApartado) || `tema-${tema}-${apartado}`;
  const sufijoId = unidad.id.replace(/[^\w-]/g, "_").slice(-12);
  const archivoNombre = `${slugBase}-${sufijoId}`;

  const latex = String.raw`\secciongrande{${tituloApartado}}
\resumen{${primerParrafo}}

\seccion{Continguts i desenvolupament}
${latexCuerpo || primerParrafo}
`;

  const resultado = {
    tema,
    subtema: apartado,
    titulo_tema: tituloTema,
    titulo_subtema: tituloApartado,
    archivos: [
      {
        titulo: tituloApartado,
        nombre: archivoNombre,
        conceptos: [tituloApartado],
        latex,
      },
    ],
    conceptos_clave: [tituloApartado],
    cobertura: [
      {
        concepto: tituloApartado,
        estado: "incluido",
        apartado: tituloApartado,
      },
    ],
    imagenes: [],
    fuentes: [],
  };
  const destino = {
    tema,
    apartado,
    tituloTema,
    tituloApartado,
  };
  return { unidad: unidad.id, resultado, destino };
}

async function generarUnidadEtapasConDivision(
  opciones,
  unidadOriginal = opciones.unidad,
) {
  try {
    const resultados = await generarUnidadEtapas(opciones);
    if (opciones.unidad.id !== unidadOriginal.id) {
      const sufijo = opciones.unidad.id
        .slice(unidadOriginal.id.length)
        .replace(/^-/, "")
        .replaceAll("-", "_");
      for (const archivo of resultados.flatMap((item) => item.resultado.archivos)) {
        let base = "";
        if (
          !archivo.nombre ||
          /^(?:apartado(?:-\d+)*|slug-(?:concepto|descriptivo)|seccion(?:-\d+)*)$/i.test(archivo.nombre) ||
          /fragmento/i.test(archivo.nombre)
        ) {
          base = deducirSlugConceptual(archivo.nombre, archivo.titulo);
        } else {
          base = crearNombreArchivo(archivo.nombre);
        }
        archivo.nombre = sufijo ? `${base}-fragmento-${sufijo}` : base;
      }
    }
    return resultados;
  } catch (error) {
    const profundidad = (opciones.unidad.id.match(/-p\d+/g) || []).length;
    const esDivisible =
      /token repeat limit reached|prediction aborted|límite de salida de Ollama|se truncó|no pudo procesar esta parte|exceeds the available context size|JSON|apartados LaTeX utilizables|objeto con apartados/i.test(
        `${error?.message ?? ""} ${error?.cause?.message ?? ""}`,
      );
    if (opciones.esPdf && opciones.unidad.imagenes?.length > 0 && esDivisible) {
      console.warn(
        `Ajustando ${opciones.unidad.id}: reintentando sin imágenes para evitar desbordar el contexto de Ollama (${error.message}).`,
      );
      return await generarUnidadEtapasConDivision({
        ...opciones,
        unidad: {
          ...opciones.unidad,
          imagenes: [],
        },
      });
    }

    const sePuedeDividir =
      opciones.esPdf &&
      profundidad < 2 &&
      opciones.unidad.texto.length > 1000 &&
      esDivisible;
    if (!sePuedeDividir) {
      throw error;
    }

    const partes = dividirMaterial(
      opciones.unidad.texto,
      Math.ceil(opciones.unidad.texto.length / 2),
    );
    if (partes.length < 2) throw error;
    console.warn(
      `Ollama no pudo completar ${opciones.unidad.id}; se reintentará en ${partes.length} fragmentos. ${error.message}`,
    );
    actualizarProgreso(opciones.trabajo.id, {
      fase: "ia",
      mensaje: "Ajustando el tamaño de una parte para Ollama",
      detalle: `${opciones.unidad.documento.name}: la petición se dividirá en ${partes.length} fragmentos y se reintentará automáticamente.`,
    });

    const resultados = [];
    for (const [indice, texto] of partes.entries()) {
      comprobarCancelacion(opciones.controlador.signal);
      resultados.push(
        ...(await generarUnidadEtapasConDivision(
          {
            ...opciones,
            unidad: {
              ...opciones.unidad,
              id: `${opciones.unidad.id}-p${indice + 1}`,
              texto,
            },
          },
          unidadOriginal,
        )),
      );
    }
    return resultados;
  }
}

async function generarUnidadEtapas({
  trabajo,
  unidad,
  esPdf,
  referenciaBiblioteca,
  controlador,
}) {
  const compararApuntesHabilitado =
    trabajo.opciones.compararApuntesHabilitado;
  const catalogo = compararApuntesHabilitado
    ? await catalogoTemasTrabajo(trabajo)
    : [];
  const temasExistentes = compararApuntesHabilitado
    ? catalogo
    .map((tema) => {
      const apartados = tema.apartados
        .map((apartado) => `Apartado ${tema.numero}.${apartado.numero}: ${apartado.nombre}`)
        .join("; ");
      return `- Tema ${tema.numero}: ${tema.titulo || tema.nombre}${apartados ? ` (${apartados})` : ""}`;
    })
    .join("\n")
    : "";
  const inferidoDoc = inferirTemaYApartadoDeDocumento(unidad.documento?.name, unidad.texto);
  const tieneMultiplesTemas =
    (trabajo.unidadesPdf?.length || 0) + (trabajo.unidadesCodigo?.length || 0) > 1;
  const usarInferencia = inferidoDoc && (tieneMultiplesTemas || !trabajo.opciones.tema);
  const temaEfectivo = unidad.temaNumero || (usarInferencia ? inferidoDoc.tema : (trabajo.opciones.tema || 1));
  const apartadoEfectivo = unidad.apartadoNumero || (usarInferencia ? inferidoDoc.apartado : (trabajo.opciones.apartado || 1));
  const tituloTemaEfectivo = (usarInferencia ? inferidoDoc.tituloTema : (trabajo.opciones.tituloTema || `Tema ${temaEfectivo}`));
  const tituloApartadoEfectivo = unidad.apartadoTitulo || (usarInferencia ? inferidoDoc.tituloApartado : (trabajo.opciones.tituloApartado || `Apartado ${apartadoEfectivo}`));

  if (esPdf) {
    let fuentesWeb = [];
    if (trabajo.opciones.investigacionHabilitada) {
      const consultas = crearConsultasInvestigacion({
        asignatura: trabajo.asignatura,
        tituloTema: tituloTemaEfectivo,
        tituloApartado: tituloApartadoEfectivo,
        material: { documents: [{ name: unidad.documento.name, text: unidad.texto }] },
      });
      trabajo.avisos ??= [];
      fuentesWeb = await buscarFuentesOpcionales(
        consultas,
        trabajo.avisos,
        (consulta) => buscarEnInternet(consulta, 3, controlador.signal),
        () => {},
        controlador.signal,
      );
    }
    const instruccion = crearPromptApuntes({
      asignatura: trabajo.asignatura,
      tema: temaEfectivo,
      tituloTema: tituloTemaEfectivo,
      apartado: apartadoEfectivo,
      tituloApartado: tituloApartadoEfectivo,
      instruccionEstudiante: trabajo.opciones.instruccionEstudiante,
      material: unidad.texto,
      temasExistentes,
      investigacion: fuentesWeb
        .map((fuente) =>
          `FUENTE: ${fuente.titulo}\nURL: ${fuente.url}\nRESUMEN: ${fuente.resumen}`,
        )
        .join("\n\n"),
      referenciaBiblioteca,
      parteMaterial:
        [
          `ETAPA_PDF: APARTADO ${apartadoEfectivo}: ${tituloApartadoEfectivo}. OBLIGATORIO: traduce el título del tema, del apartado y todas las secciones al ESPAÑOL ESTÁNDAR en el JSON ("titulo_tema", "titulo_subtema", "archivos[].titulo", "archivos[].nombre", y en cada macro LaTeX \\secciongrande, \\subtituloA, \\subtituloB, \\resumen, \\definicion). NUNCA dejes palabras en catalán ni en otro idioma en los títulos, slugs o secciones. Desarrolla este apartado con explicaciones docentes rigurosas y completas en español. Prohibido hacer resúmenes telegráficos de 2 líneas; explica cada concepto, arquitectura, código y pregunta de autoevaluación («Posa't a prova»).`,
          crearGuiaMaterialBreve(unidad.texto, unidad.imagenes),
        ]
          .filter(Boolean)
          .join("\n"),
    });
    const inicioUnidad = Date.now();
    await registrarLogGeneracion(
      trabajo.id,
      `[PDF] Iniciando ${unidad.id} (${unidad.documento?.name || "documento"}): ${unidad.texto.length} caracteres, ${unidad.imagenes.length} imágenes`,
    );
    const opcionesNormalizacion = {
      subject: trabajo.asignatura,
      theme: temaEfectivo,
      themeTitle: tituloTemaEfectivo,
      subtheme: apartadoEfectivo,
      subthemeTitle: tituloApartadoEfectivo,
    };
    const normalizar = (payload) => {
      const norm = normalizarResultadoIA(payload, opcionesNormalizacion);
      if (unidad.apartadoNumero && Array.isArray(norm.archivos)) {
        for (const arch of norm.archivos) {
          arch.subtema = unidad.apartadoNumero;
          arch.apartado = unidad.apartadoNumero;
        }
        norm.subtema = unidad.apartadoNumero;
      }
      return norm;
    };
    const resultado = await consultarApuntesConReintento({
      instruccion,
      imagenes: unidad.imagenes,
      signal: controlador.signal,
      normalizar,
      contexto: unidad.id,
      validar: (resultadoIA) =>
        evaluarCoberturaMaterial(resultadoIA, unidad.texto),
    });
    // Convertir markdown a LaTeX usando el conversor del sistema
    if (resultado.archivos && resultado.archivos.length > 0) {
      for (const archivo of resultado.archivos) {
        if (archivo.latex) {
          archivo.latex = convertirMarkdownALatexWec(archivo.latex);
        }
      }
    }

    if (resultado.archivos && resultado.archivos.length > 0) {
      if (resultado.titulo_tema || resultado.titulo_subtema) {
        try {
          const tradTema = await traducirTituloYNombreConIA(
            { titulo: resultado.titulo_tema, nombre: resultado.titulo_subtema },
            controlador.signal,
          );
          if (tradTema.titulo) resultado.titulo_tema = tradTema.titulo;
          if (tradTema.nombre) resultado.titulo_subtema = tradTema.nombre;
        } catch {}
      }
      for (const archivo of resultado.archivos) {
        if (apartadoEfectivo) {
          archivo.subtema = apartadoEfectivo;
          archivo.apartado = apartadoEfectivo;
        }
        archivo.titulo = String(archivo.titulo || "")
          .replace(/\\textbf\{([^}]+)\}/g, "$1")
          .replace(/[*#]/g, "")
          .trim();
        if (!archivo.titulo || esTituloDePlantilla(archivo.titulo)) {
          archivo.titulo = resultado.titulo_subtema || tituloApartadoEfectivo;
        }
        if (
          !archivo.nombre ||
          /^(?:apartado(?:-\d+)*|slug-(?:concepto|descriptivo)|seccion(?:-\d+)*)$/i.test(archivo.nombre) ||
          /fragmento/i.test(archivo.nombre)
        ) {
          archivo.nombre = deducirSlugConceptual(archivo.nombre, archivo.titulo);
        } else {
          archivo.nombre = crearNombreArchivo(archivo.nombre);
        }
        try {
          const trad = await traducirTituloYNombreConIA(
            { titulo: archivo.titulo, nombre: archivo.nombre },
            controlador.signal,
          );
          if (trad.titulo) archivo.titulo = trad.titulo;
          if (trad.nombre) archivo.nombre = crearNombreArchivo(trad.nombre);
        } catch (errTrad) {
          console.warn(`Verificación del título omitida: ${errTrad.message}`);
        }
        // La traducción del contenido no depende de que la traducción del título
        // haya funcionado; antes ambas operaciones compartían un único try/catch.
        try {
          if (archivo.latex) archivo.latex = await traducirLatexAEspanolConIA(archivo.latex, controlador.signal);
        } catch (errTrad) {
          console.warn(`Verificación del LaTeX omitida: ${errTrad.message}`);
        }
        archivo.latex = aplicarEstilosLatex(archivo.latex, trabajo.asignatura);
      }
    }

    const segundos = ((Date.now() - inicioUnidad) / 1000).toFixed(1);
    await registrarLogGeneracion(
      trabajo.id,
      `[PDF] Completada ${unidad.id} en ${segundos}s -> "${resultado.archivos?.[0]?.titulo || "Apartado"}"`,
    );
    const destino = resolverDestinoGeneracion({
      temaSolicitado: temaEfectivo,
      apartadoSolicitado: apartadoEfectivo,
      temaTituloSolicitado: tituloTemaEfectivo,
      apartadoTituloSolicitado: tituloApartadoEfectivo,
      temasExistentes: catalogo,
      resultado,
    });
    resultado.tema = destino.tema;
    resultado.subtema = destino.apartado;
    resultado.titulo_tema = destino.tituloTema || resultado.titulo_tema;
    resultado.titulo_subtema = destino.tituloApartado || resultado.titulo_subtema;
    delete resultado.tema_existente;
    resultado.fuentes = combinarFuentes(resultado.fuentes, fuentesWeb);
    if (fuentesWeb.length)
      resultado.archivos[0].latex += crearCitasLatex(fuentesWeb);
    return [{ unidad: unidad.id, resultado, destino }];
  }

  const instruccion = crearPromptCodigoPorTemas({
    asignatura: trabajo.asignatura,
    temasExistentes,
    temarioPDF: compactarTemarioPdf(trabajo.resultadosPreparados),
    material: unidad.texto,
    instruccionEstudiante: trabajo.opciones.instruccionEstudiante,
    referenciaBiblioteca,
  });
  const payload = await consultarCodigoConReintento(
    instruccion,
    controlador.signal,
    unidad.id,
  );
  let apartados = payload.apartados ?? payload.archivos ?? [];
  if (!Array.isArray(apartados)) {
    if (apartados && typeof apartados === "object") {
      apartados = [apartados];
    } else {
      apartados = [];
    }
  }
  if (!apartados.length && payload.latex) {
    apartados = [payload];
  }
  if (!apartados.length) {
    console.warn(
      `La IA no clasificó bloques conceptuales de código para ${unidad.documento.name}. Se omite como archivo auxiliar.`,
    );
    trabajo.avisos ??= [];
    trabajo.avisos.push(
      `Archivo ${unidad.documento.name}: no contenía bloques conceptuales clasificables en el temario y se omitió.`,
    );
    return [];
  }
  const resultados = [];
  for (const [indice, apartado] of apartados.entries()) {
    comprobarCancelacion(controlador.signal);
    if (!apartado || typeof apartado !== "object") continue;
    const latexContenido = typeof apartado.latex === "string" ? apartado.latex.trim() : "";
    if (!latexContenido) continue;
    const temaExistente = Number(apartado.tema_existente ?? apartado.tema_existente_numero ?? apartado.tema);
    const resultado = normalizarResultadoIA(
      {
        tema_existente: Number.isSafeInteger(temaExistente) ? temaExistente : 0,
        titulo_tema: apartado.titulo_tema,
        titulo_subtema: apartado.titulo_subtema ?? apartado.apartado,
        conceptos_clave: apartado.conceptos,
        cobertura: (apartado.conceptos ?? []).map((concepto) => ({
          concepto,
          estado: "incluido",
          apartado: apartado.titulo_subtema ?? apartado.apartado ?? "",
        })),
        archivos: [
          {
            titulo: apartado.titulo,
            nombre: apartado.nombre,
            conceptos: apartado.conceptos,
            latex: apartado.latex,
          },
        ],
      },
      {
        subject: trabajo.asignatura,
        theme: temaEfectivo,
        themeTitle: tituloTemaEfectivo,
        subtheme: apartadoEfectivo,
        subthemeTitle: tituloApartadoEfectivo,
      },
    );
    for (const arch of resultado.archivos ?? []) {
      arch.titulo = String(arch.titulo || "")
        .replace(/\\textbf\{([^}]+)\}/g, "$1")
        .replace(/[*#]/g, "")
        .trim();
      try {
        const trad = await traducirTituloYNombreConIA(
          { titulo: arch.titulo, nombre: arch.nombre },
          controlador.signal,
        );
        if (trad.titulo) arch.titulo = trad.titulo;
        if (trad.nombre) arch.nombre = crearNombreArchivo(trad.nombre);
      } catch {}
      try {
        if (arch.latex) arch.latex = await traducirLatexAEspanolConIA(arch.latex, controlador.signal);
      } catch (error) {
        console.warn(`Verificación del LaTeX omitida: ${error.message}`);
      }
      arch.latex = aplicarEstilosLatex(arch.latex, trabajo.asignatura);
    }
    let temaDestino = Number.isSafeInteger(temaExistente) && temaExistente > 0 ? temaExistente : temaEfectivo;
    // La IA interpreta y asigna conceptualmente el tema. Si el número mencionado no existe
    // en los PDF del catálogo, se acota al temario válido de los PDF para no crear temas ficticios:
    if (catalogo.length > 0 && !catalogo.some((t) => t.numero === temaDestino)) {
      temaDestino = Math.min(temaDestino, Math.max(...catalogo.map((t) => t.numero)));
    }
    const temaCatalogo = catalogo.find((t) => t.numero === temaDestino);
    const apartadoDestino = apartado.subtema ? Number(apartado.subtema) : (apartado.apartado ? Number(apartado.apartado) : apartadoEfectivo);
    const destino = resolverDestinoGeneracion({
      temaSolicitado: temaDestino,
      apartadoSolicitado: apartadoDestino,
      temaTituloSolicitado: temaCatalogo ? (temaCatalogo.titulo || temaCatalogo.nombre) : (apartado.titulo_tema || tituloTemaEfectivo),
      apartadoTituloSolicitado: apartado.titulo_subtema || tituloApartadoEfectivo,
      temasExistentes: catalogo,
      resultado,
    });
    resultado.tema = destino.tema;
    resultado.subtema = destino.apartado;
    resultado.titulo_tema = destino.tituloTema || resultado.titulo_tema;
    resultado.titulo_subtema = destino.tituloApartado || resultado.titulo_subtema;
    delete resultado.tema_existente;
    resultados.push({ unidad: `${unidad.id}-${indice}`, resultado, destino });
    const temaActual = catalogo.find((item) => item.numero === destino.tema);
    if (temaActual) {
      if (!temaActual.apartados.some((item) => item.numero === destino.apartado))
        temaActual.apartados.push({
          numero: destino.apartado,
          nombre: destino.tituloApartado,
        });
    } else {
      catalogo.push({
        numero: destino.tema,
        titulo: destino.tituloTema,
        apartados: [{
          numero: destino.apartado,
          nombre: destino.tituloApartado,
        }],
      });
    }
  }
  return resultados;
}

async function catalogoTemasTrabajo(trabajo) {
  const asignatura =
    (await listarAsignaturas()).find((item) => item.nombre === trabajo.asignatura);
  const temas = (asignatura?.temas ?? []).map((tema) => ({
    ...tema,
    apartados: tema.apartados.map((apartado) => ({ ...apartado })),
  }));
  for (const item of trabajo.resultadosPreparados ?? []) {
    const { destino } = item;
    let tema = temas.find((existente) => existente.numero === destino.tema);
    if (!tema) {
      tema = {
        numero: destino.tema,
        titulo: destino.tituloTema,
        apartados: [],
      };
      temas.push(tema);
    }
    if (!tema.apartados.some((apartado) => apartado.numero === destino.apartado))
      tema.apartados.push({
        numero: destino.apartado,
        nombre: destino.tituloApartado,
      });
  }
  return temas.sort((a, b) => a.numero - b.numero);
}

async function prepararGuardadoTrabajo(
  trabajo,
  fuentes,
  material,
  fase,
  faseFinal,
) {
  const grupos = agruparResultadosTrabajo(trabajo, fase);
  if (!grupos.length) {
    if (faseFinal) {
      trabajo.estado = "completado";
      trabajo.fase = "completado";
      await guardarTrabajoEtapas(trabajo);
    }
    return true;
  }
  if (trabajo.opciones.sustituirExistentes) {
    const colisiones = [];
    for (const grupo of grupos) {
      const archivos = await inspeccionarReemplazosGeneracion({
        result: grupo.resultado,
        subject: trabajo.asignatura,
        theme: grupo.destino.tema,
        subtheme: grupo.destino.apartado,
        fingerprint: grupo.fingerprint,
        inputFiles: fuentes,
      });
      colisiones.push(...archivos);
    }
    if (colisiones.length) {
      trabajo.archivosASustituir = colisiones.map((archivo) => archivo.path);
      trabajo.hashesArchivosASustituir = Object.fromEntries(
        colisiones.map((archivo) => [archivo.path, archivo.sha256]),
      );
      trabajo.estado = "confirmacion";
      trabajo.confirmacionFase = fase;
      trabajo.fase = fase;
      await guardarTrabajoEtapas(trabajo);
      actualizarProgreso(trabajo.id, {
        fase: "confirmacion",
        mensaje: "Confirma si quieres sustituir los apuntes existentes",
        detalle: `Hay ${colisiones.length} archivo(s) con el mismo nombre que se sustituirían.`,
      });
      return false;
    }
  }
  await guardarGruposTrabajo(
    trabajo,
    grupos,
    fuentes,
    material,
    false,
    faseFinal,
  );
  return true;
}

function agruparResultadosTrabajo(trabajo, fase = null) {
  const grupos = new Map();
  for (const item of trabajo.resultadosPreparados ?? []) {
    if (
      fase === "pdf" && !item.unidad.startsWith("pdf-") ||
      fase === "codigo" && !item.unidad.startsWith("codigo-")
    )
      continue;
    const clave = [
      item.destino.tema,
      item.destino.apartado,
    ].join("-");
    let grupo = grupos.get(clave);
    if (!grupo) {
      grupo = {
        destino: item.destino,
        unidadIds: [],
        resultado: {
          ...item.resultado,
          archivos: [],
          conceptos_clave: [],
          cobertura: [],
          imagenes: [],
          fuentes: [],
          resumen: "",
        },
      };
      grupos.set(clave, grupo);
    }
    grupo.unidadIds.push(item.unidad);
    grupo.resultado.archivos.push(...(item.resultado?.archivos ?? []));
    grupo.resultado.conceptos_clave.push(...(item.resultado?.conceptos_clave ?? []));
    grupo.resultado.cobertura.push(...(item.resultado?.cobertura ?? []));
    grupo.resultado.imagenes.push(...(item.resultado?.imagenes ?? []));
    grupo.resultado.fuentes.push(...(item.resultado?.fuentes ?? []));
    if (item.resultado.resumen)
      grupo.resultado.resumen = [grupo.resultado.resumen, item.resultado.resumen]
        .filter(Boolean)
        .join("\n\n");
  }
  return [...grupos.values()].map((grupo) => {
    const huella = createHash("sha256")
      .update(trabajo.id)
      .update(JSON.stringify(grupo.destino))
      .update(grupo.unidadIds.join("\n"))
      .digest("hex");
    grupo.fingerprint = huella;
    return grupo;
  });
}

async function guardarResultadosTrabajo(trabajo, sustituir) {
  if (trabajo.estado !== "confirmacion")
    throw errorHttp(409, "Esta generación no está esperando confirmación.");
  const fase = trabajo.confirmacionFase;
  const grupos = agruparResultadosTrabajo(trabajo, fase);
  if (!grupos.length)
    throw errorHttp(409, "No se encontraron resultados para guardar en esta etapa.");
  const fuentes = await Promise.all(
    trabajo.fuentes.map(async (fuente) => ({
      originalname: fuente.nombre,
      size: fuente.bytes,
      buffer: await leerFuenteTrabajo(trabajo, fuente),
    })),
  );
  const documentos = [];
  const avisos = [];
  const imagenes = [];
  let imagesOcr = 0;
  for (let indice = 0; indice < fuentes.length; indice += 1) {
    const extraido = await cargarExtraccionTrabajo(trabajo.id, indice);
    if (!extraido) continue;
    documentos.push(...extraido.documents);
    avisos.push(...extraido.warnings);
    imagenes.push(...extraido.visuals);
    imagesOcr += extraido.imagesOcr;
  }
  await guardarGruposTrabajo(
    trabajo,
    grupos,
    fuentes,
    {
      documents: documentos,
      warnings: [...avisos, ...(trabajo.avisos ?? [])],
      visuals: imagenes,
      imagesOcr,
    },
    sustituir,
    fase === "codigo",
  );
  if (fase === "pdf") {
    trabajo.etapaPdfGuardada = true;
    trabajo.fase = "codigo";
    trabajo.unidadActual = 0;
    trabajo.estado = "pendiente";
    trabajo.confirmacionFase = "";
    trabajo.archivosASustituir = [];
    trabajo.hashesArchivosASustituir = {};
    await guardarTrabajoEtapas(trabajo);
    iniciarTrabajoEtapas(trabajo.id);
  }
}

async function guardarGruposTrabajo(
  trabajo,
  grupos,
  fuentes,
  material,
  sustituir,
  faseFinal = true,
) {
  const informesPrevios = await listarHistorialGeneraciones(trabajo.asignatura);
  const archivosCambiados = compararArchivosProcesados(fuentes, informesPrevios);
  const guardados = [];
  for (const grupo of grupos) {
    comprobarCancelacion(controladoresGeneracion.get(trabajo.id) ?? new AbortController().signal);
    const expectedExistingFiles = sustituir
      ? Object.fromEntries(
          Object.entries(trabajo.hashesArchivosASustituir ?? {}).filter(([nombre]) =>
            nombre.startsWith(`${trabajo.asignatura}/Tema ${grupo.destino.tema}/Tema ${grupo.destino.tema}.${grupo.destino.apartado}/`),
          ),
        )
      : {};
    const generation = await guardarGeneracion({
      result: grupo.resultado,
      fingerprint: grupo.fingerprint,
      subject: trabajo.asignatura,
      theme: grupo.destino.tema,
      subtheme: grupo.destino.apartado,
      inputFiles: fuentes,
      material,
      existingCount: (await listarApuntes(trabajo.asignatura)).length,
      replaceExisting: sustituir || Boolean(trabajo.id),
      expectedExistingFiles,
      archivosCambiados,
    });
    const guardado = {
      fingerprint: grupo.fingerprint,
      fase: grupo.unidadIds.every((unidad) => unidad.startsWith("pdf-"))
        ? "pdf"
        : "codigo",
      tema: grupo.destino.tema,
      titulo_tema: grupo.destino.tituloTema,
      subtema: grupo.destino.apartado,
      titulo_subtema: grupo.destino.tituloApartado,
      archivos_generados: generation.report.archivos_generados,
      conceptos_clave: grupo.resultado.conceptos_clave,
      cobertura: grupo.resultado.cobertura,
    };
    guardados.push(guardado);
    trabajo.guardados = [
      ...(trabajo.guardados ?? []).filter(
        (anterior) => anterior.fingerprint !== grupo.fingerprint,
      ),
      guardado,
    ];
    await guardarTrabajoEtapas(trabajo);
  }
  if (faseFinal) {
    trabajo.estado = "completado";
    trabajo.fase = "completado";
  } else {
    trabajo.estado = "procesando";
  }
  trabajo.error = "";
  await guardarTrabajoEtapas(trabajo);
  if (faseFinal)
    actualizarProgreso(trabajo.id, {
      fase: "completado",
      mensaje: "Generación por etapas completada",
      detalle: `${trabajo.guardados.length} resultado(s) guardados en sus temas y apartados.`,
      actual: 1,
      total: 1,
    });
}

function crearExtraccionesPorTema(trabajo, unidadesPdf, unidadesCodigo) {
  const unidades = new Map(
    [...unidadesPdf, ...unidadesCodigo].map((unidad) => [unidad.id, unidad]),
  );
  const temas = new Map();
  for (const item of trabajo.resultadosPreparados ?? []) {
    const tema = item.destino?.tema;
    if (!Number.isSafeInteger(tema)) continue;
    let grupo = temas.get(tema);
    if (!grupo) {
      grupo = { tema, apartados: new Map() };
      temas.set(tema, grupo);
    }
    const apartado = item.destino.apartado;
    let bloque = grupo.apartados.get(apartado);
    if (!bloque) {
      bloque = {
        apartado,
        titulo: item.destino.tituloApartado,
        unidades: [],
      };
      grupo.apartados.set(apartado, bloque);
    }
    const unidad = unidades.get(item.unidad);
    if (unidad && !bloque.unidades.some((existente) => existente.id === unidad.id))
      bloque.unidades.push({
        id: unidad.id,
        nombre: unidad.documento.name,
        texto: textoUnidadParaExtraccion(unidad),
        imagenes: unidad.imagenes ?? [],
      });
  }
  return [...temas.values()].map((grupo) => ({
    tema: grupo.tema,
    apartados: [...grupo.apartados.values()],
  }));
}

function textoUnidadParaExtraccion(unidad) {
  const texto = String(unidad.texto ?? "");
  if (unidad.documento?.kind !== "pdf") return texto;
  const cabecera = `--- PDF: ${unidad.documento.name} ---\n`;
  return texto.startsWith(cabecera) ? texto.slice(cabecera.length) : texto;
}

function rutaAsincrona(handler) {
  return (solicitud, respuesta, next) =>
    Promise.resolve(handler(solicitud, respuesta, next)).catch(next);
}

async function obtenerReferenciaBibliotecaSegura() {
  try {
    return await cargarReferenciaBiblioteca(config.latexLibraryGithub);
  } catch {
    try {
      return await cargarReferenciaBiblioteca(config.latexLibrary);
    } catch {
      return "";
    }
  }
}

async function consultarApuntesConReintento({
  instruccion,
  imagenes,
  signal,
  normalizar,
  contexto,
  validar,
}) {
  const maxIntentos = 3;
  const erroresReintentables = new Set([
    "EMPTY_LATEX_BLOCKS",
    "INVALID_JSON_OBJECT",
    "INVALID_JSON",
  ]);
  let prompt = instruccion;
  let ultimoResultado = null;
  let mejorResultado = null;
  let mejorLongitud = -1;
  let ultimoError = null;

  for (let intento = 1; intento <= maxIntentos; intento += 1) {
    try {
      const resultado = await normalizar(
        await consultarModeloIA(sistemaApuntes, prompt, imagenes, signal),
      );
      ultimoResultado = resultado;
      const longitudActual = (resultado?.archivos || []).reduce(
        (total, a) => total + (typeof a?.latex === "string" ? a.latex.length : 0),
        0,
      );
      if (longitudActual > mejorLongitud) {
        mejorLongitud = longitudActual;
        mejorResultado = resultado;
      }
      const problemas = validar ? validar(resultado) : [];
      if (problemas.length === 0) return resultado;

      console.warn(
        `Cobertura insuficiente para ${contexto} (intento ${intento}/${maxIntentos}): ${problemas.join(" ")}`,
      );
      if (intento === maxIntentos) break;
      prompt = `${instruccion}

REVISIÓN OBLIGATORIA DE COBERTURA (la respuesta anterior fue rechazada automáticamente):
${problemas.map((problema) => `- ${problema}`).join("\n")}

Vuelve a redactar el JSON completo desde cero. No resumas ni recortes: desarrolla cada diapositiva del material con todas sus ideas, datos, ejemplos y preguntas, y conserva la introducción. Incluye un \\resumen inicial, un encabezado propio (\\subtituloA, \\subtituloB o \\seccion) por cada título de diapositiva y todos los comandos LaTeX de la biblioteca. No uses títulos genéricos ni de plantilla.`;
    } catch (error) {
      ultimoError = error;
      if (!erroresReintentables.has(error.code)) throw error;
      console.warn(
        `La IA no devolvió un objeto con apartados para ${contexto} (intento ${intento}/${maxIntentos}); se repetirá con el formato de salida corregido. ${error.message}`,
      );
      if (intento === maxIntentos) break;
      prompt = `${instruccion}

CORRECCIÓN OBLIGATORIA: La respuesta anterior no contenía apartados LaTeX utilizables. Vuelve a analizar el material completo y devuelve exclusivamente el JSON solicitado. Incluye "archivos" como una lista no vacía de objetos; cada objeto debe tener "titulo", "conceptos" y "latex" con contenido didáctico desarrollado y comandos LaTeX de la biblioteca. No devuelvas solo un resumen, conceptos_clave o cobertura.`;
    }
  }

  if (mejorResultado?.archivos?.length) return mejorResultado;
  if (ultimoResultado?.archivos?.length) return ultimoResultado;
  if (ultimoResultado) return ultimoResultado;
  throw new Error(
    `La IA no produjo un objeto con apartados LaTeX utilizables tras ${maxIntentos} intentos. ${ultimoError?.message ?? ""}`,
    { cause: ultimoError },
  );
}

async function consultarCodigoConReintento(instruccion, signal, contexto) {
  try {
    return await consultarModeloIA(
      sistemaCodigoPorTemas,
      instruccion,
      [],
      signal,
      config.codeModel,
    );
  } catch (error) {
    if (error.code !== "INVALID_JSON") throw error;
    console.warn(
      `La IA no devolvió JSON válido para ${contexto}; se repetirá una vez con el formato corregido. ${error.message}`,
    );
    return consultarModeloIA(
      sistemaCodigoPorTemas,
      `${instruccion}

CORRECCIÓN OBLIGATORIA: la respuesta anterior no era JSON válido. Devuelve exclusivamente un objeto JSON válido, sin explicaciones ni Markdown, con "apartados" como una lista no vacía de objetos. Cada objeto debe incluir "titulo", "nombre", "conceptos" y "latex".`,
      [],
      signal,
      config.codeModel,
    );
  }
}

function actualizarProgreso(id, datos) {
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

function errorHttp(status, message) {
  return Object.assign(new Error(message), { status });
}

function comprobarCancelacion(signal) {
  if (signal.aborted)
    throw errorHttp(499, "Generación detenida. No se guardaron apuntes.");
}

function crearGuiaMaterialBreve(material, imagenes) {
  const longitud = material.trim().length;
  if (imagenes.length || longitud === 0 || longitud > 500) return "";
  if (longitud <= 120)
    return "MATERIAL MUY BREVE: ajusta la extensión a la fuente. Explica solo la idea que realmente aparece, en una sección y unas 100-160 palabras como máximo. No añadas temas genéricos, ejemplos extensos ni preguntas de examen si la fuente no da contenido suficiente.";
  return "MATERIAL BREVE: desarrolla únicamente las ideas presentes, en una sección y unas 180-260 palabras como máximo. No alargues con teoría genérica, ejemplos extensos ni preguntas de examen que la fuente no justifique.";
}

function numeroPositivo(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 999)
    throw errorHttp(400, `El número de ${label} debe estar entre 1 y 999.`);
  return parsed;
}

function numeroOpcional(value, label) {
  if (value == null || value === "" || value === "__auto__" || value === "0")
    return 0;
  return numeroPositivo(value, label);
}

function etiquetaAcotada(value, fallback) {
  return String(value ?? fallback).trim().slice(0, 160) || fallback;
}

function normalizarTitulo(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export function inferirTemaYApartadoDeDocumento(nombre = "", texto = "") {
  const n = String(nombre || "");
  const base = path.basename(n);

  const mSub = base.match(/(?:tema|unitat|unidad)\s*(\d+)[\._\-](\d+)[_\-\s]*(.*?)(\.pdf|\.zip|\.txt|\.md|$)/i);
  if (mSub) {
    const tema = Number(mSub[1]);
    const apartado = Number(mSub[2]);
    const titulo = mSub[3].replace(/[_\-]+/g, " ").trim();
    return {
      tema,
      apartado,
      tituloTema: `Tema ${tema}`,
      tituloApartado: titulo || `Apartado ${apartado}`,
    };
  }

  const mSimple = base.match(/(?:tema|unitat|unidad)\s*(\d+)[_\-\s]*(.*?)(\.pdf|\.zip|\.txt|\.md|$)/i);
  if (mSimple) {
    const tema = Number(mSimple[1]);
    const titulo = mSimple[2].replace(/[_\-]+/g, " ").trim();
    return {
      tema,
      apartado: 1,
      tituloTema: titulo || `Tema ${tema}`,
      tituloApartado: titulo || `Tema ${tema}`,
    };
  }

  const c = String(texto || "").slice(0, 4000);
  const mTextoTema = c.match(/(?:tema|unitat|unidad)\s*(\d+)[\._\-](\d+)/i);
  if (mTextoTema) {
    const tema = Number(mTextoTema[1]);
    const apartado = Number(mTextoTema[2]);
    return {
      tema,
      apartado,
      tituloTema: `Tema ${tema}`,
      tituloApartado: `Apartado ${apartado}`,
    };
  }
  const mTextoSimple = c.match(/(?:tema|unitat|unidad)\s*(\d+)/i);
  if (mTextoSimple) {
    const tema = Number(mTextoSimple[1]);
    return {
      tema,
      apartado: 1,
      tituloTema: `Tema ${tema}`,
      tituloApartado: `Tema ${tema}`,
    };
  }

  return null;
}

function resolverDestinoGeneracion({
  temaSolicitado,
  apartadoSolicitado,
  temaTituloSolicitado,
  apartadoTituloSolicitado,
  temasExistentes,
  resultado,
}) {
  let temaExistente = temasExistentes.find(
    (tema) => tema.numero === temaSolicitado,
  );
  if (!temaSolicitado) {
    temaExistente = temasExistentes.find(
      (tema) => tema.numero === resultado.tema_existente,
    );
    if (!temaExistente) {
      const tituloInferido = normalizarTitulo(resultado.titulo_tema);
      temaExistente = temasExistentes.find(
        (tema) => normalizarTitulo(tema.titulo || tema.nombre) === tituloInferido,
      );
    }
  }
  const tema =
    temaSolicitado ||
    temaExistente?.numero ||
    Math.max(0, ...temasExistentes.map((item) => item.numero)) + 1;
  const esGenerico = (t) => !t || /^(?:apartado|seccion|tema)\s*\d*$/i.test(String(t).trim());
  const tituloTemaIA = resultado?.titulo_tema;
  const tituloTema =
    (!esGenerico(tituloTemaIA) ? tituloTemaIA : null) ||
    (!temaSolicitado && temaExistente
      ? temaExistente.titulo || temaExistente.nombre
      : temaTituloSolicitado) ||
    `Tema ${tema}`;
  let apartadoExistente = temaExistente?.apartados.find(
    (apartado) => apartado.numero === apartadoSolicitado,
  );
  if (!apartadoSolicitado && temaExistente) {
    const tituloInferido = normalizarTitulo(resultado.titulo_subtema);
    apartadoExistente = temaExistente.apartados.find(
      (apartado) => normalizarTitulo(apartado.nombre) === tituloInferido,
    );
  }
  const subtemaDetectado =
    (resultado?.subtema && Number.isFinite(Number(resultado.subtema))
      ? Number(resultado.subtema)
      : null) ||
    (resultado?.archivos?.[0]?.subtema && Number.isFinite(Number(resultado.archivos[0].subtema))
      ? Number(resultado.archivos[0].subtema)
      : null);
  const apartado =
    apartadoSolicitado ||
    subtemaDetectado ||
    apartadoExistente?.numero ||
    Math.max(0, ...(temaExistente?.apartados ?? []).map((item) => item.numero)) + 1;
  const tituloSubtemaIA =
    resultado?.titulo_subtema ||
    resultado?.archivos?.[0]?.titulo;
  const tituloApartado =
    (!esGenerico(tituloSubtemaIA) ? tituloSubtemaIA : null) ||
    (!esGenerico(apartadoExistente?.nombre) ? apartadoExistente?.nombre : null) ||
    apartadoTituloSolicitado ||
    `Apartado ${apartado}`;
  return { tema, tituloTema, apartado, tituloApartado };
}

function obtenerBufferArchivo(archivo) {
  if (archivo.buffer) return archivo.buffer;
  if (archivo.path) {
    try {
      return readFileSync(archivo.path);
    } catch {
      return Buffer.alloc(0);
    }
  }
  return Buffer.alloc(0);
}

function compararArchivosProcesados(inputFiles, informes) {
  const anterioresPorNombre = new Map();
  for (const informe of informes) {
    for (const archivo of informe.archivos_procesados_detalle ?? []) {
      if (!anterioresPorNombre.has(archivo.nombre))
        anterioresPorNombre.set(archivo.nombre, archivo.sha256);
    }
  }
  return inputFiles
    .filter((archivo) => {
      const anterior = anterioresPorNombre.get(archivo.originalname);
      if (!anterior) return false;
      const actual = createHash("sha256")
        .update(obtenerBufferArchivo(archivo))
        .digest("hex");
      return actual !== anterior;
    })
    .map((archivo) => archivo.originalname);
}

function huellaSolicitud({
  asignatura,
  tema,
  tituloTema,
  apartado,
  tituloApartado,
  instruccionEstudiante,
  investigacionHabilitada,
  compararApuntesHabilitado = true,
  archivos,
}) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      asignatura,
      tema,
      tituloTema,
      apartado,
      tituloApartado,
      instruccionEstudiante,
      investigacionHabilitada,
      compararApuntesHabilitado,
      modelo: config.model,
    }),
  );
  for (const archivo of [...archivos].sort((izquierdo, derecho) =>
    izquierdo.originalname.localeCompare(derecho.originalname),
  )) {
    hash.update(archivo.originalname);
    hash.update(obtenerBufferArchivo(archivo));
  }
  return hash.digest("hex");
}

function combinarFuentes(modelSources, actualSources = []) {
  const fuentesValidas = Array.isArray(actualSources) ? actualSources : [];
  const allowed = new Map(fuentesValidas.map((source) => [source?.url, source]));
  const output = [];
  const seen = new Set();
  const fuentesModelo = Array.isArray(modelSources) ? modelSources : [];
  for (const source of fuentesModelo) {
    if (source && source.url && allowed.has(source.url) && !seen.has(source.url)) {
      output.push({
        ...allowed.get(source.url),
        titulo: source.titulo || allowed.get(source.url).titulo,
      });
      seen.add(source.url);
    }
  }
  for (const source of fuentesValidas) {
    if (source && source.url && !seen.has(source.url)) output.push(source);
  }
  return output;
}

function crearCitasLatex(sources) {
  const escapeTitle = (value) => String(value).replace(/[#$%&_]/g, "\\$&");
  const citations = sources.map(
    (source) => `\\href{${source.url}}{${escapeTitle(source.titulo)}}`,
  );
  return `\n\n\\seccion{Fuentes web consultadas}\n\\lista{${citations.join("|")}|}`;
}

function respuestaInforme(report, output, cached) {
  return {
    ...report,
    cached,
    guardado_ahora: !cached,
    archivos_procesados: report.archivos_procesados.length,
    apuntes_existentes: report.apuntes_existentes ?? { files: 0 },
    salida: output ?? {
      theme_document: report.tema_documento,
      written: report.archivos_generados.map((file) => ({
        titulo: file.titulo,
        archivo: file.path,
      })),
      warnings: report.avisos,
    },
  };
}
