import { createHash } from "node:crypto";
import { config } from "../configuracion.js";
import {
  actualizarProgreso,
  controladoresGeneracion,
} from "../estado-trabajos.js";
import {
  guardarTrabajoEtapas,
  leerFuenteTrabajo,
  cargarExtraccionTrabajo,
} from "../trabajos-etapas.js";
import {
  errorHttp,
  comprobarCancelacion,
  compararArchivosProcesados,
} from "../utilidades-generacion.js";
import {
  guardarGeneracion,
  listarApuntes,
  listarHistorialGeneraciones,
  listarAsignaturas,
  inspeccionarReemplazosGeneracion,
  desglosarBloquesPorSubtitulos,
  deducirSlugConceptual,
} from "../apuntes.js";

export async function catalogoTemasTrabajo(trabajo) {
  const asignatura =
    (await listarAsignaturas()).find((item) => item.nombre === trabajo.asignatura);
  const temas = (asignatura?.temas ?? []).map((tema) => ({
    ...tema,
    apartados: tema.apartados.map((apartado) => ({ ...apartado })),
  }));
  for (const item of trabajo.resultadosPreparados ?? []) {
    const { destino } = item;
    let tema = temas.find((existente) => existente.numero === destino.tema);
    if (!tema) {
      tema = {
        numero: destino.tema,
        titulo: destino.tituloTema,
        apartados: [],
      };
      temas.push(tema);
    }
    if (!tema.apartados.some((apartado) => apartado.numero === destino.apartado))
      tema.apartados.push({
        numero: destino.apartado,
        nombre: destino.tituloApartado,
      });
  }
  return temas.sort((a, b) => a.numero - b.numero);
}

export async function prepararGuardadoTrabajo(
  trabajo,
  fuentes,
  material,
  fase,
  faseFinal,
) {
  const grupos = agruparResultadosTrabajo(trabajo, fase);
  if (!grupos.length) {
    if (faseFinal) {
      trabajo.estado = "completado";
      trabajo.fase = "completado";
      await guardarTrabajoEtapas(trabajo);
    }
    return true;
  }
  if (trabajo.opciones.sustituirExistentes) {
    const colisiones = [];
    for (const grupo of grupos) {
      const archivos = await inspeccionarReemplazosGeneracion({
        result: grupo.resultado,
        subject: trabajo.asignatura,
        theme: grupo.destino.tema,
        subtheme: grupo.destino.apartado,
        fingerprint: grupo.fingerprint,
        inputFiles: fuentes,
      });
      colisiones.push(...archivos);
    }
    if (colisiones.length) {
      trabajo.archivosASustituir = colisiones.map((archivo) => archivo.path);
      trabajo.hashesArchivosASustituir = Object.fromEntries(
        colisiones.map((archivo) => [archivo.path, archivo.sha256]),
      );
      trabajo.estado = "confirmacion";
      trabajo.confirmacionFase = fase;
      trabajo.fase = fase;
      await guardarTrabajoEtapas(trabajo);
      actualizarProgreso(trabajo.id, {
        fase: "confirmacion",
        mensaje: "Confirma si quieres sustituir los apuntes existentes",
        detalle: `Hay ${colisiones.length} archivo(s) con el mismo nombre que se sustituirían.`,
      });
      return false;
    }
  }
  await guardarGruposTrabajo(
    trabajo,
    grupos,
    fuentes,
    material,
    false,
    faseFinal,
  );
  return true;
}

