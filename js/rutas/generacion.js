import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../modulos/configuracion.js";
import { subida, subidaTemporal } from "../modulos/subida.js";
import {
  seguimientosGeneracion,
  controladoresGeneracion,
  generacionesPendientes,
  trabajosEtapasActivos,
  actualizarProgreso,
} from "../modulos/estado-trabajos.js";
import {
  rutaAsincrona,
  obtenerReferenciaBibliotecaSegura,
  consultarApuntesConReintento,
} from "../modulos/consultas-ia.js";
import {
  iniciarTrabajoEtapas,
  guardarResultadosTrabajo,
  prepararGuardadoTrabajo,
  catalogoTemasTrabajo,
} from "../modulos/motor-etapas.js";
import {
  errorHttp,
  comprobarCancelacion,
  crearGuiaMaterialBreve,
  numeroPositivo,
  numeroOpcional,
  etiquetaAcotada,
  normalizarTitulo,
  inferirTemaYApartadoDeDocumento,
  resolverDestinoGeneracion,
  obtenerBufferArchivo,
  compararArchivosProcesados,
  huellaSolicitud,
  combinarFuentes,
  crearCitasLatex,
  respuestaInforme,
} from "../modulos/utilidades-generacion.js";
import {
  cargarTrabajoEtapas,
  crearTrabajoEtapas,
  pausarTrabajoEtapas,
  buscarTrabajoEtapasReutilizable,
  trabajoCoincideConArchivos,
  eliminarTrabajoEtapas,
  guardarTrabajoEtapas,
  listarTrabajosEtapas,
  reiniciarEtapaTrabajo,
} from "../modulos/trabajos-etapas.js";
import {
  extraerMateriales,
  textoMaterial,
} from "../modulos/material.js";
import {
  consultarModeloIA,
  traducirLatexAEspanolConIA,
  detectarCatalanConIA,
  traducirTituloYNombreConIA,
} from "../modulos/modelo.js";
import {
  obtenerInformeGeneracion,
  listarHistorialGeneraciones,
  listarApuntes,
  normalizarResultadoIA,
  convertirMarkdownALatexWec,
  crearNombreArchivo,
  deducirSlugConceptual,
  leerApunte,
  componenteSeguro,
  limpiarLatex,
  guardarGeneracion,
  guardarApunte,
  rutaInformeGeneracion,
  aplicarEstilosLatex,
  detectarCatalan,
  esTituloDePlantilla,
  desglosarBloquesPorSubtitulos,
  inspeccionarReemplazosGeneracion,
} from "../modulos/apuntes.js";
import {
  cargarReferenciaBiblioteca,
  dividirMaterial,
  dividirMaterialConImagenes,
  detectarApartadosEnTexto,
  dividirTextoPorApartados,
  dividirCodigoEnBloques,
  procesarEnParalelo,
  crearPromptApuntes,
  sistemaApuntes,
  sistemaMejora,
  sistemaReescrituraDidactica,
  evaluarCoberturaMaterial,
} from "../modulos/instrucciones.js";
import {
  buscarEnInternet,
  buscarFuentesOpcionales,
  crearConsultasInvestigacion,
} from "../modulos/investigacion.js";

const router = Router();

router.get(
  "/api/progress/:id",
  rutaAsincrona(async (solicitud, respuesta) => {
    const seguimiento = seguimientosGeneracion.get(solicitud.params.id);
    if (!seguimiento) throw errorHttp(404, "No se encontró el progreso de esta generación.");
    respuesta.json(seguimiento);
  }),
);

router.post(
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
    if (trabajoEtapas) {
      trabajoEtapas.fase = "cancelado";
      trabajoEtapas.estado = "cancelado";
      await guardarTrabajoEtapas(trabajoEtapas);
    }
    respuesta.json({ cancelado: true });
  }),
);

router.get(
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

router.post(
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

router.post(
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

router.post(
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

router.post(
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

router.get(
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

router.delete(
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

router.post(
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
    if (trabajo.fase === "cancelado") {
      trabajo.fase = !trabajo.unidadesPreparadas
        ? "extraccion"
        : trabajo.unidadActual < (trabajo.unidadesPdf?.length || 0)
          ? "pdf"
          : trabajo.unidadActual < ((trabajo.unidadesPdf?.length || 0) + (trabajo.unidadesCodigo?.length || 0))
            ? "codigo"
            : "guardado";
    }
    await guardarTrabajoEtapas(trabajo);
    iniciarTrabajoEtapas(trabajo.id);
    respuesta.status(202).json({ id: trabajo.id, estado: "pendiente" });
  }),
);

router.post(
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

router.post(
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

router.post(
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
                ? `PARTE ${indiceBloque + 1} DE ${bloquesMaterial.length}: APARTADO ${subtemaEfectivo} (${tituloApartadoEfectivo}). OBLIGATORIO: traduce el título del tema, del apartado y todas las secciones al ESPAÑOL ESTÁNDAR en el JSON ("titulo_tema", "titulo_subtema", "archivos[].titulo", "archivos[].nombre", y en cada macro LaTeX \\secciongrande, \\subtituloA, \\subtituloB, \\resumen, \\definicion). NUNCA dejes palabras en catalán ni en otro idioma en los títulos, slugs o secciones. PARÁFRASIS EXHAUSTIVA PÁRRAFO A PÁRRAFO: transcribe y desarrolla cada párrafo y punto del material en tus propias palabras en español estándar (decir lo mismo con rigor docente para no vulnerar derechos de autor ni hacer copia literal). PROHIBIDO RESUMIR: no omitas ningún detalle, arquitectura, código ni pregunta de autoevaluación.`
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
        // Un slug inglés ("models-execution") no identifica el contenido:
        // en ese caso se deduce del título ya traducido del apartado.
        if (necesitaSlugDelTitulo(archivo.nombre)) {
          archivo.nombre =
            deducirSlugConceptual("", archivo.titulo) ||
            crearNombreArchivo(archivo.nombre);
        } else {
          archivo.nombre = crearNombreArchivo(archivo.nombre);
        }
        try {
          const trad = await traducirTituloYNombreConIA(
            { titulo: archivo.titulo, nombre: archivo.nombre },
            controlador.signal,
          );
          if (trad.titulo) archivo.titulo = trad.titulo;
          if (trad.nombre) {
            const nombreTraducido = crearNombreArchivo(trad.nombre);
            archivo.nombre = necesitaSlugDelTitulo(nombreTraducido)
              ? deducirSlugConceptual("", archivo.titulo) || nombreTraducido
              : nombreTraducido;
          }
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
      resultado.archivos = desglosarBloquesPorSubtitulos(resultado.archivos);
      const contadorSubtemasGen = new Map();
      for (const arch of resultado.archivos) {
        const sub = arch.subtema || apartado || 1;
        const count = (contadorSubtemasGen.get(sub) || 0) + 1;
        contadorSubtemasGen.set(sub, count);
        arch.orden = count;
        arch.indiceApartado = count;
        let slug = deducirSlugConceptual("", arch.titulo || arch.nombre || "apartado");
        slug = slug.replace(/^\d+[.\-]+\s*/, "");
        arch.nombre = `${count}.${slug || "apartado"}`;
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

router.post(
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

router.post(
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

export default router;
