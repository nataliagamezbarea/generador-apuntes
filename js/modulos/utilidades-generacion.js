import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./configuracion.js";

export function errorHttp(status, message) {
  return Object.assign(new Error(message), { status });
}

export function comprobarCancelacion(signal) {
  if (signal?.aborted)
    throw errorHttp(499, "Generación detenida. No se guardaron apuntes.");
}

export function crearGuiaMaterialBreve(material, imagenes) {
  const longitud = material.trim().length;
  if (imagenes.length || longitud === 0 || longitud > 500) return "";
  if (longitud <= 120)
    return "MATERIAL MUY BREVE: ajusta la extensión a la fuente. Explica solo la idea que realmente aparece, en una sección y unas 100-160 palabras como máximo. No añadas temas genéricos, ejemplos extensos ni preguntas de examen si la fuente no da contenido suficiente.";
  return "MATERIAL BREVE: desarrolla únicamente las ideas presentes, en una sección y unas 180-260 palabras como máximo. No alargues con teoría genérica, ejemplos extensos ni preguntas de examen que la fuente no justifique.";
}

export function numeroPositivo(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 999)
    throw errorHttp(400, `El número de ${label} debe estar entre 1 y 999.`);
  return parsed;
}

export function numeroOpcional(value, label) {
  if (value == null || value === "" || value === "__auto__" || value === "0")
    return 0;
  return numeroPositivo(value, label);
}

export function etiquetaAcotada(value, fallback) {
  return String(value ?? fallback).trim().slice(0, 160) || fallback;
}

export function normalizarTitulo(value) {
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

export function resolverDestinoGeneracion({
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

export function obtenerBufferArchivo(archivo) {
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

export function compararArchivosProcesados(inputFiles, informes) {
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

export function huellaSolicitud({
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

export function combinarFuentes(modelSources, actualSources = []) {
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

export function crearCitasLatex(sources) {
  const escapeTitle = (value) => String(value).replace(/[#$%&_]/g, "\\$&");
  const citations = sources.map(
    (source) => `\\href{${source.url}}{${escapeTitle(source.titulo)}}`,
  );
  return `\n\n\\seccion{Fuentes web consultadas}\n\\lista{${citations.join("|")}|}`;
}

export function respuestaInforme(report, output, cached) {
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
