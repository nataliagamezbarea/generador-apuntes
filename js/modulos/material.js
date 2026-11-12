import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import yauzl from "yauzl";
import {
  extensionesCodigo,
  config,
  obtenerExtension,
  extensionesImagen,
  extensionesAdmitidas,
  extensionesTexto,
} from "./configuracion.js";

const execFile = promisify(execFileCallback);
const skippedDirectories = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);
const skippedBundledLibraries = new Set(["three.module.js", "orbitcontrols.js"]);
const maxSingleFileBytes = config.maxUploadBytes;
const minPdfImageWidth = 64;
const minPdfImageHeight = 48;
const minPdfImagePixels = 8_000;
// Rectángulos de un solo color (fondos de bloques de código, sombras...) ocupan
// unos 0,01 bytes/píxel como PNG; una imagen con contenido, 0,03 o más.
const minBytesPorPixelImagenPdf = 0.015;

export async function extraerMateriales(
  files,
  { signal, onProgress = () => {} } = {},
) {
  const documents = [];
  const warnings = [];
  const visuals = [];
  let imagesOcr = 0;
  for (const [indice, file] of files.entries()) {
    comprobarCancelacion(signal);
    const name = limpiarRutaRelativa(file.originalname);
    if (!esArchivoLegible(name)) continue;
    onProgress({
      archivo: indice + 1,
      archivos: files.length,
      nombre: name,
    });
    try {
      if (obtenerExtension(name) === ".zip") {
        const extracted = await extraerArchivoZip(
          name,
          file.buffer,
          config.maxVisualPages - visuals.length,
          signal,
          (pagina, total) =>
            onProgress({
              archivo: indice + 1,
              archivos: files.length,
              nombre: name,
              pagina,
              paginas: total,
            }),
        );
        documents.push(...extracted.documents);
        warnings.push(...extracted.warnings);
        visuals.push(...extracted.visuals);
        imagesOcr += extracted.imagesOcr;
      } else {
        const extracted = await extraerArchivo(
          name,
          file.buffer,
          config.maxVisualPages - visuals.length,
          signal,
          (pagina, total) =>
            onProgress({
              archivo: indice + 1,
              archivos: files.length,
              nombre: name,
              pagina,
              paginas: total,
            }),
        );
        if (extracted.document) documents.push(extracted.document);
        warnings.push(...(extracted.warnings ?? []));
        visuals.push(...(extracted.visuals ?? []));
        imagesOcr += extracted.imagesOcr ?? 0;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      warnings.push(`${name}: ${error.message}`);
    }
  }
  return {
    documents: documents.filter((item) => item.text.trim()),
    warnings,
    imagesOcr,
    visuals,
  };
}

export function textoMaterial(material) {
  return material.documents
    .map((document) => {
      let header = `--- ${document.kind.toUpperCase()}: ${document.name}`;
      if (document.language) header += ` (${document.language})`;
      return `${header} ---\n${document.text.trim()}`;
    })
    .join("\n\n");
}

export async function textoPdf(
  name,
  data,
  maxVisualPages = config.maxVisualPages,
  signal,
  onPageProgress = () => {},
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "generador-pdf-"));
  const pdfPath = path.join(tempDir, "input.pdf");
  const warnings = [];
  try {
    await writeFile(pdfPath, data);
    const info = await execFile("pdfinfo", [pdfPath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      signal,
    });
    const pageCount = Number.parseInt(
      info.stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? "0",
      10,
    );
    if (!pageCount) throw new Error("el PDF no contiene páginas legibles.");
    const pageLimit = Math.min(pageCount, config.maxPdfPages);
    if (pageCount > pageLimit)
      warnings.push(
        `${name}: se leen ${pageLimit} de ${pageCount} páginas (MAX_PDF_PAGES).`,
      );
    const textResult = await execFile(
      "pdftotext",
      [
        "-layout",
        "-enc",
        "UTF-8",
        "-f",
        "1",
        "-l",
        String(pageLimit),
        pdfPath,
        "-",
      ],
      {
        timeout: 120_000,
        maxBuffer: 30 * 1024 * 1024,
        encoding: "utf8",
        signal,
      },
    );
    const pages = textResult.stdout.split("\f").slice(0, pageLimit);
    const imagenesPorPagina = await obtenerImagenesPorPagina(
      pdfPath,
      warnings,
      name,
      signal,
    );
    const visuals = [];
    const huellasVistas = new Set();
    let ocrCount = 0;
    for (let index = 0; index < pages.length; index += 1) {
      comprobarCancelacion(signal);
      onPageProgress(index + 1, pages.length);
      const imagenesPagina = imagenesPorPagina.get(index + 1) ?? [];
      if (!imagenesPagina.some(esImagenPdfRelevante)) continue;
      try {
        const prefix = path.join(tempDir, `page-${index + 1}-image`);
        await execFile(
          "pdfimages",
          [
            "-png",
            "-f",
            String(index + 1),
            "-l",
            String(index + 1),
            pdfPath,
            prefix,
          ],
          { timeout: 90_000, maxBuffer: 1024 * 1024, signal },
        );
        const prefixName = path.basename(prefix);
        const imageFiles = (await readdir(tempDir))
          .filter(
            (filename) =>
              filename.startsWith(`${prefixName}-`) &&
              [".png", ".jpg", ".jpeg"].includes(path.extname(filename).toLowerCase()),
          )
          .sort(
            (left, right) =>
              Number(left.match(/-(\d+)\./)?.[1] ?? 0) -
              Number(right.match(/-(\d+)\./)?.[1] ?? 0),
          );
        if (!imageFiles.length) {
          warnings.push(
            `${name}: se detectaron imágenes en la página ${index + 1}, pero Poppler no pudo extraerlas en un formato compatible.`,
          );
          continue;
        }

        const textosOcr = [];
        let imagenRealIndex = 0;
        for (const [imageIndex, filename] of imageFiles.entries()) {
          const metadatos = imagenesPagina[imageIndex];
          if (!metadatos || !esImagenPdfRelevante(metadatos)) continue;
          comprobarCancelacion(signal);
          const imagePath = path.join(tempDir, filename);
          const imageData = await readFile(imagePath);
          // Sin información visual: imagen plana o idéntica a otra ya enviada.
          if (
            imageData.length / (metadatos.ancho * metadatos.alto) <
            minBytesPorPixelImagenPdf
          )
            continue;
          const huella = createHash("sha1").update(imageData).digest("hex");
          if (huellasVistas.has(huella)) continue;
          huellasVistas.add(huella);
          imagenRealIndex += 1;
          visuals.push({
            name: `${name} · página ${index + 1} · imagen ${imagenRealIndex}`,
            data: imageData.toString("base64"),
          });
          if (pages[index].trim().length >= 80 || ocrCount >= config.maxOcrPages) continue;

          const result = await execFile(
            "tesseract",
            [imagePath, "stdout", "-l", "spa+eng"],
            {
              timeout: 90_000,
              maxBuffer: 2 * 1024 * 1024,
              encoding: "utf8",
              signal,
            },
          );
          if (result.stdout.trim())
            textosOcr.push(
              `[TEXTO OCR DE IMAGEN ${imageIndex + 1} EN PÁGINA ${index + 1}]\n${result.stdout.trim()}`,
            );
        }
        if (textosOcr.length) {
          pages[index] = `${pages[index].trim()}${pages[index].trim() ? "\n\n" : ""}${textosOcr.join("\n\n")}`;
          ocrCount += 1;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        warnings.push(
          `${name}: no se pudo aplicar OCR a la página ${index + 1} (${error.message}).`,
        );
      }
    }
    return {
      text: pages.join("\n\n").trim(),
      imagesOcr: ocrCount,
      warnings,
      visuals,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function extraerArchivo(
  name,
  data,
  maxVisualPages = config.maxVisualPages,
  signal,
  onPageProgress,
) {
  const ext = obtenerExtension(name);
  if (data.length > maxSingleFileBytes)
    return {
      warnings: [`${name}: supera el tamaño máximo por archivo y se omite.`],
    };
  if (ext === ".pdf") {
    const result = await textoPdf(
      name,
      data,
      maxVisualPages,
      signal,
      onPageProgress,
    );
    return {
      document: { name, kind: "pdf", text: result.text },
      warnings: result.warnings,
      imagesOcr: result.imagesOcr,
      visuals: result.visuals,
    };
  }
  if (extensionesCodigo.has(ext)) {
    return {
      document: {
        name,
        kind: "code",
        language: extensionesCodigo.get(ext),
        text: decodificarTexto(data),
      },
    };
  }
  if (extensionesTexto.has(ext)) {
    return {
      document: {
        name,
        kind: "text",
        text: decodificarTexto(data),
      },
    };
  }
  if (extensionesImagen.has(ext)) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "generador-image-"));
    const imagePath = path.join(tempDir, `input${ext}`);
    try {
      await writeFile(imagePath, data);
      const result = await execFile(
        "tesseract",
        [imagePath, "stdout", "-l", "spa+eng"],
        {
          timeout: 90_000,
          maxBuffer: 2 * 1024 * 1024,
          encoding: "utf8",
          signal,
        },
      );
      if (!result.stdout.trim())
        return {
          warnings: [`${name}: no se detectó texto legible en la imagen.`],
        };
      return {
        document: {
          name,
          kind: "image",
          text: result.stdout,
        },
        imagesOcr: 1,
        visuals:
          [".jpg", ".jpeg", ".png"].includes(ext) && maxVisualPages > 0
            ? [{ name, data: data.toString("base64") }]
            : [],
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  return { warnings: [`${name}: formato no compatible; se omite.`] };
}

async function extraerArchivoZip(
  name,
  data,
  maxVisualPages,
  signal,
  onPageProgress,
) {
  if (data.length > maxSingleFileBytes) {
    return {
      documents: [],
      warnings: [`${name}: ZIP supera el tamaño máximo por archivo.`],
      imagesOcr: 0,
      visuals: [],
    };
  }
  const entries = await leerEntradasZip(data);
  const documents = [];
  const warnings = [];
  const visuals = [];
  let totalUncompressed = 0;
  let imagesOcr = 0;
  for (const entry of entries) {
    comprobarCancelacion(signal);
    if (!esArchivoLegible(entry.fileName)) continue;
    if (entry.uncompressedSize > maxSingleFileBytes) {
      warnings.push(
        `${name}/${entry.fileName}: supera el tamaño máximo por archivo y se omite.`,
      );
      continue;
    }
    if (totalUncompressed + entry.uncompressedSize > config.maxZipBytes) {
      warnings.push(
        `${name}: se alcanza el límite de ${config.maxZipBytes / 1024 / 1024} MB descomprimidos.`,
      );
      break;
    }
    totalUncompressed += entry.uncompressedSize;
    try {
      const extracted = await extraerArchivo(
        `${name}/${limpiarRutaRelativa(entry.fileName)}`,
        entry.data,
        maxVisualPages - visuals.length,
        signal,
        onPageProgress,
      );
      if (extracted.document) documents.push(extracted.document);
      warnings.push(...(extracted.warnings ?? []));
      visuals.push(...(extracted.visuals ?? []));
      imagesOcr += extracted.imagesOcr ?? 0;
    } catch (error) {
      if (signal?.aborted) throw error;
      warnings.push(`${name}/${entry.fileName}: ${error.message}`);
    }
  }
  return { documents, warnings, imagesOcr, visuals };
}

function leerEntradasZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true },
      (openError, zip) => {
        if (openError)
          return reject(
            new Error(`no es un ZIP válido (${openError.message}).`),
          );
        const entries = [];
        let totalEntries = 0;
        let totalBytes = 0;
        zip.on("error", reject);
        zip.on("end", () => resolve(entries));
        zip.on("entry", (entry) => {
          totalEntries += 1;
          if (totalEntries > config.maxUploadFiles) {
            zip.close();
            reject(
              new Error(
                `supera el límite de ${config.maxUploadFiles} archivos internos.`,
              ),
            );
            return;
          }
          if (entry.fileName.endsWith("/") || !esArchivoLegible(entry.fileName)) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return reject(streamError);
            const chunks = [];
            let bytes = 0;
            stream.on("data", (chunk) => {
              bytes += chunk.length;
              totalBytes += chunk.length;
              if (
                bytes > maxSingleFileBytes ||
                totalBytes > config.maxZipBytes
              ) {
                stream.destroy(
                  new Error(
                    "el ZIP supera el límite por archivo o el total descomprimido.",
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });
            stream.on("error", reject);
            stream.on("end", () => {
              entries.push({
                fileName: entry.fileName,
                uncompressedSize: entry.uncompressedSize,
                data: Buffer.concat(chunks),
              });
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

export function analizarListaImagenesPdf(salida) {
  const imagenesPorPagina = new Map();
  for (const linea of salida.split("\n")) {
    const match = linea.match(
      /^\s*(\d+)\s+(\d+)\s+(image|mask|smask|stencil)\s+(\d+)\s+(\d+)/,
    );
    if (!match) continue;
    const pagina = Number(match[1]);
    const imagenes = imagenesPorPagina.get(pagina) ?? [];
    imagenes.push({
      tipo: match[3],
      ancho: Number(match[4]),
      alto: Number(match[5]),
    });
    imagenesPorPagina.set(pagina, imagenes);
  }
  return imagenesPorPagina;
}

export function esImagenPdfRelevante(imagen) {
  return (
    imagen.tipo === "image" &&
    imagen.ancho >= minPdfImageWidth &&
    imagen.alto >= minPdfImageHeight &&
    imagen.ancho * imagen.alto >= minPdfImagePixels
  );
}

async function obtenerImagenesPorPagina(pdfPath, warnings, filename, signal) {
  try {
    const result = await execFile("pdfimages", ["-list", pdfPath], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      signal,
    });
    return analizarListaImagenesPdf(result.stdout);
  } catch (error) {
    if (signal?.aborted) throw error;
    warnings.push(
      `${filename}: no se pudieron detectar las imágenes interiores del PDF (${error.message}).`,
    );
    return new Map();
  }
}

function comprobarCancelacion(signal) {
  if (signal?.aborted)
    throw new Error("Se ha cancelado la lectura del material.");
}

function limpiarRutaRelativa(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(
      (part) => part && part !== "." && part !== ".." && !part.startsWith("."),
    )
    .join("/");
}

function esArchivoLegible(filename) {
  const normalized = filename.replaceAll("\\", "/");
  if (
    !normalized ||
    esBibliotecaTerceraParte(normalized) ||
    normalized
      .split("/")
      .some(
        (part) =>
          skippedDirectories.has(part.toLowerCase()) || part.startsWith("."),
      )
  )
    return false;
  return extensionesAdmitidas.has(obtenerExtension(normalized));
}

export function esBibliotecaTerceraParte(filename) {
  const partes = filename.replaceAll("\\", "/").split("/");
  return (
    partes.some((parte) => parte.toLowerCase() === "lib") &&
    skippedBundledLibraries.has(path.posix.basename(filename.replaceAll("\\", "/")).toLowerCase())
  );
}

function decodificarTexto(data) {
  return new TextDecoder("utf-8").decode(data).replace(/^\uFEFF/, "");
}
