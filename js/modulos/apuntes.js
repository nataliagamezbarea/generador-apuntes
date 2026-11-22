import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./configuracion.js";
import { buscarImagenAbierta } from "./imagenes.js";

const titlePattern =
  /\\(?:secciongrande|seccion|titulo|subtituloA|subtituloB|subtitulo)\*?(?:\[[^\]]*\])?\{([^{}]+)\}/g;
const stopWords = new Set(
  "para porque como cuando donde desde hasta entre sobre tambien puede pueden hace hacer tiene tienen este esta estos estas otro otra todos todas solo cada mismo misma ser estar hay muy mas pero aunque mientras mediante segun ejemplo forma parte caso tipo uso usar utiliza utilizar sirve consiste permite debe deben son con los las del que una uno unos unas por sin".split(
    " ",
  ),
);

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

function normalizarTexto(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function convertirLatexATextoPlano(value) {
  return String(value ?? "")
    .replace(/(?<!\\)%.*$/gm, " ")
    .replace(/\\(?:begin|end)\{[^}]+\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?/g, " ")
    .replace(/[{}\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function obtenerTerminos(value) {
  return new Set(
    normalizarTexto(value)
      .match(/[a-z0-9ñ]{3,}/g)
      ?.filter((word) => !stopWords.has(word)) ?? [],
  );
}

function similitudJaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export class IndiceConceptos {
  constructor() {
    this.titles = [];
    this.sentences = [];
    this.tokenSets = [];
    this.hashes = new Set();
  }

  addText(text) {
    const plain = convertirLatexATextoPlano(text);
    for (const sentence of plain.split(/(?<=[.!?;])\s+|\n+/)) {
      const trimmed = sentence.trim();
      const normalized = normalizarTexto(trimmed);
      if (normalized.length < 20 || trimmed.length < 25 || trimmed.length > 420)
        continue;
      const hash = createHash("sha1").update(normalized).digest("hex");
      if (this.hashes.has(hash)) continue;
      this.hashes.add(hash);
      this.sentences.push(trimmed);
      this.tokenSets.push(obtenerTerminos(trimmed));
      if (this.sentences.length >= 6000) break;
    }
  }

  isDuplicate(text, threshold = 0.72) {
    const normalized = normalizarTexto(text);
    if (normalized.length < 12) return false;
    if (this.hashes.has(createHash("sha1").update(normalized).digest("hex")))
      return true;
    const candidate = obtenerTerminos(text);
    return this.tokenSets.some(
      (existing) => similitudJaccard(candidate, existing) >= threshold,
    );
  }

  summary(maxChars = 14000) {
    const lines = [];
    if (this.titles.length)
      lines.push(
        "TÍTULOS/APARTADOS:",
        ...this.titles.slice(-180).map((title) => `- ${title}`),
      );
    if (this.sentences.length)
      lines.push(
        "",
        "IDEAS YA EXPLICADAS:",
        ...this.sentences.slice(-320).map((sentence) => `- ${sentence}`),
      );
    return lines.join("\n").slice(0, maxChars);
  }
}

async function recorrerCarpeta(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const results = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await recorrerCarpeta(fullPath)));
    else if (entry.isFile() && entry.name.endsWith(".tex"))
      results.push(fullPath);
  }
  return results;
}

export async function analizarApuntesExistentes(subject, wholeRepo = true) {
  const subjectDir = path.join(config.notesRoot, componenteSeguro(subject));
  const root = wholeRepo ? config.notesRoot : subjectDir;
  const index = new IndiceConceptos();
  let files = [];
  try {
    files = (await recorrerCarpeta(root)).filter((file) => {
      const filename = path.basename(file);
      return (
        !["carga.tex", "preambulo.tex", "generador-estilos.tex"].includes(filename) &&
        !/^tema\d+\.tex$/i.test(filename)
      );
    });
  } catch (error) {
    throw new Error(
      `No se pudieron leer los apuntes existentes: ${error.message}`,
    );
  }
  const samples = [];
  for (const file of files) {
    const source = await readFile(file, "utf8").catch(() => "");
    for (const match of source.matchAll(titlePattern)) {
      const title = convertirLatexATextoPlano(match[1]);
      if (title) {
        index.titles.push(title);
        if (samples.length < 30) samples.push(title);
      }
    }
    index.addText(source);
  }
  return {
    root,
    files: files.length,
    titles: index.titles.length,
    sentences: index.sentences.length,
    samples,
    index,
  };
}

export async function listarAsignaturas() {
  let entries;
  try {
    entries = await readdir(config.notesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const subjects = [];
  for (const entry of entries
    .filter(
      (item) =>
        item.isDirectory() &&
        !item.name.startsWith(".") &&
        !/^Tema\s+\d+$/i.test(item.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "es"))) {
    const subjectPath = path.join(config.notesRoot, entry.name);
    const children = await readdir(subjectPath, { withFileTypes: true });
    const themes = [];
    for (const child of children) {
      const match = child.isDirectory()
        ? child.name.match(/^Tema\s+(\d+)$/i)
        : null;
      if (!match) continue;
      const numero = Number(match[1]);
      const themePath = path.join(subjectPath, child.name);
      const parts = await readdir(themePath, { withFileTypes: true });
      const apartadosPorNumero = new Map();
      let tituloTema = "";
      for (const part of parts) {
        const partMatch = part.isDirectory()
          ? part.name.match(new RegExp(`^Tema\\s*${numero}\\.(\\d+)$`, "i"))
          : null;
        if (!partMatch) continue;
        const apartadoNumero = Number(partMatch[1]);
        const report = await obtenerInformeGeneracion(
          entry.name,
          numero,
          apartadoNumero,
        );
        tituloTema ||= String(report?.titulo_tema ?? "").trim();
        const tituloGuardado =
          String(report?.titulo_subtema ?? "").trim() ||
          String(report?.archivos_generados?.[0]?.titulo ?? "").trim();
        const archivosLatex = (await readdir(path.join(themePath, part.name)))
          .filter((nombre) => nombre.toLowerCase().endsWith(".tex"))
          .sort((izquierda, derecha) =>
            izquierda.localeCompare(derecha, "es"),
          );
        const tituloArchivo =
          tituloGuardado ||
          (archivosLatex.length
            ? await primerTituloLatex(
                path.join(themePath, part.name, archivosLatex[0]),
              )
            : "");
        const nombre =
          tituloArchivo || `Apartado ${apartadoNumero}`;
        apartadosPorNumero.set(apartadoNumero, new Set([nombre]));
      }
      const archivosLaTeXDelTema = parts.flatMap((item) =>
        item.isFile() && item.name.toLowerCase().endsWith(".tex")
          ? [{ nombre: item.name, ruta: path.join(themePath, item.name) }]
          : [],
      );
      for (const carpetaApartado of parts.filter((item) => item.isDirectory())) {
        const rutaApartado = path.join(themePath, carpetaApartado.name);
        const archivos = await readdir(rutaApartado, { withFileTypes: true });
        archivosLaTeXDelTema.push(
          ...archivos
            .filter(
              (item) =>
                item.isFile() && item.name.toLowerCase().endsWith(".tex"),
            )
            .map((item) => ({
              nombre: item.name,
              ruta: path.join(rutaApartado, item.name),
            })),
        );
      }
      for (const archivo of archivosLaTeXDelTema
        .sort((izquierda, derecha) =>
          izquierda.nombre.localeCompare(derecha.nombre, "es"),
        )) {
        const coincidencia = archivo.nombre.match(
          new RegExp(`^${numero}\\.(\\d+)([.-]|$)`, "i"),
        );
        if (!coincidencia) continue;
        const apartadoNumero = Number(coincidencia[1]);
        const nombres = apartadosPorNumero.get(apartadoNumero) ?? new Set();
        if (
          coincidencia[2] === "." &&
          apartadosPorNumero.has(apartadoNumero)
        )
          continue;
        const titulo = await primerTituloLatex(archivo.ruta);
        if (titulo) nombres.add(titulo);
        else if (!nombres.size) nombres.add(`Apartado ${apartadoNumero}`);
        apartadosPorNumero.set(apartadoNumero, nombres);
      }
      const tituloTemaArchivo = await primerTituloLatex(
        path.join(themePath, `tema${numero}.tex`),
      );
      themes.push({
        numero,
        nombre: child.name,
        titulo: tituloTema || tituloTemaArchivo || child.name,
        apartados: [...apartadosPorNumero]
          .sort(([numeroIzquierdo], [numeroDerecho]) => numeroIzquierdo - numeroDerecho)
          .map(([apartadoNumero, nombres]) => ({
            numero: apartadoNumero,
            nombre: [...nombres].join(" · "),
          })),
      });
    }
    themes.sort((a, b) => a.numero - b.numero);
    subjects.push({ nombre: entry.name, temas: themes });
  }
  return subjects;
}

export async function crearCarpetaAsignatura(subject) {
  const nombre = componenteSeguro(subject);
  const carpeta = path.join(config.notesRoot, nombre);
  await mkdir(carpeta, { recursive: true });
  return { nombre, carpeta };
}

async function primerTituloLatex(archivo) {
  let contenido;
  try {
    contenido = await readFile(archivo, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
  return (
    contenido.match(
      /\\(?:secciongrande|seccion|titulo|subtituloA|subtituloB|subtitulo)\*?(?:\[[^\]]*\])?\{([^{}]+)\}/,
    )?.[1] ?? ""
  ).trim();
}

export async function listarApuntes(subject) {
  const subjectDir = path.join(config.notesRoot, componenteSeguro(subject));
  const files = await recorrerCarpeta(subjectDir);
  return files
    .filter(
      (file) =>
        !["carga.tex", "preambulo.tex", "generador-estilos.tex"].includes(
          path.basename(file),
        ),
    )
    .map((file) => ({
      path: path.relative(config.notesRoot, file).split(path.sep).join("/"),
      name: path.basename(file),
    }))
    .sort((a, b) => a.path.localeCompare(b.path, "es"));
}

export function resolverRutaApunte(relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath.toLowerCase().endsWith(".tex")
  ) {
    throw Object.assign(new Error("Selecciona un archivo .tex."), {
      status: 400,
    });
  }
  const root = path.resolve(config.notesRoot);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error("La ruta del apunte no es válida."), {
      status: 400,
    });
  }
  return target;
}

export async function leerApunte(relativePath) {
  const target = resolverRutaApunte(relativePath);
  let content;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      throw Object.assign(
        new Error("No se encuentra el apunte seleccionado."),
        { status: 404 },
      );
    throw error;
  }
  return {
    path: relativePath,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export async function guardarApunte({
  path: relativePath,
  content,
  expectedSha256,
}) {
  const target = resolverRutaApunte(relativePath);
  const current = await readFile(target, "utf8");
  const currentSha256 = createHash("sha256").update(current).digest("hex");
  if (currentSha256 !== expectedSha256) {
    throw Object.assign(
      new Error(
        "El apunte cambió desde que lo abriste. Vuelve a cargarlo para evitar sobrescribir cambios.",
      ),
      { status: 409 },
    );
  }
  if (typeof content !== "string" || content.length > 2_000_000) {
    throw Object.assign(
      new Error("El contenido del apunte no es válido o es demasiado grande."),
      { status: 400 },
    );
  }
  await writeFile(target, content, "utf8");
  return {
    path: relativePath,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export async function rutaInformeGeneracion(subject, theme, subtheme) {
  return path.join(
    config.generationReportsRoot,
    componenteSeguro(subject),
    `tema-${theme}-apartado-${subtheme}`,
    "ultima-generacion.json",
  );
}

export async function obtenerInformeGeneracion(subject, theme, subtheme) {
  const file = await rutaInformeGeneracion(subject, theme, subtheme);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`No se pudo leer el informe anterior: ${error.message}`);
  }
}

export async function listarHistorialGeneraciones(subject) {
  const directory = path.join(
    config.generationReportsRoot,
    componenteSeguro(subject),
  );
  const informes = [];

  async function recorrer(ruta) {
    let entradas;
    try {
      entradas = await readdir(ruta, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && ruta === directory) return;
      throw error;
    }
    for (const entrada of entradas) {
      const destino = path.join(ruta, entrada.name);
      if (entrada.isDirectory()) await recorrer(destino);
      else if (
        entrada.isFile() &&
        (entrada.name === "ultima-generacion.json" ||
          (path.basename(ruta) === "historial" &&
            entrada.name.toLowerCase().endsWith(".json")))
      ) {
        try {
          informes.push(JSON.parse(await readFile(destino, "utf8")));
        } catch (error) {
          throw new Error(
            `No se pudo leer el historial ${path.relative(directory, destino)}: ${error.message}`,
          );
        }
      }
    }
  }

  await recorrer(directory);
  const historialCompleto = [
    ...new Map(
      informes.map((informe) => [
        [
          informe.generado,
          informe.fingerprint,
          informe.asignatura,
          informe.tema,
          informe.subtema,
        ].join("\0"),
        informe,
      ]),
    ).values(),
  ];
  return historialCompleto.sort(
    (izquierda, derecha) =>
      Date.parse(derecha.generado) - Date.parse(izquierda.generado),
  );
}

export async function eliminarInformeGeneracion(
  subject,
  { fingerprint, theme, subtheme, todo } = {},
) {
  const directory = path.join(
    config.generationReportsRoot,
    componenteSeguro(subject),
  );
  try {
    if (todo || (!fingerprint && !theme && !subtheme)) {
      await rm(directory, { recursive: true, force: true });
      return;
    }
    if (!fingerprint && theme && subtheme) {
      const apartadoDir = path.join(
        directory,
        `tema-${theme}-apartado-${subtheme}`,
      );
      await rm(apartadoDir, { recursive: true, force: true });
      return;
    }
    if (fingerprint) {
      async function recorrerYBorrar(ruta) {
        let entradas;
        try {
          entradas = await readdir(ruta, { withFileTypes: true });
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        for (const entrada of entradas) {
          const destino = path.join(ruta, entrada.name);
          if (entrada.isDirectory()) {
            await recorrerYBorrar(destino);
          } else if (entrada.isFile() && entrada.name.endsWith(".json")) {
            try {
              const data = JSON.parse(await readFile(destino, "utf8"));
              if (data.fingerprint === fingerprint) {
                await rm(destino, { force: true });
              }
            } catch {}
          }
        }
      }
      await recorrerYBorrar(directory);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function inferirSubtemaDeBloque(block, subthemePredeterminado = 1) {
  if (Number(subthemePredeterminado) > 0) {
    return Number(subthemePredeterminado);
  }
  if (block?.subtema && Number.isSafeInteger(Number(block.subtema)) && Number(block.subtema) > 0) {
    return Number(block.subtema);
  }
  if (block?.apartado) {
    const match = String(block.apartado).match(/(?:\d+\.)?(\d+)/);
    if (match) return Number(match[1]);
  }
  const matchTitulo = String(block?.titulo ?? "").match(/(?:^|\b)(?:\d+\.)(\d+)\b/);
  if (matchTitulo) {
    return Number(matchTitulo[1]);
  }
  return 1;
}

export function desglosarBloquesPorSubtitulos(archivos = []) {
  if (!Array.isArray(archivos) || archivos.length === 0) return archivos;

  const resultado = [];

  for (const block of archivos) {
    if (!block || typeof block.latex !== "string") {
      resultado.push(block);
      continue;
    }

    const latex = block.latex;
    const regexSubtitulo = /\\(?:subtituloA|subtitulo|subseccion)\*?(?:\[[^\]]*\])?\{([^}]+)\}/g;
    const matches = [];
    let m;
    while ((m = regexSubtitulo.exec(latex)) !== null) {
      matches.push({
        index: m.index,
        fullMatch: m[0],
        titulo: m[1].trim(),
        length: m[0].length,
      });
    }

    if (matches.length <= 1) {
      resultado.push(block);
      continue;
    }

    for (let i = 0; i < matches.length; i++) {
      const matchActual = matches[i];
      const startPos = i === 0 ? 0 : matchActual.index;
      const endPos = i + 1 < matches.length ? matches[i + 1].index : latex.length;
      let trozoLatex = latex.slice(startPos, endPos).trim();

      if (i > 0) {
        trozoLatex = trozoLatex
          .replace(/\\secciongrande\*?(?:\[[^\]]*\])?\{([^}]+)\}\s*/g, "")
          .replace(/\\resumen\*?(?:\[[^\]]*\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*/g, "");
        if (!trozoLatex.startsWith("\\subtituloA") && !trozoLatex.startsWith("\\subtitulo")) {
          trozoLatex = `\\subtituloA{${matchActual.titulo}}\n\n${trozoLatex}`;
        }
      }

      const tituloSub = matchActual.titulo;
      const slugSub = deducirSlugConceptual("", tituloSub) || `apartado-${i + 1}`;

      resultado.push({
        ...block,
        titulo: tituloSub,
        nombre: `${i + 1}.${slugSub}`,
        orden: i + 1,
        indiceApartado: i + 1,
        apartadoNumero: i + 1,
        latex: trozoLatex,
      });
    }
  }

  return resultado;
}

function stemArchivoGenerado(block, theme, subtheme, index) {
  let orden = null;

  if (Number.isInteger(Number(block?.orden)) && Number(block.orden) > 0) {
    orden = Number(block.orden);
  } else if (Number.isInteger(Number(block?.numeroArchivoEnSubtema)) && Number(block.numeroArchivoEnSubtema) > 0) {
    orden = Number(block.numeroArchivoEnSubtema);
  }

  if (!orden) {
    const matchNum = String(block?.nombre || "").match(/^(\d+)[.\-]/);
    if (matchNum && Number(matchNum[1]) > 0) {
      orden = Number(matchNum[1]);
    }
  }

  if (!orden) {
    orden = typeof index === "number" && index >= 0 ? index + 1 : 1;
  }

  const base = block?.nombre ? block.nombre.replace(/\.tex$/i, "").trim() : "";
  let slug = "";
  if (base && !/slug-descriptivo|^apartado(?:-\d+)*$/i.test(base)) {
    slug = crearNombreArchivo(base);
  }
  if (!slug || /slug-descriptivo|^apartado(?:-\d+)*$/i.test(slug)) {
    const deducido = deducirSlugConceptual("", block?.titulo || base || "seccion");
    slug = deducido && !/slug-descriptivo|^apartado(?:-\d+)*$/i.test(deducido)
      ? deducido
      : `seccion-${orden}`;
  }

  // Quitar cualquier prefijo numérico previo (ej: "1-origen", "1.origen" -> "origen") para garantizar el prefijo ${orden}.
  slug = slug.replace(/^\d+[.\-]+\s*/, "");

  return `${orden}.${slug || "apartado"}`;
}

export async function inspeccionarReemplazosGeneracion({
  result,
  subject,
  theme,
  subtheme,
  fingerprint,
  inputFiles = [],
}) {
  const informe = await obtenerInformeGeneracion(subject, theme, subtheme);
  const fuentesAnalizadas = new Set(
    (informe?.archivos_procesados_detalle ?? []).map((archivo) => archivo.nombre),
  );
  const archivosRegistrados = new Set(
    (informe?.archivos_generados ?? []).map((archivo) => archivo.path),
  );
  const archivosConHuella = new Set(
    informe?.fingerprint === fingerprint ? archivosRegistrados : [],
  );
  if (
    !inputFiles.some((archivo) => fuentesAnalizadas.has(archivo.originalname))
  )
    return [];

  result.archivos = desglosarBloquesPorSubtitulos(result.archivos);
  const contadorSubtemasInsp = new Map();
  for (const block of result.archivos) {
    const bloqueSubtema = inferirSubtemaDeBloque(block, subtheme);
    const contadorActual = (contadorSubtemasInsp.get(bloqueSubtema) || 0) + 1;
    contadorSubtemasInsp.set(bloqueSubtema, contadorActual);
    block.orden = contadorActual;
    block.numeroArchivoEnSubtema = contadorActual;
  }

  const existentes = [];
  for (const [index, block] of result.archivos.entries()) {
    const bloqueSubtema = inferirSubtemaDeBloque(block, subtheme);
    const subDir = path.join(
      config.notesRoot,
      componenteSeguro(subject),
      `Tema ${theme}`,
      `Tema ${theme}.${bloqueSubtema}`,
    );
    const filename = `${stemArchivoGenerado(block, theme, bloqueSubtema, index)}.tex`;
    const target = path.join(subDir, filename);
    const relativeTarget = path
      .relative(config.notesRoot, target)
      .split(path.sep)
      .join("/");
    if (!archivosRegistrados.has(relativeTarget)) continue;
    try {
      const contenido = await readFile(target, "utf8");
      if (archivosConHuella.has(relativeTarget)) continue;
      const hash = createHash("sha256").update(contenido).digest("hex");
      existentes.push({
        path: path.relative(config.notesRoot, target).split(path.sep).join("/"),
        sha256: hash,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return existentes;
}

export async function guardarGeneracion({
  result,
  fingerprint,
  subject,
  theme,
  subtheme,
  inputFiles,
  material,
  existingCount,
  replaceExisting = false,
  expectedExistingFiles = {},
  archivosCambiados = [],
}) {
  const subjectDir = path.join(config.notesRoot, componenteSeguro(subject));
  const themeDir = path.join(subjectDir, `Tema ${theme}`);
  const subDir = path.join(themeDir, `Tema ${theme}.${subtheme}`);
  await mkdir(themeDir, { recursive: true });
  const created = [];
  const warnings = [];
  const written = [];
  const imagenesIncluidas = [];
  const sugerenciasUsadas = new Set();

  await asegurarEstructuraAsignatura(subjectDir);
  await asegurarEstructuraTema(themeDir);
  const informeAnterior = await obtenerInformeGeneracion(
    subject,
    theme,
    subtheme,
  );
  const archivosConHuella = new Set(
    informeAnterior?.fingerprint === fingerprint
      ? (informeAnterior.archivos_generados ?? []).map((archivo) => archivo.path)
      : [],
  );

  result.archivos = desglosarBloquesPorSubtitulos(result.archivos);
  const contadorSubtemas = new Map();
  for (const block of result.archivos) {
    const bloqueSubtema = inferirSubtemaDeBloque(block, subtheme);
    const contadorActual = (contadorSubtemas.get(bloqueSubtema) || 0) + 1;
    contadorSubtemas.set(bloqueSubtema, contadorActual);
    block.orden = contadorActual;
    block.numeroArchivoEnSubtema = contadorActual;
  }

  for (const [index, block] of result.archivos.entries()) {
    const bloqueSubtema = inferirSubtemaDeBloque(block, subtheme);
    const subDir = path.join(themeDir, `Tema ${theme}.${bloqueSubtema}`);
    await mkdir(subDir, { recursive: true });
    const stem = stemArchivoGenerado(block, theme, bloqueSubtema, index);
    const filename = `${stem}.tex`;
    const target = path.join(subDir, filename);
    const relativeTarget = path
      .relative(config.notesRoot, target)
      .split(path.sep)
      .join("/");
    let outputPath = target;
    if (await existeArchivo(target)) {
      const existing = await readFile(target, "utf8");
      if (archivosConHuella.has(relativeTarget)) {
        outputPath = target;
      } else if (replaceExisting) {
        const expectedHash = expectedExistingFiles[relativeTarget];
        if (expectedHash) {
          const actualHash = createHash("sha256").update(existing).digest("hex");
          if (expectedHash !== actualHash) {
            throw Object.assign(
              new Error(
                `El archivo ${relativeTarget} cambió mientras confirmabas la sustitución. No se ha sobrescrito.`,
              ),
              { status: 409 },
            );
          }
        }
        outputPath = target;
      } else {
        let suffix = 2;
        while (await existeArchivo(path.join(subDir, `${stem}-${suffix}.tex`))) {
          const candidato = path.join(subDir, `${stem}-${suffix}.tex`);
          const relativoCandidato = path
            .relative(config.notesRoot, candidato)
            .split(path.sep)
            .join("/");
          if (archivosConHuella.has(relativoCandidato)) {
            outputPath = candidato;
            break;
          }
          suffix += 1;
        }
        if (outputPath === target)
          outputPath = path.join(subDir, `${stem}-${suffix}.tex`);
      }
    } else if (replaceExisting && expectedExistingFiles[relativeTarget]) {
      throw Object.assign(
        new Error(
          `El archivo ${relativeTarget} cambió mientras confirmabas la sustitución. No se ha sobrescrito.`,
        ),
        { status: 409 },
      );
    }
    
    const figuraAbierta = await adjuntarImagenAbierta({
      imagenes: result.imagenes ?? [],
      stem: path.basename(outputPath, ".tex"),
      titulo: block.titulo,
      directorio: subDir,
      warnings,
      imagenesIncluidas,
      sugerenciasUsadas,
    });
    const diagramas = imagenesDelApartado(result.imagenes, stem, block.titulo);
    let latexBloque = block.latex.trim();
    const indiceEnSubtema = (block.orden || (index + 1)) - 1;
    if (indiceEnSubtema > 0) {
      latexBloque = latexBloque
        .replace(/\\secciongrande\*?(?:\[[^\]]*\])?\{([^}]+)\}\s*/g, "")
        .replace(/\\resumen\*?(?:\[[^\]]*\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*/g, "");
    }
    const latexLimpio = aplicarEstilosLatex(latexBloque, subject);
    const latex = `${latexLimpio}${figuraAbierta ? `\n\n${figuraAbierta}` : ""}${diagramas ? `\n\n${diagramas}` : ""}\n`;
    await writeFile(outputPath, latex, "utf8");
    written.push({
      titulo: block.titulo,
      archivo: outputPath,
      relativo: path
        .relative(config.notesRoot, outputPath)
        .split(path.sep)
        .join("/"),
    });
  }

  if (replaceExisting) {
    const rutasNuevas = new Set(written.map((w) => path.resolve(w.archivo)));
    if (informeAnterior?.archivos_generados) {
      for (const viejo of informeAnterior.archivos_generados) {
        if (!viejo.path) continue;
        const absViejo = path.resolve(config.notesRoot, viejo.path);
        if (!rutasNuevas.has(absViejo)) {
          try {
            await rm(absViejo, { force: true });
          } catch {}
        }
      }
    }
    for (const [sub] of contadorSubtemas.entries()) {
      const subDirAfectado = path.join(themeDir, `Tema ${theme}.${sub}`);
      try {
        const archivosEnSubDir = await readdir(subDirAfectado);
        for (const arch of archivosEnSubDir) {
          if (!arch.endsWith(".tex")) continue;
          const absArch = path.resolve(subDirAfectado, arch);
          if (!rutasNuevas.has(absArch)) {
            try {
              await rm(absArch, { force: true });
            } catch {}
          }
        }
      } catch {}
    }
  }

  const themeDocument = await asegurarDocumentoTema(
    themeDir,
    subject,
    theme,
    result.titulo_tema,
  );
  if (themeDocument.created) created.push(themeDocument.path);
  const report = {
    fingerprint,
    generado: new Date().toISOString(),
    asignatura: subject,
    tema: theme,
    subtema: subtheme,
    titulo_tema: result.titulo_tema,
    titulo_subtema: result.titulo_subtema,
    conceptos_clave: result.conceptos_clave,
    cobertura: result.cobertura,
    fuentes: result.fuentes,
    imagenes: imagenesIncluidas,
    archivos_procesados: inputFiles.map((file) => file.originalname),
    archivos_procesados_detalle: inputFiles.map((file) => ({
      nombre: file.originalname,
      bytes: file.size,
      sha256: createHash("sha256").update(file.buffer).digest("hex"),
    })),
    archivos_cambiados: archivosCambiados,
    documentos_leidos: material.documents.length,
    imagenes_ocr: material.imagesOcr,
    paginas_enviadas_a_vision: material.visuals.length,
    apuntes_existentes: { files: existingCount },
    archivos_generados: written.map((file) => ({
      titulo: file.titulo,
      path: file.relativo,
    })),
    tema_documento: path
      .relative(config.notesRoot, themeDocument.path)
      .split(path.sep)
      .join("/"),
    avisos: [...material.warnings, ...warnings],
  };
  const reportDirectory = path.dirname(
    await rutaInformeGeneracion(subject, theme, subtheme),
  );
  await mkdir(reportDirectory, { recursive: true });
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(
    path.join(reportDirectory, "ultima-generacion.json"),
    reportText,
    "utf8",
  );
  await writeFile(path.join(reportDirectory, "cobertura.json"), reportText, "utf8");
  const historyDirectory = path.join(reportDirectory, "historial");
  await mkdir(historyDirectory, { recursive: true });
  await writeFile(
    path.join(historyDirectory, `${Date.now()}-${fingerprint}.json`),
    reportText,
    "utf8",
  );
  return {
    report,
    salida: {
      subject_dir: subjectDir,
      theme_dir: themeDir,
      sub_dir: subDir,
      theme_document: themeDocument.path,
      created,
      written,
      skipped: [],
      warnings,
    },
  };
}

async function adjuntarImagenAbierta({
  imagenes,
  stem,
  titulo,
  directorio,
  warnings,
  imagenesIncluidas,
  sugerenciasUsadas,
}) {
  if (imagenesIncluidas.length >= 3) return "";
  const indice = imagenes.findIndex((imagen, itemIndice) => {
    if (sugerenciasUsadas.has(itemIndice) || !String(imagen.consulta ?? "").trim())
      return false;
    const asociado = String(imagen.apartado ?? imagen.archivo ?? "");
    return !asociado || asociado === stem || asociado === titulo;
  });
  if (indice < 0) return "";
  sugerenciasUsadas.add(indice);
  const sugerencia = imagenes[indice];

  try {
    const imagen = await buscarImagenAbierta(sugerencia.consulta);
    if (!imagen) return "";
    const nombreImagen = `${stem}-imagen.${imagen.extension}`;
    await writeFile(path.join(directorio, nombreImagen), imagen.data);
    const descripcion = escaparTextoLatex(
      String(sugerencia.descripcion ?? imagen.descripcion ?? titulo).slice(0, 300),
    );
    const atribucion = escaparTextoLatex(
      `${imagen.autor}. ${imagen.licencia}. Fuente: ${imagen.fuenteUrl}`,
    );
    imagenesIncluidas.push({
      archivo: nombreImagen,
      titulo: imagen.titulo,
      autor: imagen.autor,
      licencia: imagen.licencia,
      licencia_url: imagen.licenciaUrl?.href ?? "",
      fuente_url: imagen.fuenteUrl,
    });
    return [
      "\\begin{figure}[htbp]",
      "\\centering",
      `\\includegraphics[width=0.8\\linewidth]{${nombreImagen}}`,
      `\\caption{${descripcion}}`,
      `\\small\\textit{${atribucion}}`,
      "\\end{figure}",
    ].join("\n");
  } catch (error) {
    warnings.push(
      `No se pudo añadir una imagen con licencia abierta para «${titulo}»: ${error.message}`,
    );
    return "";
  }
}

function escaparTextoLatex(value) {
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

function imagenesDelApartado(imagenes = [], slug, titulo) {
  if (!Array.isArray(imagenes)) return "";
  return imagenes
    .flatMap((imagen) => {
      if (String(imagen.tikz ?? "").trim()) return [];
      const asociado = String(imagen.apartado ?? imagen.archivo ?? "");
      if (asociado && asociado !== slug && asociado !== titulo) return [];
      const tikz = limpiarLatex(imagen.tikz ?? "");
      if (!tikz) return [];
      const descripcion = String(imagen.descripcion ?? "").replace(
        /[#$%&_]/g,
        "\\$&",
      );
      const dibujo = tikz.includes("\\begin{tikzpicture}")
        ? tikz
        : `\\begin{tikzpicture}\n${tikz}\n\\end{tikzpicture}`;
      return [
        `\\begin{figure}[htbp]\n\\centering\n${dibujo}\n${descripcion ? `\\caption{${descripcion}}` : ""}\n\\end{figure}`,
      ];
    })
    .join("\n\n");
}

export function sanearTitulosTema(value, tituloApartado = "", tituloTema = "") {
  let latex = String(value ?? "");

  // El modelo a veces copia el encabezado del tema dentro del resumen:
  // "\resumen{Tema 1: ... \ Tema 2.1: ...} Texto real". Se eliminan esos
  // rótulos iniciales y se conserva únicamente la síntesis técnica.
  latex = latex.replace(/\\resumen\{([\s\S]*?)\}/g, (match, cuerpo) => {
    if (!/^\s*(?:tema|apartado|secci[oó]n)\s*\d/i.test(String(cuerpo))) {
      return match;
    }
    let contenido = String(cuerpo);
    let anterior;
    do {
      anterior = contenido;
      contenido = contenido.replace(
        /^\s*(?:tema|apartado|secci[oó]n)\s*\d+(?:[.\-]\d+)*\s*[:.\-–—]\s*[^\\{}]*(?:\\\s*)?/i,
        "",
      );
    } while (contenido !== anterior);
    return contenido.trim()
      ? `\\resumen{${contenido.trim()}}`
      : "%%RESUMEN_VACIO%%";
  });
  // Si el resumen solo contenía el rótulo del tema, se recupera la frase que
  // quedó justo después para no dejar una caja vacía.
  latex = latex.replace(/%%RESUMEN_VACIO%%[ \t]*([^\n]*)/g, (_match, resto) => {
    const texto = String(resto ?? "").trim();
    return texto ? `\\resumen{${texto}}` : "";
  });

  // El modelo a veces anida la misma macro: \secciongrande{\secciongrande{X}}.
  latex = latex.replace(
    /\\secciongrande\{\s*\\secciongrande\{([^{}]*)\}\s*\}/g,
    "\\secciongrande{$1}",
  );

  // El nombre del tema nunca debe ocupar el \secciongrande del apartado.
  const tituloLimpio = String(tituloApartado ?? "").trim();
  const normalizar = (texto) =>
    String(texto ?? "")
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const temaNormalizado = normalizar(tituloTema);
  latex = latex.replace(/\\secciongrande\{([^{}]*)\}/g, (match, titulo) => {
    const esRotulo = /^\s*(?:tema|apartado|secci[oó]n)\s*\d+(?:[.\-]\d+)*\s*[:.\-–—]/i.test(titulo);
    const esNombreTema =
      Boolean(temaNormalizado) && normalizar(titulo) === temaNormalizado;
    if (esRotulo || esNombreTema) {
      return tituloLimpio ? `\\secciongrande{${tituloLimpio}}` : "";
    }
    return match;
  });

  return latex;
}

export function limpiarLatex(value) {  let latex = String(value ?? "").trim();
  if (/^```(?:latex|tex)?\s*/i.test(latex)) {
    latex = latex
      .replace(/^```(?:latex|tex)?\s*/i, "")
      .replace(/\s*```$/, "");
  }

  // La IA a veces devuelve un documento completo aunque se le pidan
  // fragmentos WEC. Si hay \begin{document}, conservar exclusivamente
  // el cuerpo; nunca guardar el preámbulo dentro de un archivo de apartado.
  // Antes se elimina el encabezado WEC mal formado que podía envolver
  // accidentalmente \documentclass: \secciongrande{\documentclass...
  const envolturaWecMalformada = /^\s*\\(?:secciongrande|seccion|subtituloA|subtituloB)\s*\{\s*(?=\\documentclass\b)/i.test(latex);
  latex = latex.replace(
    /^\s*\\(?:secciongrande|seccion|subtituloA|subtituloB)\s*\{\s*(?=\\documentclass\b)/i,
    "",
  );
  const beginDocument = latex.search(/\\begin\s*\{\s*document\s*\}/i);
  if (beginDocument >= 0) {
    const bodyStartMatch = /\\begin\s*\{\s*document\s*\}/i.exec(latex.slice(beginDocument));
    const bodyStart = beginDocument + bodyStartMatch[0].length;
    const endMatch = /\\end\s*\{\s*document\s*\}/i.exec(latex.slice(bodyStart));
    latex = latex.slice(bodyStart, endMatch ? bodyStart + endMatch.index : undefined);
  } else {
    // También tolerar respuestas sin begin{document}, eliminando preámbulo.
    latex = latex
      .replace(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
      .replace(/\\usepackage(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
      .replace(/\\RequirePackage(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
      .replace(/\\(?:input|include)\s*\{(?:carga|generador-estilos|preambulo|[^{}]*\.sty)[^{}]*\}/gi, "");
  }

  // El cuerpo tampoco debe contener comandos de control del documento.
  latex = latex
    .replace(/\\(?:begin|end)\s*\{\s*document\s*\}/gi, "")
    .replace(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
    .replace(/\\usepackage(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
    .replace(/\\RequirePackage(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
    .replace(/\\write18\s*\{[^{}]*\}/gi, "")
    .replace(/\\immediate\s*\\write[^\n]*/gi, "")
    .replace(/\\(?:openout|read|catcode)[^\n]*/gi, "")
    .replace(/\\(?:input|include)\s*\{(?:carga|generador-estilos|preambulo)[^{}]*\}/gi, "")
    .replace(/^\s*\\end\s*\{\s*document\s*\}\s*$/gim, "")
    .trim();

  // Cerrar el envoltorio accidental de la IA, que ya se ha eliminado.
  if (envolturaWecMalformada) latex = latex.replace(/}\s*$/, "").trim();

  // Reparar una llave de apertura residual del patrón
  // \secciongrande{\documentclass ... \begin{document} ... }.
  // Solo se quita si queda al principio y no tiene un título válido.
  latex = latex.replace(
    /^\s*\\(?:secciongrande|seccion|subtituloA|subtituloB)\s*\{\s*(?=\\(?:title|author|date|maketitle|tableofcontents))/i,
    "",
  );
  return latex;
}

function esSubtituloGenerico(titulo) {
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

function quitarAsignaturaDelTitulo(value, subject) {
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

export function convertirMarkdownALatexWec(contenido = "") {
  if (!contenido || typeof contenido !== "string") return "";
  let texto = contenido.trim();

  // 1. Extraer bloques verbatim para protegerlos de transformaciones
  const verbatimBlocks = [];
  texto = texto.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (_match, lang, code) => {
    const l = (lang || "").toLowerCase();
    const token = `%%VERBATIM_BLOCK_${verbatimBlocks.length}%%`;
    if (["bash", "sh", "shell", "terminal", "consola", "console"].includes(l)) {
      verbatimBlocks.push(`\\begin{consola}\n${code.trimEnd()}\n\\end{consola}`);
    } else {
      verbatimBlocks.push(`\\begin{codigo}\n${code.trimEnd()}\n\\end{codigo}`);
    }
    return token;
  });

  texto = texto.replace(/\\begin\{(?:codigo|consola)\}(?:\[[^\]]*\])?[\s\S]*?\\end\{(?:codigo|consola)\}/gi, (match) => {
    const token = `%%VERBATIM_BLOCK_${verbatimBlocks.length}%%`;
    verbatimBlocks.push(match.replace(/\\begin\{codigo\}\[[^\]]*\]/gi, "\\begin{codigo}"));
    return token;
  });

  // 1b. Extraer macros LaTeX ya existentes para evitar corruptelas o anidamientos indebidos
  const latexMacroBlocks = [];
  function protegerMacro(str, macroNombre) {
    const patron = `\\${macroNombre}{`;
    let salida = "";
    let pos = 0;
    while (pos < str.length) {
      const idx = str.indexOf(patron, pos);
      if (idx === -1) {
        salida += str.slice(pos);
        break;
      }
      salida += str.slice(pos, idx);
      const apertura = idx + patron.length - 1;
      let fin = apertura;
      let prof = 0;
      for (; fin < str.length; fin++) {
        const c = str[fin];
        if (c === "\\") { fin++; continue; }
        if (c === "{") prof++;
        else if (c === "}") {
          prof--;
          if (prof === 0) break;
        }
      }
      if (fin >= str.length) {
        salida += str.slice(idx);
        break;
      }
      // Si es una macro de dos argumentos ({arg1}{arg2})
      let finTotal = fin + 1;
      if (["definicion", "definicionpar", "nota"].includes(macroNombre)) {
        let segundoInicio = finTotal;
        while (segundoInicio < str.length && /\s/.test(str[segundoInicio])) segundoInicio++;
        if (segundoInicio < str.length && str[segundoInicio] === "{") {
          let prof2 = 0;
          let fin2 = segundoInicio;
          for (; fin2 < str.length; fin2++) {
            const c = str[fin2];
            if (c === "\\") { fin2++; continue; }
            if (c === "{") prof2++;
            else if (c === "}") {
              prof2--;
              if (prof2 === 0) break;
            }
          }
          if (fin2 < str.length) finTotal = fin2 + 1;
        }
      }
      const token = `%%LATEX_MACRO_${latexMacroBlocks.length}%%`;
      latexMacroBlocks.push(str.slice(idx, finTotal));
      salida += token;
      pos = finTotal;
    }
    return salida;
  }

  const macrosAProteger = [
    "lista",
    "pasos",
    "rectangulos",
    "rectangulosdoble",
    "definicion",
    "definicionpar",
    "nota",
    "alertas",
    "resumen",
    "tabla",
  ];
  for (const m of macrosAProteger) {
    texto = protegerMacro(texto, m);
  }

  // 2. Convertir Tablas Markdown
  texto = texto.replace(/(?:^|\n)((?:\|[^\n]+\|\r?\n)+\|[ \t]*[-:]+[-| :]*\|\r?\n(?:\|[^\n]+\|\r?\n?)+)/g, (match, bloque) => {
    const lineas = bloque.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lineas.length < 3) return match;
    const parsearFila = (fila) => fila.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
    const cabeceras = parsearFila(lineas[0]);
    const numCols = cabeceras.length;
    if (numCols === 0) return match;
    const anchoCol = (16.0 / numCols).toFixed(1);
    const spec = cabeceras.map(() => `L{${anchoCol}cm}`).join("");
    const cabeceraWec = cabeceras.map(c => `\\tablacab{${c}}`).join(" & ") + " \\\\";
    const filasDatos = lineas.slice(2).map(fila => {
      const celdas = parsearFila(fila);
      return celdas.join(" & ") + " \\\\";
    }).join("\n");
    return `\n\\tabla[${spec}]{\n${cabeceraWec}\n\\midrule\n${filasDatos}\n}\n`;
  });

  // 2b. Unir números o viñetas que quedaron en una línea separada del texto
  texto = texto.replace(/(^[ \t]*(?:\d+[.)]?|[-*•]))\s*\r?\n+[ \t]*(?=[A-Za-zÁÉÍÓÚáéíóúñÑ`"'\*\<\\\$])/gm, "$1 ");

  // 3. Convertir Encabezados Markdown asegurando separación posterior
  texto = texto
    .replace(/^####\s+(?:subt[ií]tulo(?:\s+[a-z0-9]+)?\s*[:.\-–—]\s*)?(.+)$/gmi, "\n\\subtituloB{$1}\n\n")
    .replace(/^###\s+(?:subt[ií]tulo(?:\s+[a-z0-9]+)?\s*[:.\-–—]\s*)?(.+)$/gmi, "\n\\subtituloA{$1}\n\n")
    .replace(/^##\s+(?:secci[oó]n(?:\s+[a-z0-9]+)?\s*[:.\-–—]\s*)?(.+)$/gmi, "\n\\seccion{$1}\n\n")
    .replace(/^#\s+(?:t[ií]tulo\s*[:.\-–—]\s*)?(.+)$/gmi, "\n\\secciongrande{$1}\n\n");

  // 4. Convertir Cajas y notas (garantizando que listas y definiciones queden FUERA de \resumen)
  texto = texto.replace(/^>\s*(?:\*\*Resumen:?\*\*|\[!SUMMARY\])\s*([\s\S]+?)(?=\n\n|\n[^\s>]|$)/gmi, (_m, body) => {
    let limpio = body.replace(/^>\s*/gm, "").trim();
    const partesFuera = [];
    limpio = limpio.replace(/(?:^|\n)((?:[*-]\s+|\d+\.\s+)[^\n]+(?:\n(?:[*-]\s+|\d+\.\s+)[^\n]+)*)/g, (_mList, listBlock) => {
      partesFuera.push(listBlock.trim());
      return "";
    });
    limpio = limpio.replace(/(?:^|\n)(\*\*Definici[oó]n[^\n]*\n[\s\S]*?)(?=\n\n|\n\*\*|$)/gi, (_mDef, defBlock) => {
      partesFuera.push(defBlock.trim());
      return "";
    });
    limpio = limpio.trim();
    const resumenTex = limpio ? `\\resumen{${limpio}}` : "";
    const fueraTex = partesFuera.length > 0 ? "\n\n" + partesFuera.join("\n\n") : "";
    return `${resumenTex}${fueraTex}`;
  });

  texto = texto.replace(/^>\s*\*\*Definici[oó]n\s*(?:par)?\s*(?:\[([^\]]+)\]:?|:\s*([^:\n]+)[:\-]?)\*\*\s*([\s\S]+?)(?=\n\n|\n[^\s>]|$)/gmi, (_m, t1, t2, desc) => {
    const termino = (t1 || t2 || "Concepto").trim();
    const explicacion = desc.replace(/^>\s*/gm, "").trim();
    return `\\definicion{${termino}}{${explicacion}}`;
  });

  texto = texto.replace(/^\*\*Definici[oó]n\s*(?:par)?\s*(?:\[([^\]]+)\]:?|:\s*([^:\n]+)[:\-]?)\*\*\s*([\s\S]+?)(?=\n\n|\n[A-Z#\-\*]|$)/gmi, (_m, t1, t2, desc) => {
    const termino = (t1 || t2 || "Concepto").trim();
    const explicacion = desc.trim();
    return `\\definicion{${termino}}{${explicacion}}`;
  });

  texto = texto.replace(/^>\s*(?:\*\*(?:Para el examen|Examen|Posa'?t a prova|Autoevaluaci[oó]n|Comprovem l'apr[eè]s):?\*\*|\[!(?:NOTE|TIP)\])\s*([\s\S]+?)(?=\n\n|\n[^\s>]|$)/gmi, (_m, body) => {
    return `\\nota{Para el examen}{${body.replace(/^>\s*/gm, "").trim()}}`;
  });

  texto = texto.replace(/^>\s*(?:\*\*(?:Alerta|Advertencia|Importante|Seguridad):?\*\*|\[!(?:WARNING|CAUTION|IMPORTANT)\])\s*([\s\S]+?)(?=\n\n|\n[^\s>]|$)/gmi, (_m, body) => {
    return `\\alertas{${body.replace(/^>\s*/gm, "").trim()}}`;
  });

  texto = texto.replace(/^>\s+([\s\S]+?)(?=\n\n|\n[^\s>]|$)/gm, (_m, body) => {
    const clean = body.replace(/^>\s*/gm, "").trim();
    if (!clean) return "";
    return `\\alertas{${clean}}`;
  });

  // 4b. Separar componentes enumerados explícitos pegados en un mismo párrafo (ej: "1) Servidor: ... 2) Máquina Cliente: ...")
  // Solo cuando tienen numeración explícita (1., 2., 1), etc.), nunca en prosa ordinaria con dos puntos
  texto = texto.replace(
    /(?:^|\n)\s*(?:\*\*)?(?:[1-9][.)]|\d+\.)(?:\*\*)?\s*([A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóú0-9_ -]{1,35}):\s*([\s\S]+?)(?=(?:\n\s*(?:\*\*)?(?:[1-9][.)]|\d+\.)(?:\*\*)?\s*[A-ZÁÉÍÓÚ]|\n\n|$))/g,
    (match, key, val) => {
      const k = key.trim();
      if (/^(https?|nota|definici[oó]n|ejemplo|resumen|c[oó]digo|tabla|figura)$/i.test(k)) {
        return match;
      }
      return `\n- **${k}:** ${val.trim()}`;
    }
  );

  // 5. Convertir Pasos Ordenados
  texto = texto.replace(/(?:^|\n)((?:^[ \t]*\d+\.\s+[^\n]+\r?\n?)+)/gm, (match, bloque) => {
    const items = bloque
      .trim()
      .split(/\r?\n/)
      .map(linea => linea.replace(/^[ \t]*\d+\.\s*/, "").trim())
      .filter(Boolean);
    if (items.length === 0) return match;
    return `\n\\pasos{\n  ${items.join(" |\n  ")}\n}\n`;
  });

  // 6. Convertir Listas con viñetas
  texto = texto.replace(/(?:^|\n)((?:^[ \t]*[*-]\s+[^\n]+\r?\n?)+)/gm, (match, bloque) => {
    const items = bloque
      .trim()
      .split(/\r?\n/)
      .map(linea => linea.replace(/^[ \t]*[*-]\s*/, "").replace(/\|\s*$/, "").trim())
      .filter(Boolean);
    if (items.length === 0) return match;
    return `\n\\lista{\n  ${items.join(" |\n  ")}\n}\n`;
  });

  // 7. Formato en línea
  texto = texto.replace(/`([^`\n]+)`/g, (_m, code) => `\\cmd{${code}}`);
  texto = texto.replace(/(?<!\\cmd\{)<(\/?[a-zA-Z0-9_-]+(?: [^>]*)?)>(?!\})/g, "\\cmd{<$1>}");

  // 8. Restaurar bloques verbatim protegidos
  for (let i = 0; i < verbatimBlocks.length; i++) {
    texto = texto.replace(`%%VERBATIM_BLOCK_${i}%%`, verbatimBlocks[i]);
  }

  // 8b. Restaurar macros LaTeX protegidas
  for (let i = 0; i < latexMacroBlocks.length; i++) {
    texto = texto.replace(`%%LATEX_MACRO_${i}%%`, latexMacroBlocks[i]);
  }

  // 9. Eliminar entornos y etiquetas no válidas que rompen LaTeX
  texto = texto
    .replace(/\\begin\{narrow\}(?:\[[^\]]*\]|\{[^{}]*\})*\s*/gi, "")
    .replace(/\\end\{narrow\}\s*/gi, "")
    .replace(/\\label\{[^{}]*\}\s*/gi, "");

  return texto.replace(/\n{3,}/g, "\n\n").trim();
}

export function aplicarEstilosLatex(value, subject = "") {
  // Se limpia siempre el documento completo (preámbulo, \begin{document},
  // \end{document}, \input de la biblioteca...) porque la IA a veces devuelve
  // un .tex entero en lugar del fragmento del apartado.
  let resultado = limpiarLatex(value);

  // Restos de documento o de portada que no deben acabar dentro de un apartado.
  resultado = resultado
    .replace(/\\maketitle\b/g, "")
    .replace(/\\tableofcontents\b/g, "")
    .replace(/\\(?:title|author|date)\s*\{[^{}]*\}/g, "")
    .replace(/\\t(?=[A-ZÁÉÍÓÚÑ])/g, "");

  // Canonicalizar comandos ingleses/incorrectos a las macros reales de WEC.
  // \section se convierte más abajo en \secciongrande (nivel de archivo);
  // no debe degradarse aquí a \seccion porque perdería la jerarquía.
  resultado = resultado
    .replace(/\\definitionpar\b/g, "\\definicionpar")
    .replace(/\\definition\b/g, "\\definicion")
    .replace(/\\sectiongrande\b/g, "\\secciongrande")
    .replace(/\\subtitulo\b/g, "\\subtituloA");

  // Arreglar saltos de línea literales escapados (\n como texto pero preservando comandos LaTeX que empiezan por \n)
  resultado = resultado.replace(/\\n(?!(?:ota|ode|abla|ewcommand|ewenvironment|ewlist|ewline|ormalsize|oindent|umber|egrita)\b)/g, "\n");

  // Arreglar pérdida de barra invertida por escape JSON (\b -> backspace o \b literal)
  resultado = resultado
    .replace(/\\+b\\begin/g, "\\begin")
    .replace(/[\x08]\s*egin/g, "\\begin")
    .replace(/(?:^|\s)egin\{secciongrande\}/g, "\\secciongrande")
    .replace(/(?:^|\s)egin\{seccion\}/g, "\\seccion")
    .replace(/(?:^|\s)egin\{/g, (m) => m.replace("egin{", "\\begin{"))
    .replace(/(?:^|\s)end\{/g, (m) => m.replace("end{", "\\end{"))
    .replace(/(?:[\x00-\x1f\s]|\b|\\)extbf\s*\{+/g, " \\textbf{")
    .replace(/(?:[\x00-\x1f\s]|\b|\\)extcolor\s*\{+/g, " \\textcolor{")
    .replace(/\\(textbf|textit|cmd|nota|definicion)\s*\{{2,}/g, "\\$1{")
    .replace(/(?:[\x00-\x1f\s]|\b)eginconsola/g, "\\begin{consola}")
    .replace(/(?:[\x00-\x1f\s]|\b)eginhtml/g, "\\begin{codigo}")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/^[><]{2,4}\s*/gm, "");

  // Reemplazar código artificial/inventado para campos del diseño web por la macro oficial \rectangulos
  resultado = resultado.replace(
    /(?:\\begin\{codigo\}|```[a-z]*)\s*[\s\S]*?(?:def\s+visual|def\s+tecnologia|def\s+distribucio)[\s\S]*?(?:\\end\{codigo\}|```)/gi,
    () => `\\rectangulos{
  {Visual}{Aspecto visual atractivo y comunicativo, centrado en la experiencia del usuario y su retención futura.}
  {Tecnología}{Decisiones sobre cómo implementar la página (estática o dinámica), lenguajes y bases de datos a emplear.}
  {Distribución}{Velocidad y fiabilidad para transmitir datos al cliente final sin interrupciones mediante protocolos eficientes.}
  {Propósito}{Objetivo fundamental del sitio web: modelo de negocio, comercio electrónico o difusión informativa.}
}`
  );

  // Limpiar marcas residuales de traducción o bloques huérfanos
  resultado = resultado
    .replace(/ZZBLOQUECODIGO\w*FINZZ/g, "")
    .replace(/%%PROTECTED_CODE_\w*%%/g, "")
    .replace(/\bClient-Servidor\b/gi, "Cliente-Servidor")
    .replace(/\bClient\s+Servidor\b/gi, "Cliente Servidor");

  // Arreglar comandos WEC erróneamente usados como entornos \begin{...} / \end{...}
  resultado = resultado
    .replace(/(?:\\begin|egin)\{secciongrande\}\{([^{}]*)\}/gi, "\\secciongrande{$1}")
    .replace(/(?:\\begin|egin)\{seccion\}\{([^{}]*)\}/gi, "\\seccion{$1}")
    .replace(/(?:\\begin|egin)\{subtitulo(?:A|B)?\}\{([^{}]*)\}/gi, "\\subtituloA{$1}")
    .replace(/(?:\\begin|egin)\{resumen\}\s*([\s\S]*?)\s*(?:\\end|end)\{resumen\}/gi, "\\resumen{$1}")
    .replace(/\\end\{secciongrande\}/gi, "")
    .replace(/\\end\{seccion\}/gi, "")
    .replace(/\\end\{subtitulo(?:A|B)?\}/gi, "");

  // Limpiar argumentos y llaves espurias tras \begin{consola} o \begin{codigo}
  resultado = resultado
    .replace(/\\begin\{consola\}(?:\}+)?(?:\[[^\]]*\]|\{[^}]*\})*/g, "\\begin{consola}")
    .replace(/\\begin\{codigo\}(?:\}+)?\[Lenguaje\](?:\{[^}]*\})*/g, "\\begin{codigo}")
    .replace(/\\begin\{codigo\}\}+/g, "\\begin{codigo}")
    .replace(/\\begin\{lista\}(?:\}+)?\{[^{}]*\}/g, "\\begin{itemize}")
    .replace(/\\end\{lista\}/g, "\\end{itemize}")
    .replace(/\\begin\{lista\}/gi, "")
    .replace(/\\end\{lista\}/gi, "")
    .replace(/(?:\\|\b)o(?:t|tr)a(?=\s*\{)/gi, "\\nota")
    .replace(/\\secciongrande\{\[object\s+Object\]\}\s*/gi, "")
    .replace(/\[object\s+Object\]/gi, "");

  // Desanidar \lista dentro de \lista para evitar error de anidamiento en TeX
  while (/\\lista\{[^{}]*\\lista\{/.test(resultado)) {
    resultado = resultado.replace(/\\lista\{([^{}]*)\\lista\{([^{}]*)\}([^{}]*)\}/gs, (_m, antes, dentro, despues) => {
      const parteAntes = antes.trim();
      const parteDentro = dentro.trim();
      const parteDespues = despues.trim();
      return `\\lista{\n  ${parteAntes ? parteAntes + " |\n  " : ""}${parteDentro}${parteDespues ? " |\n  " + parteDespues : ""}\n}`;
    });
  }

  // Corregir negritas sin abrir antes de dos puntos (ej: "Servidor:**" -> "**Servidor:**")
  resultado = resultado.replace(/(^|[\n|])\s*([A-Za-z0-9ÁÉÍÓÚáéíóúñÑ][^:\n|]{1,60}):\*\*/g, "$1**$2:**");

  // Eliminar párrafos vacíos (\par) dentro de macros cuyos argumentos usan \negrita no-long
  resultado = resultado
    .replace(/\\nota\{([^{}]*)\}\{([^{}]*)\}/gs, (_m, tit, cont) => `\\nota{${tit}}{${cont.replace(/\n\s*\n+/g, "\n")}}`)
    .replace(/\\definicion\{([^{}]*)\}\{([^{}]*)\}/gs, (_m, tit, cont) => `\\definicion{${tit}}{${cont.replace(/\n\s*\n+/g, "\n")}}`)
    .replace(/\\resumen\{([^{}]*)\}/gs, (_m, cont) => `\\resumen{${cont.replace(/\n\s*\n+/g, "\n")}}`);

  // Arreglar entornos incorrectos de definicion o subseccion inventados
  resultado = resultado
    .replace(/(?:\\begin|egin)\{definicion\}\{([^}]+)\}\{([^}]+)\}\s*\\end\{definicion\}/gi, "\\definicion{$1}{$2}")
    .replace(/\\subsecci[oó]n(?=[^a-zA-Z])/g, "\\subtituloA")
    .replace(/\\subsectionA(?=[^a-zA-Z])/g, "\\subtituloA")
    .replace(/\\subsectionB(?=[^a-zA-Z])/g, "\\subtituloB")
    // La IA a veces inventa \subsubsectionA/B en lugar de \subtituloA/B.
    .replace(/\\subsubsectionA(?=[^a-zA-Z])/g, "\\subtituloA")
    .replace(/\\subsubsectionB(?=[^a-zA-Z])/g, "\\subtituloB")
    .replace(/code\[\]\{([^{}]*)\}/g, "\\cmd{$1}")
    .replace(/\\textbf\{%\}/g, "\\textbf{\\%}")
    .replace(/\\textbf:([^:]*):/g, "\\textbf{$1}")
    .replace(/\\subt[ií]tuloA(?=[^a-zA-Z])/g, "\\subtituloA")
    .replace(/\\subt[ií]tuloB(?=[^a-zA-Z])/g, "\\subtituloB")
    .replace(/\\thetema(?=[^a-zA-Z])/g, "")
    .replace(/\\refstepcounter\{[^{}]*\}/g, "")
    .replace(/\\dotfill/g, "-")
    .replace(/\[label=[^\]]*\]\s*\|?/g, "")
    .replace(/\\(?:explicaci[oó]|expliqui|descriu|explica|discuteix|analitzi|mostra|defineix)(?=[^a-zA-Z])/g, "")
    .replace(/\\definicion(?:par)?\[[^\]]*\]\{([^}]+)\}\{([^}]+)\}/g, "\\definicionpar{$1}{$2}")
    .replace(/\\definicion(?:par)?\{([^}]+)\}\{([^}]+)\}\{([^}]+)\}/g, "\\definicionpar{$2}{$3}")
    .replace(/(\\(?:secciongrande|seccion|subtitulo|subtituloA|subtituloB)\{[^}]*\})\s*\\\\/g, "$1\n")
    .replace(/(?:^|\n)\s*\\\\\s*(?=\n|$)/g, "\n")
    .replace(/(?:^|\n)\s*\\\\/g, "\n");

  // Convertir entornos no válidos a macros oficiales de la biblioteca
  resultado = resultado
    .replace(/\\begin\{example\}\s*([\s\S]*?)\s*\\end\{example\}/gi, (_match, body) => `\\nota{Ejemplo}{\n${body.trim()}\n}`)
    .replace(/\\begin\{quoting\}\s*([\s\S]*?)\s*\\end\{quoting\}/gi, (_match, body) => `\\alertas{${body.trim()}}`)
    .replace(/\\begin\{narrow\}(?:\[[^\]]*\]|\{[^{}]*\})*\s*/gi, "")
    .replace(/\\end\{narrow\}\s*/gi, "")
    .replace(/\\label\{[^{}]*\}\s*/gi, "")
    .replace(/(?<!\\)\btextbf\{/g, "\\textbf{")
    .replace(/(?<!\\)\btextit\{/g, "\\textit{")
    .replace(/(?<!\\)\btexttt\{/g, "\\texttt{")
    .replace(/\\lstinline(?:\[[^\]]*\])?(?:\|([^|]*)\||\{([^}]*)\})/g, (_match, p1, p2) => `\\cmd{${p1 ?? p2 ?? ""}}`);

  // Quitar metalenguaje vacío del resumen ("En este apartado se explica...").
  resultado = resultado.replace(/\\resumen\{([^{}]*)\}/gs, (_match, cuerpo) => {
    const limpio = String(cuerpo)
      .replace(
        /(?:^|\s)(?:En|Este|El presente)\s+(?:este\s+)?apartado\s+(?:se\s+)?(?:explica|explican|describe|describen|analiza|analizan|introduce|introducen|presenta|presentan|aborda|abordan)[^.]*\./gi,
        " ",
      )
      .replace(
        /(?:^|\s)A\s+continuación\s+(?:veremos|se\s+muestra|se\s+explica)[^.]*\./gi,
        " ",
      )
      .replace(
        /(?:^|\s)Además,?\s+se\s+(?:proporciona|incluye|presenta)[^.]*\./gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
    return limpio ? `\\resumen{${limpio}}` : "";
  });

  // Asegurar que macros (definicion, nota, alertas, resumen) no envuelvan bloques verbatim
  resultado = resultado
    .replace(/(\\definicion(?:par)?\{[^{}]*\}\{[^{}]*?)(?=\\begin\{(?:codigo|consola)\})/gi, (m) => `${m.trimEnd()}\n}\n\n`)
    .replace(/(\\nota\{[^{}]*\}\{[^{}]*?)(?=\\begin\{(?:codigo|consola)\})/gi, (m) => `${m.trimEnd()}\n}\n\n`)
    .replace(/(\\alertas\{[^{}]*?)(?=\\begin\{(?:codigo|consola)\})/gi, (m) => `${m.trimEnd()}\n}\n\n`)
    .replace(/(\\resumen\{[^{}]*?)(?=\\begin\{(?:codigo|consola)\})/gi, (m) => `${m.trimEnd()}\n}\n\n`)
    .replace(/(\\end\{(?:codigo|consola)\}\s*)\}/g, "$1")
    .replace(/\\resumen\{\s*\}/g, "");

  // Extraer listas, definiciones y macros que hayan quedado atrapadas dentro de \resumen
  resultado = extraerMacrosDeResumen(resultado);

  // Auto-estructurar texto plano o desestructurado ("texto soso") en macros visuales WEC
  resultado = estructurarTextoPlano(resultado);

  // Limpiar barras de tubería espurias al final de líneas normales.
  // Nunca dentro de \lista{...}: ahí el pipe es el separador oficial de ítems.

  resultado = convertirTablasWec(resultado);
  resultado = convertirListasWec(resultado);
  resultado = normalizarListasWec(resultado);
  resultado = convertirCodigoWec(resultado);

  // \item sueltos fuera de un entorno de lista provocan
  // "Lonely \item--perhaps a missing list environment" y detienen la compilación.
  resultado = resultado.replace(/\\item(?:\s+|\[[^\]]*\])/g, "\n");

  resultado = resultado
    .replace(/\\secciongrande\{Concepto principal[^{}]*\}/gi, (_match) =>
      subject ? `\\secciongrande{${subject}}` : "\\secciongrande{Tema}",
    )
    .replace(/\\definicion(?:par)?\{Término\}\{[^}]*\}\s*/gi, "")
    .replace(/\\definicion(?:par)?\{Opción [ABC]\}\{[^}]*\}\s*/gi, "")
    .replace(/\\resumen\{Define (?:la idea central|en 2 o 3 líneas)[^}]*\}\s*/gi, "")
    .replace(/\\nota\{Para el examen\}\{[^}]*known_hosts[^}]*\}\s*/gi, (match) =>
      /ssh|known_hosts/i.test(subject) ? match : "",
    )
    .replace(
      /(\\rectangulos\{(?:\s*\{[^{}]*\}\s*\{[^{}]*\})+\s*)(?=\\seccion(?:grande)?\{)/g,
      "$1}\n\n",
    );

  // Convertir encabezados Markdown accidentales a macros WEC
  resultado = resultado
    .replace(/^####\s+(.+)$/gm, "\\subtituloB{$1}")
    .replace(/^###\s+(.+)$/gm, "\\subtituloA{$1}")
    .replace(/^##\s+(.+)$/gm, "\\seccion{$1}")
    .replace(/^#\s+(.+)$/gm, "\\secciongrande{$1}");

  // Arreglar llamadas incorrectas a \tarjeta con nombres de color
  resultado = resultado.replace(/\\tarjeta\{([^}]+)\}\{([^}]+)\}\{([^}]+)\}/g, (_m, t1, t2, t3) => {
    return `\\definicion{${t2.trim()}}{${t3.trim()}}`;
  });

  resultado = resultado
    .replace(
      /\\sectiongrande(?=\s*\{)/g,
      "\\secciongrande",
    )
    .replace(
      /\\section\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g,
      (_match, title) =>
        `\\secciongrande{${quitarAsignaturaDelTitulo(title, subject)}}`,
    )
    .replace(
      /\\subsection\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g,
      (_match, title) =>
        `\\subtituloA{${quitarAsignaturaDelTitulo(title, subject)}}`,
    )
    .replace(
      /\\subsubsection\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g,
      (_match, title) =>
        `\\subtituloA{${quitarAsignaturaDelTitulo(title, subject)}}`,
    )
    .replace(
      /\\(secciongrande|seccion|subtitulo|subtituloA|subtituloB)\{([^{}]*)\}/g,
      (_match, macro, title) => {
        let m = macro;
        if (m === "seccion" && /subt[ií]tulo/i.test(title)) {
          m = "subtituloA";
        }
        let clean = quitarAsignaturaDelTitulo(title, subject)
          .replace(/^(?:subt[ií]tulo(?:\s+[a-z0-9]+)?|secci[oó]n(?:\s+[a-z0-9]+)?|apartado(?:\s+[a-z0-9]+)?|t[ií]tulo)\s*[:.\-–—]\s*/i, "")
          .replace(/<(\/?[a-zA-Z0-9_-]+(?: [^>]*)?)>/g, "\\cmd{<$1>}")
          .replace(/</g, "\\textless ")
          .replace(/>/g, "\\textgreater ")
          .trim();
        clean = normalizarMayusculasTitulo(clean);
        if (clean.length > 0) {
          clean = clean.charAt(0).toUpperCase() + clean.slice(1);
        }
        return `\\${m}{${clean}}`;
      },
    );

  // Un solo \secciongrande por apartado; los subsiguientes en el mismo archivo se degradan a \subtituloA
  let secciongrandeEncontrada = false;
  resultado = resultado.replace(/\\secciongrande\{([^{}]+)\}/g, (match, title) => {
    if (!secciongrandeEncontrada) {
      secciongrandeEncontrada = true;
      return match;
    }
    return `\\subtituloA{${title}}`;
  });

  // Eliminar subtítulos duplicados consecutivos con el mismo nombre
  resultado = resultado.replace(/(\\(?:secciongrande|subtituloA|subtituloB)\{([^{}]+)\})\s*\n+\s*\\(?:secciongrande|subtituloA|subtituloB)\{\2\}/g, "$1");

  // \seccion dibuja barras de color y añade una subsección al índice. Los
  // subtítulos internos del contenido generado deben ser normales.
  resultado = resultado.replace(
    /\\seccion(?!grande)(?:\[[^\]]*\])?\{([^{}]*)\}/g,
    (_match, titulo) =>
      `\\subtituloA{${quitarAsignaturaDelTitulo(titulo, subject).trim()}}`,
  );

  // La IA inventa subtítulos de relleno que no aportan nada ("Elementos
  // principales", "Componentes principales"...). Se eliminan y el contenido
  // pasa a colgar directamente del encabezado anterior.
  resultado = resultado.replace(
    /\\subtitulo([AB])\{\s*([^{}]*?)\s*\}/g,
    (match, _nivel, titulo) => (esSubtituloGenerico(titulo) ? "" : match),
  );

  // Espacio adecuado después de títulos: quitar \vspace negativos y asegurar separación vertical natural
  resultado = resultado
    .replace(/\\vspace\*?\{-[^}]*\}\s*/gi, "\n\n")
    .replace(/(\\(?:secciongrande|seccion|subtituloA|subtituloB|titulo)\{[^}]*\})\s*(?:\\vspace\*?\{-[^}]*\}\s*)?/gi, "$1\n\n");

  resultado = resultado.replace(/\n{3,}/g, "\n\n");

  // Separar ítems pegados dentro de \lista{...} si no contienen |
  resultado = resultado.replace(/\\lista\{([^{}]+)\}/g, (match, cuerpo) => {
    if (!cuerpo.includes("|")) {
      let limpio = cuerpo.replace(/^(?:Entre\s+(?:ellas|ellos)\s+se\s+encuentran|Estos\s+componentes\s+incluyen|Se\s+encarga\s+de)\s*[:.\-–—\s]+/i, "").trim();
      const items = [];
      const regex = /(?:^|\n|(?<=[.:;]\s+))(?:[1-9]\.?\s*)?([A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóú0-9_ \-()\/\+]{1,45}):\s*([\s\S]+?)(?=(?:(?:\.|\;|\n)\s*(?:[1-9]\.?\s*)?[A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóú0-9_ \-()\/\+]{1,45}:\s+)|\n\n|$)/g;
      let mCoincidencia;
      while ((mCoincidencia = regex.exec(limpio)) !== null) {
        const k = mCoincidencia[1].trim();
        if (!/^(https?|nota|definici[oó]n|ejemplo|resumen|c[oó]digo|tabla|figura)$/i.test(k)) {
          items.push(`**${k}:** ${mCoincidencia[2].trim()}`);
        }
      }
      if (items.length > 1) {
        return `\\lista{\n  ${items.join(" |\n  ")}\n}`;
      }
      const lineas = limpio.split(/\r?\n/).map(l => l.replace(/^[ \t]*[-*]\s*/, "").trim()).filter(Boolean);
      if (lineas.length > 1) {
        return `\\lista{\n  ${lineas.join(" |\n  ")}\n}`;
      }
      const negritas = [...limpio.matchAll(/\*\*([^*]+)\*\*(?::?\s*([^*]*?))(?=\*\*[^*]+\*\*|$)/g)];
      if (negritas.length > 1) {
        return `\\lista{\n  ${negritas.map(m => `**${m[1].trim()}:** ${m[2].trim()}`.replace(/:\*\*\s*:?/, ":**")).join(" |\n  ")}\n}`;
      }
    }
    return match;
  });

  // Limpiar comas huérfanas entre macros y entornos LaTeX generadas por formateos erróneos de la IA
  resultado = resultado
    .replace(/\},\s*\\/g, "}\n\n\\")
    .replace(/,\s*\\(seccion(?:grande)?|subtitulo[AB]?|resumen|definicion(?:par)?|nota|lista)\b/g, "\n\n\\$1")
    .replace(/\\(subtitulo[AB]?)\{\s*[•·\-*]\s*/g, "\\$1{")
    .replace(/\\end\{codigo\}\s*,\s*/g, "\\end{codigo}\n\n")
    .replace(/\\begin\{codigo\}(\[[^\]]*\])?\s*,\s*/g, "\\begin{codigo}$1\n")
    .replace(/\\lista\{\s*,\s*/g, "\\lista{\n  ")
    .replace(/\s*,\s*\\nota/g, "\n\n\\nota");

  // Reparar saltos de fila que falten en tablas (evitar Extra alignment tab has been changed to \cr y Misplaced \noalign \bottomrule)
  resultado = resultado.replace(/(\\tabla(?:\[[^\]]*\])?\s*\{[\s\S]*?\})/g, (tablaMatch) => {
    let arreglada = tablaMatch.replace(/^([^\n&%]*&[^\n%]*?)(?<!\\\\)\s*$/gm, "$1 \\\\");
    arreglada = arreglada.replace(/([^\\ \t\r\n%])\s*(\}\s*)$/, "$1 \\\\\n$2");
    return arreglada;
  });

  // Limpiar \subnota y caracteres de tabulación espurios \t
  resultado = resultado
    .replace(/\\subnota\{/g, "\\nota{")
    .replace(/(?:^|\s)\\t(?!(?:ext|abla|itulo|ikz|iny|rue)\w*)(?=[A-Za-zÁÉÍÓÚáéíóú¿¡])/g, " ")
    .replace(/\\t(?=\s*[\}\]])/g, "");

  // En un mismo archivo o subtema solo debe haber UNA única \secciongrande con su \resumen al principio.
  // Cualquier \secciongrande secundaria se convierte en \subtituloA sin añadir otra sección grande.
  let primeraSeccionGrandeEncontrada = false;
  resultado = resultado.replace(/\\secciongrande\*?(?:\[[^\]]*\])?\{([^}]+)\}/g, (match, titulo) => {
    if (!primeraSeccionGrandeEncontrada) {
      primeraSeccionGrandeEncontrada = true;
      return match;
    }
    return `\\subtituloA{${titulo}}`;
  });

  let primerResumenEncontrado = false;
  resultado = resultado.replace(/\\resumen\*?(?:\[[^\]]*\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (match, cuerpo) => {
    if (!primerResumenEncontrado) {
      primerResumenEncontrado = true;
      return match;
    }
    return `\n\n${cuerpo.trim()}\n\n`;
  });

  // Limpiar reglas de tabla (midrule) huérfanas dentro de listas y viñetas.
  // El saneamiento con llaves equilibradas se hace en normalizarListasWec.

  // Proteger guiones bajos no escapados en texto normal para evitar que LaTeX entre en math mode
  const partesVerbatim = [];
  resultado = resultado.replace(/(\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\}|\\cmd\{[^}]*\})/g, (m) => {
    const placeholder = `@@@VERBATIM${partesVerbatim.length}@@@`;
    partesVerbatim.push(m);
    return placeholder;
  });
  resultado = resultado.replace(/(?<!\\)_/g, "\\_");
  resultado = resultado.replace(/@@@VERBATIM(\d+)@@@/g, (_, i) => partesVerbatim[Number(i)]);

  // Proteger & no escapados fuera de tablas y código para evitar "Misplaced alignment tab character &"
  const partesTablasYVerbatim = [];
  resultado = resultado.replace(
    /(\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\}|\\tabla\[[\s\S]*?\}\s*\}|\\begin\{(?:tabular|table)\}[\s\S]*?\\end\{(?:tabular|table)\}|\\cmd\{[^}]*\})/g,
    (m) => {
      const ph = `@@@TABVERBATIM${partesTablasYVerbatim.length}@@@`;
      partesTablasYVerbatim.push(m);
      return ph;
    }
  );
  resultado = resultado.replace(/(?<!\\)&/g, "\\&");
  resultado = resultado.replace(/@@@TABVERBATIM(\d+)@@@/g, (_, i) => partesTablasYVerbatim[Number(i)]);

  // Corregir acumulación espuria de llaves de cierre
  resultado = resultado.replace(/\}{4,}/g, "}\n}");

  // Deduplicar bloques de código o consola idénticos consecutivos
  resultado = resultado.replace(/(\\begin\{codigo\}[\s\S]*?\\end\{codigo\})(?:\s*\1)+/g, "$1");
  resultado = resultado.replace(/(\\begin\{consola\}[\s\S]*?\\end\{consola\})(?:\s*\1)+/g, "$1");
  resultado = resultado.replace(/(\\end\{codigo\}\s*){2,}/g, "\\end{codigo}\n");

  // Deduplicar párrafos idénticos repetidos (la IA a veces vuelve a pegar el
  // mismo bloque con otro encabezado). Los bloques de código se protegen para
  // no alterar su contenido interno.
  const bloquesVerbatim = [];
  const conMarcadores = resultado.replace(
    /(\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\})/g,
    (match) => {
      const marcador = `@@@DEDUP_VERBATIM_${bloquesVerbatim.length}@@@`;
      bloquesVerbatim.push(match);
      return marcador;
    },
  );
  const parrafosVistos = new Set();
  resultado = conMarcadores
    .split(/\n{2,}/)
    .filter((parrafo) => {
      const clave = parrafo.trim();
      if (clave.length < 80) return true;
      if (parrafosVistos.has(clave)) return false;
      parrafosVistos.add(clave);
      return true;
    })
    .join("\n\n")
    .replace(/@@@DEDUP_VERBATIM_(\d+)@@@/g, (_match, indice) => bloquesVerbatim[Number(indice)]);

  // Limpiar listas anidadas redundantes y corregir cierres de negrita sin apertura (ej: Servidor:** -> **Servidor:**)
  resultado = resultado
    .replace(/\\lista\{\s*(?:\*\*[^*]+\*\*:?[^\n]*\s*)?\\lista\{/g, "\\lista{")
    .replace(/(?:^|\n)\s*([A-ZÁÉÍÓÚ][a-zA-ZÁÉÍÓÚáéíóú0-9_ \-()\/]+):\*\*/g, "\n  **$1:**");

  // Traducir y corregir fragmentos residuales en catalán a español
  resultado = corregirCatalanAEspanol(resultado);

  // Asegurar que entornos de código y consola estén estrictamente en su propia línea
  resultado = resultado
    .replace(/,\s*\\begin\{codigo\}/g, "\n\n\\begin{codigo}")
    .replace(/,\s*\\end\{codigo\}/g, "\n\\end{codigo}\n\n")
    .replace(/,\s*\\begin\{consola\}/g, "\n\n\\begin{consola}")
    .replace(/,\s*\\end\{consola\}/g, "\n\\end{consola}\n\n")
    .replace(/([^\n])\s*\\begin\{codigo\}(\[[^\]]*\])?/g, "$1\n\n\\begin{codigo}$2")
    .replace(/([^\n])\s*\\begin\{consola\}/g, "$1\n\n\\begin{consola}")
    .replace(/([^\n])\s*\\end\{codigo\}/g, "$1\n\\end{codigo}\n\n")
    .replace(/([^\n])\s*\\end\{consola\}/g, "$1\n\\end{consola}\n\n");

  // Asegurar que entornos de código y consola estén perfectamente balanceados secuencialmente sin anidamiento ni huérfanos
  function balancearEntornoVerbatim(texto, nombreEntorno) {
    const beginRegex = new RegExp(`\\\\begin\\{${nombreEntorno}\\}(\\[[^\\]]*\\])?`, "g");
    const endRegex = new RegExp(`\\\\end\\{${nombreEntorno}\\}`, "g");
    const tokens = [];
    let m;
    while ((m = beginRegex.exec(texto)) !== null) {
      tokens.push({ type: "begin", index: m.index, length: m[0].length, full: m[0] });
    }
    while ((m = endRegex.exec(texto)) !== null) {
      tokens.push({ type: "end", index: m.index, length: m[0].length, full: m[0] });
    }
    tokens.sort((a, b) => a.index - b.index);

    if (tokens.length === 0) return texto;

    let abierto = false;
    let resultadoFinal = "";
    let lastIndex = 0;

    for (const token of tokens) {
      resultadoFinal += texto.slice(lastIndex, token.index);
      lastIndex = token.index + token.length;

      if (token.type === "begin") {
        if (abierto) {
          // Si ya había un bloque abierto, cerramos el anterior antes de iniciar el nuevo
          resultadoFinal += `\\end{${nombreEntorno}}\n\n${token.full}`;
        } else {
          resultadoFinal += token.full;
          abierto = true;
        }
      } else if (token.type === "end") {
        if (abierto) {
          resultadoFinal += token.full;
          abierto = false;
        } else {
          // Descartar \end huérfano que no tiene ningún \begin abierto
        }
      }
    }

    resultadoFinal += texto.slice(lastIndex);
    if (abierto) {
      resultadoFinal += `\n\\end{${nombreEntorno}}\n`;
    }
    return resultadoFinal;
  }

  resultado = balancearEntornoVerbatim(resultado, "codigo");
  resultado = balancearEntornoVerbatim(resultado, "consola");

  // Eliminar TikZ no validado: el preámbulo de los apuntes no carga pgf/tikz,
  // así que cualquier dibujo de este tipo impide compilar. Se conserva su
  // descripción (\caption) como texto para no perder información.
  resultado = resultado
    .replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/gi, "")
    .replace(/\\begin\{(?:table|figure)\}(?:\[[^\]]*\])?/gi, "")
    .replace(/\\end\{(?:table|figure)\}/gi, "")
    .replace(/\\centering\b/g, "")
    .replace(
      /\\caption\*?(?:\[[^\]]*\])?\{([^{}]*)\}/gi,
      (_match, descripcion) => `\n\\textit{${descripcion.trim()}}\n`,
    )
    .replace(/\\begin\{align\*?\}/gi, "")
    .replace(/\\end\{align\*?\}/gi, "");

  // Reparar argumentos de una sola línea que quedaron sin cerrar, p. ej.
  // \cmd{</head>:** ... (la IA perdió la llave y \cmd se tragaba el resto).
  resultado = resultado
    .replace(/\\cmd\{([^}\n]*?)(?=:\*\*)/g, "\\cmd{$1}")
    .replace(/\\cmd\{([^}\n]*)$/gm, "\\cmd{$1}");

  // Asegurar balance de llaves (ignorando entornos verbatim como codigo y consola)
  resultado = balancearLlavesLatex(resultado);

  return resultado;
}

function balancearLlavesLatex(texto) {
  const partes = [];
  const verbatimRegex = /(\\begin\{(?:codigo|consola)\}(?:\[[^\]]*\])?[\s\S]*?\\end\{(?:codigo|consola)\})/gi;
  let ultimoIndice = 0;
  let coincidencia;
  let resultadoFinal = "";

  while ((coincidencia = verbatimRegex.exec(texto)) !== null) {
    const antes = texto.slice(ultimoIndice, coincidencia.index);
    partes.push({ tipo: "latex", contenido: antes });
    partes.push({ tipo: "verbatim", contenido: coincidencia[0] });
    ultimoIndice = verbatimRegex.lastIndex;
  }
  partes.push({ tipo: "latex", contenido: texto.slice(ultimoIndice) });

  let abiertas = 0;
  for (const parte of partes) {
    if (parte.tipo === "verbatim") {
      resultadoFinal += parte.contenido;
      continue;
    }
    let limpio = "";
    for (let i = 0; i < parte.contenido.length; i++) {
      const char = parte.contenido[i];
      const prev = i > 0 ? parte.contenido[i - 1] : "";
      if (char === "{" && prev !== "\\") {
        abiertas++;
        limpio += char;
      } else if (char === "}" && prev !== "\\") {
        if (abiertas > 0) {
          abiertas--;
          limpio += char;
        }
      } else {
        limpio += char;
      }
    }
    resultadoFinal += limpio;
  }

  if (abiertas > 0) {
    resultadoFinal += "}".repeat(abiertas);
  }
  return resultadoFinal;
}

export function corregirCatalanAEspanol(texto = "") {
  if (!texto) return "";
  return texto
    .replace(/\bCol[·.]legi\s+Sant\s+Josep\s+Obrer(?:\s*·\s*\d+)?\b/gi, "")
    .replace(/\b2n\s+DAW\b/gi, "")
    .replace(/\[CONTEXTO\s+GENERAL[^\]]*\]/gi, "")
    .replace(/\[CONTENIDO\s+COMPLETO[^\]]*\]/gi, "");
}

/**
 * Extrae macros que nunca deben ir dentro de \resumen{...}
 * (\lista, \pasos, \definicion, \definicionpar, \subtituloA, \subtituloB, \nota, \alertas, etc.)
 * y las coloca fuera como bloques independientes a continuación del resumen.
 */
function extraerMacrosDeResumen(contenido) {
  let salida = "";
  let posicion = 0;
  while (posicion < contenido.length) {
    const inicio = contenido.indexOf("\\resumen{", posicion);
    if (inicio === -1) {
      salida += contenido.slice(posicion);
      break;
    }
    salida += contenido.slice(posicion, inicio);
    const apertura = inicio + "\\resumen".length;
    let fin = apertura;
    let profundidad = 0;
    for (; fin < contenido.length; fin++) {
      const c = contenido[fin];
      if (c === "\\") {
        fin++;
        continue;
      }
      if (c === "{") profundidad++;
      else if (c === "}") {
        profundidad--;
        if (profundidad === 0) break;
      }
    }
    if (fin >= contenido.length) {
      salida += contenido.slice(inicio);
      break;
    }
    const cuerpo = contenido.slice(apertura + 1, fin);
    const macrosExtraidas = [];

    function extraerMacro(nombreMacro, numArgs = 1) {
      let pos = 0;
      let resultado = "";
      const patron = `\\${nombreMacro}{`;
      while (pos < cuerpoRestante.length) {
        const idx = cuerpoRestante.indexOf(patron, pos);
        if (idx === -1) {
          resultado += cuerpoRestante.slice(pos);
          break;
        }
        resultado += cuerpoRestante.slice(pos, idx);
        let cur = idx + patron.length - 1;
        let bloqueCompleto = `\\${nombreMacro}`;
        let valido = true;
        for (let arg = 0; arg < numArgs; arg++) {
          if (cuerpoRestante[cur] !== "{") {
            valido = false;
            break;
          }
          let f = cur;
          let prof = 0;
          for (; f < cuerpoRestante.length; f++) {
            const ch = cuerpoRestante[f];
            if (ch === "\\") { f++; continue; }
            if (ch === "{") prof++;
            else if (ch === "}") {
              prof--;
              if (prof === 0) break;
            }
          }
          if (f >= cuerpoRestante.length) {
            valido = false;
            break;
          }
          bloqueCompleto += cuerpoRestante.slice(cur, f + 1);
          cur = f + 1;
          while (cur < cuerpoRestante.length && /\s/.test(cuerpoRestante[cur])) cur++;
        }
        if (valido) {
          macrosExtraidas.push(bloqueCompleto.trim());
          pos = cur;
        } else {
          resultado += cuerpoRestante.slice(idx, idx + patron.length);
          pos = idx + patron.length;
        }
      }
      cuerpoRestante = resultado;
    }

    let cuerpoRestante = cuerpo;
    extraerMacro("definicionpar", 2);
    extraerMacro("definicion", 2);
    extraerMacro("nota", 2);
    extraerMacro("alertas", 1);
    extraerMacro("lista", 1);
    extraerMacro("pasos", 1);
    extraerMacro("subtituloA", 1);
    extraerMacro("subtituloB", 1);
    extraerMacro("rectangulos", 1);

    const resumenLimpio = cuerpoRestante.replace(/\r?\n\s*\r?\n+/g, " ").replace(/\s+/g, " ").trim();
    if (resumenLimpio) {
      salida += `\\resumen{\n  ${resumenLimpio}\n}\n\n`;
    }
    if (macrosExtraidas.length > 0) {
      salida += macrosExtraidas.join("\n\n") + "\n\n";
    }
    posicion = fin + 1;
  }
  return salida;
}

/**
 * Detecta párrafos planos o desestructurados que la IA entrega sin macros ("texto soso")
 * y los estructura en macros visuales WEC (\definicion, \nota, \alertas).
 */
function estructurarTextoPlano(texto) {
  const bloques = [];
  let protegido = texto.replace(/(\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\})/g, (m) => {
    // Si es un bloque de código vacío o simulado que solo dice "No hay código..."
    if (/\\begin\{codigo\}\s*(?:\/\/|#|<!--)?\s*No hay c[oó]digo[^\n]*\s*\\end\{codigo\}/i.test(m)) {
      return "";
    }
    const token = `@@@ESTRUC_VERBATIM_${bloques.length}@@@`;
    bloques.push(m);
    return token;
  });

  // 1. Definiciones en texto plano: "**Definición de X:** ..." o "Definición de X: ..."
  protegido = protegido.replace(/(?:^|\n)\s*(?:\*\*(?:Definici[oó]n(?:\s+de)?|Concepto):\s*([^*\n]+)\*\*|Definici[oó]n(?:\s+de\s+|\s*:\s*)([A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóú0-9_ -]{1,40}):?)\s*([^\n]+(?:\n[^\n\\]+)*)/gi, (_m, t1, t2, desc) => {
    const termino = (t1 || t2).trim();
    return `\n\n\\definicion{${termino}}{${desc.trim()}}\n\n`;
  });

  // 2. Avisos de examen sueltos en texto plano
  protegido = protegido.replace(/(?:^|\n)\s*(?:\*\*(?:Para el examen|Ojo para el examen|Examen):\*\*|(?:Para el examen|Ojo para el examen|Examen):)\s*([^\n]+(?:\n[^\n\\]+)*)/gi, (_m, desc) => {
    return `\n\n\\nota{Para el examen}{${desc.trim()}}\n\n`;
  });

  // 3. Alertas o advertencias sueltas en texto plano
  protegido = protegido.replace(/(?:^|\n)\s*(?:\*\*(?:Alerta|Advertencia|Importante|Seguridad):\*\*|(?:Alerta|Advertencia|Importante|Seguridad):)\s*([^\n]+(?:\n[^\n\\]+)*)/gi, (_m, desc) => {
    return `\n\n\\alertas{${desc.trim()}}\n\n`;
  });

  // 4. Dividir «textacos» densos y largos en párrafos cortos y digeribles (de 2 a 3 oraciones)
  const parrafos = protegido.split(/\n\s*\n/);
  const parrafosDivididos = [];
  for (const p of parrafos) {
    const trimP = p.trim();
    // No tocar macros de LaTeX, comentarios ni bloques verbatim
    if (trimP.startsWith("\\") || trimP.startsWith("%") || trimP.startsWith("@@@ESTRUC_VERBATIM") || trimP.length < 350) {
      parrafosDivididos.push(p);
      continue;
    }
    // Si contiene una enumeración tipo 1. ... 2. ... 3. ... convertirla a \lista
    const itemsNumerados = [...trimP.matchAll(/(?:^|\s)(?:[1-9]\.|\([1-9]\))\s*([A-ZÁÉÍÓÚ][^.\n]+[.!?])/g)];
    if (itemsNumerados.length >= 2) {
      const itemsLista = itemsNumerados.map(m => m[1].trim());
      parrafosDivididos.push(`\\lista{\n  ${itemsLista.join(" |\n  ")}\n}`);
      continue;
    }

    // Dividir textaco largo por oraciones terminadas en punto
    const oraciones = trimP.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
    if (oraciones && oraciones.length >= 3) {
      let acumulado = "";
      let oracionesLote = [];
      for (const o of oraciones) {
        acumulado += o;
        oracionesLote.push(o.trim());
        if (acumulado.length >= 200 && oracionesLote.length >= 2) {
          parrafosDivididos.push(oracionesLote.join(" "));
          acumulado = "";
          oracionesLote = [];
        }
      }
      if (oracionesLote.length > 0) {
        parrafosDivididos.push(oracionesLote.join(" "));
      }
    } else {
      parrafosDivididos.push(p);
    }
  }
  protegido = parrafosDivididos.join("\n\n");

  return protegido.replace(/@@@ESTRUC_VERBATIM_(\d+)@@@/g, (_m, i) => bloques[Number(i)]);
}

/**
 * Recorre las macros \lista{...} y \pasos{...} respetando llaves anidadas (por ejemplo
 * \cmd{<head>} o \textbf{...}) y garantiza que los ítems estén separados por |,
 * sin números sueltos con salto de línea ni divisiones espurias por \par.
 */
function normalizarListasWec(value) {
  // Los bloques de código pueden contener \lista o \pasos como texto literal: no se tocan.
  const bloques = [];
  const protegido = value.replace(
    /(\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\})/g,
    (_match, bloque) => {
      const marca = `@@@LISTA_CODIGO_${bloques.length}@@@`;
      bloques.push(bloque);
      return marca;
    },
  );
  let normalizado = normalizarEntornoListaOPasos(protegido, "lista");
  normalizado = normalizarEntornoListaOPasos(normalizado, "pasos");
  return normalizado.replace(
    /@@@LISTA_CODIGO_(\d+)@@@/g,
    (_match, indice) => bloques[Number(indice)],
  );
}

function normalizarEntornoListaOPasos(value, macroNombre) {
  const patron = `\\${macroNombre}{`;
  let salida = "";
  let posicion = 0;
  while (posicion < value.length) {
    const inicio = value.indexOf(patron, posicion);
    if (inicio === -1) {
      salida += value.slice(posicion);
      break;
    }
    salida += value.slice(posicion, inicio);
    const apertura = inicio + patron.length - 1;
    let fin = apertura;
    let profundidad = 0;
    for (; fin < value.length; fin++) {
      const caracter = value[fin];
      if (caracter === "\\") {
        fin++;
        continue;
      }
      if (caracter === "{") profundidad++;
      else if (caracter === "}") {
        profundidad--;
        if (profundidad === 0) break;
      }
    }
    if (fin >= value.length) {
      salida += value.slice(inicio);
      break;
    }
    const cuerpo = value.slice(apertura + 1, fin);
    salida += `\\${macroNombre}{${normalizarCuerpoLista(cuerpo, macroNombre)}}`;
    posicion = fin + 1;
  }
  return salida;
}

function dividirPorPipe(cuerpo) {
  const partes = [];
  let actual = "";
  let profundidad = 0;
  for (let i = 0; i < cuerpo.length; i++) {
    const caracter = cuerpo[i];
    if (caracter === "\\") {
      actual += caracter;
      if (i + 1 < cuerpo.length) actual += cuerpo[++i];
      continue;
    }
    if (caracter === "{") profundidad++;
    else if (caracter === "}") profundidad--;
    if (caracter === "|" && profundidad === 0) {
      partes.push(actual);
      actual = "";
      continue;
    }
    actual += caracter;
  }
  partes.push(actual);
  return partes;
}

const INICIO_ITEM = /^(?:\*\*[^*\n]+\*\*|\\textbf\{|[-*]\s+|\d+[.)]\s+)/;

function normalizarCuerpoLista(cuerpoOriginal, tipo = "lista") {
  let cuerpo = cuerpoOriginal
    .replace(/\\(?:midrule|toprule|bottomrule)\b/g, "")
    .replace(/(?:^|\n|\s)\*([a-zA-ZÁÉÍÓÚáéíóú0-9_ -]+:\*\*)/g, "\n  **$1");

  // Reemplazar saltos de línea forzados (\\ o \newline) tras números o viñetas al inicio
  cuerpo = cuerpo.replace(/(^|[|\n])\s*(\d+[.)]?|[-*•])\s*(?:\\\\|\s*\\newline)\s*/g, "$1$2 ");

  // Si una línea consiste solo de un número (ej. "1." o "1") o viñeta, unirla inmediatamente con la siguiente línea
  cuerpo = cuerpo.replace(/(^|[|\n])\s*(\d+[.)]?|[-*•])\s*\r?\n+\s*/g, "$1$2 ");

  // Quitar líneas en blanco internas (\par) para que \itemsnuevos no divida items
  cuerpo = cuerpo.replace(/\r?\n\s*\r?\n+/g, "\n  ");

  // En pasos: quitar la numeración manual redundante ("1.", "**1:**", "Paso 1:", "**Paso 1:**", etc.)
  // ya que la macro \pasos numera automáticamente con círculos del 1 al N
  if (tipo === "pasos") {
    cuerpo = cuerpo.replace(/(^|[|\n])\s*(?:\*{0,2}(?:Paso\s+)?\d+[\.:\)\-–—]?\*{0,2}\s*)+/gi, "$1 ");
  }

  const items = [];
  for (const segmento of dividirPorPipe(cuerpo)) {
    const limpio = segmento.trim();
    if (!limpio) continue;
    const lineas = limpio
      .split(/\r?\n/)
      .map((linea) => linea.trim())
      .filter(Boolean);
    const lineasQueInicianItem = lineas.filter((linea) => INICIO_ITEM.test(linea));
    if (lineas.length > 1 && lineasQueInicianItem.length > 1) {
      let actual = "";
      for (const linea of lineas) {
        if (INICIO_ITEM.test(linea) && actual) {
          items.push(actual);
          actual = linea.replace(/^[-*]\s+/, "");
        } else {
          const trozo = linea.replace(/^[-*]\s+/, "");
          actual = actual ? `${actual} ${trozo}` : trozo;
        }
      }
      if (actual) items.push(actual);
      continue;
    }
    const partes = limpio.split(/(?<=[.;:])\s+(?=\*\*[^*\n]+\*\*)/);
    if (partes.length > 1) {
      items.push(...partes.map((parte) => parte.trim()).filter(Boolean));
    } else {
      items.push(limpio.replace(/\s+/g, " "));
    }
  }

  // Post-procesado final de cada item
  const itemsLimpios = [];
  for (let item of items) {
    item = item.trim().replace(/\s+/g, " ");
    if (tipo === "pasos") {
      item = item.replace(/^(?:\*{0,2}(?:Paso\s+)?\d+[\.:\)\-–—]?\*{0,2}\s*)+/i, "").trim();
    }
    // Si en lista quedó un número solo (ej: "1" o "1.") como item completo, descartarlo
    if (/^\d+[.)]?$/.test(item)) continue;

    // Quitar saltos de línea forzados residuales al principio o final del item
    item = item.replace(/^(?:\\\\|\s*\\newline)+\s*/, "").replace(/(?:\\\\|\s*\\newline)+\s*$/, "");
    if (item) itemsLimpios.push(item);
  }

  if (itemsLimpios.length === 0) return cuerpoOriginal;
  return `\n  ${itemsLimpios.join(" |\n  ")}\n`;
}

function convertirListasWec(value) {
  return value
    .replace(
      /\\begin\{(?:itemize|enumerate)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{(?:itemize|enumerate)\}/gi,
      (_match, body) => {
        const items = body
          .split(/\\item(?:\s+|\[[^\]]*\])/)
          .map((item) => item.trim())
          .filter(Boolean);
        if (!items.length) return "";
        return `\\lista{\n  ${items.join(" |\n  ")}\n}`;
      },
    )
    .replace(
      /\\begin\{description\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{description\}/gi,
      (_match, body) => {
        const entradas = [
          ...body.matchAll(/\\item\[([^\]]+)\]([\s\S]*?)(?=\\item\[|$)/g),
        ];
        if (!entradas.length) return _match;
        return entradas
          .map(
            ([, termino, desc]) =>
              `\\definicionpar{${termino.trim()}}{${desc.trim()}}`,
          )
          .join("\n\n");
      },
    )
    .replace(/\\begin\{(?:itemize|enumerate)\}(?:\[[^\]]*\])?/gi, "")
    .replace(/\\end\{(?:itemize|enumerate)\}/gi, "")
    .replace(/\[<[+-]*>\]/g, "");
}

function convertirCodigoWec(value) {
  return value
    .replace(/([^\n])\s*\\end\{(codigo|consola)\}/g, "$1\n\\end{$2}")
    .replace(
      /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g,
      (_match, lang, code) => {
        const etiqueta = lang ? `[${lang}]` : "";
        return `\\begin{codigo}${etiqueta}\n${code.trimEnd()}\n\\end{codigo}`;
      },
    )
    .replace(
      /\\begin\{lstlisting\}(?:\[(?:language=)?([a-zA-Z0-9_-]+)\])?([\s\S]*?)\\end\{lstlisting\}/gi,
      (_match, lang, code) => {
        const etiqueta = lang ? `[${lang}]` : "";
        return `\\begin{codigo}${etiqueta}\n${code.trimEnd()}\n\\end{codigo}`;
      },
    )
    .replace(
      /\\begin\{verbatim\}([\s\S]*?)\\end\{verbatim\}/gi,
      (_match, code) => `\\begin{consola}\n${code.trimEnd()}\n\\end{consola}`,
    )
    .replace(
      /\\begin\{consola\}(?:\[[^\]]*\]|\{[^}]*\})+/g,
      "\\begin{consola}",
    );
}

function convertirTablasWec(value) {
  return value.replace(
    /(?:\\begin\{table\}(?:\[[^\]]*\])?\s*(?:\\centering\s*)?)?\\begin\{tabular\}\{([^}]*)\}([\s\S]*?)\\end\{tabular\}(?:\s*\\caption\{[^{}]*\}\s*)?(?:\\end\{table\})?/gi,
    (_match, columns, body) => {
      const filas = body
        .replace(/\\hline/g, "")
        .split(/\\\\\s*/)
        .map((fila) => fila.trim())
        .filter(Boolean);
      if (filas.length < 2) return _match;
      const cabecera = filas.shift();
      const encabezado = cabecera
        .replace(/\\textbf\{([^{}]*)\}/g, "$1")
        .trim();
      const filasWec = filas.map((fila) => fila.trim()).join("\n");
      const anchos = columns
        .replace(/[|]/g, "")
        .split("")
        .map((tipo) => (tipo === "c" || tipo === "l" || tipo === "r" ? "L{5.2cm}" : "L{5.2cm}"))
        .join("");
      const encabezadosWec = encabezado
        .split(/\s*&\s*/)
        .map((celda) => `\\tablacab{${celda.replace(/[{}]/g, "")}}`)
        .join(" & ");
      return `\\tabla[${anchos}]{\n${encabezadosWec} \\\\\n\\midrule\n${filasWec}\n}`;
    },
  );
}

function asegurarSeccionPrincipal(latex, titulo) {
  if (/\\secciongrande\s*\{/.test(latex)) return latex;
  let enc = titulo;
  if (typeof enc === "object" && enc !== null) {
    enc = enc.titulo || enc.title || enc.texto || enc.nombre || "";
  }
  const encabezado = String(enc ?? "").trim() || "Apuntes";
  if (/^\[object\s+Object\]$/i.test(encabezado)) {
    return latex;
  }
  return `\\secciongrande{${encabezado}}\n\n${latex}`;
}

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
      // Solo usar el resumen global si es extenso y no hay otra opción,
      // y solo para el primer bloque (evita crear archivos duplicados con mismo resumen)
      if (index === 0) contenidoBruto = payload.resumen;
    }

    // Descartar bloques vacíos o fantasmas sin desarrollo técnico real (evita bug de cientos de archivos Apartado X)
    const textoVerificacion = String(contenidoBruto ?? "").trim();
    if (!textoVerificacion || /^(?:apartado|seccion)\s*\d+$/i.test(textoVerificacion)) {
      return [];
    }
    // Descartar bloques sin ninguna macro útil que sean solo el nombre o texto trivial (menos de 60 caracteres y sin comandos LaTeX)
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

function obtenerListaTexto(value, maxItems, maxLength) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((item) => ["string", "number"].includes(typeof item))
    .map((item) => String(item).slice(0, maxLength))
    .slice(0, maxItems);
}

async function asegurarEstructuraAsignatura(subjectDir) {
  await mkdir(subjectDir, { recursive: true });
  const preamblePath = path.join(subjectDir, "preambulo.tex");
  await asegurarCargaLatex(subjectDir);
  const preambuloWec = String.raw`% =====================================================================
%  PREAMBULO.TEX - estilos completos WEC de bibliotecas_latex
% =====================================================================
\spanishdeactivate{<>}
\AtBeginDocument{\spanishdeactivate{<>}}
\newcommand{\subt}[1]{\par\Needspace{4\baselineskip}\vspace{2mm}\noindent{\bfseries\color{primary}#1}\par\vspace{1mm}}
\newcommand{\cmd}[1]{\texttt{\detokenize{#1}}}
\definecolor{codeForeground}{HTML}{243247}
\definecolor{codeString}{HTML}{8A4B08}
\definecolor{codeComment}{HTML}{58745C}
\definecolor{consoleBackground}{HTML}{F1F4F8}
\definecolor{codeBackgroundA}{HTML}{F1F7FF}
\definecolor{codeBackgroundB}{HTML}{EFF9F5}
\definecolor{codeBackgroundC}{HTML}{F7F2FC}
\definecolor{codeBackgroundD}{HTML}{FFF7ED}
\definecolor{codeBackgroundE}{HTML}{F0F8FA}
\definecolor{codeBackgroundF}{HTML}{FFF3F5}
\definecolor{codeKeywordA}{HTML}{2457A6}
\definecolor{codeKeywordB}{HTML}{19704F}
\definecolor{codeKeywordC}{HTML}{7046A3}
\definecolor{codeKeywordD}{HTML}{A45B12}
\definecolor{codeKeywordE}{HTML}{117184}
\definecolor{codeKeywordF}{HTML}{A63F5B}
\def\codeCurrentBackground{codeBackgroundA}
\def\codeCurrentKeyword{codeKeywordA}
\newcounter{codePaletteIndex}
\newcommand{\nextCodePalette}{%
  \stepcounter{codePaletteIndex}%
  \ifnum\value{codePaletteIndex}>6\setcounter{codePaletteIndex}{1}\fi
  \ifcase\value{codePaletteIndex}\or
    \gdef\codeCurrentBackground{codeBackgroundA}\gdef\codeCurrentKeyword{codeKeywordA}\or
    \gdef\codeCurrentBackground{codeBackgroundB}\gdef\codeCurrentKeyword{codeKeywordB}\or
    \gdef\codeCurrentBackground{codeBackgroundC}\gdef\codeCurrentKeyword{codeKeywordC}\or
    \gdef\codeCurrentBackground{codeBackgroundD}\gdef\codeCurrentKeyword{codeKeywordD}\or
    \gdef\codeCurrentBackground{codeBackgroundE}\gdef\codeCurrentKeyword{codeKeywordE}\or
    \gdef\codeCurrentBackground{codeBackgroundF}\gdef\codeCurrentKeyword{codeKeywordF}%
  \fi}
\AddToHook{cmd/secciongrande/after}{\nextCodePalette}
\AddToHook{cmd/seccion/after}{\nextCodePalette}
\AddToHook{cmd/subtitulo/after}{\nextCodePalette}
\AddToHook{cmd/subtituloA/after}{\nextCodePalette}
\AddToHook{cmd/subtituloB/after}{\nextCodePalette}
\ifcsname codigo\endcsname\else
\newtcblisting{codigo}{listing only, breakable, colback=\codeCurrentBackground, colframe=primary!28!white,
  boxrule=0pt, arc=3pt, left=6pt, right=6pt, top=4pt, bottom=4pt,
  listing options={language=Java, basicstyle=\ttfamily\footnotesize\color{codeForeground},
    keywordstyle=\color{\codeCurrentKeyword}\bfseries,
    morekeywords={const,let,var,of,async,await,undefined,null,true,false,console,document,window,localStorage,fetch,Promise,script,html,head,body,noscript,div,span,p,ul,li,input,form,button,type,src,id,class},
    stringstyle=\color{codeString}, commentstyle=\color{codeComment}\itshape,
    showstringspaces=false, breaklines=true, columns=fullflexible, keepspaces=true, upquote=true}}
\fi
\ifcsname consola\endcsname\else
\newtcblisting{consola}{listing only, breakable, colback=consoleBackground, colframe=primary!22!white,
  boxrule=0pt, arc=3pt, left=6pt, right=6pt, top=4pt, bottom=4pt,
  listing options={basicstyle=\ttfamily\footnotesize\color{codeForeground}, breaklines=true,
    columns=fullflexible, keepspaces=true, upquote=true}}
\fi
\newcolumntype{L}[1]{>{\raggedright\arraybackslash}p{#1}}
`;
  if (!(await existeArchivo(preamblePath))) {
    await writeFile(preamblePath, preambuloWec, "utf8");
  } else {
    const anterior = await readFile(preamblePath, "utf8");
    if (!anterior.includes("newtcblisting{codigo}")) {
      await writeFile(preamblePath, preambuloWec, "utf8");
    }
  }
}

async function asegurarEstructuraTema(themeDir) {
  await mkdir(themeDir, { recursive: true });
  await asegurarCargaLatex(themeDir);
  await asegurarEstilosGenerador(themeDir);
}

async function asegurarEstilosGenerador(themeDir) {
  const file = path.join(themeDir, "generador-estilos.tex");
  const estilos = String.raw`% Generador de apuntes: integración con la biblioteca oficial WEC.
% La paleta y las macros visuales (titulo, secciongrande, seccion,
% subtituloA/B, resumen, lista, pasos, definicion, nota, tabla...) proceden
% de bibliotecas_latex/cabecera.tex. Aquí se sincronizan los colores
% del resaltado de código y el índice automático clicable con hyperref.
\providecommand{\cmd}[1]{\texttt{\detokenize{#1}}}
\providecommand{\subnota}[2]{\nota{#1}{#2}}
\providecommand{\subnotasin}[2]{\nota{#1}{#2}}
\AtBeginDocument{\spanishdeactivate{<>}}
\providecommand{\subt}[1]{\par\Needspace{4\baselineskip}\vspace{2mm}\noindent{\bfseries\color{primary}#1}\par\vspace{1mm}}
\providecolor{codeForeground}{HTML}{243247}
\providecolor{codeString}{HTML}{8A4B08}
\providecolor{codeComment}{HTML}{58745C}
\providecolor{codeBackground}{HTML}{F1F7FF}
\providecolor{codeKeyword}{HTML}{2457A6}
\providecolor{consoleBackground}{HTML}{F1F4F8}
\newcommand{\actualizarColoresCodigo}{%
  \colorlet{codeBackground}{\coloractual!7!white}%
  \colorlet{codeKeyword}{\coloractual!80!black}%
}
\newcommand{\iniciarPaletaSecciones}{\pickcolor{\coloractual}}
\AddToHook{cmd/titulo/after}{\iniciarPaletaSecciones\actualizarColoresCodigo}
\AddToHook{cmd/secciongrande/after}{\actualizarColoresCodigo}

% --- ÍNDICE AUTOMÁTICO CLICABLE CON HYPERREF ---
% Se envuelven \secciongrande (sección) y \seccion (subsección) usando
% \RenewDocumentCommand para mantener compatibilidad total con los hooks
% de LaTeX y con hyperref sin romper la sintaxis ni duplicar entradas en el índice.
\makeatletter
\let\orig@secciongrande\secciongrande
\RenewDocumentCommand{\secciongrande}{o m}{%
  \phantomsection
  \IfValueTF{#1}{\orig@secciongrande[#1]{#2}}{\orig@secciongrande[]{#2}}%
}
\let\orig@seccion\seccion
\RenewDocumentCommand{\seccion}{o m}{%
  \phantomsection
  \IfValueTF{#1}{\orig@seccion[#1]{#2}}{\orig@seccion[]{#2}}%
}
\makeatother

\lstdefinelanguage{JavaScript}{
  sensitive=true,
  morekeywords={const,let,var,of,async,await,undefined,null,true,false,function,return,if,else,for,while,switch,case,break,continue,new,class,extends,import,export,default,try,catch,throw},
  morecomment=[l]{//},
  morecomment=[s]{/*}{*/},
  morestring=[b]",
  morestring=[b]'
}
\ifcsname codigo\endcsname\else
\newtcblisting{codigo}[1][Java]{listing only,breakable,colback=codeBackground,colframe=\coloractual!28!white,boxrule=0pt,arc=3pt,left=6pt,right=6pt,top=4pt,bottom=4pt,listing options={language=#1,basicstyle=\ttfamily\footnotesize\color{codeForeground},keywordstyle=\color{codeKeyword}\bfseries,morekeywords={const,let,var,of,async,await,undefined,null,true,false,console,document,window,localStorage,fetch,Promise,script,html,head,body,noscript,div,span,p,ul,li,input,form,button,type,src,id,class},stringstyle=\color{codeString},commentstyle=\color{codeComment}\itshape,showstringspaces=false,breaklines=true,columns=fullflexible,keepspaces=true,tabsize=4,upquote=true}}
\fi
\ifcsname consola\endcsname\else
\newtcblisting{consola}{listing only,breakable,colback=consoleBackground,colframe=primary!22!white,boxrule=0pt,arc=3pt,left=6pt,right=6pt,top=4pt,bottom=4pt,listing options={basicstyle=\ttfamily\footnotesize\color{codeForeground},breaklines=true,columns=fullflexible,keepspaces=true,upquote=true}}
\fi
`;

  if (await existeArchivo(file)) {
    const anterior = await readFile(file, "utf8");
    const estiloWecActualConIndice =
      anterior.startsWith(
        "% Generador de apuntes: integración con la biblioteca oficial WEC.\n",
      ) &&
      anterior.includes("RenewDocumentCommand{\\secciongrande}") &&
      anterior.includes("RenewDocumentCommand{\\seccion}") &&
      anterior.includes("\\orig@secciongrande[]{#2}") &&
      anterior.includes("AddToHook{cmd/secciongrande/after}") &&
      !anterior.includes("\\addcontentsline{toc}{section}{#2}");
    if (estiloWecActualConIndice) return;
  }
  await writeFile(file, estilos, "utf8");
}

async function asegurarCargaLatex(directory) {
  const loadPath = path.join(directory, "carga.tex");
  const libraryPath =
    path.relative(directory, config.latexLibrary).split(path.sep).join("/") ||
    ".";
  const legacyPath = String.raw`\def\apuntesrutalib{/data/bibliotecas_latex}`;
  const replacement = String.raw`\def\apuntesrutalib{${libraryPath}}`;
  let content;
  try {
    content = await readFile(loadPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    content = "";
  }
  if (!content) {
    content = String.raw`\def\apuntesrutalib{${libraryPath}}
\IfFileExists{\apuntesrutalib/cabecera.tex}{%
  \def\bibliotecasDir{\apuntesrutalib}%
  \input{\apuntesrutalib/cabecera}%
}{%
  \PackageError{apuntes}{No encuentro bibliotecas_latex}{Comprueba la ruta de la biblioteca de LaTeX configurada en el Generador.}%
}
`;
    await writeFile(loadPath, content, "utf8");
  } else if (content.includes(legacyPath)) {
    await writeFile(loadPath, content.replace(legacyPath, replacement), "utf8");
  }
}

async function asegurarDocumentoTema(themeDir, subject, theme, title) {
  const target = path.join(themeDir, `tema${theme}.tex`);
  const styleInput = "\\input{generador-estilos.tex}";
  const children = (await readdir(themeDir, { withFileTypes: true }))
    .filter(
      (item) =>
        item.isDirectory() &&
        new RegExp(`^Tema ${theme}\\.\\d+$`, "i").test(item.name),
    );

  if (!(await existeArchivo(target))) {
    const sortedChildren = children.sort(
      (a, b) =>
        Number(a.name.split(".").at(-1)) - Number(b.name.split(".").at(-1)),
    );
    const inputLines = sortedChildren.map((item) => `\\inputcarpeta{${item.name}}`);
    const bookmark = crearNombreArchivo(`${subject}-tema${theme}`, 80);
    const content = [
      "\\documentclass[11pt,a4paper]{extarticle}",
      "\\input{carga.tex}",
      "\\usepackage[hidelinks]{hyperref}",
      "\\IfFileExists{../preambulo.tex}{\\input{../preambulo.tex}}{\\input{preambulo.tex}}",
      styleInput,
      "\\begin{document}",
      "\\paletaAzul",
      `\\titulo{TEMA ${theme}}{${escaparLatex(title)}}`,
      "\\usarfondo",
      "\\renewcommand{\\contentsname}{Índice}",
      "\\setcounter{tocdepth}{2}",
      `\\pdfbookmark[0]{Índice}{${bookmark}}`,
      "{\\color{black}\\tableofcontents}",
      "\\clearpage",
      ...inputLines,
      "\\end{document}",
      "",
    ].join("\n");
    await writeFile(target, content, "utf8");
    return { path: target, created: true };
  }
  {
    const original = await readFile(target, "utf8");
    const beginDocument = original.indexOf("\\begin{document}");
    const endDocument = original.indexOf("\\end{document}");
    if (beginDocument < 0 || (endDocument >= 0 && endDocument < beginDocument))
      throw new Error(`El documento ${target} no tiene una estructura LaTeX válida.`);
    const preamble = original.slice(0, beginDocument);
    const body = original.slice(
      beginDocument + "\\begin{document}".length,
      endDocument < 0 ? original.length : endDocument,
    );

    // Conservar todas las carpetas que ya estaban en el documento para nunca perder apartados
    const carpetasEnDoc = [
      ...original.matchAll(/\\inputcarpeta\{([^}]+)\}/g),
    ].map((m) => m[1]);

    const carpetasEnDisco = children.map((item) => item.name);
    const todasLasCarpetas = Array.from(
      new Set([...carpetasEnDoc, ...carpetasEnDisco]),
    ).sort((a, b) => {
      const numA = Number(a.split(".").at(-1)) || 0;
      const numB = Number(b.split(".").at(-1)) || 0;
      return numA - numB;
    });

    const inputLines = todasLasCarpetas.map((c) => `\\inputcarpeta{${c}}`);

    const preambleLines = preamble
      .split("\n")
      .filter(
        (line) =>
          line.trim() !== styleInput &&
          !/^\\inputcarpeta\{[^{}]+\}$/.test(line.trim()),
      );
    const normalizedBody = body
      .split("\n")
      .filter(
        (line) =>
          line.trim() !== styleInput &&
          !/^\\inputcarpeta\{[^{}]+\}$/.test(line.trim()),
      )
      .join("\n")
      .replace(
        /(?:\{\s*)*\\color\{black\}\s*\\tableofcontents(?:\s*\})*|\\tableofcontents/,
        "{\\color{black}\\tableofcontents}",
      );
    const bodyConIndice = normalizedBody.includes("\\setcounter{tocdepth}{2}")
      ? normalizedBody
      : normalizedBody.replace(
          "{\\color{black}\\tableofcontents}",
          "\\setcounter{tocdepth}{2}\n{\\color{black}\\tableofcontents}",
        );
    // El nombre de la carpeta del tema no debe aparecer en el PDF.
    const bodySinCarpeta = bodyConIndice.replace(
      /\\titulo\{[^{}]*·\s*TEMA\s*\d+\}\{([^{}]*)\}/,
      `\\titulo{TEMA ${theme}}{$1}`,
    );
    const bodyLines = bodySinCarpeta.split("\n");
    const clearPageIndex = bodyLines.findIndex((line) =>
      line.includes("\\clearpage"),
    );
    const insertionIndex =
      clearPageIndex >= 0
        ? clearPageIndex + 1
        : bodyLines.findIndex((line) => line.trim()) + 1;
    bodyLines.splice(insertionIndex, 0, ...inputLines);
    const updatedPreamble = `${preambleLines.join("\n").trimEnd()}\n${styleInput}\n`;
    const updated = `${updatedPreamble}\\begin{document}${bodyLines.join("\n")}${
      endDocument < 0 ? "" : `\\end{document}${original.slice(endDocument + "\\end{document}".length)}`
    }`;
    if (updated !== original) {
      await writeFile(target, updated, "utf8");
    }
  }
  return { path: target, created: false };
}

const ACRONYMS_SET = new Set([
  "HTML", "CSS", "JS", "DOM", "XML", "URL", "HTTP", "HTTPS", "API", "SQL",
  "V8", "JIT", "WEC", "DAW", "PHP", "SSL", "TLS", "TCP", "IP", "JSON"
]);
const MINOR_WORDS_SET = new Set([
  "de", "del", "la", "el", "los", "las", "en", "un", "una", "unos", "unas",
  "por", "para", "con", "y", "o", "al", "a", "vs"
]);

export function normalizarMayusculasTitulo(titulo = "") {
  if (!titulo || typeof titulo !== "string") return titulo;
  const t = titulo.trim();
  const soloLetras = t.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "");
  if (soloLetras.length >= 4 && soloLetras === soloLetras.toUpperCase()) {
    const palabras = t.toLowerCase().split(/\s+/);
    return palabras
      .map((p, idx) => {
        const limpia = p.replace(/[^a-záéíóúñ0-9]/gi, "").toUpperCase();
        if (ACRONYMS_SET.has(limpia)) return p.toUpperCase();
        if (limpia === "JAVASCRIPT") return "JavaScript";
        if (limpia === "NODEJS" || limpia === "NODE.JS") return "Node.js";
        if (idx > 0 && MINOR_WORDS_SET.has(p)) return p;
        return p.charAt(0).toUpperCase() + p.slice(1);
      })
      .join(" ");
  }
  return t;
}

export function detectarCatalan(texto = "") {
  if (!texto || typeof texto !== "string" || !texto.trim()) return false;
  const patron = /(?:^|[^a-zà-ÿ])(?:client-servidor|client(?:\s+servidor)?|l['’](?:origen|abast|execuci[oó]|usuari|entorn)|d['’](?:execuci[oó]|un|una|aquest|aquesta)|eines|llenguatges|execuci[oó]|entorn|entorns|desenvolupament|cercador|fitxers?|dades|sol[·.]licituds?|aquest|aquesta|aquests|aquestes|tamb[eé]|aix[oò]|dels|deles|amb|sense|per[oò]|s[oó]n|mitjan[cç]ant|interf[ií]cie|renderitzat|comunicacions|navigador)(?![a-zà-ÿ])/iu;
  return patron.test(texto);
}

function escaparLatex(value) {
  return String(value).replace(/[#$%&_]/g, "\\$&");
}

async function existeArchivo(file) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
