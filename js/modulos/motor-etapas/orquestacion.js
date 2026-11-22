import { createHash } from "node:crypto";
import { config } from "../configuracion.js";
import {
  controladoresGeneracion,
  trabajosEtapasActivos,
  actualizarProgreso,
} from "../estado-trabajos.js";
import { obtenerReferenciaBibliotecaSegura } from "../consultas-ia.js";
import {
  errorHttp,
  comprobarCancelacion,
} from "../utilidades-generacion.js";
import {
  cargarTrabajoEtapas,
  guardarTrabajoEtapas,
  leerFuenteTrabajo,
  cargarExtraccionTrabajo,
  guardarExtraccionTrabajo,
  guardarExtraccionesPorTema,
  listarTrabajosEtapas,
} from "../trabajos-etapas.js";
import {
  extraerMateriales,
  esBibliotecaTerceraParte,
} from "../material.js";
import { guardarGeneracion } from "../apuntes.js";
import {
  dividirMaterial,
  dividirMaterialConImagenes,
  detectarApartadosEnTexto,
  dividirTextoPorApartados,
  dividirCodigoEnBloques,
} from "../instrucciones.js";
import {
  generarUnidadEtapasConReintentos,
} from "./generacion-unidad.js";
import {
  prepararGuardadoTrabajo,
  crearExtraccionesPorTema,
} from "./guardado-trabajo.js";

export async function reanudarTrabajosEtapasAlArrancar() {
  const trabajos = await listarTrabajosEtapas();
  for (const trabajo of trabajos) {
    if (
      trabajo.estado === "confirmacion" ||
      trabajo.estado === "cancelado" ||
      trabajo.fase === "cancelado" ||
      /aborted|cancelad|detenido por el usuario/i.test(trabajo.error)
    )
      continue;
    console.log(
      `Reanudando trabajo guardado ${trabajo.id} (${trabajo.unidadActual}/${trabajo.totalUnidades}).`,
    );
    iniciarTrabajoEtapas(trabajo.id);
  }
}

export function iniciarTrabajoEtapas(id) {
  if (trabajosEtapasActivos.has(id)) return;
  const controlador = new AbortController();
  trabajosEtapasActivos.add(id);
  controladoresGeneracion.set(id, controlador);
  void ejecutarTrabajoEtapas(id, controlador)
    .catch(async (error) => {
      const pausado = error?.name === "AbortError" || error?.status === 499;
      console.error(`Falló el trabajo por etapas ${id}:`, error);
      try {
        const trabajo = await cargarTrabajoEtapas(id);
        trabajo.estado = pausado ? "cancelado" : "pendiente";
        if (pausado) trabajo.fase = "cancelado";
        trabajo.error = pausado
          ? ""
          : error.message || "Error inesperado durante la generación.";
        await guardarTrabajoEtapas(trabajo);
      } catch (errorEstado) {
        console.error(`No se pudo guardar el estado del trabajo ${id}:`, errorEstado);
      }
      if (!pausado)
        actualizarProgreso(id, {
          fase: "error",
          mensaje: "La generación se detuvo y puede reanudarse",
          detalle: error.message || "Error inesperado durante la generación.",
        });
    })
    .finally(() => {
      trabajosEtapasActivos.delete(id);
      if (controladoresGeneracion.get(id) === controlador)
        controladoresGeneracion.delete(id);
    });
}

