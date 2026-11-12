const secuenciasTerminal =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const caracteresControl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function limpiarSalida(texto) {
  return String(texto)
    .replace(secuenciasTerminal, "")
    .replace(caracteresControl, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((linea) => linea.trim())
    .filter(Boolean);
}

export function formatearDuracion(segundos) {
  const restante = Math.max(0, Math.floor(segundos));
  const horas = Math.floor(restante / 3600);
  const minutos = Math.floor((restante % 3600) / 60);
  const segundosRestantes = restante % 60;
  return [
    horas ? `${horas} h` : "",
    minutos ? `${minutos} min` : "",
    segundosRestantes ? `${segundosRestantes} s` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatearProgresoDescarga(linea) {
  const coincidencia = linea.match(
    /(\d{1,3})%\s+.*?(\d+(?:\.\d+)?\s*[KMGT]?B)\s*\/\s*(\d+(?:\.\d+)?\s*[KMGT]?B)(?:\s+(\d+(?:\.\d+)?\s*[KMGT]?B\/s))?(?:\s+([\dhms]+))?/i,
  );
  if (!coincidencia) return null;

  const [, porcentaje, descargado, total, velocidad, tiempo] = coincidencia;
  const detalles = [`${porcentaje} %`, `${descargado} de ${total}`];
  if (velocidad) detalles.push(velocidad);
  if (tiempo) detalles.push(`restan ${tiempo}`);
  return `Descarga del modelo: ${detalles.join(" · ")}`;
}
