import { readFile } from "node:fs/promises";

export const titlePattern =
  /\\(?:secciongrande|seccion|titulo|subtituloA|subtituloB|subtitulo)\*?(?:\[[^\]]*\])?\{([^{}]+)\}/g;

export const stopWords = new Set(
  "para porque como cuando donde desde hasta entre sobre tambien puede pueden hace hacer tiene tienen este esta estos estas otro otra todos todas solo cada mismo misma ser estar hay muy mas pero aunque mientras mediante segun ejemplo forma parte caso tipo uso usar utiliza utilizar sirve consiste permite debe deben son con los las del que una uno unos unas por sin".split(
    " ",
  ),
);

const ACRONYMS_SET = new Set([
  "HTML", "CSS", "JS", "DOM", "XML", "URL", "URI", "HTTP", "HTTPS", "API", "SQL",
  "V8", "JIT", "WEC", "DAW", "PHP", "SSL", "TLS", "TCP", "IP", "JSON",
  "W3C", "XSS", "CORS", "SOP", "FTP", "XHTML", "DWEC", "DEC"
]);

const MINOR_WORDS_SET = new Set([
  "de", "del", "la", "el", "los", "las", "en", "un", "una", "unos", "unas",
  "por", "para", "con", "y", "o", "al", "a", "vs"
]);

export function componenteSeguro(value) {
  const clean = String(value ?? "")
    .trim()
    .replace(/[\\/]/g, "-")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "");
  if (!clean || clean === "." || clean === "..")
    throw new Error("Nombre de asignatura no válido.");
  return clean.slice(0, 80);
}

export function crearNombreArchivo(value, maxLength = 58) {
  return (
    String(value ?? "")
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLength)
      .replace(/-+$/g, "") || "apartado"
  );
}

export function deducirSlugConceptual(nombre = "", titulo = "", contenido = "") {
  let candidato = String(nombre || "").replace(/\.tex$/i, "").trim();
  candidato = candidato.replace(/[-_]fragmento(?:[-_]p\d+)?/gi, "").replace(/[-_]p\d+$/gi, "");

  if (!candidato || /slug-(?:descriptivo|concepto)|^apartado(?:-\d+)*$/i.test(candidato)) {
    candidato = String(titulo || "").trim();
  }

  if (!candidato || /^apartado(?:-\d+)*$/i.test(candidato) || /^\[object\s+Object\]$/i.test(candidato)) {
    const primerEncabezado = String(contenido || "").match(/\\secciongrande\{([^}]+)\}/i)?.[1];
    if (primerEncabezado && !/^apartado/i.test(primerEncabezado)) {
      candidato = primerEncabezado.trim();
    }
  }

  candidato = candidato
    .replace(/\\(?:textbf|textit|text|emph|seccion|titulo|cmd|bf)\{([^}]+)\}/gi, "$1")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/^(?:tema|apartado|seccion)\s*\d+(?:[.-]\d+)*\s*[-·:]*\s*/i, "")
    .replace(/^\d+(?:[.-]\d+)*\s*[-·:]*\s*/, "")
    .replace(/^\[object\s+Object\]$/i, "");

  const slug = candidato
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const palabras = slug.split("-").filter(Boolean);
  const stopWordsSlug = new Set([
    "de", "del", "la", "el", "los", "las", "en", "un", "una", "unos", "unas",
    "por", "para", "con", "sobre", "entre", "y", "o", "al", "su", "sus",
    "que", "como", "dels", "deles", "amb", "sense", "els", "les",
    "titulo", "titulos", "subtitulo", "subtitulos", "seccion", "secciones",
    "apartado", "apartados", "tema", "temas", "textbf", "textit", "cmd",
    "ejemplo", "ejemplos", "parte", "partes", "fragmento", "fragmentos"
  ]);
  const palabrasSignificativas = palabras.filter((p) => !stopWordsSlug.has(p));

  if (palabrasSignificativas.length > 0) {
    return palabrasSignificativas.slice(0, 3).join("-");
  }

  return crearNombreArchivo(slug.slice(0, 30)) || "apartado";
}

