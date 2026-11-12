import { formatearProgresoDescarga, limpiarSalida } from "./formato-salida.js";

const mensaje = document.querySelector("#mensaje");
const progreso = document.querySelector("#progreso");
const porcentaje = document.querySelector("#porcentaje");
const registros = document.querySelector("#registros");
const detallesTecnicos = document.querySelector("#detalles-tecnicos");
const error = document.querySelector("#error");
const errorCarpetas = document.querySelector("#error-carpetas");
const enlace = document.querySelector("#enlace");
const abrir = document.querySelector("#abrir");
const rutaApuntes = document.querySelector("#ruta-apuntes");
const botonElegirCarpeta = document.querySelector("#elegir-carpeta");
const botonIniciar = document.querySelector("#iniciar-generador");
const selectorApuntes = document.querySelector("#seleccion-apuntes");
const panelProgreso = document.querySelector("#progreso-inicio");
let iniciando = false;

botonElegirCarpeta.addEventListener("click", async () => {
  botonElegirCarpeta.disabled = true;
  errorCarpetas.classList.add("oculto");
  try {
    const respuesta = await fetch("/seleccionar-carpeta", { method: "POST" });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.error);
    if (resultado.ruta) {
      rutaApuntes.textContent = resultado.ruta;
      rutaApuntes.dataset.seleccionada = "true";
      botonIniciar.disabled = false;
    }
  } catch (fallo) {
    errorCarpetas.textContent = fallo.message;
    errorCarpetas.classList.remove("oculto");
  } finally {
    botonElegirCarpeta.disabled = false;
  }
});

botonIniciar.addEventListener("click", async () => {
  if (iniciando) return;
  iniciando = true;
  botonIniciar.disabled = true;
  botonElegirCarpeta.disabled = true;
  errorCarpetas.classList.add("oculto");
  try {
    const respuesta = await fetch("/iniciar", { method: "POST" });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.error);
    selectorApuntes.classList.add("oculto");
    panelProgreso.classList.remove("oculto");
    actualizar();
  } catch (fallo) {
    iniciando = false;
    botonIniciar.disabled = false;
    botonElegirCarpeta.disabled = false;
    errorCarpetas.textContent = fallo.message;
    errorCarpetas.classList.remove("oculto");
  }
});

async function actualizar() {
  try {
    const respuesta = await fetch("/estado", { cache: "no-store" });
    const estado = await respuesta.json();
    if (estado.rutaApuntes) rutaApuntes.textContent = estado.rutaApuntes;
    botonIniciar.disabled = !estado.carpetaValida || iniciando;
    if (estado.iniciando) {
      selectorApuntes.classList.add("oculto");
      panelProgreso.classList.remove("oculto");
    }
    const lineas = [
      ...new Set(estado.registros.flatMap((linea) => limpiarSalida(linea))),
    ];
    const avanceModelo = lineas
      .map(formatearProgresoDescarga)
      .filter(Boolean)
      .at(-1);
    const porcentajeModelo = Number(avanceModelo?.match(/\d+/)?.[0] ?? 0);
    const valorProgreso = avanceModelo
      ? Math.min(95, 60 + Math.floor(porcentajeModelo * 0.35))
      : estado.progreso;
    mensaje.textContent =
      avanceModelo || limpiarSalida(estado.mensaje).join(" ");
    progreso.value = valorProgreso;
    porcentaje.textContent = `${valorProgreso} %`;
    if (lineas.length) {
      registros.textContent = lineas
        .map((linea) => formatearProgresoDescarga(linea) || linea)
        .filter((linea, posicion, todas) => linea !== todas[posicion - 1])
        .join("\n");
      detallesTecnicos.classList.remove("oculto");
    }
    if (estado.listo) {
      abrir.href = estado.direccion;
      enlace.classList.remove("oculto");
      progreso.value = 100;
      porcentaje.textContent = "100 %";
      setTimeout(() => {
        window.location.href = estado.direccion;
      }, 1800);
      return;
    }
    if (estado.error) {
      error.textContent = limpiarSalida(estado.error).join("\n");
      error.classList.remove("oculto");
      porcentaje.textContent = "Inicio interrumpido";
    }
  } catch {
    mensaje.textContent = "Conectando con el iniciador…";
  }
  setTimeout(actualizar, 1000);
}

actualizar();
