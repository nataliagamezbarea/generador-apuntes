import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "./configuracion.js";
import { detectarBloquesCodigo } from "./deteccion-codigo.js";

const idTrabajoValido = /^[\da-f-]{36}$/i;

function directorioTrabajos() {
  return path.join(config.generationReportsRoot, ".procesamiento");
}

function rutaTrabajo(id) {
  if (!idTrabajoValido.test(id))
    throw Object.assign(new Error("Identificador de trabajo no válido."), {
      status: 400,
    });
  return path.join(directorioTrabajos(), id);
}

function huellaFuente(archivo) {
  if (archivo.buffer) {
    return createHash("sha256").update(archivo.buffer).digest("hex");
  }
  if (archivo.path) {
    try {
      return createHash("sha256").update(readFileSync(archivo.path)).digest("hex");
    } catch {
      return "";
    }
  }
  return "";
}

async function huellaFuentesTrabajo(trabajo) {
  const fuentes = await Promise.all(
    trabajo.fuentes.map(async (fuente) => ({
      nombre: fuente.nombre,
      bytes: fuente.bytes,
      huella: createHash("sha256")
        .update(
          await readFile(
            path.join(rutaTrabajo(trabajo.id), "fuentes", fuente.archivo),
          ),
        )
        .digest("hex"),
    })),
  );
  return JSON.stringify(
    fuentes.sort((a, b) => a.nombre.localeCompare(b.nombre)),
  );
}

