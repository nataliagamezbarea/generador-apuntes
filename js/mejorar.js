const selectorAsignatura = document.querySelector("#selector-asignatura");
const selectorApunte = document.querySelector("#selector-apunte");
const selectorTema = document.querySelector("#selector-tema-revision");
const selectorApartado = document.querySelector("#selector-apartado-revision");
const contenidoApunte = document.querySelector("#contenido-apunte");
const campoConsulta = document.querySelector("#consulta");
const archivosApoyo = document.querySelector("#archivos-apoyo");
const investigarRevision = document.querySelector("#investigar-revision");
const listaArchivosApoyo = document.querySelector("#lista-archivos-apoyo");
const botonUsarSeleccion = document.querySelector("#usar-seleccion");
const botonMejorar = document.querySelector("#boton-mejorar");
const estadoSeleccion = document.querySelector("#estado-seleccion");
const estadoEditor = document.querySelector("#estado-editor");
const indicadorProgreso = document.querySelector("#progreso");
const panelError = document.querySelector("#panel-error");
const panelPropuesta = document.querySelector("#propuesta");
const estadoModelo = document.querySelector("#estado-modelo");
let asignaturas = [];
let apunteActual = null;
let propuesta = null;
let controladorRevision;

async function solicitarDatos(direccion, opciones) {
  const respuesta = await fetch(direccion, opciones);
  const datos = await respuesta.json();
  if (!respuesta.ok)
    throw new Error(
      datos.detail || `Error del servidor (${respuesta.status}).`,
    );
  return datos;
}

async function cargarAsignaturas() {
  const datos = await solicitarDatos("/api/subjects");
  asignaturas = datos.asignaturas;
  selectorAsignatura.replaceChildren();
  for (const asignatura of asignaturas) {
    const opcion = document.createElement("option");
    opcion.value = asignatura.nombre;
    opcion.textContent = asignatura.nombre;
    selectorAsignatura.append(opcion);
  }
  if (!asignaturas.length) {
    const opcion = document.createElement("option");
    opcion.value = "";
    opcion.textContent = "Todavía no hay asignaturas";
    selectorAsignatura.append(opcion);
    selectorApunte.replaceChildren();
    estadoEditor.textContent =
      "Genera primero unos apuntes para poder revisarlos aquí.";
    return;
  }
  actualizarTemas(asignaturas[0]);
  actualizarApartados(asignaturas[0], "");
  await cargarApuntes();
}

function actualizarTemas(asignatura) {
  selectorTema.replaceChildren();
  const automatico = document.createElement("option");
  automatico.value = "";
  automatico.textContent = "Toda la asignatura (detección automática)";
  selectorTema.append(automatico);
  for (const tema of asignatura?.temas ?? []) {
    const opcionTema = document.createElement("option");
    opcionTema.value = `tema:${tema.numero}`;
    opcionTema.textContent = `Tema ${tema.numero}: ${tema.titulo}`;
    selectorTema.append(opcionTema);
  }
}

function actualizarApartados(asignatura, valorTema) {
  selectorApartado.replaceChildren();
  const automatico = document.createElement("option");
  automatico.value = "";
  automatico.textContent = valorTema
    ? "Todos los apartados del tema (detección automática)"
    : "Elige primero un tema";
  selectorApartado.append(automatico);
  const numeroTema = valorTema.match(/^tema:(\d+)$/)?.[1];
  const tema = asignatura?.temas?.find(
    (item) => String(item.numero) === numeroTema,
  );
  selectorApartado.disabled = !tema;
  for (const apartado of tema?.apartados ?? []) {
    const opcionApartado = document.createElement("option");
    opcionApartado.value = `apartado:${apartado.numero}`;
    opcionApartado.textContent = `${tema.numero}.${apartado.numero} · ${apartado.nombre}`;
    selectorApartado.append(opcionApartado);
  }
}

async function cargarApuntes() {
  selectorApunte.replaceChildren();
  const datos = await solicitarDatos(
    `/api/notes?subject=${encodeURIComponent(selectorAsignatura.value)}`,
  );
  for (const apunte of datos.archivos) {
    const opcion = document.createElement("option");
    opcion.value = apunte.path;
    opcion.textContent = apunte.path;
    selectorApunte.append(opcion);
  }
  if (!datos.archivos.length) {
    const opcion = document.createElement("option");
    opcion.value = "";
    opcion.textContent = "Esta asignatura no tiene archivos LaTeX";
    selectorApunte.append(opcion);
    contenidoApunte.value = "";
    contenidoApunte.disabled = true;
    estadoEditor.textContent =
      "No hay archivos .tex que cargar en esta asignatura.";
    return;
  }
  contenidoApunte.disabled = false;
  await cargarApunte();
}

async function cargarApunte() {
  if (!selectorApunte.value) return;
  apunteActual = await solicitarDatos(
    `/api/notes/content?path=${encodeURIComponent(selectorApunte.value)}`,
  );
  contenidoApunte.value = apunteActual.content;
  estadoEditor.textContent = `Abierto: ${apunteActual.path}. Los cambios no se guardan automáticamente.`;
  panelPropuesta.hidden = true;
  propuesta = null;
}

