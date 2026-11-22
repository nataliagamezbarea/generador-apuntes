import { Router } from "express";
import express from "express";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../modulos/configuracion.js";
import { rutaAsincrona } from "../modulos/consultas-ia.js";
import {
  errorHttp,
  comprobarCancelacion,
  numeroPositivo,
} from "../modulos/utilidades-generacion.js";
import {
  listarAsignaturas,
  crearCarpetaAsignatura,
  listarApuntes,
  leerApunte,
  guardarApunte,
  listarHistorialGeneraciones,
  obtenerInformeGeneracion,
  eliminarInformeGeneracion,
  rutaInformeGeneracion,
  aplicarEstilosLatex,
  componenteSeguro,
} from "../modulos/apuntes.js";
import { consultarModeloIA } from "../modulos/modelo.js";
import { sistemaReescrituraDidactica } from "../modulos/instrucciones.js";

const router = Router();

router.get(
  "/api/subjects",
  rutaAsincrona(async (_request, respuesta) => {
    respuesta.json({ asignaturas: await listarAsignaturas() });
  }),
);

router.post(
  "/api/subjects",
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = componenteSeguro(solicitud.body?.nombre);
    const creada = await crearCarpetaAsignatura(subject);
    respuesta.status(201).json({ nombre: creada.nombre });
  }),
);

router.get(
  "/api/notes",
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = componenteSeguro(solicitud.query.subject);
    respuesta.json({ archivos: await listarApuntes(subject) });
  }),
);

router.get(
  "/api/notes/content",
  rutaAsincrona(async (solicitud, respuesta) => {
    respuesta.json(await leerApunte(String(solicitud.query.path ?? "")));
  }),
);

router.put(
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

router.get(
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

router.delete(
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

router.post(
  "/api/history/improve",
  express.json(),
  rutaAsincrona(async (solicitud, respuesta) => {
    const subject = componenteSeguro(solicitud.body.subject);
    const theme = numeroPositivo(solicitud.body.tema, "tema");
    const subtheme = numeroPositivo(solicitud.body.subtema, "apartado");
    const fingerprint = solicitud.body.fingerprint
      ? String(solicitud.body.fingerprint)
      : "";
    const archivosSeleccionados = Array.isArray(solicitud.body.archivos)
      ? solicitud.body.archivos
      : [];
    const instruccionUsuario = String(solicitud.body.instruccion ?? "")
      .trim()
      .slice(0, 2000);

    const historial = await listarHistorialGeneraciones(subject);
    const informeBase =
      historial.find(
        (item) =>
          item.asignatura === subject &&
          item.tema === theme &&
          item.subtema === subtheme &&
          (!fingerprint || item.fingerprint === fingerprint),
      ) || (await obtenerInformeGeneracion(subject, theme, subtheme));

    if (!informeBase) {
      throw errorHttp(
        404,
        "No se encontró el informe de generación en el historial.",
      );
    }

    const archivosGenerados = informeBase.archivos_generados ?? [];
    if (!archivosGenerados.length) {
      throw errorHttp(
        400,
        "Esta generación no tiene archivos de apuntes generados.",
      );
    }

    const archivosAMejorar = archivosSeleccionados.length
      ? archivosGenerados.filter((a) => archivosSeleccionados.includes(a.path))
      : archivosGenerados;

    if (!archivosAMejorar.length) {
      throw errorHttp(
        400,
        "Ninguno de los archivos seleccionados coincide con los apuntes generados.",
      );
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
        console.warn(
          `Error al mejorar ${archivoInfo.path} con IA: ${err.message}`,
        );
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

      const indice = archivosActualizados.findIndex(
        (a) => a.path === archivoInfo.path,
      );
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
    await writeFile(
      path.join(reportDirectory, "ultima-generacion.json"),
      reportText,
      "utf8",
    );
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

export default router;
