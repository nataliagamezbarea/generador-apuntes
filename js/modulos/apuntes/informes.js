import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../configuracion.js";
import { componenteSeguro } from "./utilidades-nombres.js";

export async function rutaInformeGeneracion(subject, theme, subtheme) {
  return path.join(
    config.generationReportsRoot,
    componenteSeguro(subject),
    `tema-${theme}-apartado-${subtheme}`,
    "ultima-generacion.json",
  );
}

export async function obtenerInformeGeneracion(subject, theme, subtheme) {
  const file = await rutaInformeGeneracion(subject, theme, subtheme);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`No se pudo leer el informe anterior: ${error.message}`);
  }
}

export async function listarHistorialGeneraciones(subject) {
  const directory = path.join(
    config.generationReportsRoot,
    componenteSeguro(subject),
  );
  const informes = [];

  async function recorrer(ruta) {
    let entradas;
    try {
      entradas = await readdir(ruta, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && ruta === directory) return;
      throw error;
    }
    for (const entrada of entradas) {
      const destino = path.join(ruta, entrada.name);
      if (entrada.isDirectory()) await recorrer(destino);
      else if (
        entrada.isFile() &&
        (entrada.name === "ultima-generacion.json" ||
          (path.basename(ruta) === "historial" &&
            entrada.name.toLowerCase().endsWith(".json")))
      ) {
        try {
          informes.push(JSON.parse(await readFile(destino, "utf8")));
        } catch (error) {
          throw new Error(
            `No se pudo leer el historial ${path.relative(directory, destino)}: ${error.message}`,
          );
        }
      }
    }
  }

  await recorrer(directory);
  const historialCompleto = [
    ...new Map(
      informes.map((informe) => [
        [
          informe.generado,
          informe.fingerprint,
          informe.asignatura,
          informe.tema,
          informe.subtema,
        ].join("\0"),
        informe,
      ]),
    ).values(),
  ];
  return historialCompleto.sort(
    (izquierda, derecha) =>
      Date.parse(derecha.generado) - Date.parse(izquierda.generado),
  );
}

export async function eliminarInformeGeneracion(
  subject,
  { fingerprint, theme, subtheme, todo } = {},
) {
  const directory = path.join(
    config.generationReportsRoot,
    componenteSeguro(subject),
  );
  try {
    if (todo || (!fingerprint && !theme && !subtheme)) {
      await rm(directory, { recursive: true, force: true });
      return;
    }
    if (!fingerprint && theme && subtheme) {
      const apartadoDir = path.join(
        directory,
        `tema-${theme}-apartado-${subtheme}`,
      );
      await rm(apartadoDir, { recursive: true, force: true });
      return;
    }
    if (fingerprint) {
      async function recorrerYBorrar(ruta) {
        let entradas;
        try {
          entradas = await readdir(ruta, { withFileTypes: true });
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        for (const entrada of entradas) {
          const destino = path.join(ruta, entrada.name);
          if (entrada.isDirectory()) {
            await recorrerYBorrar(destino);
          } else if (entrada.isFile() && entrada.name.endsWith(".json")) {
            try {
              const data = JSON.parse(await readFile(destino, "utf8"));
              if (data.fingerprint === fingerprint) {
                await rm(destino, { force: true });
              }
            } catch {}
          }
        }
      }
      await recorrerYBorrar(directory);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