export async function ejecutarTrabajoEtapas(id, controlador) {
  const trabajo = await cargarTrabajoEtapas(id);
  if (trabajo.estado === "completado" || trabajo.estado === "confirmacion") return;
  trabajo.estado = "procesando";
  trabajo.error = "";
  if (trabajo.fase === "cancelado") {
    trabajo.fase = !trabajo.unidadesPreparadas
      ? "extraccion"
      : trabajo.unidadActual < (trabajo.unidadesPdf?.length || 0)
        ? "pdf"
        : trabajo.unidadActual < ((trabajo.unidadesPdf?.length || 0) + (trabajo.unidadesCodigo?.length || 0))
          ? "codigo"
          : "guardado";
  }
  await guardarTrabajoEtapas(trabajo);
  const fuentes = await Promise.all(
    trabajo.fuentes.map(async (fuente) => ({
      originalname: fuente.nombre,
      size: fuente.bytes,
      buffer: await leerFuenteTrabajo(trabajo, fuente),
    })),
  );
  const extracciones = [];
  for (let indice = 0; indice < fuentes.length; indice += 1) {
    comprobarCancelacion(controlador.signal);
    let extraido = await cargarExtraccionTrabajo(id, indice);
    if (!extraido) {
      actualizarProgreso(id, {
        fase: "lectura",
        mensaje: `Leyendo fuente ${indice + 1} de ${fuentes.length}`,
        detalle: `${fuentes[indice].originalname}: extrayendo texto, código y OCR.`,
        actual: indice + 1,
        total: fuentes.length,
      });
      extraido = await extraerMateriales([fuentes[indice]], {
        signal: controlador.signal,
      });
      await guardarExtraccionTrabajo(id, indice, extraido);
    }
    extracciones.push(extraido);
  }
  comprobarCancelacion(controlador.signal);
  const documentos = extracciones.flatMap((extraido) => extraido.documents);
  const avisos = extracciones.flatMap((extraido) => extraido.warnings);
  const imagenes = extracciones.flatMap((extraido) => extraido.visuals);
  const materialCompleto = {
    documents: documentos,
    warnings: [...avisos, ...(trabajo.avisos ?? [])],
    visuals: imagenes,
    imagesOcr: extracciones.reduce(
      (total, extraido) => total + extraido.imagesOcr,
      0,
    ),
  };
  if (!documentos.length)
    throw errorHttp(
      422,
      `No se pudo extraer texto de los archivos seleccionados. ${avisos.slice(0, 4).join(" ")}`,
    );

  const unidadesPdf = [];
  const unidadesCodigo = [];
  // Los trabajos nuevos agrupan los archivos pequeños de código/texto en una
  // sola llamada a la IA; los trabajos ya empezados conservan sus ids antiguos.
  const analizarCodigo =
    trabajo.opciones.analisisCodigoHabilitado !== false;
  const agruparCodigo = trabajo.agruparCodigo ?? !trabajo.unidadesPreparadas;
  trabajo.agruparCodigo = agruparCodigo;
  const bloquesCodigoSueltos = [];
  const bloquesTextoSueltos = [];
  const textosVistos = new Set();
  const documentosUnicos = [];
  for (const doc of documentos) {
    const textoDoc = (doc.text || "").trim();
    const clave = `${doc.kind}:${textoDoc}`;
    if (textoDoc && clave.length > 50 && textosVistos.has(clave)) continue;
    if (clave.length > 50) textosVistos.add(clave);
    documentosUnicos.push(doc);
  }
  for (const [indiceDocumento, documento] of documentosUnicos.entries()) {
    if (
      documento.kind === "code" &&
      esBibliotecaTerceraParte(documento.name)
    )
      continue;
    const bloquesCodigo =
      Array.isArray(documento.bloquesCodigo) && documento.bloquesCodigo.length
        ? documento.bloquesCodigo
        : [];
    const textoBase =
      documento.kind === "code"
        ? documento.text
        : bloquesCodigo.length
          ? `${documento.text}\n\n${bloquesCodigo
              .map((bloque) => `--- CÓDIGO ---\n${bloque}`)
              .join("\n\n")}`
          : documento.text;
    const textoDocumento = `--- ${documento.kind.toUpperCase()}: ${documento.name}${documento.language ? ` (${documento.language})` : ""} ---\n${textoBase}`;
    if (documento.kind === "pdf") {
      const visualesDocumento = imagenes.filter(
        (imagen) => imagen.name === documento.name || imagen.name.startsWith(`${documento.name} ·`),
      );
      // Prioridad texto puro: si el PDF ya contiene texto digital abundante (> 1000 caracteres),
      // no fragmentar por imágenes decorativas de diapositivas (fotos de stock, logos o iconos).
      // Conservar solo si son diagramas arquitectónicos relevantes o si el PDF tiene poco texto.
      const apartadosDetectados = detectarApartadosEnTexto(textoDocumento);
      if (apartadosDetectados.length >= 2) {
        const bloquesApartados = dividirTextoPorApartados(
          textoDocumento,
          visualesDocumento,
          apartadosDetectados,
        );
        for (const [indiceBloque, bloque] of bloquesApartados.entries()) {
          const maxCaracteresApartado = 8000;
          if (bloque.texto.length > maxCaracteresApartado) {
            const fragmentos = dividirMaterial(bloque.texto, maxCaracteresApartado);
            for (const [indiceFrag, textoFrag] of fragmentos.entries()) {
              unidadesPdf.push({
                id: `pdf-${indiceDocumento}-apartado-${bloque.temaNumero}_${bloque.apartadoNumero}-p${indiceFrag + 1}`,
                documento,
                texto: textoFrag,
                imagenes: indiceFrag === 0 ? bloque.imagenes : [],
                apartadoNumero: bloque.apartadoNumero,
                indiceApartado: indiceBloque + 1,
                orden: indiceBloque + 1,
                apartadoTitulo: fragmentos.length > 1 ? `${bloque.apartadoTitulo} (Parte ${indiceFrag + 1})` : bloque.apartadoTitulo,
                temaNumero: bloque.temaNumero,
              });
            }
          } else {
            unidadesPdf.push({
              id: `pdf-${indiceDocumento}-apartado-${bloque.temaNumero}_${bloque.apartadoNumero}`,
              documento,
              texto: bloque.texto,
              imagenes: bloque.imagenes,
              apartadoNumero: bloque.apartadoNumero,
              indiceApartado: indiceBloque + 1,
              orden: indiceBloque + 1,
              apartadoTitulo: bloque.apartadoTitulo,
              temaNumero: bloque.temaNumero,
            });
          }
        }
      } else {
        const visualesRelevantes =
          textoDocumento.length > 1000 && visualesDocumento.length > 4
            ? visualesDocumento.filter((img) => (img.ancho >= 400 && img.alto >= 250) || !img.ancho).slice(0, 4)
            : visualesDocumento;
        const tamanoBloque = 8000;
        const maxImagenesBloque = 2;
        const bloques = dividirMaterialConImagenes(
          textoDocumento,
          visualesRelevantes,
          tamanoBloque,
          maxImagenesBloque,
        );
        for (const [indiceBloque, bloque] of bloques.entries()) {
          unidadesPdf.push({
            id: `pdf-${indiceDocumento}-${indiceBloque}`,
            documento,
            texto: bloque.texto,
            imagenes: bloque.imagenes,
            apartadoNumero: indiceBloque + 1,
            indiceApartado: indiceBloque + 1,
            orden: indiceBloque + 1,
          });
        }
      }
    } else if (documento.kind === "code") {
      // Procesar siempre los archivos de código y ZIPs aportados por el usuario
      const bloques = dividirCodigoEnBloques(
        textoDocumento,
        8000,
        documento.language === "JSON",
      );
      for (const [indiceBloque, texto] of bloques.entries()) {
        if (agruparCodigo) {
          bloquesCodigoSueltos.push({
            documento,
            texto:
              indiceBloque === 0
                ? texto
                : `--- ${documento.kind.toUpperCase()}: ${documento.name} (continuación) ---\n${texto}`,
          });
        } else {
          unidadesCodigo.push({
            id: `codigo-${indiceDocumento}-${indiceBloque}`,
            documento,
            texto,
          });
        }
      }
    } else {
      const tamanoBloque = 8000;
      const bloques = dividirMaterial(textoDocumento, tamanoBloque);
      for (const [indiceBloque, texto] of bloques.entries()) {
        if (agruparCodigo) {
          bloquesTextoSueltos.push({
            documento,
            texto,
          });
        } else {
          unidadesPdf.push({
            id: `texto-${indiceDocumento}-${indiceBloque}`,
            documento,
            texto,
            imagenes: [],
          });
        }
      }
    }
  }
  if (agruparCodigo && bloquesTextoSueltos.length) {
    let grupo = [];
    let longitud = 0;
    const cerrarGrupoTexto = () => {
      if (!grupo.length) return;
      const nombres = [...new Set(grupo.map((bloque) => bloque.documento.name))];
      unidadesPdf.push({
        id: `texto-g${unidadesPdf.length}`,
        documento: {
          ...grupo[0].documento,
          name:
            nombres.length > 1
              ? `${nombres[0]} y ${nombres.length - 1} archivo(s) más`
              : nombres[0],
        },
        texto: grupo.map((bloque) => bloque.texto).join("\n\n"),
        imagenes: [],
      });
      grupo = [];
      longitud = 0;
    };
    for (const bloque of bloquesTextoSueltos) {
      if (grupo.length && longitud + bloque.texto.length > 18000) cerrarGrupoTexto();
      grupo.push(bloque);
      longitud += bloque.texto.length + 2;
    }
    cerrarGrupoTexto();
  }
  if (agruparCodigo) {
    let grupo = [];
    let longitud = 0;
    const cerrarGrupo = () => {
      if (!grupo.length) return;
      const nombres = [...new Set(grupo.map((bloque) => bloque.documento.name))];
      unidadesCodigo.push({
        id: `codigo-g${unidadesCodigo.length}`,
        documento: {
          ...grupo[0].documento,
          name:
            nombres.length > 1
              ? `${nombres[0]} y ${nombres.length - 1} archivo(s) más`
              : nombres[0],
        },
        texto: grupo.map((bloque) => bloque.texto).join("\n\n"),
      });
      grupo = [];
      longitud = 0;
    };
    for (const bloque of bloquesCodigoSueltos) {
      if (grupo.length && longitud + bloque.texto.length > 18000) cerrarGrupo();
      grupo.push(bloque);
      longitud += bloque.texto.length + 2;
    }
    cerrarGrupo();
  }
  if (!trabajo.unidadesPreparadas) {
    trabajo.unidadesPdf = unidadesPdf.map((unidad) => unidad.id);
    trabajo.unidadesCodigo = unidadesCodigo.map((unidad) => unidad.id);
    trabajo.unidadesPreparadas = true;
    trabajo.fase = unidadesPdf.length ? "pdf" : "codigo";
    trabajo.unidadActual = 0;
    await guardarTrabajoEtapas(trabajo);
  } else {
    if (trabajo.fase === "extraccion" || trabajo.fase === "cancelado") {
      trabajo.fase =
        trabajo.unidadActual < unidadesPdf.length
          ? "pdf"
          : trabajo.unidadActual < (unidadesPdf.length + unidadesCodigo.length)
            ? "codigo"
            : "guardado";
    }
    if (
      trabajo.fase === "pdf" ||
      (trabajo.unidadActual === 0 &&
        !(trabajo.resultadosPreparados ?? []).some((item) =>
          item.unidad.startsWith("codigo-"),
        ) &&
        !trabajo.bloquePendiente)
    ) {
      trabajo.unidadesPdf = unidadesPdf.map((unidad) => unidad.id);
      trabajo.unidadesCodigo = unidadesCodigo.map((unidad) => unidad.id);
    }
    await guardarTrabajoEtapas(trabajo);
  }

  const referenciaBiblioteca = await obtenerReferenciaBibliotecaSegura();
  while (trabajo.fase === "pdf" || trabajo.fase === "codigo") {
    comprobarCancelacion(controlador.signal);
    const esPdf = trabajo.fase === "pdf";
    const unidades = esPdf ? unidadesPdf : unidadesCodigo;
    if (trabajo.unidadActual >= unidades.length) {
      if (esPdf && !trabajo.etapaPdfGuardada) {
        const pdfGuardados = await prepararGuardadoTrabajo(
          trabajo,
          fuentes,
          materialCompleto,
          "pdf",
          false,
        );
        if (!pdfGuardados) return;
        trabajo.etapaPdfGuardada = true;
        await guardarTrabajoEtapas(trabajo);
      }
      trabajo.fase = esPdf ? "codigo" : "guardado";
      trabajo.unidadActual = 0;
      await guardarTrabajoEtapas(trabajo);
      continue;
    }
    if (trabajo.bloquePendiente) {
      trabajo.resultadosPreparados ??= [];
      trabajo.resultadosPreparados.push(...trabajo.bloquePendiente);
      trabajo.bloquePendiente = null;
      trabajo.unidadActual += 1;
      await guardarTrabajoEtapas(trabajo);
      continue;
    }

    const concurrenciaEtapas = Math.min(config.parallelRequests, 2);
    const lote = unidades.slice(
      trabajo.unidadActual,
      trabajo.unidadActual + concurrenciaEtapas,
    );
    actualizarProgreso(id, {
      fase: "ia",
      mensaje: `Analizando ${esPdf ? "PDF" : "código"} (${lote.length} en paralelo)`,
      detalle: `${lote.map((unidad) => unidad.documento.name).join("; ")}. Se guardarán juntas estas partes antes de avanzar; las partes anteriores ya están conservadas.`,
      actual: trabajo.unidadActual + 1,
      total: unidades.length,
    });
    trabajo.resultadosPreparados ??= [];
    const resultadosLote = await Promise.allSettled(
      lote.map((unidad) =>
        generarUnidadEtapasConReintentos({
          trabajo,
          unidad,
          esPdf,
          referenciaBiblioteca,
          controlador,
        }),
      ),
    );
    const falloLote = resultadosLote.find(
      (resultado) => resultado.status === "rejected",
    );
    if (falloLote) throw falloLote.reason;
    for (const resultado of resultadosLote) {
      trabajo.resultadosPreparados.push(...resultado.value);
      // Escritura simultánea inmediata de los archivos LaTeX en disco
      for (const bloqueResultado of resultado.value) {
        if (bloqueResultado?.resultado?.archivos?.length) {
          try {
            await guardarGeneracion({
              result: bloqueResultado.resultado,
              fingerprint: createHash("sha256")
                .update(trabajo.id)
                .update(bloqueResultado.unidad)
                .digest("hex"),
              subject: trabajo.asignatura,
              theme: bloqueResultado.destino.tema,
              subtheme: bloqueResultado.destino.apartado,
              inputFiles: fuentes,
              material: materialCompleto,
              existingCount: 0,
              replaceExisting: true,
            });
          } catch (errGuardado) {
            console.warn("Aviso al guardar avance simultáneo:", errGuardado.message);
          }
        }
      }
    }
    trabajo.unidadActual += lote.length;
    await guardarExtraccionesPorTema(
      id,
      crearExtraccionesPorTema(trabajo, unidadesPdf, unidadesCodigo),
    );
    await guardarTrabajoEtapas(trabajo);
  }
  comprobarCancelacion(controlador.signal);
  if (trabajo.fase === "guardado")
    await prepararGuardadoTrabajo(
      trabajo,
      fuentes,
      materialCompleto,
      "codigo",
      true,
    );
}
