import { combinarArchivos } from "./seleccion-archivos.js";
import {
  borrarArchivosPersistidos,
  cargarArchivosPersistidos,
  guardarArchivosPersistidos,
} from "./persistencia-archivos.js";
import { formatearDuracion } from "./formato-salida.js";

const formulario = document.querySelector("#formulario-generacion");
const selectorAsignatura = document.querySelector("#selector-asignatura");
const asignaturaNueva = document.querySelector("#asignatura-nueva");
const botonCrearAsignatura = document.querySelector("#crear-asignatura");
const selectorTema = document.querySelector("#selector-tema");
const temaNuevo = document.querySelector("#tema-nuevo");
const selectorApartado = document.querySelector("#selector-apartado");
const apartadoNuevo = document.querySelector("#apartado-nuevo");
const selectorArchivos = document.querySelector("#selector-archivos");
const selectorCarpeta = document.querySelector("#selector-carpeta");
const zonaArchivos = document.querySelector(".upload-grid");
const textoFuente = document.querySelector("#texto-fuente");
const archivosSeleccionados = document.querySelector("#archivos-seleccionados");
const estadoAsignatura = document.querySelector("#estado-asignatura");
const estadoSelector = document.querySelector("#estado-selector");
const investigacionWeb = document.querySelector("#investigacion-web");
const progreso = document.querySelector("#progreso");
const etiquetaProgreso = document.querySelector("#etiqueta-progreso");
const detalleProgreso = document.querySelector("#detalle-progreso");
const barraProgreso = document.querySelector("#barra-progreso");
const listaPasosProgreso = document.querySelector("#lista-pasos-progreso");
const tiempoEstimado = document.querySelector("#tiempo-estimado");
const botonDetener = document.querySelector("#detener-generacion");
const botonReiniciar = document.querySelector("#reiniciar-generacion");
const iconoProgreso = document.querySelector("#icono-progreso");
const panelError = document.querySelector("#panel-error");
const panelResultados = document.querySelector("#panel-resultados");
const ultimaGeneracion = document.querySelector("#ultima-generacion");
const trabajosPendientes = document.querySelector("#trabajos-pendientes");
const botonGenerar = document.querySelector("#boton-generar");
const estadoModelo = document.querySelector("#estado-modelo");
let archivosElegidos = [];
let temporizadorBorrador;
let asignaturas = [];
let controladorGeneracion;
let idGeneracionActiva;
let idProgresoActual;
let idTrabajoPreparandose;
let reiniciarAlFinalizar = false;
let inicioEtapasDisponible = false;
let asignaturaGeneracionActiva;
let monitorGeneracionActivo = 0;
let generacionDetenida = false;
let ultimoEstadoProgreso;
let tokenEtaServidor;
let ultimaConsultaProgreso = 0;
let fuentesBloqueadas = false;
let asignaturaBorradorActiva = "";
let cambioAsignaturaPendiente = Promise.resolve();
let interfazInicializada = false;
const registroConsolaEnVivo = [];
let ultimaUnidadRegistrada = -1;
let segundosTickerBloque = 0;
let ultimaFaseRegistrada = "";
let avisosRegistrados = 0;
let consolaPausada = false;
let consolaOculta = false;
let ultimaUnidadDetallada = "";
let ultimosResultadosMostrados = 0;

function registrarEventoConsola(mensaje) {
  const hora = new Date().toLocaleTimeString("es-ES", { hour12: false });
  registroConsolaEnVivo.push(`[${hora}] ${mensaje}`);
  if (registroConsolaEnVivo.length > 200) registroConsolaEnVivo.shift();
  if (consolaPausada) return;
  const textoConsola = document.querySelector("#texto-consola");
  if (textoConsola && !consolaOculta) {
    textoConsola.textContent = registroConsolaEnVivo.slice(-100).join("\n");
    textoConsola.scrollTop = textoConsola.scrollHeight;
  }
}
const trabajosPendientesOcultos = new Set(
  JSON.parse(sessionStorage.getItem("generador.trabajos-pendientes-ocultos") || "[]"),
);
const fasesProgreso = [
  ["subida", "Envío de archivos al servidor local"],
  ["lectura", "Lectura de PDF, documentos, código y OCR"],
  ["internet", "Búsqueda en Internet y recopilación de fuentes"],
  ["comparacion", "Comparación con apuntes y conceptos anteriores"],
  ["ia", "Análisis de material y redacción con IA local"],
  ["confirmacion", "Confirmación de sustitución de apuntes existentes"],
  ["guardado", "Creación de apuntes LaTeX e informe de cobertura"],
  ["completado", "Generación finalizada"],
];

function asignarValorValido(selector, valorGuardado) {
  if ([...selector.options].some((opcion) => opcion.value === valorGuardado))
    selector.value = valorGuardado;
}

function compararApuntesHabilitado() {
  return document.querySelector("#sustituir-existentes")?.checked === true;
}

async function cargarAsignaturas() {
  const respuesta = await fetch("/api/subjects");
  if (!respuesta.ok) throw new Error("No se pudieron cargar las asignaturas.");
  asignaturas = (await respuesta.json()).asignaturas;
  const respuestaTrabajos = await fetch("/api/staged-generations");
  if (!respuestaTrabajos.ok)
    throw new Error("No se pudieron recuperar las generaciones activas.");
  const trabajosActivos = (await respuestaTrabajos.json()).trabajos ?? [];
  const trabajoActivo = trabajosActivos.find(
    (trabajo) => trabajo.estado === "procesando" || trabajo.estado === "pendiente",
  );
  const asignaturaGuardada = localStorage.getItem("generador.asignatura");
  const asignaturaWec = asignaturas.find(
    (asignatura) => asignatura.nombre.trim().toLocaleUpperCase("es") === "WEC",
  );
  const valorAnterior =
    !interfazInicializada && trabajoActivo?.asignatura
      ? trabajoActivo.asignatura
      : asignaturas.some((asignatura) => asignatura.nombre === asignaturaGuardada)
        ? asignaturaGuardada
        : asignaturaWec?.nombre ?? selectorAsignatura.value;
  selectorAsignatura.replaceChildren();
  for (const asignatura of asignaturas) {
    const opcion = document.createElement("option");
    opcion.value = asignatura.nombre;
    opcion.textContent = asignatura.nombre;
    selectorAsignatura.append(opcion);
  }
  const opcionAnadir = document.createElement("option");
  opcionAnadir.value = "__new__";
  opcionAnadir.textContent = "+ Añadir asignatura…";
  selectorAsignatura.append(opcionAnadir);
  selectorAsignatura.value = asignaturas.some(
    (asignatura) => asignatura.nombre === valorAnterior,
  )
    ? valorAnterior
    : asignaturas.length
      ? asignaturas[0].nombre
      : "__new__";
  await cargarBorradorFuentes();
  actualizarCamposAsignatura();
  await cargarUltimaGeneracion();
  await cargarTrabajosPendientes();
  const iniciarTrabajoActivo =
    !interfazInicializada &&
    trabajoActivo &&
    trabajoActivo.estado === "procesando" &&
    trabajoActivo.asignatura === selectorAsignatura.value;
  interfazInicializada = true;
  if (iniciarTrabajoActivo)
    await reanudarTrabajoEtapas(trabajoActivo.id);
}

async function cargarTrabajosPendientes() {
  const asignatura =
    selectorAsignatura.value === "__new__"
      ? asignaturaNueva.value.trim()
      : selectorAsignatura.value;
  if (!asignatura) {
    fuentesBloqueadas = false;
    actualizarResumenFuentes();
    trabajosPendientes.hidden = true;
    return;
  }
  const parametros = new URLSearchParams({
    subject: asignatura,
    include_completed: "true",
  });
  const respuesta = await fetch(`/api/staged-generations?${parametros}`);
  if (!respuesta.ok)
    throw new Error(
      (await respuesta.json()).detail ||
        "No se pudieron cargar las generaciones pendientes.",
    );
  const trabajos = (await respuesta.json()).trabajos ?? [];
  fuentesBloqueadas = trabajos.some(
    (trabajo) => trabajo.estado === "procesando",
  );
  actualizarResumenFuentes();
  const trabajosReanudables = trabajos.filter(
    (trabajo) =>
      trabajo.estado !== "procesando" &&
      !trabajosPendientesOcultos.has(trabajo.id),
  );
  trabajosPendientes.replaceChildren();
  trabajosPendientes.hidden = trabajosReanudables.length === 0;
  const trabajoActivo = trabajos.find(
    (trabajo) =>
      trabajo.estado === "procesando" || trabajo.estado === "pendiente",
  );
  if (!idGeneracionActiva && !controladorGeneracion)
    progreso.hidden = true;
  botonGenerar.disabled =
    Boolean(trabajoActivo) ||
    (Boolean(controladorGeneracion) &&
      asignaturaGeneracionActiva === selectorAsignatura.value);
  if (
    !trabajosReanudables.length ||
    (idGeneracionActiva && trabajoActivo?.id === idGeneracionActiva)
  ) {
    trabajosPendientes.hidden = true;
    return;
  }
  const titulo = document.createElement("strong");
  titulo.textContent = "Generaciones interrumpidas o pendientes";
  trabajosPendientes.append(titulo);
  for (const trabajo of trabajosReanudables) {
    const fila = document.createElement("div");
    fila.className = "staged-job";
    const descripcion = document.createElement("span");
    const esCompletado = trabajo.estado === "completado";
    const fase =
      trabajo.fase === "pdf"
        ? "PDF"
        : trabajo.fase === "codigo"
          ? "código"
          : trabajo.fase;
    descripcion.textContent = esCompletado
      ? `Completada (${trabajo.totalUnidades} bloques guardados)`
      : `${fase}: ${trabajo.unidadActual} de ${trabajo.totalUnidades} bloques${trabajo.error ? ` · ${trabajo.error}` : ""}`;

    const acciones = document.createElement("div");
    acciones.style.cssText = "display: flex; gap: 6px; align-items: center;";

    if (!esCompletado) {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "secondary-button";
      boton.textContent =
        trabajo.estado === "confirmacion" ? "Revisar y continuar" : "Reanudar";
      boton.addEventListener("click", () => {
        trabajosPendientes.hidden = true;
        void reanudarTrabajoEtapas(trabajo.id);
      });
      acciones.append(boton);
    }

    const botonReescribir = document.createElement("button");
    botonReescribir.type = "button";
    botonReescribir.className = "secondary-button";
    botonReescribir.textContent = "🔁 Reescribir (LaTeX)";
    botonReescribir.title = "Vuelve a redactar los apuntes en LaTeX usando el texto ya extraído (sin re-leer los archivos)";
    botonReescribir.addEventListener("click", () => {
      trabajosPendientes.hidden = true;
      void repetirEtapaTrabajo(trabajo.id, "reescribir");
    });
    acciones.append(botonReescribir);

    const botonAnalizar = document.createElement("button");
    botonAnalizar.type = "button";
    botonAnalizar.className = "secondary-button";
    botonAnalizar.textContent = "⚙️ Analizar código";
    botonAnalizar.title = "Vuelve a clasificar los bloques de código en los temas correspondientes";
    botonAnalizar.addEventListener("click", () => {
      trabajosPendientes.hidden = true;
      void repetirEtapaTrabajo(trabajo.id, "analizar");
    });
    acciones.append(botonAnalizar);

    const botonDesdeCero = document.createElement("button");
    botonDesdeCero.type = "button";
    botonDesdeCero.className = "secondary-button";
    botonDesdeCero.textContent = "🔄 Desde 0";
    botonDesdeCero.title = "Borra las extracciones en caché y vuelve a procesar los archivos desde el inicio";
    botonDesdeCero.addEventListener("click", () => {
      trabajosPendientes.hidden = true;
      void repetirEtapaTrabajo(trabajo.id, "desde-cero");
    });
    acciones.append(botonDesdeCero);

    const cerrar = document.createElement("button");
    cerrar.type = "button";
    cerrar.className = "staged-job-dismiss";
    cerrar.textContent = "×";
    cerrar.title = "Eliminar esta generación y su caché";
    cerrar.setAttribute("aria-label", "Eliminar generación y su caché");
    cerrar.addEventListener("click", async () => {
      cerrar.disabled = true;
      try {
        const respuesta = await fetch(
          `/api/staged-generations/${encodeURIComponent(trabajo.id)}`,
          { method: "DELETE" },
        );
        if (!respuesta.ok)
          throw new Error("No se pudo eliminar la generación.");
        await borrarArchivosPersistidos(claveBorradorFuentes(trabajo.asignatura));
        if (selectorAsignatura.value === trabajo.asignatura) {
          archivosElegidos = [];
          textoFuente.value = "";
          actualizarResumenFuentes();
        }
        await cargarTrabajosPendientes();
        await cargarUltimaGeneracion();
      } catch (error) {
        cerrar.disabled = false;
        panelError.textContent = error.message;
        panelError.hidden = false;
        return;
      }
      trabajosPendientesOcultos.add(trabajo.id);
      sessionStorage.setItem(
        "generador.trabajos-pendientes-ocultos",
        JSON.stringify([...trabajosPendientesOcultos]),
      );
      fila.remove();
      if (!trabajosPendientes.querySelector(".staged-job"))
        trabajosPendientes.hidden = true;
    });
    fila.append(descripcion, acciones, cerrar);
    trabajosPendientes.append(fila);
  }
}