function huellaFuentes(archivos) {
  return JSON.stringify(
    archivos
      .map((archivo) => ({
        nombre: archivo.originalname,
        bytes: archivo.size,
        huella: huellaFuente(archivo),
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre)),
  );
}

async function escribirJsonAtomico(ruta, contenido) {
  const temporal = `${ruta}.${randomUUID()}.tmp`;
  await writeFile(temporal, `${JSON.stringify(contenido, null, 2)}\n`, "utf8");
  await rename(temporal, ruta);
}

export async function crearTrabajoEtapas({ id = randomUUID(), subject, opciones, archivos }) {
  if (!idTrabajoValido.test(id))
    throw Object.assign(new Error("Identificador de trabajo no válido."), {
      status: 400,
    });
  const directory = rutaTrabajo(id);
  await mkdir(directorioTrabajos(), { recursive: true });
  try {
    await mkdir(directory);
    await mkdir(path.join(directory, "fuentes"));
  } catch (error) {
    if (error.code === "EEXIST")
      throw Object.assign(new Error("Ya existe una generación con este identificador."), {
        status: 409,
      });
    throw error;
  }
  const fuentes = [];
  for (const [indice, archivo] of archivos.entries()) {
    const nombreInterno = `fuente-${String(indice + 1).padStart(4, "0")}.bin`;
    const rutaDestino = path.join(directory, "fuentes", nombreInterno);
    if (archivo.path) {
      await copyFile(archivo.path, rutaDestino);
      await rm(archivo.path, { force: true }).catch(() => {});
    } else if (archivo.buffer) {
      await writeFile(rutaDestino, archivo.buffer);
    }
    fuentes.push({
      archivo: nombreInterno,
      nombre: archivo.originalname,
      bytes: archivo.size,
    });
  }
  const trabajo = {
    id,
    asignatura: subject,
    opciones,
    fuentes,
    estado: "pendiente",
    fase: "extraccion",
    extracciones: [],
    unidadesPdf: [],
    unidadesCodigo: [],
    unidadActual: 0,
    bloquePendiente: null,
    guardados: [],
    creado: new Date().toISOString(),
    actualizado: new Date().toISOString(),
  };
  await guardarTrabajoEtapas(trabajo);
  return trabajo;
}

export async function guardarTrabajoEtapas(trabajo) {
  trabajo.actualizado = new Date().toISOString();
  const directory = rutaTrabajo(trabajo.id);
  await mkdir(directory, { recursive: true });
  await escribirJsonAtomico(path.join(directory, "estado.json"), trabajo);
}

export async function cargarTrabajoEtapas(id) {
  const directory = rutaTrabajo(id);
  try {
    return JSON.parse(await readFile(path.join(directory, "estado.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw Object.assign(
        new Error("No se encontró el trabajo pendiente."),
        { status: 404, code: "ENOENT" },
      );
    throw new Error(`No se pudo leer el estado del trabajo: ${error.message}`);
  }
}

export async function listarTrabajosEtapas(
  subject = null,
  incluirCancelados = false,
  incluirCompletados = false,
) {
  let entradas;
  try {
    entradas = await readdir(directorioTrabajos(), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const trabajos = [];
  for (const entrada of entradas) {
    if (!entrada.isDirectory() || !idTrabajoValido.test(entrada.name)) continue;
    let trabajo;
    try {
      trabajo = await cargarTrabajoEtapas(entrada.name);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (
      (!subject || trabajo.asignatura === subject) &&
      (incluirCompletados || trabajo.estado !== "completado") &&
      (incluirCancelados || trabajo.estado !== "cancelado")
    )
      trabajos.push({
        id: trabajo.id,
        asignatura: trabajo.asignatura,
        estado: trabajo.estado,
        fase: trabajo.fase,
        unidadActual:
          trabajo.fase === "codigo"
            ? trabajo.unidadesPdf.length + trabajo.unidadActual
            : trabajo.unidadActual,
        totalUnidades: trabajo.unidadesPdf.length + trabajo.unidadesCodigo.length,
        compararApuntesHabilitado:
          trabajo.opciones?.compararApuntesHabilitado === true,
        error: trabajo.error ?? "",
        actualizado: trabajo.actualizado,
      });
  }
  return trabajos.sort((a, b) => b.actualizado.localeCompare(a.actualizado));
}

export async function buscarTrabajoEtapasReutilizable(subject, archivos) {
  const huellaMaterial = huellaFuentes(archivos);
  const trabajos = await listarTrabajosEtapas(subject, true);
  for (const resumen of trabajos) {
    const trabajo = await cargarTrabajoEtapas(resumen.id);
    if ((await huellaFuentesTrabajo(trabajo)) === huellaMaterial) return trabajo;
  }
  return null;
}

/**
 * Comprueba si un trabajo existente se creó con exactamente los mismos
 * archivos que se acaban de subir. Se usa para no reanudar por error un
 * trabajo antiguo cuando el usuario cambia el material.
 */
export async function trabajoCoincideConArchivos(trabajo, archivos) {
  return (await huellaFuentesTrabajo(trabajo)) === huellaFuentes(archivos);
}

export async function leerFuenteTrabajo(trabajo, fuente) {
  if (!trabajo.fuentes.some((entrada) => entrada.archivo === fuente.archivo))
    throw new Error("La fuente no pertenece al trabajo pendiente.");
  try {
    return await readFile(
      path.join(rutaTrabajo(trabajo.id), "fuentes", fuente.archivo),
    );
  } catch (error) {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

export async function guardarExtraccionTrabajo(id, indice, material) {
  if (!Number.isSafeInteger(indice) || indice < 0)
    throw new Error("Índice de extracción no válido.");
  const directory = path.join(rutaTrabajo(id), "extracciones");
  await mkdir(directory, { recursive: true });
  let extracciones = [];
  try {
    extracciones = JSON.parse(
      await readFile(path.join(directory, "extracciones.json"), "utf8"),
    );
    if (!Array.isArray(extracciones)) extracciones = [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  extracciones[indice] = estructurarExtraccion(material);
  await escribirJsonAtomico(path.join(directory, "extracciones.json"), extracciones);
}

export async function cargarExtraccionTrabajo(id, indice) {
  const directory = path.join(rutaTrabajo(id), "extracciones");
  try {
    const extracciones = JSON.parse(
      await readFile(path.join(directory, "extracciones.json"), "utf8"),
    );
    return Array.isArray(extracciones)
      ? desestructurarExtraccion(extracciones[indice])
      : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`No se pudo recuperar el material extraído: ${error.message}`);
  }
}

function estructurarExtraccion(material) {
  const visuals = material.visuals ?? [];
  return {
    warnings: material.warnings ?? [],
    imagesOcr: material.imagesOcr ?? 0,
    documents: (material.documents ?? []).map((documento) => {
      if (documento.kind !== "pdf") return documento;
      const imagenes = visuals.filter(
        (imagen) =>
          imagen.name === documento.name ||
          imagen.name.startsWith(`${documento.name} ·`),
      );
      const codigo = detectarBloquesCodigo(documento.text);
      return {
        [documento.name]: {
          imagenes,
          codigo: codigo.bloques,
          texto: codigo.texto,
        },
      };
    }),
  };
}

function desestructurarExtraccion(material) {
  if (!material) return null;
  if (!Array.isArray(material.documents)) return material;
  const visuals = [];
  const documents = material.documents.map((documento) => {
    if (documento.kind) return documento;
    const [nombre, contenido] = Object.entries(documento)[0] ?? [];
    if (!contenido) return documento;
    visuals.push(...(contenido.imagenes ?? []));
    return {
      name: nombre,
      kind: "pdf",
      text: contenido.texto ?? "",
      bloquesCodigo: Array.isArray(contenido.codigo) ? contenido.codigo : [],
    };
  });
  return { ...material, documents, visuals };
}

export async function guardarExtraccionesPorTema(id, grupos) {
  const directory = path.join(rutaTrabajo(id), "extracciones");
  await mkdir(directory, { recursive: true });
  const existentes = new Set(
    (await readdir(directory)).filter((nombre) => /^tema-\d+\.json$/.test(nombre)),
  );
  const guardados = new Set();
  for (const grupo of grupos) {
    const nombre = `tema-${String(grupo.tema).padStart(2, "0")}.json`;
    guardados.add(nombre);
    await escribirJsonAtomico(path.join(directory, nombre), grupo);
  }
  await Promise.all(
    [...existentes]
      .filter((nombre) => !guardados.has(nombre))
      .map((nombre) => rm(path.join(directory, nombre), { force: true })),
  );
}

export async function limpiarFuentesTrabajo(id) {
  const directory = rutaTrabajo(id);
  await Promise.all([
    rm(path.join(directory, "fuentes"), { recursive: true, force: true }),
    rm(path.join(directory, "extracciones"), { recursive: true, force: true }),
  ]);
}

export async function eliminarTrabajoEtapas(id) {
  await rm(rutaTrabajo(id), { recursive: true, force: true });
}

export async function cancelarTrabajoEtapas(id) {
  const trabajo = await cargarTrabajoEtapas(id);
  trabajo.estado = "cancelado";
  trabajo.fase = "cancelado";
  trabajo.error = "";
  await guardarTrabajoEtapas(trabajo);
  return trabajo;
}

/**
 * Pausa un trabajo por etapas sin cancelarlo: conserva la fase y lo deja
 * en estado "pendiente" para que la interfaz muestre el botón «Reanudar».
 */
export async function pausarTrabajoEtapas(id) {
  const trabajo = await cargarTrabajoEtapas(id);
  if (trabajo.estado === "completado" || trabajo.estado === "confirmacion")
    return trabajo;
  trabajo.estado = "pendiente";
  trabajo.error = "";
  await guardarTrabajoEtapas(trabajo);
  return trabajo;
}

/**
 * Reinicia una etapa específica del trabajo con 3 niveles de control para depuración:
 * - "reescribir" / "latex": Conserva las fuentes y el texto/OCR extraído; regenera la redacción LaTeX y los ejemplos con la IA.
 * - "analizar" / "codigo": Conserva el temario y LaTeX del PDF; vuelve a clasificar los bloques de código.
 * - "desde-cero" / "extraccion": Borra la caché de extracción y vuelve a leer y procesar las fuentes desde el inicio.
 */
export async function reiniciarEtapaTrabajo(id, etapa = "reescribir") {
  const trabajo = await cargarTrabajoEtapas(id);
  const modo = String(etapa).toLowerCase().trim();

  if (modo === "desde-cero" || modo === "extraccion" || modo === "inicio") {
    const directory = rutaTrabajo(id);
    await rm(path.join(directory, "extracciones"), { recursive: true, force: true }).catch(() => {});
    trabajo.fase = "extraccion";
    trabajo.unidadActual = 0;
    trabajo.unidadesPreparadas = false;
    trabajo.extracciones = [];
    trabajo.unidadesPdf = [];
    trabajo.unidadesCodigo = [];
    trabajo.bloquePendiente = null;
    trabajo.resultadosPreparados = [];
    trabajo.etapaPdfGuardada = false;
    trabajo.guardados = [];
    trabajo.estado = "pendiente";
    trabajo.error = "";
  } else if (modo === "analizar" || modo === "codigo") {
    trabajo.fase = "codigo";
    trabajo.unidadActual = 0;
    trabajo.bloquePendiente = null;
    trabajo.resultadosPreparados = (trabajo.resultadosPreparados ?? []).filter(
      (item) => item.unidad?.startsWith("pdf-"),
    );
    trabajo.estado = "pendiente";
    trabajo.error = "";
  } else {
    // Modo "reescribir" o "latex" o "pdf" (por defecto)
    trabajo.fase = "pdf";
    trabajo.unidadActual = 0;
    trabajo.bloquePendiente = null;
    trabajo.resultadosPreparados = [];
    trabajo.etapaPdfGuardada = false;
    trabajo.estado = "pendiente";
    trabajo.error = "";
  }
  await guardarTrabajoEtapas(trabajo);
  return trabajo;
}
