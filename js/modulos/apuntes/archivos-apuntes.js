import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../configuracion.js";
import {
  componenteSeguro,
  convertirLatexATextoPlano,
  titlePattern,
} from "./utilidades-nombres.js";
import { IndiceConceptos } from "./indice-conceptos.js";
import { obtenerInformeGeneracion } from "./informes.js";

export async function recorrerCarpeta(directory) {
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

export async function primerTituloLatex(archivo) {
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