export function agruparResultadosTrabajo(trabajo, fase = null) {
  const grupos = new Map();
  for (const item of trabajo.resultadosPreparados ?? []) {
    if (
      (fase === "pdf" && !item.unidad.startsWith("pdf-")) ||
      (fase === "codigo" && !item.unidad.startsWith("codigo-"))
    )
      continue;
    const clave = [
      item.destino.tema,
      item.destino.apartado,
    ].join("-");
    let grupo = grupos.get(clave);
    if (!grupo) {
      grupo = {
        destino: item.destino,
        unidadIds: [],
        resultado: {
          ...item.resultado,
          archivos: [],
          conceptos_clave: [],
          cobertura: [],
          imagenes: [],
          fuentes: [],
          resumen: "",
        },
      };
      grupos.set(clave, grupo);
    }
    grupo.unidadIds.push(item.unidad);
    const archivosDesglosados = desglosarBloquesPorSubtitulos(item.resultado?.archivos ?? []);
    for (const arch of archivosDesglosados) {
      const count = grupo.resultado.archivos.length + 1;
      arch.orden = count;
      arch.numeroArchivoEnSubtema = count;
      let slug = deducirSlugConceptual("", arch.titulo || arch.nombre || "apartado");
      slug = slug.replace(/^\d+[.\-]+\s*/, "");
      arch.nombre = `${count}.${slug || "apartado"}`;
      grupo.resultado.archivos.push(arch);
    }
    grupo.resultado.conceptos_clave.push(...(item.resultado?.conceptos_clave ?? []));
    grupo.resultado.cobertura.push(...(item.resultado?.cobertura ?? []));
    grupo.resultado.imagenes.push(...(item.resultado?.imagenes ?? []));
    grupo.resultado.fuentes.push(...(item.resultado?.fuentes ?? []));
    if (item.resultado.resumen)
      grupo.resultado.resumen = [grupo.resultado.resumen, item.resultado.resumen]
        .filter(Boolean)
        .join("\n\n");
  }
  return [...grupos.values()].map((grupo) => {
    const huella = createHash("sha256")
      .update(trabajo.id)
      .update(JSON.stringify(grupo.destino))
      .update(grupo.unidadIds.join("\n"))
      .digest("hex");
    grupo.fingerprint = huella;
    return grupo;
  });
}

export async function guardarResultadosTrabajo(trabajo, sustituir, iniciarTrabajoEtapasFn) {
  if (trabajo.estado !== "confirmacion")
    throw errorHttp(409, "Esta generación no está esperando confirmación.");
  const fase = trabajo.confirmacionFase;
  const grupos = agruparResultadosTrabajo(trabajo, fase);
  if (!grupos.length)
    throw errorHttp(409, "No se encontraron resultados para guardar en esta etapa.");
  const fuentes = await Promise.all(
    trabajo.fuentes.map(async (fuente) => ({
      originalname: fuente.nombre,
      size: fuente.bytes,
      buffer: await leerFuenteTrabajo(trabajo, fuente),
    })),
  );
  const documentos = [];
  const avisos = [];
  const imagenes = [];
  let imagesOcr = 0;
  for (let indice = 0; indice < fuentes.length; indice += 1) {
    const extraido = await cargarExtraccionTrabajo(trabajo.id, indice);
    if (!extraido) continue;
    documentos.push(...extraido.documents);
    avisos.push(...extraido.warnings);
    imagenes.push(...extraido.visuals);
    imagesOcr += extraido.imagesOcr;
  }
  await guardarGruposTrabajo(
    trabajo,
    grupos,
    fuentes,
    {
      documents: documentos,
      warnings: [...avisos, ...(trabajo.avisos ?? [])],
      visuals: imagenes,
      imagesOcr,
    },
    sustituir,
    fase === "codigo",
  );
  if (fase === "pdf") {
    trabajo.etapaPdfGuardada = true;
    trabajo.fase = "codigo";
    trabajo.unidadActual = 0;
    trabajo.estado = "pendiente";
    trabajo.confirmacionFase = "";
    trabajo.archivosASustituir = [];
    trabajo.hashesArchivosASustituir = {};
    await guardarTrabajoEtapas(trabajo);
    if (iniciarTrabajoEtapasFn) {
      iniciarTrabajoEtapasFn(trabajo.id);
    }
  }
}

