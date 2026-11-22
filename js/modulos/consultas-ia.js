import { config } from "./configuracion.js";
import { cargarReferenciaBiblioteca } from "./instrucciones.js";
import { consultarModeloIA } from "./modelo.js";
import { sistemaApuntes, sistemaCodigoPorTemas } from "./instrucciones.js";

export function rutaAsincrona(handler) {
  return (solicitud, respuesta, next) =>
    Promise.resolve(handler(solicitud, respuesta, next)).catch(next);
}

export async function obtenerReferenciaBibliotecaSegura() {
  try {
    return await cargarReferenciaBiblioteca(config.latexLibraryGithub);
  } catch {
    try {
      return await cargarReferenciaBiblioteca(config.latexLibrary);
    } catch {
      return "";
    }
  }
}

export async function consultarApuntesConReintento({
  instruccion,
  imagenes,
  signal,
  normalizar,
  contexto,
  validar,
}) {
  const maxIntentos = 3;
  const erroresReintentables = new Set([
    "EMPTY_LATEX_BLOCKS",
    "INVALID_JSON_OBJECT",
    "INVALID_JSON",
  ]);
  let prompt = instruccion;
  let ultimoResultado = null;
  let mejorResultado = null;
  let mejorLongitud = -1;
  let ultimoError = null;

  for (let intento = 1; intento <= maxIntentos; intento += 1) {
    try {
      const resultado = await normalizar(
        await consultarModeloIA(sistemaApuntes, prompt, imagenes, signal),
      );
      ultimoResultado = resultado;
      const longitudActual = (resultado?.archivos || []).reduce(
        (total, a) => total + (typeof a?.latex === "string" ? a.latex.length : 0),
        0,
      );
      if (longitudActual > mejorLongitud) {
        mejorLongitud = longitudActual;
        mejorResultado = resultado;
      }
      const problemas = validar ? validar(resultado) : [];
      if (problemas.length === 0) return resultado;

      console.warn(
        `Cobertura insuficiente para ${contexto} (intento ${intento}/${maxIntentos}): ${problemas.join(" ")}`,
      );
      if (intento === maxIntentos) break;
      prompt = `${instruccion}

REVISIÓN OBLIGATORIA DE COBERTURA (la respuesta anterior fue rechazada automáticamente):
${problemas.map((problema) => `- ${problema}`).join("\n")}

Vuelve a redactar el JSON completo desde cero. No resumas ni recortes: desarrolla cada diapositiva del material con todas sus ideas, datos, ejemplos y preguntas, y conserva la introducción. Incluye un \\resumen inicial, un encabezado propio (\\subtituloA, \\subtituloB o \\seccion) por cada título de diapositiva y todos los comandos LaTeX de la biblioteca. No uses títulos genéricos ni de plantilla.`;
    } catch (error) {
      ultimoError = error;
      if (!erroresReintentables.has(error.code)) throw error;
      console.warn(
        `La IA no devolvió un objeto con apartados para ${contexto} (intento ${intento}/${maxIntentos}); se repetirá con el formato de salida corregido. ${error.message}`,
      );
      if (intento === maxIntentos) break;
      prompt = `${instruccion}

CORRECCIÓN OBLIGATORIA: La respuesta anterior no contenía apartados LaTeX utilizables. Vuelve a analizar el material completo y devuelve exclusivamente el JSON solicitado. Incluye "archivos" como una lista no vacía de objetos; cada objeto debe tener "titulo", "conceptos" y "latex" con contenido didáctico desarrollado y comandos LaTeX de la biblioteca. No devuelvas solo un resumen, conceptos_clave o cobertura.`;
    }
  }

  if (mejorResultado?.archivos?.length) return mejorResultado;
  if (ultimoResultado?.archivos?.length) return ultimoResultado;
  if (ultimoResultado) return ultimoResultado;
  throw new Error(
    `La IA no produjo un objeto con apartados LaTeX utilizables tras ${maxIntentos} intentos. ${ultimoError?.message ?? ""}`,
    { cause: ultimoError },
  );
}

export async function consultarCodigoConReintento(instruccion, signal, contexto) {
  try {
    return await consultarModeloIA(
      sistemaCodigoPorTemas,
      instruccion,
      [],
      signal,
      config.codeModel,
    );
  } catch (error) {
    if (error.code !== "INVALID_JSON") throw error;
    console.warn(
      `La IA no devolvió JSON válido para ${contexto}; se repetirá una vez con el formato corregido. ${error.message}`,
    );
    return consultarModeloIA(
      sistemaCodigoPorTemas,
      `${instruccion}

CORRECCIÓN OBLIGATORIA: la respuesta anterior no era JSON válido. Devuelve exclusivamente un objeto JSON válido, sin explicaciones ni Markdown, con "apartados" como una lista no vacía de objetos. Cada objeto debe incluir "titulo", "nombre", "conceptos" y "latex".`,
      [],
      signal,
      config.codeModel,
    );
  }
}