function obtenerSeleccion() {
  const inicio = contenidoApunte.selectionStart;
  const fin = contenidoApunte.selectionEnd;
  return inicio !== fin ? contenidoApunte.value.slice(inicio, fin) : "";
}

function mostrarEstadoSeleccion() {
  const textoSeleccionado = obtenerSeleccion().trim();
  estadoSeleccion.textContent = textoSeleccionado
    ? `Selección lista (${textoSeleccionado.length} caracteres).`
    : "Selecciona un texto en el apunte o usa «Usar texto seleccionado».";
}

function mostrarPropuesta(datos) {
  panelPropuesta.replaceChildren();
  const titulo = document.createElement("h2");
  titulo.textContent = "Propuesta para revisar";
  panelPropuesta.append(titulo);
  const tituloExplicacion = document.createElement("h3");
  tituloExplicacion.textContent = "Explicación para ti";
  const explicacion = document.createElement("p");
  explicacion.className = "suggestion-explanation";
  explicacion.textContent =
    datos.explicacion || "La IA no ha devuelto una explicación adicional.";
  panelPropuesta.append(tituloExplicacion, explicacion);
  if (datos.reemplazo_latex) {
    const tituloReemplazo = document.createElement("h3");
    tituloReemplazo.textContent = "Texto que sustituirá la selección";
    const reemplazo = document.createElement("pre");
    reemplazo.className = "latex-proposal";
    reemplazo.textContent = datos.reemplazo_latex;
    panelPropuesta.append(tituloReemplazo, reemplazo);
  }
  if (datos.anadido_latex) {
    const tituloAnadido = document.createElement("h3");
    tituloAnadido.textContent = "Material complementario";
    const contenidoAnadido = document.createElement("pre");
    contenidoAnadido.className = "latex-proposal";
    contenidoAnadido.textContent = datos.anadido_latex;
    panelPropuesta.append(tituloAnadido, contenidoAnadido);
  }
  if (datos.fuentes?.length) {
    const tituloFuentes = document.createElement("h3");
    tituloFuentes.textContent = "Fuentes consultadas";
    const listaFuentes = document.createElement("ul");
    for (const fuente of datos.fuentes) {
      const fila = document.createElement("li");
      const enlace = document.createElement("a");
      enlace.href = fuente.url;
      enlace.target = "_blank";
      enlace.rel = "noopener noreferrer";
      enlace.textContent = fuente.titulo;
      fila.append(enlace);
      listaFuentes.append(fila);
    }
    panelPropuesta.append(tituloFuentes, listaFuentes);
  }
  const aviso = document.createElement("p");
  aviso.className = "result-footer";
  aviso.textContent =
    "Nada se ha guardado todavía. Puedes revisar el editor y elegir qué aplicar.";
  const acciones = document.createElement("div");
  acciones.className = "suggestion-actions";
  const botonReemplazar = document.createElement("button");
  botonReemplazar.type = "button";
  botonReemplazar.className = "editor-primary";
  botonReemplazar.textContent = "Aplicar reemplazo y guardar";
  botonReemplazar.disabled = !datos.reemplazo_latex || !datos.selectedText;
  botonReemplazar.addEventListener("click", () =>
    aplicarPropuesta("sustituir"),
  );
  const botonAnadir = document.createElement("button");
  botonAnadir.type = "button";
  botonAnadir.className = "secondary-button";
  botonAnadir.textContent = "Añadir al final del apunte y guardar";
  botonAnadir.disabled = !datos.anadido_latex;
  botonAnadir.addEventListener("click", () => aplicarPropuesta("anadir"));
  acciones.append(botonReemplazar, botonAnadir);
  panelPropuesta.append(aviso, acciones);
  panelPropuesta.hidden = false;
  panelPropuesta.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function aplicarPropuesta(modo) {
  if (!propuesta || !apunteActual) return;
  let contenidoActualizado = contenidoApunte.value;
  if (modo === "sustituir") {
    const textoSeleccionado = propuesta.selectedText;
    const posicion = contenidoActualizado.indexOf(textoSeleccionado);
    if (
      !textoSeleccionado ||
      posicion < 0 ||
      contenidoActualizado.indexOf(
        textoSeleccionado,
        posicion + textoSeleccionado.length,
      ) >= 0
    ) {
      panelError.textContent =
        "No se puede identificar de forma inequívoca la selección en el apunte. Carga de nuevo el archivo y vuelve a seleccionar el texto.";
      panelError.hidden = false;
      return;
    }
    contenidoActualizado = `${contenidoActualizado.slice(0, posicion)}${propuesta.reemplazo_latex}${contenidoActualizado.slice(posicion + textoSeleccionado.length)}`;
  } else {
    const textoAnadido = propuesta.anadido_latex.trim();
    contenidoActualizado = `${contenidoActualizado.trimEnd()}\n\n${textoAnadido}\n`;
  }

  try {
    const resultadoGuardado = await solicitarDatos("/api/notes/content", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: apunteActual.path,
        content: contenidoActualizado,
        expectedSha256: apunteActual.sha256,
      }),
    });
    contenidoApunte.value = contenidoActualizado;
    apunteActual = {
      ...apunteActual,
      content: contenidoActualizado,
      sha256: resultadoGuardado.sha256,
    };
    propuesta = null;
    panelPropuesta.hidden = true;
    estadoEditor.textContent = `Guardado: ${apunteActual.path}`;
  } catch (problema) {
    panelError.textContent = problema.message;
    panelError.hidden = false;
  }
}