export async function guardarGruposTrabajo(
  trabajo,
  grupos,
  fuentes,
  material,
  sustituir,
  faseFinal = true,
) {
  const informesPrevios = await listarHistorialGeneraciones(trabajo.asignatura);
  const archivosCambiados = compararArchivosProcesados(fuentes, informesPrevios);
  const guardados = [];
  for (const grupo of grupos) {
    comprobarCancelacion(controladoresGeneracion.get(trabajo.id) ?? new AbortController().signal);
    const expectedExistingFiles = sustituir
      ? Object.fromEntries(
          Object.entries(trabajo.hashesArchivosASustituir ?? {}).filter(([nombre]) =>
            nombre.startsWith(`${trabajo.asignatura}/Tema ${grupo.destino.tema}/Tema ${grupo.destino.tema}.${grupo.destino.apartado}/`),
          ),
        )
      : {};
    const generation = await guardarGeneracion({
      result: grupo.resultado,
      fingerprint: grupo.fingerprint,
      subject: trabajo.asignatura,
      theme: grupo.destino.tema,
      subtheme: grupo.destino.apartado,
      inputFiles: fuentes,
      material,
      existingCount: (await listarApuntes(trabajo.asignatura)).length,
      replaceExisting: sustituir || Boolean(trabajo.id),
      expectedExistingFiles,
      archivosCambiados,
    });
    const guardado = {
      fingerprint: grupo.fingerprint,
      fase: grupo.unidadIds.every((unidad) => unidad.startsWith("pdf-"))
        ? "pdf"
        : "codigo",
      tema: grupo.destino.tema,
      titulo_tema: grupo.destino.tituloTema,
      subtema: grupo.destino.apartado,
      titulo_subtema: grupo.destino.tituloApartado,
      archivos_generados: generation.report.archivos_generados,
      conceptos_clave: grupo.resultado.conceptos_clave,
      cobertura: grupo.resultado.cobertura,
    };
    guardados.push(guardado);
    trabajo.guardados = [
      ...(trabajo.guardados ?? []).filter(
        (anterior) => anterior.fingerprint !== grupo.fingerprint,
      ),
      guardado,
    ];
    await guardarTrabajoEtapas(trabajo);
  }
  if (faseFinal) {
    trabajo.estado = "completado";
    trabajo.fase = "completado";
  } else {
    trabajo.estado = "procesando";
  }
  trabajo.error = "";
  await guardarTrabajoEtapas(trabajo);
  if (faseFinal)
    actualizarProgreso(trabajo.id, {
      fase: "completado",
      mensaje: "Generación por etapas completada",
      detalle: `${trabajo.guardados.length} resultado(s) guardados en sus temas y apartados.`,
      actual: 1,
      total: 1,
    });
}

export function crearExtraccionesPorTema(trabajo, unidadesPdf, unidadesCodigo) {
  const unidades = new Map(
    [...unidadesPdf, ...unidadesCodigo].map((unidad) => [unidad.id, unidad]),
  );
  const temas = new Map();
  for (const item of trabajo.resultadosPreparados ?? []) {
    const tema = item.destino?.tema;
    if (!Number.isSafeInteger(tema)) continue;
    let grupo = temas.get(tema);
    if (!grupo) {
      grupo = { tema, apartados: new Map() };
      temas.set(tema, grupo);
    }
    const apartado = item.destino.apartado;
    let bloque = grupo.apartados.get(apartado);
    if (!bloque) {
      bloque = {
        apartado,
        titulo: item.destino.tituloApartado,
        unidades: [],
      };
      grupo.apartados.set(apartado, bloque);
    }
    const unidad = unidades.get(item.unidad);
    if (unidad && !bloque.unidades.some((existente) => existente.id === unidad.id))
      bloque.unidades.push({
        id: unidad.id,
        nombre: unidad.documento.name,
        texto: textoUnidadParaExtraccion(unidad),
        imagenes: unidad.imagenes ?? [],
      });
  }
  return [...temas.values()].map((grupo) => ({
    tema: grupo.tema,
    apartados: [...grupo.apartados.values()],
  }));
}

export function textoUnidadParaExtraccion(unidad) {
  const texto = String(unidad.texto ?? "");
  if (unidad.documento?.kind !== "pdf") return texto;
  const cabecera = `--- PDF: ${unidad.documento.name} ---\n`;
  return texto.startsWith(cabecera) ? texto.slice(cabecera.length) : texto;
}