async function reanudarTrabajoEtapas(id) {
  if (idGeneracionActiva === id) return;
  const monitorId = ++monitorGeneracionActivo;
  panelError.hidden = true;
  panelResultados.hidden = true;
  controladorGeneracion = new AbortController();
  idGeneracionActiva = id;
  generacionDetenida = false;
  fuentesBloqueadas = true;
  actualizarResumenFuentes();
  botonGenerar.disabled = true;
  botonDetener.hidden = false;
  botonDetener.disabled = false;
  botonDetener.textContent = "Detener generación";
  if (botonReiniciar) {
    botonReiniciar.hidden = false;
    botonReiniciar.disabled = false;
  }
  progreso.hidden = false;
  mostrarProgresoGeneracion(
    {
      fase: "lectura",
      mensaje: "Reanudando generación",
      detalle: "Conectando con el servidor para continuar desde la última etapa guardada.",
    },
    investigacionWeb.checked,
  );
  trabajosPendientes.hidden = true;
  const temporizador = window.setInterval(actualizarTiempoEstimado, 1000);
  try {
    const estado = await fetch(`/api/staged-generations/${encodeURIComponent(id)}`);
    if (!estado.ok)
      throw new Error((await estado.json()).detail || "No se encontró el trabajo.");
    const trabajo = await estado.json();
    const asignaturaTrabajo = trabajo.asignatura;
    asignaturaGeneracionActiva = asignaturaTrabajo;
    if (selectorAsignatura.value !== asignaturaTrabajo) {
      selectorAsignatura.value = asignaturaTrabajo;
    }
    mostrarProgresoTrabajoEtapas(trabajo, monitorId);
    if (trabajo.estado !== "confirmacion") {
      const respuesta = await fetch(
        `/api/staged-generations/${encodeURIComponent(id)}/resume`,
        { method: "POST", signal: controladorGeneracion.signal },
      );
      if (!respuesta.ok)
        throw new Error((await respuesta.json()).detail || "No se pudo reanudar.");
    }
    await vigilarTrabajoEtapas(id, asignaturaTrabajo, monitorId);
    await cargarAsignaturas();
    if (asignaturaGeneracionActiva === selectorAsignatura.value)
      await cargarTrabajosPendientes();
  } catch (error) {
    if (!generacionDetenida && error.name !== "AbortError") {
      panelError.textContent = error.message || "No se pudo reanudar la generación.";
      panelError.hidden = false;
      await cargarTrabajosPendientes();
    }
  } finally {
    window.clearInterval(temporizador);
    if (monitorId === monitorGeneracionActivo) {
      progreso.hidden = generacionDetenida;
      botonGenerar.disabled = false;
      botonDetener.hidden = true;
      botonDetener.disabled = false;
      botonDetener.textContent = "Detener generación";
      if (botonReiniciar) {
        botonReiniciar.hidden = true;
        botonReiniciar.disabled = false;
      }
      fuentesBloqueadas = false;
      actualizarResumenFuentes();
      controladorGeneracion = undefined;
      idGeneracionActiva = undefined;
      await cargarTrabajosPendientes();
    }
  }
}