async function prepararMejora() {
  if (controladorRevision) {
    controladorRevision.abort();
    return;
  }
  panelError.hidden = true;
  panelPropuesta.hidden = true;
  const textoSeleccionado = obtenerSeleccion();
  if (!campoConsulta.value.trim()) {
    panelError.textContent = "Escribe qué no entiendes o qué quieres mejorar.";
    panelError.hidden = false;
    return;
  }
  if (!estadoModelo.classList.contains("ready")) {
    panelError.textContent =
      "La IA local no está lista. Inicia Ollama con el acceso directo del escritorio.";
    panelError.hidden = false;
    return;
  }
  const formulario = new FormData();
  formulario.append("subject", selectorAsignatura.value);
  const tema = selectorTema.value;
  const apartado = selectorApartado.value;
  formulario.append(
    "topic",
    apartado ? `${tema};${apartado}` : tema,
  );
  formulario.append("research_enabled", String(investigarRevision.checked));
  formulario.append("selectedText", textoSeleccionado);
  formulario.append("question", campoConsulta.value);
  for (const archivo of archivosApoyo.files)
    formulario.append(
      "files",
      archivo,
      archivo.webkitRelativePath || archivo.name,
    );
  controladorRevision = new AbortController();
  botonMejorar.textContent = "Detener preparación";
  indicadorProgreso.hidden = false;
  try {
    const datos = await solicitarDatos("/api/improve", {
      method: "POST",
      body: formulario,
      signal: controladorRevision.signal,
    });
    if (datos.path !== apunteActual?.path) {
      selectorApunte.value = datos.path;
      await cargarApunte();
    }
    propuesta = datos;
    mostrarPropuesta(datos);
  } catch (problema) {
    if (problema.name === "AbortError") return;
    panelError.textContent = problema.message;
    panelError.hidden = false;
  } finally {
    indicadorProgreso.hidden = true;
    const seDetuvo = controladorRevision?.signal.aborted === true;
    controladorRevision = undefined;
    botonMejorar.textContent = seDetuvo
      ? "Reanudar explicación y mejora"
      : "Preparar explicación y mejora";
  }
}

selectorAsignatura.addEventListener("change", () =>
  (actualizarTemas(
    asignaturas.find((asignatura) => asignatura.nombre === selectorAsignatura.value),
  ),
  actualizarApartados(
    asignaturas.find((asignatura) => asignatura.nombre === selectorAsignatura.value),
    "",
  ),
  cargarApuntes().catch(mostrarError)),
);
selectorTema.addEventListener("change", () => {
  actualizarApartados(
    asignaturas.find((asignatura) => asignatura.nombre === selectorAsignatura.value),
    selectorTema.value,
  );
});
selectorApunte.addEventListener("change", () =>
  cargarApunte().catch(mostrarError),
);
contenidoApunte.addEventListener("select", mostrarEstadoSeleccion);
contenidoApunte.addEventListener("keyup", mostrarEstadoSeleccion);
archivosApoyo.addEventListener("change", () => {
  listaArchivosApoyo.textContent = archivosApoyo.files.length
    ? `${archivosApoyo.files.length} archivo(s) de apoyo seleccionados.`
    : "No has añadido material de apoyo.";
});
botonMejorar.addEventListener("click", prepararMejora);

function mostrarError(problema) {
  panelError.textContent = problema.message;
  panelError.hidden = false;
}

async function comprobarEstadoModelo() {
  try {
    const estado = await solicitarDatos("/api/health");
    estadoModelo.classList.toggle(
      "ready",
      estado.connected && estado.modelAvailable,
    );
    estadoModelo.classList.toggle("failed", !estado.connected);
    estadoModelo.querySelector("span:last-child").textContent =
      estado.modelAvailable
        ? `IA local lista · ${estado.model}`
        : estado.connected
          ? `Preparando el modelo local ${estado.model}…`
          : "IA local sin conexión";
  } catch {
    estadoModelo.classList.add("failed");
    estadoModelo.querySelector("span:last-child").textContent =
      "No se pudo conectar con el servidor";
  }
}

cargarAsignaturas().catch(mostrarError);
comprobarEstadoModelo();
window.setInterval(comprobarEstadoModelo, 30000);
