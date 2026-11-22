import {
  crearNombreArchivo,
  deducirSlugConceptual,
} from "./utilidades-nombres.js";

export function inferirSubtemaDeBloque(block, subthemePredeterminado = 1) {
  if (Number(subthemePredeterminado) > 0) {
    return Number(subthemePredeterminado);
  }
  if (block?.subtema && Number.isSafeInteger(Number(block.subtema)) && Number(block.subtema) > 0) {
    return Number(block.subtema);
  }
  if (block?.apartado) {
    const match = String(block.apartado).match(/(?:\d+\.)?(\d+)/);
    if (match) return Number(match[1]);
  }
  const matchTitulo = String(block?.titulo ?? "").match(/(?:^|\b)(?:\d+\.)(\d+)\b/);
  if (matchTitulo) {
    return Number(matchTitulo[1]);
  }
  return 1;
}

export function desglosarBloquesPorSubtitulos(archivos = []) {
  if (!Array.isArray(archivos) || archivos.length === 0) return archivos;

  const resultado = [];

  for (const block of archivos) {
    if (!block || typeof block.latex !== "string") {
      resultado.push(block);
      continue;
    }

    const latex = block.latex;
    const regexSubtitulo = /\\(?:subtituloA|subtitulo|subseccion)\*?(?:\[[^\]]*\])?\{([^}]+)\}/g;
    const matches = [];
    let m;
    while ((m = regexSubtitulo.exec(latex)) !== null) {
      matches.push({
        index: m.index,
        fullMatch: m[0],
        titulo: m[1].trim(),
        length: m[0].length,
      });
    }

    if (matches.length <= 1) {
      resultado.push(block);
      continue;
    }

    for (let i = 0; i < matches.length; i++) {
      const matchActual = matches[i];
      const startPos = i === 0 ? 0 : matchActual.index;
      const endPos = i + 1 < matches.length ? matches[i + 1].index : latex.length;
      let trozoLatex = latex.slice(startPos, endPos).trim();

      if (i > 0) {
        trozoLatex = trozoLatex
          .replace(/\\secciongrande\*?(?:\[[^\]]*\])?\{([^}]+)\}\s*/g, "")
          .replace(/\\resumen\*?(?:\[[^\]]*\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*/g, "");
        if (!trozoLatex.startsWith("\\subtituloA") && !trozoLatex.startsWith("\\subtitulo")) {
          trozoLatex = `\\subtituloA{${matchActual.titulo}}\n\n${trozoLatex}`;
        }
      }

      const tituloSub = matchActual.titulo;
      const slugSub = deducirSlugConceptual("", tituloSub) || `apartado-${i + 1}`;

      resultado.push({
        ...block,
        titulo: tituloSub,
        nombre: `${i + 1}.${slugSub}`,
        orden: i + 1,
        indiceApartado: i + 1,
        apartadoNumero: i + 1,
        latex: trozoLatex,
      });
    }
  }

  return resultado;
}

export function stemArchivoGenerado(block, theme, subtheme, index) {
  let orden = null;

  if (Number.isInteger(Number(block?.orden)) && Number(block.orden) > 0) {
    orden = Number(block.orden);
  } else if (Number.isInteger(Number(block?.numeroArchivoEnSubtema)) && Number(block.numeroArchivoEnSubtema) > 0) {
    orden = Number(block.numeroArchivoEnSubtema);
  }

  if (!orden) {
    const matchNum = String(block?.nombre || "").match(/^(\d+)[.\-]/);
    if (matchNum && Number(matchNum[1]) > 0) {
      orden = Number(matchNum[1]);
    }
  }

  if (!orden) {
    orden = typeof index === "number" && index >= 0 ? index + 1 : 1;
  }

  const base = block?.nombre ? block.nombre.replace(/\.tex$/i, "").trim() : "";
  let slug = "";
  if (base && !/slug-descriptivo|^apartado(?:-\d+)*$/i.test(base)) {
    slug = crearNombreArchivo(base);
  }
  if (!slug || /slug-descriptivo|^apartado(?:-\d+)*$/i.test(slug)) {
    const deducido = deducirSlugConceptual("", block?.titulo || base || "seccion");
    slug = deducido && !/slug-descriptivo|^apartado(?:-\d+)*$/i.test(deducido)
      ? deducido
      : `seccion-${orden}`;
  }

  // Quitar cualquier prefijo numérico previo para garantizar el prefijo ${orden}.
  slug = slug.replace(/^\d+[.\-]+\s*/, "");

  return `${orden}.${slug || "apartado"}`;
}