async function repetirEtapaTrabajo(id, etapa = "reescribir") {
  // «Desde 0» también debe funcionar mientras el trabajo está procesándose.
  // Se invalida la vigilancia anterior antes de crear la nueva.
  if (idGeneracionActiva === id && etapa !== "desde-cero" && etapa !== "extraccion") return;
  if (idGeneracionActiva === id) controladorGeneracion?.abort();
  const monitorId = ++monitorGeneracionActivo;
  panelError.hidden = true;
  panelResultados.hidden = true;
  controladorGeneracion = new AbortController();
  idGeneracionActiva = id;
  generacionDetenida = false;
  fuentesBloqueadas = true;
  actualizarResumenFuentes();
  botonGenerar.disabled = true;
  botonDetener.hidden = false;
  botonDetener.disabled = false;
  botonDetener.textContent = "Detener generación";
  if (botonReiniciar) {
    botonReiniciar.hidden = false;
    botonReiniciar.disabled = false;
  }
  progreso.hidden = false;

  const esDesdeCero = etapa === "desde-cero" || etapa === "extraccion";
  const esAnalizar = etapa === "analizar" || etapa === "codigo";
  const faseProgreso = esDesdeCero ? "lectura" : esAnalizar ? "codigo" : "ia";
  const tituloMensaje = esDesdeCero
    ? "Reiniciando generación desde 0"
    : esAnalizar
      ? "Repitiendo análisis de código"
      : "Reescribiendo apuntes en LaTeX";
  const detalleMensaje = esDesdeCero
    ? "Volviendo a extraer texto, código e imágenes de los archivos originales."
    : esAnalizar
      ? "Volviendo a analizar y clasificar los fragmentos de código por temas."
      : "Generando nueva redacción pedagógica en LaTeX a partir del material extraído.";

  mostrarProgresoGeneracion(
    {
      fase: faseProgreso,
      mensaje: tituloMensaje,
      detalle: detalleMensaje,
    },
    investigacionWeb.checked,
  );
  trabajosPendientes.hidden = true;
  const temporizador = window.setInterval(actualizarTiempoEstimado, 1000);
  try {
    const estado = await fetch(`/api/staged-generations/${encodeURIComponent(id)}`);
    if (!estado.ok)
      throw new Error((await estado.json()).detail || "No se encontró el trabajo.");
    const trabajo = await estado.json();
    const asignaturaTrabajo = trabajo.asignatura;
    asignaturaGeneracionActiva = asignaturaTrabajo;
    if (selectorAsignatura.value !== asignaturaTrabajo) {
      selectorAsignatura.value = asignaturaTrabajo;
    }
    const respuesta = await fetch(
      `/api/staged-generations/${encodeURIComponent(id)}/repeat-stage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ etapa }),
        signal: controladorGeneracion.signal,
      },
    );
    if (!respuesta.ok)
      throw new Error((await respuesta.json()).detail || "No se pudo repetir la etapa.");
    await vigilarTrabajoEtapas(id, asignaturaTrabajo, monitorId);
    await cargarAsignaturas();
    if (asignaturaGeneracionActiva === selectorAsignatura.value)
      await cargarTrabajosPendientes();
  } catch (error) {
    if (!generacionDetenida && error.name !== "AbortError") {
      panelError.textContent = error.message || "Error al repetir la etapa.";
      panelError.hidden = false;
      await cargarTrabajosPendientes();
    }
  } finally {
    window.clearInterval(temporizador);
    if (monitorId === monitorGeneracionActivo) {
      progreso.hidden = generacionDetenida;
      botonGenerar.disabled = false;
      botonDetener.hidden = true;
      if (botonReiniciar) botonReiniciar.hidden = true;
      fuentesBloqueadas = false;
      actualizarResumenFuentes();
      controladorGeneracion = undefined;
      idGeneracionActiva = undefined;
      await cargarTrabajosPendientes();
    }
  }
}

async function vigilarTrabajoEtapas(id, asignaturaTrabajo, monitorId) {
  while (true) {
    if (controladorGeneracion.signal.aborted)
      throw new DOMException("Generación detenida.", "AbortError");
    const respuesta = await fetch(
      `/api/staged-generations/${encodeURIComponent(id)}`,
      { signal: controladorGeneracion.signal },
    );
    if (!respuesta.ok)
      throw new Error((await respuesta.json()).detail || "No se pudo consultar el progreso.");
    const trabajo = await respuesta.json();
    mostrarProgresoTrabajoEtapas(trabajo, monitorId);
    if (trabajo.estado === "confirmacion") {
      const confirmar = window.confirm(
        `La etapa ${trabajo.archivosASustituir?.length ? "PDF" : "de generación"} va a sustituir estos apuntes:\n${(trabajo.archivosASustituir ?? []).map((archivo) => `• ${archivo}`).join("\n")}\n\n¿Confirmas? Si eliges «Cancelar», los existentes se conservarán y los nuevos tendrán otro nombre.`,
      );
      const guardado = await fetch(
        `/api/staged-generations/${encodeURIComponent(id)}/save`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ replace_existing: confirmar }),
          signal: controladorGeneracion.signal,
        },
      );
      if (!guardado.ok)
        throw new Error(
          (await guardado.json()).detail || "No se pudieron guardar los apuntes.",
        );
      const resultadoGuardado = await guardado.json();
      if (resultadoGuardado.estado === "completado") {
        mostrarResultadosEtapas(resultadoGuardado.resultados ?? []);
        return;
      }

    } else if (trabajo.estado === "completado") {
      mostrarResultadosEtapas(trabajo.resultados ?? []);
      return;
    } else if (trabajo.estado === "pendiente" && trabajo.error) {
      throw new Error(
        `Se guardó el progreso y puedes reanudarlo. ${trabajo.error}`,
      );
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
}

function mostrarProgresoTrabajoEtapas(trabajo, monitorId) {
  if (monitorId !== monitorGeneracionActivo) return;
  if (
    asignaturaGeneracionActiva &&
    selectorAsignatura.value !== asignaturaGeneracionActiva
  ) {
    selectorAsignatura.value = asignaturaGeneracionActiva;
  }
  const total = Math.max(1, Number(trabajo.totalUnidades) || 1);
  const actual = Math.min(
    total,
    Math.max(0, Number(trabajo.unidadActual) || 0),
  );
  const enExtraccion = trabajo.fase === "extraccion";
  const enBloques = trabajo.fase === "pdf" || trabajo.fase === "codigo";
  const faseTrabajo = enExtraccion
    ? "lectura"
    : enBloques
      ? "ia"
      : trabajo.fase === "guardado"
        ? "guardado"
        : trabajo.fase;
  const mensaje =
    trabajo.estado === "pendiente"
      ? "Generación pausada"
      : enExtraccion
        ? "Leyendo PDF, documentos, código y OCR"
        : trabajo.fase === "pdf"
          ? "Analizando PDF"
          : trabajo.fase === "codigo"
            ? "Analizando código"
            : trabajo.fase === "guardado"
              ? "Guardando apuntes"
              : trabajo.fase === "confirmacion"
                ? "Esperando confirmación"
                : trabajo.fase === "completado"
                  ? "Generación finalizada"
                  : "Preparando la generación";
  const detalle =
    trabajo.estado === "pendiente"
      ? enBloques
        ? `Pausada en ${trabajo.fase}: ${actual} de ${total} bloques procesados`
        : "Pausada durante la lectura del material."
      : enExtraccion
        ? "Extrayendo texto, código e imágenes de las fuentes."
        : enBloques
          ? `${actual} de ${total} bloques procesados`
          : trabajo.fase === "guardado"
            ? "Creando los apuntes LaTeX y el informe de cobertura."
            : "";
  mostrarProgresoGeneracion(
    {
      fase: faseTrabajo,
      mensaje,
      detalle,
      actual,
      total,
      actualizado: trabajo.actualizado,
    },
    investigacionWeb.checked,
    trabajo.compararApuntesHabilitado === true,
    trabajo.estado === "confirmacion" ||
      (trabajo.archivosASustituir?.length ?? 0) > 0,
    enExtraccion ? 0 : (actual / total) * 100,
  );

  if (trabajo.fase && trabajo.fase !== ultimaFaseRegistrada) {
    ultimaFaseRegistrada = trabajo.fase;
    registrarEventoConsola(`▶ FASE: ${trabajo.fase.toUpperCase()} (${mensaje})`);
  }
  if (typeof trabajo.unidadActual === "number" && trabajo.unidadActual !== ultimaUnidadRegistrada) {
    if (ultimaUnidadRegistrada !== -1) {
      registrarEventoConsola(`✅ [IA] Bloque ${ultimaUnidadRegistrada} completado e integrado en los apuntes.`);
    }
    ultimaUnidadRegistrada = trabajo.unidadActual;
    segundosTickerBloque = 0;

    const archivosPdf = archivosElegidos.filter((a) => a.name.endsWith(".pdf"));
    const docEstimado =
      archivosPdf[
        Math.min(
          archivosPdf.length - 1,
          Math.floor((actual / Math.max(total, 1)) * (archivosPdf.length || 1)),
        )
      ];
    const docNombre =
      trabajo.unidadActivaInfo?.documento ||
      docEstimado?.name ||
      (trabajo.fase === "codigo" ? "Código fuente ZIP" : "Diapositivas del temario");

    registrarEventoConsola(`▶ [IA] Procesando bloque ${actual} de ${total} (${trabajo.fase.toUpperCase()})...`);
    registrarEventoConsola(`📄 [Material origen] ${docNombre}`);
    registrarEventoConsola(`📋 [Prompt del sistema]: "Eres un docente universitario experto. Convierte el material en apuntes rigurosos en LaTeX con explicaciones exhaustivas, sintaxis, código y tablas."`);
    if (trabajo.unidadActivaInfo?.extractoTexto) {
      registrarEventoConsola(`📥 [Texto enviado a Ollama]: "${trabajo.unidadActivaInfo.extractoTexto}..." (${trabajo.unidadActivaInfo.numCaracteres} chars, ${trabajo.unidadActivaInfo.numImagenes} img)`);
    } else {
      registrarEventoConsola(`📥 [Instrucción enviada a Ollama]: "Analiza el bloque ${actual} de ${docNombre}. Extrae conceptos clave de la materia, deduce el apartado correspondiente y devuelve JSON con apartados LaTeX formateados (\\secciongrande, \\subtituloA, \\begin{codigo}, tablas)."`);
    }
  } else if (trabajo.estado === "procesando") {
    segundosTickerBloque += 1;
    if (segundosTickerBloque === 8) {
      registrarEventoConsola(`⚙️ [IA Generando bloque ${actual}] Redactando teoría, sintaxis y ejemplos prácticos (${segundosTickerBloque}s)...`);
    } else if (segundosTickerBloque === 20) {
      registrarEventoConsola(`📝 [IA Generando bloque ${actual}] Estructurando secciones, tablas y bloques de código (${segundosTickerBloque}s)...`);
    } else if (segundosTickerBloque === 40) {
      registrarEventoConsola(`⏳ [IA Generando bloque ${actual}] Consolidando explicación didáctica en LaTeX (${segundosTickerBloque}s)...`);
    } else if (segundosTickerBloque > 40 && segundosTickerBloque % 20 === 0) {
      registrarEventoConsola(`🔄 [IA Procesando bloque ${actual}] Emitiendo tokens LaTeX (${segundosTickerBloque}s transcurridos)...`);
    }
  }

  const listaGuardados = trabajo.guardados || trabajo.resultados || trabajo.ultimosResultados || [];
  if (Array.isArray(listaGuardados) && listaGuardados.length > ultimosResultadosMostrados) {
    for (let i = ultimosResultadosMostrados; i < listaGuardados.length; i++) {
      const item = listaGuardados[i];
      const r = item.resultado?.archivos?.[0] || item.archivos?.[0] || item;
      const titulo = r.titulo || r.nombre || "Apartado de apuntes";
      const tema = item.destino?.tituloTema || r.titulo_tema || (r.tema ? `Tema ${r.tema}` : "General");
      const conceptos = item.resultado?.conceptos_clave || r.conceptos_clave || r.conceptos || [];
      const resumen = item.resultado?.resumen || r.resumen || "";
      registrarEventoConsola(`📤 [Respuesta IA] Apartado redactado: "${titulo}" (${tema})`);
      if (conceptos.length) {
        registrarEventoConsola(`💡 [Conceptos clave] ${conceptos.slice(0, 8).join(", ")}`);
      }
      if (resumen) {
        registrarEventoConsola(`📝 [Resumen generado] ${resumen}`);
      }
      if (r.latex) {
        const preview = r.latex.slice(0, 160).replace(/\s+/g, " ");
        registrarEventoConsola(`📄 [Código LaTeX generado] ${preview}...`);
      }
    }
    ultimosResultadosMostrados = listaGuardados.length;
  }
  if (Array.isArray(trabajo.avisos) && trabajo.avisos.length > avisosRegistrados) {
    for (let i = avisosRegistrados; i < trabajo.avisos.length; i++) {
      registrarEventoConsola(`ℹ️ ${trabajo.avisos[i]}`);
    }
    avisosRegistrados = trabajo.avisos.length;
  }
  if (Array.isArray(trabajo.logsRecientes) && trabajo.logsRecientes.length) {
    for (const linea of trabajo.logsRecientes) {
      if (!registroConsolaEnVivo.includes(linea)) {
        registroConsolaEnVivo.push(linea);
      }
    }
    const textoConsola = document.querySelector("#texto-consola");
    if (textoConsola) {
      textoConsola.textContent = registroConsolaEnVivo.slice(-100).join("\n");
      textoConsola.scrollTop = textoConsola.scrollHeight;
    }
  }
}

function mostrarResultadosEtapas(resultados) {
  panelResultados.replaceChildren();
  const titulo = document.createElement("h2");
  titulo.textContent = "Apuntes guardados por tema";
  panelResultados.append(titulo);

  const barraAcciones = document.createElement("div");
  barraAcciones.style.cssText = "display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap;";

  const botonReescribir = document.createElement("button");
  botonReescribir.type = "button";
  botonReescribir.className = "secondary-button";
  botonReescribir.textContent = "🔁 Reescribir (LaTeX)";
  botonReescribir.title = "Vuelve a redactar los apuntes en LaTeX usando el texto ya extraído (sin re-leer los archivos)";
  botonReescribir.addEventListener("click", async () => {
    try {
      const resp = await fetch(`/api/staged-generations?subject=${encodeURIComponent(selectorAsignatura.value)}&include_completed=true`);
      const datos = await resp.json();
      const ultimo = (datos.trabajos ?? [])[0];
      if (ultimo) {
        void repetirEtapaTrabajo(ultimo.id, "reescribir");
      } else {
        panelError.textContent = "No hay generación previa disponible para repetir.";
        panelError.hidden = false;
      }
    } catch (err) {
      panelError.textContent = err.message || "Error al solicitar la repetición.";
      panelError.hidden = false;
    }
  });
  barraAcciones.append(botonReescribir);

  const botonAnalizar = document.createElement("button");
  botonAnalizar.type = "button";
  botonAnalizar.className = "secondary-button";
  botonAnalizar.textContent = "⚙️ Analizar código";
  botonAnalizar.title = "Vuelve a clasificar los bloques de código en los temas correspondientes";
  botonAnalizar.addEventListener("click", async () => {
    try {
      const resp = await fetch(`/api/staged-generations?subject=${encodeURIComponent(selectorAsignatura.value)}&include_completed=true`);
      const datos = await resp.json();
      const ultimo = (datos.trabajos ?? [])[0];
      if (ultimo) {
        void repetirEtapaTrabajo(ultimo.id, "analizar");
      } else {
        panelError.textContent = "No hay generación previa disponible para repetir.";
        panelError.hidden = false;
      }
    } catch (err) {
      panelError.textContent = err.message || "Error al solicitar la repetición.";
      panelError.hidden = false;
    }
  });
  barraAcciones.append(botonAnalizar);

  const botonDesdeCero = document.createElement("button");
  botonDesdeCero.type = "button";
  botonDesdeCero.className = "secondary-button";
  botonDesdeCero.textContent = "🔄 Desde 0";
  botonDesdeCero.title = "Borra las extracciones en caché y vuelve a procesar los archivos desde el inicio";
  botonDesdeCero.addEventListener("click", async () => {
    try {
      const resp = await fetch(`/api/staged-generations?subject=${encodeURIComponent(selectorAsignatura.value)}&include_completed=true`);
      const datos = await resp.json();
      const ultimo = (datos.trabajos ?? [])[0];
      if (ultimo) {
        void repetirEtapaTrabajo(ultimo.id, "desde-cero");
      } else {
        panelError.textContent = "No hay generación previa disponible para repetir.";
        panelError.hidden = false;
      }
    } catch (err) {
      panelError.textContent = err.message || "Error al solicitar la repetición.";
      panelError.hidden = false;
    }
  });
  barraAcciones.append(botonDesdeCero);
  panelResultados.append(barraAcciones);

  for (const resultado of resultados) {
    const entrada = document.createElement("details");
    entrada.className = "generation-history-entry";
    const resumen = document.createElement("summary");
    resumen.textContent = `Tema ${resultado.tema}: ${resultado.titulo_tema} · Apartado ${resultado.tema}.${resultado.subtema}: ${resultado.titulo_subtema}`;
    entrada.append(resumen);
    for (const archivo of resultado.archivos_generados ?? []) {
      const fila = document.createElement("code");
      fila.textContent = archivo.path;
      entrada.append(fila);
    }
    panelResultados.append(entrada);
  }
  panelResultados.hidden = false;
}

function actualizarCamposAsignatura() {
  const esNuevo = selectorAsignatura.value === "__new__";
  asignaturaNueva.hidden = !esNuevo;
  asignaturaNueva.required = esNuevo;
  botonCrearAsignatura.hidden = !esNuevo;
  actualizarOpcionesTema();
  if (!esNuevo) {
    const preferencia = leerPreferenciaSeleccion(selectorAsignatura.value);
    document.querySelector("#material-contiene-codigo").checked =
      preferencia?.contieneCodigo === true;
    if (preferencia?.tema) {
      selectorTema.value = preferencia.tema;
      actualizarCamposTema();
      if (preferencia.apartado) {
        selectorApartado.value = preferencia.apartado;
        actualizarCamposApartado();
      }
    }
  }
}

function leerPreferenciaSeleccion(asignatura) {
  try {
    return JSON.parse(
      localStorage.getItem(`generador.seleccion.${asignatura}`) ?? "null",
    );
  } catch {
    return null;
  }
}

function guardarPreferenciaSeleccion() {
  const asignatura = selectorAsignatura.value;
  if (!asignatura || asignatura === "__new__") return;
  localStorage.setItem("generador.asignatura", asignatura);
  localStorage.setItem(
    `generador.seleccion.${asignatura}`,
    JSON.stringify({
      tema: selectorTema.value,
      apartado: selectorApartado.value,
      contieneCodigo: document.querySelector("#material-contiene-codigo").checked,
    }),
  );
}

function asignaturaSeleccionada() {
  return asignaturas.find(
    (asignatura) => asignatura.nombre === selectorAsignatura.value,
  );
}

function temaSeleccionado() {
  return asignaturaSeleccionada()?.temas.find(
    (tema) => tema.numero === Number(selectorTema.value),
  );
}

function siguienteNumero(elementos) {
  return Math.max(0, ...elementos.map((elemento) => elemento.numero)) + 1;
}

function actualizarOpcionesTema() {
  const temas = asignaturaSeleccionada()?.temas ?? [];
  const valorAnterior = selectorTema.value;
  selectorTema.replaceChildren();
  const opcionAutomatica = document.createElement("option");
  opcionAutomatica.value = "__auto__";
  opcionAutomatica.textContent = "Detectar tema según el material";
  selectorTema.append(opcionAutomatica);
  for (const tema of temas) {
    const opcion = document.createElement("option");
    opcion.value = String(tema.numero);
    const tituloGenerico =
      !tema.titulo ||
      tema.titulo === tema.nombre ||
      new RegExp(`^TEMA\\s+0*${tema.numero}$`, "i").test(tema.titulo);
    opcion.textContent = `Tema ${tema.numero}${tituloGenerico ? "" : ` · ${tema.titulo}`}`;
    selectorTema.append(opcion);
  }
  const opcionAnadir = document.createElement("option");
  opcionAnadir.value = "__new__";
  opcionAnadir.textContent = "+ Crear tema…";
  selectorTema.append(opcionAnadir);
  selectorTema.value = temas.some(
    (tema) => String(tema.numero) === valorAnterior,
  )
    ? valorAnterior
    : ["__auto__", "__new__"].includes(valorAnterior)
      ? valorAnterior
      : "__auto__";
  const preferencia = leerPreferenciaSeleccion(
    selectorAsignatura.value,
  );
  if (temas.some((tema) => String(tema.numero) === preferencia?.tema))
    asignarValorValido(selectorTema, preferencia.tema);
  else if (["__auto__", "__new__"].includes(preferencia?.tema))
    asignarValorValido(selectorTema, preferencia.tema);
  actualizarCamposTema();
}

function actualizarCamposTema() {
  const esAutomatico = selectorTema.value === "__auto__";
  const esNuevo = selectorTema.value === "__new__";
  temaNuevo.hidden = !esNuevo;
  temaNuevo.required = esNuevo;
  const apartados = temaSeleccionado()?.apartados ?? [];
  const valorAnterior = selectorApartado.value;
  selectorApartado.replaceChildren();
  const opcionAutomatica = document.createElement("option");
  opcionAutomatica.value = "__auto__";
  opcionAutomatica.textContent = esAutomatico
    ? "Detectar tema y apartado según el material"
    : "Detectar o crear apartado según el material";
  selectorApartado.append(opcionAutomatica);
  if (!esAutomatico)
    for (const apartado of apartados) {
      const opcion = document.createElement("option");
      opcion.value = String(apartado.numero);
      opcion.textContent = `Apartado ${apartado.numero} · ${apartado.nombre}`;
      selectorApartado.append(opcion);
    }
  const opcionAnadir = document.createElement("option");
  opcionAnadir.value = "__new__";
  opcionAnadir.textContent = "+ Crear apartado…";
  selectorApartado.append(opcionAnadir);
  selectorApartado.value = apartados.some(
    (apartado) => String(apartado.numero) === valorAnterior,
  )
    ? valorAnterior
    : ["__auto__", "__new__"].includes(valorAnterior)
      ? valorAnterior
      : "__auto__";
  const preferencia = leerPreferenciaSeleccion(
    selectorAsignatura.value,
  );
  if (
    apartados.some(
      (apartado) => String(apartado.numero) === preferencia?.apartado,
    )
  )
    asignarValorValido(selectorApartado, preferencia.apartado);
  else if (["__auto__", "__new__"].includes(preferencia?.apartado))
    asignarValorValido(selectorApartado, preferencia.apartado);
  actualizarCamposApartado();
}

function actualizarCamposApartado() {
  const esNuevo = selectorApartado.value === "__new__";
  apartadoNuevo.hidden = !esNuevo;
  apartadoNuevo.required = esNuevo;
  cargarUltimaGeneracion();
}

async function crearCarpetaNuevaAsignatura() {
  const nombre = asignaturaNueva.value.trim();
  if (!nombre) throw new Error("Escribe primero el nombre de la asignatura.");
  const respuesta = await fetch("/api/subjects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nombre }),
  });
  const resultado = await respuesta.json();
  if (!respuesta.ok)
    throw new Error(resultado.detail || "No se pudo crear la carpeta de la asignatura.");
  localStorage.setItem("generador.asignatura", resultado.nombre);
  await cargarAsignaturas();
  selectorAsignatura.value = resultado.nombre;
  actualizarCamposAsignatura();
  asignaturaNueva.value = "";
  guardarPreferenciaSeleccion();
  return resultado.nombre;
}

function numeroTemaSeleccionado() {
  if (selectorTema.value === "__auto__") return 0;
  return selectorTema.value === "__new__"
    ? siguienteNumero(asignaturaSeleccionada()?.temas ?? [])
    : Number(selectorTema.value);
}

function numeroApartadoSeleccionado() {
  if (selectorApartado.value === "__auto__") return 0;
  return selectorApartado.value === "__new__"
    ? siguienteNumero(temaSeleccionado()?.apartados ?? [])
    : Number(selectorApartado.value);
}

function tituloTemaSeleccionado() {
  if (selectorTema.value === "__auto__") return "";
  return selectorTema.value === "__new__"
    ? temaNuevo.value.trim()
    : temaSeleccionado()?.titulo || temaSeleccionado()?.nombre || "";
}

function tituloApartadoSeleccionado() {
  if (selectorApartado.value === "__auto__") return "";
  if (selectorApartado.value === "__new__") return apartadoNuevo.value.trim();
  return (
    temaSeleccionado()?.apartados.find(
      (apartado) => apartado.numero === Number(selectorApartado.value),
    )?.nombre ?? ""
  );
}

function mostrarArchivos(archivos) {
  estadoSelector.hidden = true;
  archivosElegidos = combinarArchivos(archivosElegidos, archivos);
  actualizarResumenFuentes();
  guardarBorradorFuentes().catch((error) => mostrarErrorBorrador(error));
}

function detectarAsignaturasEnCarpeta(archivos) {
  const nombres = new Set();
  for (const archivo of archivos) {
    const ruta = archivo.webkitRelativePath || "";
    const partes = ruta.split("/").filter(Boolean);
    if (partes.length < 2) continue;
    const nombre = partes.length >= 3 ? partes[1] : partes[0];
    if (nombre && !/^tema\s+\d+$/i.test(nombre)) nombres.add(nombre);
  }
  return [...nombres].sort((a, b) => a.localeCompare(b, "es"));
}

function mostrarAsignaturasDetectadas(archivos) {
  const nombres = detectarAsignaturasEnCarpeta(archivos);
  for (const opcion of [...selectorAsignatura.options])
    if (opcion.dataset.detectada === "true") opcion.remove();
  const existentes = new Set([...selectorAsignatura.options].map((opcion) => opcion.value));
  for (const nombre of nombres) {
    if (existentes.has(nombre)) continue;
    const opcion = document.createElement("option");
    opcion.value = nombre;
    opcion.textContent = `${nombre} (carpeta seleccionada)`;
    opcion.dataset.detectada = "true";
    selectorAsignatura.insertBefore(opcion, selectorAsignatura.lastElementChild);
  }
  if (nombres.length && !existentes.has(selectorAsignatura.value)) {
    selectorAsignatura.value = nombres[0];
    actualizarCamposAsignatura();
  }
}

function guardarBorradorFuentes() {
  return guardarArchivosPersistidos(claveBorradorFuentes(), archivosElegidos, {
    texto: textoFuente.value,
  });
}

function claveBorradorFuentes(asignatura = selectorAsignatura.value) {
  return `generacion:${asignatura || "__sin-asignatura__"}`;
}

function mostrarErrorBorrador(error) {
  mostrarEstadoSelector(
    `No se pudo guardar el borrador en este navegador: ${error.message}. Mantén esta página abierta o vuelve a seleccionar los archivos después de recargar.`,
  );
}

function programarGuardadoTexto() {
  window.clearTimeout(temporizadorBorrador);
  temporizadorBorrador = window.setTimeout(() => {
    guardarBorradorFuentes().catch((error) => mostrarErrorBorrador(error));
  }, 400);
}

async function restaurarBorradorFuentes() {
  await cargarBorradorFuentes();
}

async function cargarBorradorFuentes() {
  try {
    const asignatura = selectorAsignatura.value;
    if (!asignatura || asignatura === "__new__") return;
    if (asignaturaBorradorActiva === asignatura) return;
    asignaturaBorradorActiva = asignatura;
    const borrador = await cargarArchivosPersistidos(claveBorradorFuentes(asignatura));
    archivosElegidos = borrador.archivos;
    textoFuente.value = borrador.valores.texto ?? "";
    actualizarResumenFuentes();
    if (archivosElegidos.length || textoFuente.value.trim()) {
      mostrarEstadoSelector(
        `Se restauró el borrador anterior: ${archivosElegidos.length} archivo(s) y texto pegado.`,
      );
    }
  } catch (error) {
    mostrarErrorBorrador(error);
  }
}

function actualizarResumenFuentes() {
  archivosSeleccionados.replaceChildren();
  let tieneFuentes = false;
  if (archivosElegidos.length) {
    tieneFuentes = true;
    const resumen = document.createElement("span");
    resumen.className = "selected-files-summary";
    resumen.textContent = `${archivosElegidos.length} archivo(s) · ${(archivosElegidos.reduce((total, archivo) => total + archivo.size, 0) / 1024 / 1024).toFixed(1)} MB`;
    archivosSeleccionados.append(resumen);
    const quitarTodos = document.createElement("button");
    quitarTodos.className = "remove-all-files";
    quitarTodos.type = "button";
    quitarTodos.textContent = "Quitar todos";
    quitarTodos.disabled = fuentesBloqueadas;
    quitarTodos.title = fuentesBloqueadas
      ? "Cancela la generación para quitar estas fuentes."
      : "";
    quitarTodos.addEventListener("click", () => {
      archivosElegidos = [];
      estadoSelector.hidden = true;
      actualizarResumenFuentes();
      guardarBorradorFuentes().catch((error) => mostrarErrorBorrador(error));
    });
    archivosSeleccionados.append(quitarTodos);
    for (const [indice, archivo] of archivosElegidos.entries()) {
      const etiqueta = document.createElement("span");
      etiqueta.className = "file-chip";
      const nombre = archivo.webkitRelativePath || archivo.name;
      etiqueta.title = nombre;
      const texto = document.createElement("span");
      texto.className = "file-chip-name";
      texto.textContent = nombre;
      const quitar = document.createElement("button");
      quitar.className = "remove-file-button";
      quitar.type = "button";
      quitar.textContent = "Quitar";
      quitar.disabled = fuentesBloqueadas;
      quitar.title = fuentesBloqueadas
        ? "Cancela la generación para quitar esta fuente."
        : "";
      quitar.setAttribute("aria-label", `Quitar ${nombre}`);
      quitar.addEventListener("click", () => {
        archivosElegidos.splice(indice, 1);
        estadoSelector.hidden = true;
        actualizarResumenFuentes();
        guardarBorradorFuentes().catch((error) => mostrarErrorBorrador(error));
      });
      etiqueta.append(texto, quitar);
      archivosSeleccionados.append(etiqueta);
    }
  }
  const caracteresTexto = textoFuente.value.trim().length;
  if (caracteresTexto) {
    tieneFuentes = true;
    const resumenTexto = document.createElement("span");
    resumenTexto.textContent = `Texto pegado · ${caracteresTexto.toLocaleString("es-ES")} caracteres`;
    archivosSeleccionados.append(resumenTexto);
  }
  if (!tieneFuentes) {
    archivosSeleccionados.textContent =
      "Añade archivos, elige una carpeta o pega texto aquí.";
    return;
  }
}

async function cargarUltimaGeneracion() {
  const asignatura =
    selectorAsignatura.value === "__new__"
      ? asignaturaNueva.value.trim()
      : selectorAsignatura.value;
  if (!asignatura) {
    ultimaGeneracion.hidden = true;
    return;
  }
  try {
    const parametros = new URLSearchParams({ subject: asignatura });
    const respuesta = await fetch(`/api/history?${parametros}`);
    if (!respuesta.ok)
      throw new Error(
        (await respuesta.json()).detail || "No se pudo leer el historial.",
      );
    const historial = (await respuesta.json()).historial ?? [];
    ultimaGeneracion.replaceChildren();

    const cabecera = document.createElement("div");
    cabecera.className = "history-header";
    cabecera.style.display = "flex";
    cabecera.style.justifyContent = "space-between";
    cabecera.style.alignItems = "center";
    cabecera.style.marginBottom = "8px";

    const titulo = document.createElement("strong");
    titulo.textContent = `Historial completo de ${asignatura} · ${historial.length} generación(es)`;
    cabecera.append(titulo);

    let historialVisible = localStorage.getItem("generador.historial_visible") !== "false";

    const botonToggle = document.createElement("button");
    botonToggle.type = "button";
    botonToggle.className = "secondary-button history-toggle-btn";
    botonToggle.style.padding = "4px 10px";
    botonToggle.style.fontSize = "0.85rem";
    botonToggle.setAttribute("aria-label", "Mostrar u ocultar historial");

    const actualizarBotonToggle = () => {
      botonToggle.innerHTML = historialVisible
        ? '<i class="fa-solid fa-eye-slash" aria-hidden="true"></i> Ocultar'
        : '<i class="fa-solid fa-eye" aria-hidden="true"></i> Mostrar';
    };
    actualizarBotonToggle();

    const contenedorEntradas = document.createElement("div");
    contenedorEntradas.className = "history-entries-container";
    contenedorEntradas.hidden = !historialVisible;

    botonToggle.addEventListener("click", () => {
      historialVisible = !historialVisible;
      localStorage.setItem("generador.historial_visible", String(historialVisible));
      actualizarBotonToggle();
      contenedorEntradas.hidden = !historialVisible;
    });

    const accionesCabecera = document.createElement("div");
    accionesCabecera.style.display = "flex";
    accionesCabecera.style.alignItems = "center";
    accionesCabecera.style.gap = "8px";

    if (historial.length > 0) {
      const botonEliminarTodo = document.createElement("button");
      botonEliminarTodo.type = "button";
      botonEliminarTodo.className = "secondary-button";
      botonEliminarTodo.style.padding = "4px 10px";
      botonEliminarTodo.style.fontSize = "0.85rem";
      botonEliminarTodo.style.color = "#ff8a80";
      botonEliminarTodo.style.borderColor = "#ff5252";
      botonEliminarTodo.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Eliminar todo el historial';
      botonEliminarTodo.title = "Eliminar definitivamente todos los informes del historial de esta asignatura";
      botonEliminarTodo.addEventListener("click", async () => {
        if (!window.confirm(`¿Seguro que deseas eliminar definitivamente TODO el historial de "${asignatura}"?`)) return;
        botonEliminarTodo.disabled = true;
        try {
          const resp = await fetch(`/api/history?subject=${encodeURIComponent(asignatura)}&todo=true`, {
            method: "DELETE",
          });
          if (!resp.ok) throw new Error("No se pudo eliminar el historial.");
          await cargarUltimaGeneracion();
        } catch (err) {
          alert(err.message);
          botonEliminarTodo.disabled = false;
        }
      });
      accionesCabecera.append(botonEliminarTodo);
    }

    accionesCabecera.append(botonToggle);
    cabecera.append(accionesCabecera);
    ultimaGeneracion.append(cabecera);

    if (!historial.length) {
      const vacio = document.createElement("span");
      vacio.textContent = "Todavía no hay generaciones guardadas para esta asignatura.";
      contenedorEntradas.append(vacio);
    }
    for (const informe of historial) {
      const entrada = document.createElement("details");
      entrada.className = "generation-history-entry";
      const resumen = document.createElement("summary");
      resumen.textContent = `${new Date(informe.generado).toLocaleString("es-ES")} · Tema ${informe.tema}: ${informe.titulo_tema} · Apartado ${informe.tema}.${informe.subtema}: ${informe.titulo_subtema}`;
      const fuentes = document.createElement("div");
      fuentes.className = "generation-history-files";
      const encabezadoFuentes = document.createElement("strong");
      encabezadoFuentes.textContent = `Archivos procesados (${(informe.archivos_procesados_detalle ?? informe.archivos_procesados ?? []).length})`;
      fuentes.append(encabezadoFuentes);
      const archivosProcesados = informe.archivos_procesados_detalle ??
        (informe.archivos_procesados ?? []).map((nombre) => ({ nombre }));
      for (const archivo of archivosProcesados) {
        const fila = document.createElement("code");
        fila.textContent = archivo.nombre;
        fuentes.append(fila);
      }
      const generados = document.createElement("div");
      generados.className = "generation-history-files";
      const encabezadoGenerados = document.createElement("strong");
      encabezadoGenerados.textContent = "Apuntes generados";
      generados.append(encabezadoGenerados);
      for (const archivo of informe.archivos_generados ?? []) {
        const fila = document.createElement("code");
        fila.textContent = archivo.path;
        generados.append(fila);
      }
      const acciones = document.createElement("div");
      acciones.className = "generation-history-actions";
      acciones.style.display = "flex";
      acciones.style.gap = "8px";
      acciones.style.margin = "8px 0";

      const botonElegir = document.createElement("button");
      botonElegir.type = "button";
      botonElegir.className = "secondary-button";
      botonElegir.textContent = "Elegir esta generación";
      botonElegir.addEventListener("click", (evento) => {
        evento.stopPropagation();
        const conf1 = window.confirm(
          `¿Deseas elegir la generación del Tema ${informe.tema}: ${informe.titulo_tema} (Apartado ${informe.tema}.${informe.subtema})?`,
        );
        if (!conf1) return;
        const conf2 = window.confirm(
          "Confirmación final: Esto seleccionará este tema en el formulario y mostrará los resultados de esta generación. ¿Confirmas la selección?",
        );
        if (!conf2) return;

        if (informe.tema) {
          selectorTema.value = String(informe.tema);
          actualizarCamposTema();
          if (informe.subtema) {
            selectorApartado.value = String(informe.subtema);
            actualizarCamposApartado();
          }
        }
        const resultadoAdaptado = {
          cached: true,
          asignatura: informe.asignatura,
          tema: informe.tema,
          titulo_tema: informe.titulo_tema,
          subtema: informe.subtema,
          titulo_subtema: informe.titulo_subtema,
          documentos_leidos:
            informe.documentos_leidos ??
            (informe.archivos_procesados_detalle ?? []).length,
          archivos_procesados:
            informe.archivos_procesados?.length ??
            (informe.archivos_procesados_detalle ?? []).length,
          conceptos_clave: informe.conceptos_clave ?? [],
          cobertura: informe.cobertura ?? [],
          fuentes: informe.fuentes ?? [],
          avisos: informe.avisos ?? [],
          salida: {
            theme_document: informe.tema_documento ?? "",
            written: (informe.archivos_generados ?? []).map((a) => ({
              titulo: a.titulo ?? a.path?.split("/").pop() ?? "",
              archivo: a.path,
            })),
          },
        };
        mostrarResultados(resultadoAdaptado);
      });

      const botonEliminar = document.createElement("button");
      botonEliminar.type = "button";
      botonEliminar.className = "secondary-button";
      botonEliminar.style.color = "var(--error, #e53e3e)";
      botonEliminar.textContent = "Eliminar del historial";
      botonEliminar.addEventListener("click", async (evento) => {
        evento.stopPropagation();
        if (!window.confirm(`¿Deseas eliminar del historial la generación del Tema ${informe.tema}.${informe.subtema}?`)) return;

        botonEliminar.disabled = true;
        try {
          const params = new URLSearchParams({
            subject: informe.asignatura,
            fingerprint: informe.fingerprint || "",
            tema: String(informe.tema || ""),
            subtema: String(informe.subtema || ""),
          });
          const resp = await fetch(`/api/history?${params}`, {
            method: "DELETE",
          });
          if (!resp.ok) throw new Error("No se pudo eliminar del historial.");
          await cargarUltimaGeneracion();
        } catch (error) {
          alert(error.message);
          botonEliminar.disabled = false;
        }
      });

      const botonMejorarRedaccion = document.createElement("button");
      botonMejorarRedaccion.type = "button";
      botonMejorarRedaccion.className = "secondary-button";
      botonMejorarRedaccion.style.color = "#8fe3b2";
      botonMejorarRedaccion.textContent = "Mejorar redacción con IA";

      const panelMejora = document.createElement("div");
      panelMejora.className = "generation-history-improve-panel";
      panelMejora.style.display = "none";
      panelMejora.style.background = "#1a2536";
      panelMejora.style.border = "1px solid #34463f";
      panelMejora.style.borderRadius = "6px";
      panelMejora.style.padding = "12px";
      panelMejora.style.margin = "8px 0";

      const tituloMejora = document.createElement("strong");
      tituloMejora.textContent = "Mejorar redacción docente con IA (calificación 10)";
      tituloMejora.style.display = "block";
      tituloMejora.style.marginBottom = "8px";
      tituloMejora.style.color = "#c5f0d7";

      const grupoOpciones = document.createElement("div");
      grupoOpciones.style.display = "grid";
      grupoOpciones.style.gap = "6px";
      grupoOpciones.style.marginBottom = "10px";

      const archivosGenerados = informe.archivos_generados ?? [];

      const labelTodos = document.createElement("label");
      labelTodos.style.display = "flex";
      labelTodos.style.alignItems = "center";
      labelTodos.style.gap = "6px";
      labelTodos.style.cursor = "pointer";
      const radioTodos = document.createElement("input");
      radioTodos.type = "radio";
      radioTodos.name = `mejora-alcance-${informe.fingerprint || Math.random()}`;
      radioTodos.value = "todos";
      radioTodos.checked = true;
      labelTodos.append(radioTodos, document.createTextNode(`Todos los apartados (${archivosGenerados.length} archivo(s))`));

      const labelUno = document.createElement("label");
      labelUno.style.display = "flex";
      labelUno.style.alignItems = "center";
      labelUno.style.gap = "6px";
      labelUno.style.cursor = "pointer";
      const radioUno = document.createElement("input");
      radioUno.type = "radio";
      radioUno.name = radioTodos.name;
      radioUno.value = "uno";
      labelUno.append(radioUno, document.createTextNode("Elegir un apunte específico"));

      const selectorArchivo = document.createElement("select");
      selectorArchivo.style.width = "100%";
      selectorArchivo.style.padding = "6px";
      selectorArchivo.style.background = "#0f1722";
      selectorArchivo.style.color = "#cbd6e6";
      selectorArchivo.style.border = "1px solid #34463f";
      selectorArchivo.style.borderRadius = "4px";
      selectorArchivo.style.display = "none";
      selectorArchivo.style.marginTop = "4px";

      for (const archivo of archivosGenerados) {
        const opcion = document.createElement("option");
        opcion.value = archivo.path;
        opcion.textContent = archivo.titulo ? `${archivo.titulo} (${archivo.path.split("/").pop()})` : archivo.path;
        selectorArchivo.append(opcion);
      }

      radioTodos.addEventListener("change", () => {
        selectorArchivo.style.display = "none";
      });
      radioUno.addEventListener("change", () => {
        selectorArchivo.style.display = "block";
      });

      grupoOpciones.append(labelTodos, labelUno, selectorArchivo);

      const labelInstruccion = document.createElement("label");
      labelInstruccion.style.display = "block";
      labelInstruccion.style.marginBottom = "4px";
      labelInstruccion.style.fontSize = "12px";
      labelInstruccion.textContent = "Instrucciones de mejora para la IA (opcional):";

      const inputInstruccion = document.createElement("textarea");
      inputInstruccion.rows = 2;
      inputInstruccion.style.width = "100%";
      inputInstruccion.style.boxSizing = "border-box";
      inputInstruccion.style.padding = "6px";
      inputInstruccion.style.background = "#0f1722";
      inputInstruccion.style.color = "#cbd6e6";
      inputInstruccion.style.border = "1px solid #34463f";
      inputInstruccion.style.borderRadius = "4px";
      inputInstruccion.style.marginBottom = "8px";
      inputInstruccion.placeholder = "Ej: Explicar a fondo con estilo docente claro, razonamiento técnico profundo, definiciones precisas y ejemplos originales para sacar un 10.";

      const barraBotones = document.createElement("div");
      barraBotones.style.display = "flex";
      barraBotones.style.gap = "8px";
      barraBotones.style.alignItems = "center";

      const botonEjecutar = document.createElement("button");
      botonEjecutar.type = "button";
      botonEjecutar.className = "primary-button";
      botonEjecutar.textContent = "Reescribir con IA ahora";

      const botonCerrar = document.createElement("button");
      botonCerrar.type = "button";
      botonCerrar.className = "secondary-button";
      botonCerrar.textContent = "Cancelar";
      botonCerrar.addEventListener("click", () => {
        panelMejora.style.display = "none";
      });

      const estadoMejora = document.createElement("span");
      estadoMejora.style.fontSize = "12px";
      estadoMejora.style.color = "#8fe3b2";

      barraBotones.append(botonEjecutar, botonCerrar, estadoMejora);

      panelMejora.append(tituloMejora, grupoOpciones, labelInstruccion, inputInstruccion, barraBotones);

      botonMejorarRedaccion.addEventListener("click", (evento) => {
        evento.stopPropagation();
        panelMejora.style.display = panelMejora.style.display === "none" ? "block" : "none";
      });

      botonEjecutar.addEventListener("click", async (evento) => {
        evento.stopPropagation();
        const archivosTarget = radioTodos.checked
          ? archivosGenerados.map((a) => a.path)
          : [selectorArchivo.value];

        botonEjecutar.disabled = true;
        botonCerrar.disabled = true;
        estadoMejora.textContent = "Reescribiendo y mejorando redacción con IA local... Esto puede tardar unos segundos.";

        try {
          const resp = await fetch("/api/history/improve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              subject: informe.asignatura,
              tema: informe.tema,
              subtema: informe.subtema,
              fingerprint: informe.fingerprint || "",
              archivos: archivosTarget,
              instruccion: inputInstruccion.value.trim(),
            }),
          });
          const datos = await resp.json();
          if (!resp.ok) throw new Error(datos.detail || "Error al mejorar la redacción con IA.");

          estadoMejora.textContent = "¡Redacción mejorada con éxito! Aparece ahora en el historial.";
          setTimeout(async () => {
            panelMejora.style.display = "none";
            await cargarUltimaGeneracion();
          }, 1500);
        } catch (err) {
          estadoMejora.textContent = `Error: ${err.message}`;
          botonEjecutar.disabled = false;
          botonCerrar.disabled = false;
        }
      });

      acciones.append(botonElegir, botonMejorarRedaccion, botonEliminar);
      entrada.append(resumen, acciones, panelMejora, fuentes, generados);
      contenedorEntradas.append(entrada);
    }
    ultimaGeneracion.append(contenedorEntradas);
    ultimaGeneracion.hidden = false;
  } catch (fallo) {
    ultimaGeneracion.textContent = fallo.message;
    ultimaGeneracion.hidden = false;
  }
}

function anadirSeccionResultado(titulo, contenido) {
  const seccion = document.createElement("section");
  seccion.className = "result-section";
  const encabezado = document.createElement("h3");
  encabezado.textContent = titulo;
  seccion.append(encabezado, contenido);
  panelResultados.append(seccion);
}

function tituloNumerado(tipo, numero, titulo) {
  const nombre = String(titulo ?? "")
    .trim()
    .replace(/^tema\s+\d+\s*(?:[-:–—·]\s*)?/i, "")
    .replace(/^apartado\s+\d+(?:\.\d+)?\s*(?:[-:–—·]\s*)?/i, "");
  return `${tipo} ${numero}${nombre ? ` - ${nombre}` : ""}`;
}

function mostrarResultados(resultado) {
  panelResultados.replaceChildren();
  const encabezado = document.createElement("div");
  encabezado.className = "result-head";
  const rotulo = document.createElement("p");
  rotulo.className = "eyebrow";
  rotulo.textContent = resultado.cached
    ? "ÚLTIMA GENERACIÓN · YA ESTABA GUARDADA"
    : "GENERACIÓN COMPLETADA";
  const titulo = document.createElement("h2");
  titulo.textContent = `${resultado.asignatura} · ${tituloNumerado("Tema", resultado.tema, resultado.titulo_tema)} · ${tituloNumerado("Apartado", `${resultado.tema}.${resultado.subtema}`, resultado.titulo_subtema)}`;
  const descripcion = document.createElement("p");
  descripcion.textContent = `${resultado.documentos_leidos} fuente(s) leídas, de ${resultado.archivos_procesados} archivo(s). Esta generación se compara solo con los apuntes de esta asignatura.`;
  const estadisticas = document.createElement("div");
  estadisticas.className = "result-stats";
  for (const nombreEstadistica of [
    `${resultado.conceptos_clave.length} conceptos clave`,
    `${resultado.cobertura.length} conceptos revisados`,
    `${resultado.salida.written.length} archivos LaTeX`,
  ]) {
    const etiquetaEstadistica = document.createElement("span");
    etiquetaEstadistica.className = "stat-chip";
    etiquetaEstadistica.textContent = nombreEstadistica;
    estadisticas.append(etiquetaEstadistica);
  }

  encabezado.append(rotulo, titulo, descripcion, estadisticas);
  panelResultados.append(encabezado);

  if (resultado.conceptos_clave.length) {
    const conceptos = document.createElement("div");
    conceptos.className = "concept-list";
    for (const concepto of resultado.conceptos_clave) {
      const etiqueta = document.createElement("span");
      etiqueta.className = "concept-chip";
      etiqueta.textContent = String(concepto);
      conceptos.append(etiqueta);
    }
    anadirSeccionResultado("Conceptos clave del material", conceptos);
  }

  if (resultado.cobertura.length) {
    const lista = document.createElement("ul");
    lista.className = "coverage-list";
    const estados = {
      incluido: ["Incluido ahora", "included"],
      ya_cubierto: ["Ya cubierto", "covered"],
      pendiente: ["Pendiente de revisar", "pending"],
    };
    for (const elemento of resultado.cobertura) {
      const fila = document.createElement("li");
      fila.className = "coverage-item";
      const [etiqueta, color] = estados[elemento.estado] ?? estados.pendiente;
      const insignia = document.createElement("span");
      insignia.className = `coverage-badge ${color}`;
      insignia.textContent = etiqueta;
      const texto = document.createElement("span");
      texto.textContent = `${elemento.concepto ?? "Concepto"}${elemento.apartado ? ` — ${elemento.apartado}` : ""}`;
      fila.append(insignia, texto);
      lista.append(fila);
    }
    anadirSeccionResultado("Cobertura para estudiar", lista);
  }

  const listaArchivos = document.createElement("ul");
  listaArchivos.className = "file-list";
  for (const archivo of resultado.salida.written) {
    const fila = document.createElement("li");
    fila.textContent = `${archivo.titulo}: ${archivo.archivo}`;
    listaArchivos.append(fila);
  }
  if (!resultado.salida.written.length) {
    const fila = document.createElement("li");
    fila.textContent =
      "No se creó ningún archivo nuevo. Revisa si los apartados ya existían.";
    listaArchivos.append(fila);
  }
  anadirSeccionResultado("Apuntes LaTeX guardados", listaArchivos);

  if (resultado.fuentes.length) {
    const listaFuentes = document.createElement("ul");
    listaFuentes.className = "source-list";
    for (const fuente of resultado.fuentes) {
      const fila = document.createElement("li");
      const enlace = document.createElement("a");
      enlace.href = fuente.url;
      enlace.target = "_blank";
      enlace.rel = "noopener noreferrer";
      enlace.textContent = fuente.titulo;
      fila.append(enlace, document.createTextNode(` — ${fuente.url}`));
      listaFuentes.append(fila);
    }
    anadirSeccionResultado("Fuentes web consultadas", listaFuentes);
  }
  if (resultado.avisos.length) {
    const aviso = document.createElement("div");
    aviso.className = "warning";
    aviso.textContent = resultado.avisos.join(" · ");
    anadirSeccionResultado("Avisos de lectura y guardado", aviso);
  }
  const pie = document.createElement("p");
  pie.className = "result-footer";
  pie.textContent = `Documento del tema: ${resultado.salida.theme_document}. Puedes seleccionar un apunte y mejorarlo en la página de revisión.`;
  panelResultados.append(pie);
  panelResultados.hidden = false;
  panelResultados.scrollIntoView({ behavior: "smooth", block: "start" });
}

function mostrarProgresoGeneracion(
  estado,
  investigar,
  compararApuntes =
    compararApuntesHabilitado(),
  mostrarConfirmacion = true,
  progresoDirecto = null,
) {
  const fases = fasesProgreso.filter(
    ([id]) =>
      (id !== "internet" || investigar) &&
      (id !== "comparacion" || compararApuntes) &&
      (id !== "confirmacion" || mostrarConfirmacion),
  );
  const indiceActual = fases.findIndex(([id]) => id === estado.fase);
  etiquetaProgreso.textContent = estado.mensaje;
  detalleProgreso.textContent = estado.detalle;
  iconoProgreso.className =
    estado.fase === "completado"
      ? "fa-solid fa-circle-check spinner"
      : estado.fase === "cancelado"
        ? "fa-solid fa-circle-stop spinner"
        : estado.fase === "error"
          ? "fa-solid fa-triangle-exclamation spinner"
          : "fa-solid fa-spinner fa-spin spinner";
  if (Number.isFinite(estado.segundosRestantes)) {
    const nuevoToken = `${estado.actualizado}:${estado.segundosRestantes}`;
    if (nuevoToken !== tokenEtaServidor) {
      ultimoEstadoProgreso = {
        segundosRestantes: estado.segundosRestantes,
        recibido: Date.now(),
      };
      tokenEtaServidor = nuevoToken;
    }
  } else if (estado.fase !== "ia") {
    ultimoEstadoProgreso = null;
    tokenEtaServidor = undefined;
  }
  actualizarTiempoEstimado();
  if (estado.fase === "cancelado")
    tiempoEstimado.textContent = "Tiempo estimado: detenido por ti.";
  if (estado.fase === "completado")
    tiempoEstimado.textContent = "Tiempo estimado: completado.";
  if (estado.fase === "error")
    tiempoEstimado.textContent = "Tiempo estimado: no disponible por el error.";
  if (progresoDirecto !== null && Number.isFinite(progresoDirecto)) {
    barraProgreso.value = Math.max(0, Math.min(100, progresoDirecto));
  } else if (estado.total > 0) {
    barraProgreso.value =
      ((Math.max(indiceActual, 0) +
        estado.actual / estado.total) /
        fases.length) *
      100;
  } else {
    barraProgreso.value =
      (Math.max(indiceActual, 0) / fases.length) * 100;
  }
  listaPasosProgreso.replaceChildren();
  for (const [indice, [id, nombre]] of fases.entries()) {
    const paso = document.createElement("li");
    paso.className =
      indice < indiceActual
        ? "progress-step done"
        : indice === indiceActual
          ? "progress-step current"
          : "progress-step";
    if (indice === indiceActual) paso.setAttribute("aria-current", "step");
    paso.textContent = nombre;
    listaPasosProgreso.append(paso);
  }
}

function actualizarTiempoEstimado() {
  if (!ultimoEstadoProgreso) {
    tiempoEstimado.textContent = "Tiempo estimado: calculando la primera etapa…";
    return;
  }
  const restante = Math.max(
    0,
    ultimoEstadoProgreso.segundosRestantes -
      Math.floor((Date.now() - ultimoEstadoProgreso.recibido) / 1000),
  );
  if (restante === 0) {
    tiempoEstimado.textContent = "Tiempo estimado: finalizando y guardando…";
  } else if (restante < 60) {
    tiempoEstimado.textContent = `Tiempo estimado restante: aproximadamente ${restante} s. Se recalcula mientras trabaja.`;
  } else {
    const duracion = formatearDuracion(restante);
    tiempoEstimado.textContent = `Tiempo estimado restante: aproximadamente ${duracion}. Se recalcula mientras trabaja.`;
  }
}

async function consultarProgreso(
  id,
  investigar,
  asignaturaTrabajo = asignaturaGeneracionActiva,
  monitorId = monitorGeneracionActivo,
) {
  const consultaActual = ++ultimaConsultaProgreso;
  try {
    const respuesta = await fetch(`/api/progress/${encodeURIComponent(id)}`);
    if (!respuesta.ok) return;
    const estado = await respuesta.json();
    if (
      consultaActual !== ultimaConsultaProgreso ||
      monitorId !== monitorGeneracionActivo ||
      asignaturaTrabajo !== selectorAsignatura.value
    )
      return;
    if (estado.fase === "cancelado") {
      generacionDetenida = true;
      const progresoPrevio = barraProgreso.value;
      mostrarProgresoGeneracion(
        estado,
        investigar,
        compararApuntesHabilitado(),
      );
      barraProgreso.value = Math.min(progresoPrevio, 95);
      return;
    }
    if (estado.fase === "error") {
      mostrarProgresoGeneracion(
        estado,
        investigar,
        compararApuntesHabilitado(),
      );
      return;
    }
    mostrarProgresoGeneracion(
      estado,
      investigar,
      compararApuntesHabilitado(),
    );
  } catch {
    // El envío de la generación sigue siendo la fuente de verdad si falla el sondeo.
  }
}

async function detenerGeneracion() {
  if (!idGeneracionActiva || generacionDetenida) return;
  botonDetener.disabled = true;
  botonDetener.textContent = "Deteniendo…";
  try {
    const respuesta = await fetch(
      `/api/progress/${encodeURIComponent(idGeneracionActiva)}/cancel`,
      { method: "POST" },
    );
    if (respuesta.status === 409) {
      generacionDetenida = false;
      const resultado = await respuesta.json();
      detalleProgreso.textContent = resultado.detail;
      botonDetener.hidden = true;
      if (botonReiniciar) botonReiniciar.hidden = true;
      return;
    }
    if (!respuesta.ok) {
      const resultado = await respuesta.json();
      throw new Error(resultado.detail || "No se pudo detener la generación.");
    }
    generacionDetenida = true;
    fuentesBloqueadas = false;
    actualizarResumenFuentes();
    controladorGeneracion?.abort();
    progreso.hidden = true;
    idGeneracionActiva = undefined;
    controladorGeneracion = undefined;
    try {
      await cargarTrabajosPendientes();
    } catch {
      // Silencioso: el panel se actualizará en el siguiente sondeo.
    }
  } catch (error) {
    botonDetener.disabled = false;
    botonDetener.textContent = "Detener generación";
    panelError.textContent = error.message;
    panelError.hidden = false;
  }
}

async function comprobarEstadoModelo() {
  try {
    const respuesta = await fetch("/api/health");
    const estadoSalud = await respuesta.json();
    estadoModelo.classList.toggle(
      "ready",
      estadoSalud.connected && estadoSalud.modelAvailable,
    );
    estadoModelo.classList.toggle("failed", !estadoSalud.connected);
    estadoModelo.querySelector("span:last-child").textContent =
      estadoSalud.modelAvailable
        ? `IA local lista · ${estadoSalud.model}`
        : estadoSalud.connected
          ? `Preparando el modelo local ${estadoSalud.model}…`
          : "IA local sin conexión";
  } catch {
    estadoModelo.classList.add("failed");
    estadoModelo.querySelector("span:last-child").textContent =
      "No se pudo conectar con el servidor";
  }
}

document
  .querySelector("#material-contiene-codigo")
  .addEventListener("change", guardarPreferenciaSeleccion);

selectorAsignatura.addEventListener("change", () => {
  const asignaturaSeleccionada = selectorAsignatura.value;
  if (asignaturaSeleccionada !== "__new__") {
    localStorage.setItem("generador.asignatura", asignaturaSeleccionada);
  }
  const seguimientoDeOtraAsignatura =
    asignaturaGeneracionActiva &&
    asignaturaGeneracionActiva !== asignaturaSeleccionada;
  if (seguimientoDeOtraAsignatura) {
    progreso.hidden = true;
    botonDetener.hidden = true;
    if (botonReiniciar) botonReiniciar.hidden = true;
    panelResultados.hidden = true;
    panelError.hidden = true;
    ultimoEstadoProgreso = undefined;
  }
  cambioAsignaturaPendiente = (async () => {
    try {
      const resp = await fetch("/api/subjects");
      if (resp.ok) {
        asignaturas = (await resp.json()).asignaturas ?? asignaturas;
      }
    } catch {}
    actualizarCamposAsignatura();
    archivosElegidos = [];
    textoFuente.value = "";
    asignaturaBorradorActiva = "";
    await cargarBorradorFuentes();
    actualizarResumenFuentes();
    await cargarUltimaGeneracion();
    await cargarTrabajosPendientes();
    if (selectorAsignatura.value !== "__new__") {
      guardarPreferenciaSeleccion();
    }
  })().catch((error) => {
    panelError.textContent = error.message;
    panelError.hidden = false;
    throw error;
  });
});
asignaturaNueva.addEventListener("input", cargarUltimaGeneracion);
selectorTema.addEventListener("change", () => {
  actualizarCamposTema();
  guardarPreferenciaSeleccion();
});
temaNuevo.addEventListener("input", cargarUltimaGeneracion);
selectorApartado.addEventListener("change", () => {
  actualizarCamposApartado();
  guardarPreferenciaSeleccion();
});
apartadoNuevo.addEventListener("input", cargarUltimaGeneracion);
botonCrearAsignatura.addEventListener("click", async () => {
  botonCrearAsignatura.disabled = true;
  panelError.hidden = true;
  estadoAsignatura.hidden = true;
  try {
    const nombre = await crearCarpetaNuevaAsignatura();
    estadoAsignatura.textContent = `Carpeta «${nombre}» creada correctamente.`;
    estadoAsignatura.hidden = false;
  } catch (error) {
    panelError.textContent = error.message;
    panelError.hidden = false;
    panelError.scrollIntoView({ behavior: "smooth", block: "center" });
  } finally {
    botonCrearAsignatura.disabled = false;
  }
});
botonDetener.addEventListener("click", async () => {
  const conf1 = window.confirm("¿Seguro que deseas detener la generación en curso?");
  if (!conf1) return;
  const conf2 = window.confirm("Confirmación final: Se cancelará el proceso actual de la IA. ¿Confirmas definitivamente detener la generación?");
  if (!conf2) return;
  await detenerGeneracion();
});

if (botonReiniciar) {
  botonReiniciar.addEventListener("click", async () => {
    const conf1 = window.confirm("¿Seguro que deseas reiniciar la generación y borrar el historial de esta tarea?");
    if (!conf1) return;
    const conf2 = window.confirm("Confirmación final: Esta acción reiniciará todo el progreso desde cero y reseteará el historial. ¿Confirmas definitivamente el reinicio?");
    if (!conf2) return;
    await reiniciarGeneracionEHistorial();
  });
}

const botonPausarConsola = document.querySelector("#boton-pausar-consola");
const botonToggleConsola = document.querySelector("#boton-toggle-consola");
const consolaEstado = document.querySelector("#consola-estado");
const textoConsola = document.querySelector("#texto-consola");

if (botonPausarConsola) {
  botonPausarConsola.addEventListener("click", () => {
    consolaPausada = !consolaPausada;
    if (consolaPausada) {
      botonPausarConsola.innerHTML = '<i class="fa-solid fa-play" aria-hidden="true"></i> <span>Reanudar registro</span>';
      if (consolaEstado) {
        consolaEstado.textContent = "Pausado";
        consolaEstado.classList.add("paused");
      }
    } else {
      botonPausarConsola.innerHTML = '<i class="fa-solid fa-pause" aria-hidden="true"></i> <span>Parar registro</span>';
      if (consolaEstado) {
        consolaEstado.textContent = "Activo";
        consolaEstado.classList.remove("paused");
      }
      if (textoConsola) {
        textoConsola.textContent = registroConsolaEnVivo.slice(-100).join("\n");
        textoConsola.scrollTop = textoConsola.scrollHeight;
      }
    }
  });
}

if (botonToggleConsola) {
  botonToggleConsola.addEventListener("click", () => {
    consolaOculta = !consolaOculta;
    if (textoConsola) textoConsola.hidden = consolaOculta;
    if (consolaOculta) {
      botonToggleConsola.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> <span>Habilitar registro</span>';
    } else {
      botonToggleConsola.innerHTML = '<i class="fa-solid fa-ban" aria-hidden="true"></i> <span>Deshabilitar registro</span>';
      if (textoConsola) textoConsola.scrollTop = textoConsola.scrollHeight;
    }
  });
}

async function reiniciarGeneracionEHistorial() {
  botonDetener.disabled = true;
  if (botonReiniciar) {
    botonReiniciar.disabled = true;
    botonReiniciar.textContent = "Reiniciando…";
  }
  try {
    const id = idGeneracionActiva;
    const asignatura =
      selectorAsignatura.value === "__new__"
        ? asignaturaNueva.value.trim()
        : selectorAsignatura.value;

    if (asignatura && asignatura !== "__new__") {
      try {
        await fetch(`/api/history?subject=${encodeURIComponent(asignatura)}`, { method: "DELETE" });
      } catch {}
    }

    // Durante la subida/inicialización todavía solo existe el UUID de
    // seguimiento. En ese punto no se puede llamar a repeat-stage porque
    // el servidor aún no ha creado (o terminado de preparar) el trabajo.
    // Se cancela esa solicitud y el finally del formulario la vuelve a
    // enviar desde el principio conservando fuentes y opciones.
    if (idProgresoActual && !inicioEtapasDisponible) {
      reiniciarAlFinalizar = true;
      generacionDetenida = true;
      try {
        await fetch(
          `/api/progress/${encodeURIComponent(idProgresoActual)}/cancel`,
          { method: "POST" },
        );
      } catch {
        // Aunque falle la notificación, abortar la petición local evita
        // que el envío anterior continúe en esta pestaña.
      }
      if (idTrabajoPreparandose) {
        try {
          await fetch(
            `/api/staged-generations/${encodeURIComponent(idTrabajoPreparandose)}`,
            { method: "DELETE" },
          );
        } catch {}
      }
      controladorGeneracion?.abort();
      progreso.hidden = true;
      if (botonReiniciar) botonReiniciar.textContent = "Preparando reinicio…";
      return;
    }

    if (id) {
      await repetirEtapaTrabajo(id, "desde-cero");
      await cargarUltimaGeneracion();
      return;
    }

    if (archivosElegidos.length || textoFuente.value.trim()) {
      formulario.requestSubmit();
      return;
    }

    progreso.hidden = true;
    botonDetener.hidden = true;
    if (botonReiniciar) botonReiniciar.hidden = true;
    botonGenerar.disabled = false;
    controladorGeneracion = undefined;
    asignaturaGeneracionActiva = undefined;

    await cargarUltimaGeneracion();
    await cargarTrabajosPendientes();
  } catch (error) {
    panelError.textContent = error.message || "Error al reiniciar.";
    panelError.hidden = false;
  } finally {
    botonDetener.disabled = false;
    if (botonReiniciar) {
      botonReiniciar.disabled = false;
      botonReiniciar.innerHTML = '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Reiniciar generación';
    }
  }
}
function mostrarEstadoSelector(mensaje) {
  estadoSelector.textContent = mensaje;
  estadoSelector.hidden = false;
}

for (const selector of [selectorArchivos, selectorCarpeta]) {
  selector.addEventListener("click", () => {
    mostrarEstadoSelector(
      "Se ha activado el selector de archivos de Brave. Elige los archivos en la ventana del sistema o ciérrala para cancelar.",
    );
  });
}
selectorArchivos.addEventListener("change", () => {
  mostrarArchivos(selectorArchivos.files);
  selectorArchivos.value = "";
});
selectorCarpeta.addEventListener("change", () => {
  mostrarAsignaturasDetectadas(selectorCarpeta.files);
  mostrarArchivos(selectorCarpeta.files);
  selectorCarpeta.value = "";
});
zonaArchivos.addEventListener("dragover", (evento) => {
  if (!evento.dataTransfer?.types.includes("Files")) return;
  evento.preventDefault();
  zonaArchivos.classList.add("drag-over");
});
zonaArchivos.addEventListener("dragleave", (evento) => {
  if (evento.relatedTarget && zonaArchivos.contains(evento.relatedTarget)) return;
  zonaArchivos.classList.remove("drag-over");
});
zonaArchivos.addEventListener("drop", (evento) => {
  if (!evento.dataTransfer?.files.length) return;
  evento.preventDefault();
  zonaArchivos.classList.remove("drag-over");
  mostrarArchivos(evento.dataTransfer.files);
});
textoFuente.addEventListener("input", () => {
  actualizarResumenFuentes();
  programarGuardadoTexto();
});

formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  await cambioAsignaturaPendiente;
  panelError.hidden = true;
  panelResultados.hidden = true;
  if (!archivosElegidos.length && !textoFuente.value.trim()) {
    panelError.textContent =
      "Selecciona archivos, elige una carpeta o pega el texto que quieres convertir en apuntes.";
    panelError.hidden = false;
    return;
  }
  if (!estadoModelo.classList.contains("ready")) {
    panelError.textContent =
      "La IA local no está lista. Comprueba Ollama y la descarga del modelo con el acceso directo del escritorio.";
    panelError.hidden = false;
    return;
  }
  const asignatura =
    selectorAsignatura.value === "__new__"
      ? asignaturaNueva.value.trim()
      : selectorAsignatura.value;
  if (!asignatura) {
    panelError.textContent = "Escribe el nombre de la asignatura.";
    panelError.hidden = false;
    return;
  }
  if (selectorAsignatura.value === "__new__") {
    try {
      await crearCarpetaNuevaAsignatura();
    } catch (error) {
      panelError.textContent = error.message;
      panelError.hidden = false;
      return;
    }
  }

  const datos = new FormData();
  const idProgreso = crypto.randomUUID();
  const monitorId = ++monitorGeneracionActivo;
  controladorGeneracion = new AbortController();
  idGeneracionActiva = idProgreso;
  idProgresoActual = idProgreso;
  inicioEtapasDisponible = false;
  asignaturaGeneracionActiva = asignatura;
  generacionDetenida = false;
  ultimoEstadoProgreso = null;
  tokenEtaServidor = undefined;
  fuentesBloqueadas = true;
  actualizarResumenFuentes();
  datos.append("progress_id", idProgreso);
  datos.append("subject", asignatura);
  datos.append("tema", String(numeroTemaSeleccionado()));
  datos.append("tema_nombre", tituloTemaSeleccionado());
  datos.append("subtema", String(numeroApartadoSeleccionado()));
  datos.append("subtema_nombre", tituloApartadoSeleccionado());
  datos.append(
    "replace_existing",
    String(document.querySelector("#sustituir-existentes").checked),
  );
  datos.append("user_prompt", document.querySelector("#instruccion-estudiante").value);
  datos.append("research_enabled", String(investigacionWeb.checked));
  datos.append(
    "code_analysis_enabled",
    String(document.querySelector("#material-contiene-codigo").checked),
  );
  datos.append(
    "compare_notes_enabled",
    String(compararApuntesHabilitado()),
  );
  datos.append("source_text", textoFuente.value);
  for (const archivo of archivosElegidos)
    datos.append("files", archivo, archivo.webkitRelativePath || archivo.name);
  botonGenerar.disabled = true;
  botonDetener.hidden = false;
  botonDetener.disabled = false;
  botonDetener.innerHTML =
    '<i class="fa-solid fa-stop" aria-hidden="true"></i> Detener generación';
  if (botonReiniciar) {
    botonReiniciar.hidden = false;
    botonReiniciar.disabled = false;
    botonReiniciar.innerHTML =
      '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Reiniciar generación';
  }
  progreso.hidden = false;
  mostrarProgresoGeneracion(
    {
      fase: "subida",
      mensaje: "Enviando el material al servidor local",
      detalle: `${archivosElegidos.length} archivo(s) y ${textoFuente.value.trim().length.toLocaleString("es-ES")} caracteres de texto pegado. Los archivos se procesan en tu equipo; la búsqueda web solo usa consultas derivadas si la activas.`,
    },
    investigacionWeb.checked,
  );
  const temporizador = window.setInterval(() => {
    consultarProgreso(
      idProgreso,
      investigacionWeb.checked,
      asignatura,
      monitorId,
    );
    actualizarTiempoEstimado();
  }, 1000);
  try {
    await consultarProgreso(
      idProgreso,
      investigacionWeb.checked,
      asignatura,
      monitorId,
    );
    // Todas las generaciones usan el flujo por etapas: guarda el progreso en
    // disco (.procesamiento) y permite reanudar sin perderlo al recargar.
    let inicioTrabajo;
    if (archivosElegidos.length > 5) {
      // Subida en lotes tolerante a fallos para 35+ archivos sin sobrecargar memoria ni tiempo de espera
      const metadata = new FormData();
      for (const [clave, valor] of datos.entries()) {
        if (clave !== "files" && clave !== "source_text") {
          metadata.append(clave, valor);
        }
      }
      const respInit = await fetch("/api/staged-generations/init", {
        method: "POST",
        body: metadata,
        signal: controladorGeneracion.signal,
      });
      if (!respInit.ok)
        throw new Error((await respInit.json()).detail || "Error al inicializar la generación.");
      const trabajoCreado = await respInit.json();
      const jobId = trabajoCreado.id;
      idTrabajoPreparandose = jobId;

      const TAMANO_LOTE = 5;
      for (let i = 0; i < archivosElegidos.length; i += TAMANO_LOTE) {
        if (controladorGeneracion.signal.aborted) break;
        const lote = archivosElegidos.slice(i, i + TAMANO_LOTE);
        const loteData = new FormData();
        for (const file of lote) loteData.append("files", file);

        const subidos = Math.min(i + lote.length, archivosElegidos.length);
        const pct = Math.round((subidos / archivosElegidos.length) * 100);
        mostrarProgresoGeneracion(
          {
            fase: "subida",
            mensaje: `Subiendo archivos al servidor (${subidos} de ${archivosElegidos.length})`,
            detalle: `Lote ${Math.floor(i / TAMANO_LOTE) + 1} de ${Math.ceil(archivosElegidos.length / TAMANO_LOTE)} · ${pct}% completado`,
            actual: subidos,
            total: archivosElegidos.length,
          },
          investigacionWeb.checked,
        );

        const respLote = await fetch(
          `/api/staged-generations/${encodeURIComponent(jobId)}/batch-upload`,
          {
            method: "POST",
            body: loteData,
            signal: controladorGeneracion.signal,
          },
        );
        if (!respLote.ok)
          throw new Error((await respLote.json()).detail || "Error al subir lote de archivos.");
      }

      const startData = new FormData();
      if (datos.has("source_text")) {
        startData.append("source_text", datos.get("source_text"));
      }
      const respStart = await fetch(
        `/api/staged-generations/${encodeURIComponent(jobId)}/start`,
        {
          method: "POST",
          body: startData,
          signal: controladorGeneracion.signal,
        },
      );
      if (!respStart.ok)
        throw new Error((await respStart.json()).detail || "Error al arrancar el procesamiento.");
      inicioTrabajo = await respStart.json();
      idTrabajoPreparandose = undefined;
      inicioEtapasDisponible = true;
    } else {
      const inicio = await fetch("/api/staged-generations", {
        method: "POST",
        body: datos,
        signal: controladorGeneracion.signal,
      });
      if (!inicio.ok)
        throw new Error(
          (await inicio.json()).detail ||
            `No se pudo iniciar la generación (${inicio.status}).`,
        );
      inicioTrabajo = await inicio.json();
      inicioEtapasDisponible = true;
    }
    window.clearInterval(temporizador);
    idGeneracionActiva = inicioTrabajo.id;
    await vigilarTrabajoEtapas(inicioTrabajo.id, asignatura, monitorId);
    await cargarAsignaturas();
    guardarPreferenciaSeleccion();
  } catch (fallo) {
    if (generacionDetenida || fallo.name === "AbortError") {
      if (!generacionDetenida)
        mostrarProgresoGeneracion(
          {
            fase: "cancelado",
            mensaje: "Generación detenida",
            detalle: "Se canceló la solicitud. No se mostrarán resultados incompletos.",
          },
          investigacionWeb.checked,
        );
      return;
    }
    panelError.textContent =
      fallo.message || "No se pudieron generar los apuntes.";
    panelError.hidden = false;
    try {
      await cargarTrabajosPendientes();
    } catch (errorEstado) {
      panelError.textContent += ` ${errorEstado.message}`;
    }
  } finally {
    window.clearInterval(temporizador);
    if (!generacionDetenida) progreso.hidden = false;
    botonDetener.hidden = true;
    botonDetener.disabled = false;
    controladorGeneracion = undefined;
    idGeneracionActiva = undefined;
    idProgresoActual = undefined;
    idTrabajoPreparandose = undefined;
    inicioEtapasDisponible = false;
    await cargarTrabajosPendientes();
    if (reiniciarAlFinalizar) {
      reiniciarAlFinalizar = false;
      generacionDetenida = false;
      progreso.hidden = true;
      botonGenerar.disabled = false;
      if (botonReiniciar) botonReiniciar.hidden = true;
      // Esperar a que termine por completo el envío anterior antes de
      // volver a enviar los mismos archivos y opciones desde el formulario.
      window.setTimeout(() => formulario.requestSubmit(), 0);
    }
  }
});

window.setInterval(actualizarTiempoEstimado, 1000);

/**
 * Mantiene el contador visual sincronizado con el progreso real de
 * /api/staged-generations sin necesidad de recargar la página.
 * Consulta periódicamente los trabajos en curso de la asignatura actual
 * y actualiza la barra de progreso cuando hay bloques terminados.
 */
let temporizadorProgresoStaged = null;

async function vigilarProgresoStagedGenerations() {
  // Si ya hay un flujo local activo (generación iniciada o reanudada desde
  // esta pestaña), su propia vigilancia actualiza el progreso; no duplicar.
  if (controladorGeneracion) return;
  try {
    const respuesta = await fetch("/api/staged-generations");
    if (!respuesta.ok) return;
    const { trabajos } = await respuesta.json();
    const trabajoProcesando = (trabajos ?? []).find(
      (t) => t.estado === "procesando",
    );
    if (trabajoProcesando) {
      let trabajoDetallado = trabajoProcesando;
      try {
        const resDetalle = await fetch(
          `/api/staged-generations/${encodeURIComponent(trabajoProcesando.id)}`,
        );
        if (resDetalle.ok) trabajoDetallado = await resDetalle.json();
      } catch {}

      // Solo auto-seleccionar la asignatura en curso en la carga inicial si no se está creando una nueva
      const usuarioCreandoNueva =
        selectorAsignatura.value === "__new__" ||
        document.activeElement === selectorAsignatura ||
        document.activeElement === asignaturaNueva;
      if (
        !interfazInicializada &&
        !usuarioCreandoNueva &&
        selectorAsignatura.value !== trabajoProcesando.asignatura &&
        [...selectorAsignatura.options].some(
          (opcion) => opcion.value === trabajoProcesando.asignatura,
        )
      ) {
        selectorAsignatura.value = trabajoProcesando.asignatura;
        actualizarCamposAsignatura();
        try {
          await cargarTrabajosPendientes();
          await cargarUltimaGeneracion();
        } catch {
          // Silencioso.
        }
      }
      idGeneracionActiva = trabajoProcesando.id;
      asignaturaGeneracionActiva = trabajoProcesando.asignatura;
      mostrarProgresoTrabajoEtapas(trabajoDetallado, monitorGeneracionActivo);
      progreso.hidden = false;
      botonGenerar.disabled = true;
      botonDetener.hidden = false;
      botonDetener.disabled = false;
      if (botonReiniciar) {
        botonReiniciar.hidden = false;
        botonReiniciar.disabled = false;
      }
    } else {
      idGeneracionActiva = undefined;
      asignaturaGeneracionActiva = undefined;
      progreso.hidden = true;
      botonGenerar.disabled = false;
      botonDetener.hidden = true;
      if (botonReiniciar) {
        botonReiniciar.hidden = true;
      }
    }
  } catch {
    // Silencioso: no bloquear la interfaz si falla el sondeo.
  }
}

window.setInterval(vigilarProgresoStagedGenerations, 1000);

cargarAsignaturas()
  .then(() => vigilarProgresoStagedGenerations())
  .catch((fallo) => {
    panelError.textContent = fallo.message;
    panelError.hidden = false;
  });
restaurarBorradorFuentes();
comprobarEstadoModelo();
window.setInterval(comprobarEstadoModelo, 30000);
