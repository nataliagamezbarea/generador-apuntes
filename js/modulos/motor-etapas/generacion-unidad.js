import { config } from "../configuracion.js";
import {
  maxReintentosTemporalesEtapas,
  actualizarProgreso,
  registrarLogGeneracion,
} from "../estado-trabajos.js";
import {
  consultarApuntesConReintento,
  consultarCodigoConReintento,
} from "../consultas-ia.js";
import {
  errorHttp,
  comprobarCancelacion,
  crearGuiaMaterialBreve,
  inferirTemaYApartadoDeDocumento,
  resolverDestinoGeneracion,
  combinarFuentes,
  crearCitasLatex,
} from "../utilidades-generacion.js";
import {
  consultarModeloIA,
  traducirLatexAEspanolConIA,
  traducirTituloYNombreConIA,
} from "../modelo.js";
import {
  normalizarResultadoIA,
  crearNombreArchivo,
  deducirSlugConceptual,
  convertirMarkdownALatexWec,
  aplicarEstilosLatex,
  esTituloDePlantilla,
  desglosarBloquesPorSubtitulos,
} from "../apuntes.js";
import {
  dividirMaterial,
  crearPromptCodigoPorTemas,
  crearPromptApuntes,
  evaluarCoberturaMaterial,
} from "../instrucciones.js";
import {
  buscarFuentesOpcionales,
  crearConsultasInvestigacion,
  buscarEnInternet,
} from "../investigacion.js";
import { catalogoTemasTrabajo } from "./guardado-trabajo.js";

const PALABRAS_SLUG_INGLES =
  /\b(?:models?|execution|client|server|tools?|code|browser|scripts?|programming|integration|security|editor|search|engine|rendering|interface|network|communication|language|environment|files?)\b/i;

/**
 * Devuelve true cuando el slug no identifica el contenido en español y debe
 * deducirse del título: está vacío, es genérico, es un fragmento o contiene
 * términos ingleses como "models-execution".
 */
export function necesitaSlugDelTitulo(nombre) {
  const limpio = String(nombre || "").trim();
  return (
    !limpio ||
    /^(?:apartado(?:-\d+)*|slug-(?:concepto|descriptivo)|seccion(?:-\d+)*)$/i.test(
      limpio,
    ) ||
    /fragmento/i.test(limpio) ||
    PALABRAS_SLUG_INGLES.test(limpio)
  );
}

// Un resumen por apartado en lugar de uno por cada trozo de PDF: así la
// petición de código no crece con cada PDF analizado ni agota el contexto.
export function compactarTemarioPdf(resultados = [], maxCaracteres = 8000) {
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

export async function generarUnidadEtapasConReintentos(opciones) {
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

export function esFalloTransitorioIA(error) {
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

export function esperarConCancelacion(duracionMs, signal) {
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

export function crearSeccionRespaldo(opciones) {
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

export async function generarUnidadEtapasConDivision(
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
        const base = necesitaSlugDelTitulo(archivo.nombre)
          ? deducirSlugConceptual("", archivo.titulo) ||
            crearNombreArchivo(archivo.nombre)
          : crearNombreArchivo(archivo.nombre);
        archivo.nombre = sufijo ? `${base}-fragmento-${sufijo}` : base;
      }
    }
    return resultados;
  } catch (error) {
    const profundidad = (opciones.unidad.id.match(/-p\d+/g) || []).length;
    const esDivisible =
      /Multimodal data provided|token repeat limit reached|prediction aborted|límite de salida de Ollama|se truncó|no pudo procesar esta parte|exceeds the available context size|JSON|apartados LaTeX utilizables|objeto con apartados/i.test(
        `${error?.message ?? ""} ${error?.cause?.message ?? ""}`,
      );
    if (opciones.unidad.imagenes?.length > 0) {
      console.warn(
        `Ajustando ${opciones.unidad.id}: reintentando sin imágenes para evitar desbordar Ollama (${error.message}).`,
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
      profundidad < 3 &&
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

export async function generarUnidadEtapas({
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
          `ETAPA_PDF: APARTADO ${apartadoEfectivo}: ${tituloApartadoEfectivo}. OBLIGATORIO: traduce el título del tema, del apartado y todas las secciones al ESPAÑOL ESTÁNDAR en el JSON ("titulo_tema", "titulo_subtema", "archivos[].titulo", "archivos[].nombre", y en cada macro LaTeX \\secciongrande, \\subtituloA, \\subtituloB, \\resumen, \\definicion). NUNCA dejes palabras en catalán ni en otro idioma en los títulos, slugs o secciones. PARÁFRASIS EXHAUSTIVA PÁRRAFO A PÁRRAFO: transcribe y desarrolla cada párrafo y punto del material en tus propias palabras en español estándar (decir exactamente lo mismo pero formulado para no vulnerar derechos de autor ni cometer plagio literal). PROHIBIDO RESUMIR: no hagas esquemas telegráficos ni omitas nada; explica cada concepto, arquitectura, código y pregunta de autoevaluación («Posa't a prova») con rigor universitario.`,
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
          arch.apartadoNumero = unidad.apartadoNumero;
          arch.orden = unidad.orden || unidad.indiceApartado || unidad.apartadoNumero;
          arch.indiceApartado = unidad.orden || unidad.indiceApartado || unidad.apartadoNumero;
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
    // Convertir markdown a LaTeX usando el conversor del sistema si es necesario
    if (resultado.archivos && resultado.archivos.length > 0) {
      for (const archivo of resultado.archivos) {
        if (archivo.markdown && !archivo.latex) {
          archivo.latex = archivo.markdown;
        }
        if (archivo.latex && !/\\(?:secciongrande|subtituloA|subtituloB|resumen|definicion|lista|pasos|rectangulos)/i.test(archivo.latex)) {
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
          archivo.apartadoNumero = apartadoEfectivo;
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
        archivo.latex = aplicarEstilosLatex(archivo.latex, trabajo.asignatura);
      }
      resultado.archivos = desglosarBloquesPorSubtitulos(resultado.archivos);
      const contadorSubtemasUnidad = new Map();
      for (const arch of resultado.archivos) {
        const sub = arch.subtema || apartadoEfectivo || 1;
        const count = (contadorSubtemasUnidad.get(sub) || 0) + 1;
        contadorSubtemasUnidad.set(sub, count);
        arch.orden = count;
        arch.indiceApartado = count;
        let slug = deducirSlugConceptual("", arch.titulo || arch.nombre || "apartado");
        slug = slug.replace(/^\d+[.\-]+\s*/, "");
        arch.nombre = `${count}.${slug || "apartado"}`;
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