export function normalizarTexto(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function convertirLatexATextoPlano(value) {
  return String(value ?? "")
    .replace(/(?<!\\)%.*$/gm, " ")
    .replace(/\\(?:begin|end)\{[^}]+\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?/g, " ")
    .replace(/[{}\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function obtenerTerminos(value) {
  return new Set(
    normalizarTexto(value)
      .match(/[a-z0-9ñ]{3,}/g)
      ?.filter((word) => !stopWords.has(word)) ?? [],
  );
}

export function similitudJaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function esSubtituloGenerico(titulo) {
  const normalizado = String(titulo ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalizado) return true;
  return /^(?:(?:elementos?|componentes?|aspectos?|puntos?|ideas?|conceptos?|caracteristicas?|factores?)(?: y (?:elementos?|componentes?|aspectos?))?)(?: principales| clave| basicos?| fundamentales| esenciales| generales)?(?: de cada apartado)?$/.test(
    normalizado,
  );
}

export function quitarAsignaturaDelTitulo(value, subject) {
  let val = value;
  if (typeof val === "object" && val !== null) {
    val = val.titulo || val.title || val.texto || val.nombre || "";
  }
  let titulo = String(val ?? "").trim();
  if (/^\[object\s+Object\]$/i.test(titulo)) {
    titulo = "";
  }
  const asignatura = String(subject ?? "").trim();
  if (!asignatura) return titulo;
  const escaped = asignatura.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return titulo
    .replace(new RegExp(`\\s+(?:en|de|sobre)\\s+${escaped}\\s*$`, "i"), "")
    .trim();
}

export function esTituloDePlantilla(value = "") {
  const titulo = String(value ?? "")
    .replace(/^[*#\s]+|[*#\s]+$/g, "")
    .trim();
  return /^(?:el\s+)?t[ií]tulo del apartado(?:\s+en\s+espa[ñn]ol)?$|^t[ií]tulo descriptivo(?:\s+en\s+espa[ñn]ol)?$|^apartado\s+\d+$|^concepto principal$|^secci[oó]n\s+\d+$|^subt[ií]tulo\s+\d+$/i.test(
    titulo,
  );
}

export function corregirCatalanAEspanol(texto = "") {
  if (!texto) return "";
  return texto
    .replace(/\bCol[·.]legi\s+Sant\s+Josep\s+Obrer(?:\s*·\s*\d+)?\b/gi, "")
    .replace(/\b2n\s+DAW\b/gi, "")
    .replace(/\[CONTEXTO\s+GENERAL[^\]]*\]/gi, "")
    .replace(/\[CONTENIDO\s+COMPLETO[^\]]*\]/gi, "");
}

export function normalizarMayusculasTitulo(titulo = "") {
  if (!titulo || typeof titulo !== "string") return titulo;
  let t = titulo
    .replace(/\s*[:\-–—!¡?¿]+\s*$/g, "")
    .trim();

  if (t.includes(":")) {
    return t
      .split(":")
      .map((seg) => normalizarSegmentoMayusculas(seg.trim()))
      .join(": ");
  }
  return normalizarSegmentoMayusculas(t);
}

function normalizarSegmentoMayusculas(seg = "") {
  if (!seg) return "";
  const soloLetras = seg.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "");
  if (soloLetras.length >= 3 && soloLetras === soloLetras.toUpperCase()) {
    const palabras = seg.toLowerCase().split(/\s+/);
    return palabras
      .map((p, idx) => {
        const limpia = p.replace(/[^a-záéíóúñ0-9]/gi, "").toUpperCase();
        if (ACRONYMS_SET.has(limpia)) return limpia;
        if (limpia === "JAVASCRIPT") return "JavaScript";
        if (limpia === "NODEJS" || limpia === "NODE.JS") return "Node.js";
        if (idx === 0) return p.charAt(0).toUpperCase() + p.slice(1);
        return p;
      })
      .join(" ");
  }
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

export function deducirTituloRealista(texto = "", tema = "1", tituloActual = "") {
  if (tituloActual && !/^tema\s*\d+$/i.test(tituloActual.trim())) {
    return tituloActual.trim();
  }
  if (!texto || typeof texto !== "string") return tituloActual || `Tema ${tema}`;

  const m1 = texto.match(/Tema\s*\d+\s*[:·\-–—]\s*([^\n\r]+)/i);
  if (m1 && m1[1] && m1[1].trim().length > 3) {
    return m1[1].replace(/\s*·\s*\d+\s*$/, "").trim();
  }

  const m2 = texto.match(/Tema\s*\d+\s*\r?\n+([A-Za-zÀ-ÿ][^\n\r]+(?:\r?\n[A-Za-zÀ-ÿ][^\n\r]+)?)/i);
  if (m2 && m2[1] && m2[1].trim().length > 3) {
    return m2[1].replace(/\r?\n+/g, " ").replace(/\s*·\s*\d+\s*$/, "").trim();
  }

  return tituloActual || `Tema ${tema}`;
}

export function detectarCatalan(texto = "") {
  if (!texto || typeof texto !== "string" || !texto.trim()) return false;
  const patron = /(?:^|[^a-zà-ÿ])(?:client-servidor|client(?:\s+servidor)?|l['’](?:origen|abast|execuci[oó]|usuari|entorn)|d['’](?:execuci[oó]|un|una|aquest|aquesta)|eines|llenguatges|execuci[oó]|entorn|entorns|desenvolupament|cercador|fitxers?|dades|sol[·.]licituds?|aquest|aquesta|aquests|aquestes|tamb[eé]|aix[oò]|dels|deles|amb|sense|per[oò]|s[oó]n|mitjan[cç]ant|interf[ií]cie|renderitzat|comunicacions|navigador)(?![a-zà-ÿ])/iu;
  return patron.test(texto);
}

export function escaparLatex(value) {
  return String(value).replace(/[#$%&_]/g, "\\$&");
}

export function escaparTextoLatex(value) {
  const escapes = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "#": "\\#",
    "$": "\\$",
    "%": "\\%",
    "&": "\\&",
    "_": "\\_",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
  };
  return String(value).replace(/[\\{}#$%&_~^]/g, (character) => escapes[character]);
}

export function obtenerListaTexto(value, maxItems, maxLength) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((item) => ["string", "number"].includes(typeof item))
    .map((item) => String(item).slice(0, maxLength))
    .slice(0, maxItems);
}

export async function existeArchivo(file) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
