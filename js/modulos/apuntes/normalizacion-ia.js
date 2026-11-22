import {
  crearNombreArchivo,
  deducirSlugConceptual,
  esTituloDePlantilla,
  normalizarTexto,
  obtenerListaTexto,
  quitarAsignaturaDelTitulo,
} from "./utilidades-nombres.js";
import {
  aplicarEstilosLatex,
  asegurarSeccionPrincipal,
  convertirMarkdownALatexWec,
  limpiarLatex,
  sanearTitulosTema,
} from "./estilos-latex.js";
import {
  desglosarBloquesPorSubtitulos,
  inferirSubtemaDeBloque,
} from "./bloques.js";

export function normalizarResultadoIA(payload, {
  subject,
  theme,
  subtheme,
  themeTitle = `Tema ${theme}`,
  subthemeTitle = `Tema ${theme}.${subtheme}`,
}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw Object.assign(
      new Error("La IA no devolvió un objeto JSON."),
      { code: "INVALID_JSON_OBJECT" },
    );
  let rawBlocks =
    payload.archivos ??
    payload.ficheros ??
    payload.secciones ??
    payload.apartados ??
    payload.blocks ??
    [];
  if (!Array.isArray(rawBlocks)) rawBlocks = [rawBlocks];
  rawBlocks = rawBlocks.filter((b) => b && typeof b === "object");
  if (!rawBlocks.length) {
    const fallbackLatex = payload.latex ?? payload.markdown ?? payload.contenido ?? payload.resumen ?? "";
    if (fallbackLatex && fallbackLatex.length > 30) {
      rawBlocks = [
        {
          titulo: payload.titulo_subtema ?? payload.titulo_tema ?? "Apuntes generados",
          latex: fallbackLatex,
        },
      ];
    }
  }
  const blocks = rawBlocks.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    let valTitulo = raw.titulo ?? raw.title ?? `Apartado ${index + 1}`;
    if (typeof valTitulo === "object" && valTitulo !== null) {
      valTitulo = valTitulo.titulo || valTitulo.title || valTitulo.texto || valTitulo.nombre || `Apartado ${index + 1}`;
    }
    let titulo = quitarAsignaturaDelTitulo(valTitulo, subject).slice(0, 160);
    if (esTituloDePlantilla(titulo)) {
      titulo =
        quitarAsignaturaDelTitulo(
          subthemeTitle || themeTitle || "Apuntes",
          subject,
        ).slice(0, 160) || "Apuntes";
    }
    let contenidoBruto =
      raw.markdown ??
      raw.contenido ??
      raw.latex ??
      raw.contenido_latex ??
      raw.tex ??
      raw.texto ??
      raw.content ??
      raw.body ??
      raw.desarrollo ??
      raw.explicacion ??
      raw.teoria ??
      raw.apuntes ??
      raw.secciones ??
      "";
    if (typeof contenidoBruto === "object" && contenidoBruto !== null) {
      if (Array.isArray(contenidoBruto)) {
        contenidoBruto = contenidoBruto.map((x) => typeof x === "string" ? x : (x.texto || x.latex || x.markdown || x.desarrollo || x.explicacion || x.contenido || "")).join("\n\n");
      } else {
        contenidoBruto = contenidoBruto.markdown ?? contenidoBruto.latex ?? contenidoBruto.contenido ?? contenidoBruto.texto ?? contenidoBruto.desarrollo ?? "";
        if (Array.isArray(contenidoBruto)) {
          contenidoBruto = contenidoBruto.map((x) => typeof x === "string" ? x : (x.texto || x.latex || x.markdown || "")).join("\n\n");
        }
      }
    }
    if (!contenidoBruto && payload.resumen && payload.resumen.length > 300) {
      if (index === 0) contenidoBruto = payload.resumen;
    }

    let textoVerificacion = String(contenidoBruto ?? "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\/\/--><!\]\]>/g, "")
      .replace(/<!\[CDATA\[\/\/><!--/g, "")
      .replace(/<!\[CDATA\[/g, "")
      .replace(/\]\]>/g, "")
      .replace(/<!--\/\/-->/g, "")
      .trim();
    if (!textoVerificacion || /^(?:apartado|seccion)\s*\d+$/i.test(textoVerificacion)) {
      return [];
    }
    if (textoVerificacion.length < 60 && !/\\[a-zA-Z]+/.test(textoVerificacion)) {
      return [];
    }

    let latexConvertido = convertirMarkdownALatexWec(textoVerificacion);
    latexConvertido = latexConvertido.replace(
      /\\(secciongrande|seccion|subtituloA|subtituloB)\s*\{\s*(?:(?:el\s+)?t[ií]tulo del apartado(?:\s+en\s+espa[ñn]ol)?|t[ií]tulo descriptivo(?:\s+en\s+espa[ñn]ol)?|concepto principal)\s*\}/gi,
      (_match, macro) => `\\${macro}{${titulo}}`,
    );
    const latex = sanearTitulosTema(
      asegurarSeccionPrincipal(
        aplicarEstilosLatex(
          limpiarLatex(latexConvertido),
          subject,
        ),
        titulo,
      ),
      titulo,
      themeTitle,
    );
    if (!latex) return [];

    let slug = "";
    const rawSlug = String(raw.nombre ?? raw.archivo ?? raw.slug ?? "").trim();
    if (
      rawSlug &&
      !/^(?:apartado(?:-\d+)*|slug-(?:concepto|descriptivo)|seccion(?:-\d+)*)$/i.test(rawSlug) &&
      !/fragmento/i.test(rawSlug)
    ) {
      slug = crearNombreArchivo(rawSlug);
    } else {
      slug = deducirSlugConceptual(rawSlug, titulo, latex);
    }

    return [
      {
        titulo,
        nombre: slug,
        subtema: raw.subtema ?? raw.apartado,
        apartado: raw.apartado ?? raw.subtema,
        latex,
        conceptos: obtenerListaTexto(raw.conceptos ?? raw.concepts, 20, 200),
      },
    ];
  });

  const bloquesFinales = desglosarBloquesPorSubtitulos(blocks);
  const contadorSubtemasNorm = new Map();
  for (const block of bloquesFinales) {
    const bloqueSubtema = inferirSubtemaDeBloque(block, subtheme);
    const contadorActual = (contadorSubtemasNorm.get(bloqueSubtema) || 0) + 1;
    contadorSubtemasNorm.set(bloqueSubtema, contadorActual);
    if (!block.orden) {
      block.orden = contadorActual;
    }
  }

  if (!bloquesFinales.length)
    throw Object.assign(
      new Error(
        `La IA no devolvió apartados LaTeX utilizables. Campos recibidos: ${Object.keys(payload).slice(0, 20).join(", ") || "ninguno"}.`,
      ),
      { code: "EMPTY_LATEX_BLOCKS" },
    );
  const images = Array.isArray(payload.imagenes)
    ? payload.imagenes
        .filter((item) => item && typeof item === "object")
        .slice(0, 30)
    : [];
  const fuentes = Array.isArray(payload.fuentes)
    ? payload.fuentes
        .filter((item) => item && typeof item === "object")
        .slice(0, 30)
    : [];
  const cobertura = Array.isArray(payload.cobertura)
    ? payload.cobertura
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          concepto: String(item.concepto ?? "Concepto"),
          estado: ["incluido", "ya_cubierto", "pendiente"].includes(item.estado)
            ? item.estado
            : "pendiente",
          apartado: String(item.apartado ?? ""),
        }))
    : [];
  const temaExistente = Number(payload.tema_existente);
  const conceptNames = obtenerListaTexto(payload.conceptos_clave, 100, 200);
  if (!cobertura.length && conceptNames.length) {
    for (const concept of conceptNames) {
      cobertura.push({
        concepto: concept,
        estado: bloquesFinales.some((block) =>
          block.conceptos.some(
            (name) => normalizarTexto(name) === normalizarTexto(concept),
          ),
        )
          ? "incluido"
          : "pendiente",
        apartado: "",
      });
    }
  }
  return {
    asignatura: subject,
    tema: theme,
    tema_existente:
      Number.isSafeInteger(temaExistente) && temaExistente > 0
        ? temaExistente
        : 0,
    subtema: subtheme,
    titulo_tema: quitarAsignaturaDelTitulo(
      payload.titulo_tema ?? payload.titulo ?? themeTitle,
      subject,
    ).slice(0, 160),
    titulo_subtema: quitarAsignaturaDelTitulo(
      payload.titulo_subtema ?? payload.subtitulo ?? subthemeTitle,
      subject,
    ).slice(0, 160),
    resumen: String(payload.resumen ?? "").trim(),
    archivos: bloquesFinales,
    imagenes: images,
    conceptos_clave: conceptNames,
    cobertura,
    fuentes,
  };
}
