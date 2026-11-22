import { config } from "./configuracion.js";
import {
  seguimientosGeneracion,
  controladoresGeneracion,
  trabajosEtapasActivos,
  actualizarProgreso,
  maxReintentosTemporalesEtapas,
  registrarLogGeneracion,
} from "./estado-trabajos.js";
import {
  obtenerReferenciaBibliotecaSegura,
  consultarApuntesConReintento,
  consultarCodigoConReintento,
} from "./consultas-ia.js";
import {
  errorHttp,
  comprobarCancelacion,
  crearGuiaMaterialBreve,
  numeroPositivo,
  numeroOpcional,
  etiquetaAcotada,
  normalizarTitulo,
  inferirTemaYApartadoDeDocumento,
  resolverDestinoGeneracion,
  combinarFuentes,
  crearCitasLatex,
} from "./utilidades-generacion.js";
import {
  cargarTrabajoEtapas,
  guardarTrabajoEtapas,
  leerFuenteTrabajo,
  cargarExtraccionTrabajo,
  guardarExtraccionTrabajo,
  guardarExtraccionesPorTema,
  listarTrabajosEtapas,
} from "./trabajos-etapas.js";
import {
  extraerMateriales,
  textoMaterial,
  esBibliotecaTerceraParte,
} from "./material.js";
import {
  consultarModeloIA,
  traducirLatexAEspanolConIA,
  detectarCatalanConIA,
  traducirTituloYNombreConIA,
} from "./modelo.js";
import {
  normalizarResultadoIA,
  crearNombreArchivo,
  deducirSlugConceptual,
  limpiarLatex,
  guardarApunte,
  guardarGeneracion,
  aplicarEstilosLatex,
  detectarCatalan,
  esTituloDePlantilla,
  desglosarBloquesPorSubtitulos,
  componenteSeguro,
} from "./apuntes.js";
import {
  dividirMaterial,
  dividirMaterialConImagenes,
  detectarApartadosEnTexto,
  dividirTextoPorApartados,
  dividirCodigoEnBloques,
  crearPromptCodigoPorTemas,
  crearPromptApuntes,
  sistemaReescrituraDidactica,
  evaluarCoberturaMaterial,
} from "./instrucciones.js";
import {
  buscarFuentesOpcionales,
  crearConsultasInvestigacion,
} from "./investigacion.js";

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
      fase === "pdf" && !item.unidad.startsWith("pdf-") ||
      fase === "codigo" && !item.unidad.startsWith("codigo-")
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

export async function guardarResultadosTrabajo(trabajo, sustituir) {
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
    iniciarTrabajoEtapas(trabajo.id);
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