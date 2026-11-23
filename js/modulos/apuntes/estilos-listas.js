// ============================================================
// NORMALIZACIÓN Y TRANSFORMACIÓN DE LISTAS Y PASOS LATEX WEC
// ============================================================

const INICIO_ITEM = /^(?:\*\*[^*\n]+\*\*|\\textbf\{|[-*]\s+|\d+[.)]\s+)/;

export function dividirPorPipe(cuerpo) {
  const partes = [];
  let actual = "";
  let profundidad = 0;
  for (let i = 0; i < cuerpo.length; i++) {
    const caracter = cuerpo[i];
    if (caracter === "\\") {
      actual += caracter;
      if (i + 1 < cuerpo.length) actual += cuerpo[++i];
      continue;
    }
    if (caracter === "{") profundidad++;
    else if (caracter === "}") profundidad--;
    if (caracter === "|" && profundidad === 0) {
      partes.push(actual);
      actual = "";
      continue;
    }
    actual += caracter;
  }
  partes.push(actual);
  return partes;
}

export function normalizarCuerpoLista(cuerpoOriginal, tipo = "lista") {
  let cuerpo = cuerpoOriginal
    .replace(/\\(?:midrule|toprule|bottomrule)\b/g, "")
    .replace(/(?:^|\n|\s)\*([a-zA-ZÁÉÍÓÚáéíóú0-9_ -]+:\*\*)/g, "\n  **$1");

  cuerpo = cuerpo.replace(/(^|[|\n])\s*(\d+[.)]?|[-*•])\s*(?:\\\\|\s*\\newline)\s*/g, "$1$2 ");
  cuerpo = cuerpo.replace(/(^|[|\n])\s*(\d+[.)]?|[-*•])\s*\r?\n+\s*/g, "$1$2 ");
  cuerpo = cuerpo.replace(/\r?\n\s*\r?\n+/g, "\n  ");

  if (tipo === "pasos") {
    cuerpo = cuerpo.replace(/(^|[|\n])\s*(?:\*{0,2}(?:Paso\s+)?\d+[\.:\)\-–—]?\*{0,2}\s*)+/gi, "$1 ");
  }

  const items = [];
  for (const segmento of dividirPorPipe(cuerpo)) {
    const limpio = segmento.trim();
    if (!limpio) continue;
    const lineas = limpio
      .split(/\r?\n/)
      .map((linea) => linea.trim())
      .filter(Boolean);
    const lineasQueInicianItem = lineas.filter((linea) => INICIO_ITEM.test(linea));
    if (lineas.length > 1 && lineasQueInicianItem.length > 1) {
      let actual = "";
      for (const linea of lineas) {
        if (INICIO_ITEM.test(linea) && actual) {
          items.push(actual);
          actual = linea.replace(/^[-*]\s+/, "");
        } else {
          const trozo = linea.replace(/^[-*]\s+/, "");
          actual = actual ? `${actual} ${trozo}` : trozo;
        }
      }
      if (actual) items.push(actual);
      continue;
    }
    const partes = limpio.split(/(?<=[.;:])\s+(?=\*\*[^*\n]+\*\*)/);
    if (partes.length > 1) {
      items.push(...partes.map((parte) => parte.trim()).filter(Boolean));
    } else {
      items.push(limpio.replace(/\s+/g, " "));
    }
  }

  const itemsCombinados = [];
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    const esSoloEtiqueta = /^(?:\*\*[^*\n]+:\*\*|\\textbf\{[^}]*:\})\s*$/.test(cur);
    if (esSoloEtiqueta && i + 1 < items.length && !INICIO_ITEM.test(items[i + 1])) {
      itemsCombinados.push(`${cur} ${items[i + 1]}`);
      i++;
    } else {
      itemsCombinados.push(cur);
    }
  }

  const itemsDesglosados = [];
  for (const item of itemsCombinados) {
    const itemPlano = item
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\\textbf\{([^}]+)\}/g, "$1")
      .replace(/^[|\s]+/, "")
      .replace(/\|\s*([^:|]+):\s*\|?\s*/g, "$1: ");
    const subConceptos = [...itemPlano.matchAll(/(?:^|(?<=[.:;]\s+))(?:[1-9]\.?\s*)?([A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóú0-9_ \-()\/\+]{1,45}):\s+([\s\S]+?)(?=(?:(?:\.|\;|\n)\s*[A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóú0-9_ \-()\/\+]{1,45}:\s+)|\n\n|$)/g)];
    if (subConceptos.length >= 2) {
      for (const m of subConceptos) {
        const k = m[1].trim();
        const v = m[2].trim().replace(/^\|\s*/, "");
        if (!/^(https?|nota|definici[oó]n|ejemplo|resumen|c[oó]digo|tabla|figura)$/i.test(k)) {
          itemsDesglosados.push(`**${k}:** ${v}`);
        } else {
          itemsDesglosados.push(`${k}: ${v}`);
        }
      }
    } else {
      itemsDesglosados.push(item);
    }
  }

  const itemsLimpios = [];
  for (let item of itemsDesglosados) {
    item = item.trim().replace(/\s+/g, " ");
    item = item.replace(/^[.•·]\s*/, "");
    item = item.replace(/\]\]>/g, "").replace(/<!\[CDATA\[/g, "");
    item = item.replace(/\*\*([^*\n]+?)\*\*/g, "\\textbf{$1}");
    if (tipo === "pasos") {
      item = item.replace(/^(?:\*{0,2}(?:Paso\s+)?\d+[\.:\)\-–—]?\*{0,2}\s*)+/i, "").trim();
    }
    if (/^\d+[.)]?$/.test(item)) continue;
    item = item.replace(/^(?:\\\\|\s*\\newline)+\s*/, "").replace(/(?:\\\\|\s*\\newline)+\s*$/, "");
    if (item) itemsLimpios.push(item);
  }

  if (itemsLimpios.length === 0) return cuerpoOriginal;
  return `\n  ${itemsLimpios.join(" |\n  ")}\n`;
}

export function normalizarEntornoListaOPasos(value, macroNombre) {
  const patron = `\\${macroNombre}{`;
  let salida = "";
  let posicion = 0;
  while (posicion < value.length) {
    const inicio = value.indexOf(patron, posicion);
    if (inicio === -1) {
      salida += value.slice(posicion);
      break;
    }
    salida += value.slice(posicion, inicio);
    const apertura = inicio + patron.length - 1;
    let fin = apertura;
    let profundidad = 0;
    for (; fin < value.length; fin++) {
      const caracter = value[fin];
      if (caracter === "\\") {
        fin++;
        continue;
      }
      if (caracter === "{") profundidad++;
      else if (caracter === "}") {
        profundidad--;
        if (profundidad === 0) break;
      }
    }
    if (fin >= value.length) {
      salida += value.slice(inicio);
      break;
    }
    const cuerpo = value.slice(apertura + 1, fin);
    salida += `\\${macroNombre}{${normalizarCuerpoLista(cuerpo, macroNombre)}}`;
    posicion = fin + 1;
  }
  return salida;
}

export function normalizarListasWec(value) {
  const bloques = [];
  const protegido = value.replace(
    /(\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\})/g,
    (_match, bloque) => {
      const marca = `@@@LISTA_CODIGO_${bloques.length}@@@`;
      bloques.push(bloque);
      return marca;
    },
  );
  let normalizado = normalizarEntornoListaOPasos(protegido, "lista");
  normalizado = normalizarEntornoListaOPasos(normalizado, "pasos");
  return normalizado.replace(
    /@@@LISTA_CODIGO_(\d+)@@@/g,
    (_match, indice) => bloques[Number(indice)],
  );
}

export function convertirListasWec(value) {
  return value
    .replace(
      /\\begin\{(?:itemize|enumerate)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{(?:itemize|enumerate)\}/gi,
      (_match, body) => {
        const items = body
          .split(/\\item(?:\s+|\[[^\]]*\])/)
          .map((item) => item.trim())
          .filter(Boolean);
        if (!items.length) return "";
        return `\\lista{\n  ${items.join(" |\n  ")}\n}`;
      },
    )
    .replace(
      /\\begin\{description\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{description\}/gi,
      (_match, body) => {
        const entradas = [
          ...body.matchAll(/\\item\[([^\]]+)\]([\s\S]*?)(?=\\item\[|$)/g),
        ];
        if (!entradas.length) return _match;
        return entradas
          .map(
            ([, termino, desc]) =>
              `\\definicionpar{${termino.trim()}}{${desc.trim()}}`,
          )
          .join("\n\n");
      },
    )
    .replace(/\\begin\{(?:itemize|enumerate)\}(?:\[[^\]]*\])?/gi, "")
    .replace(/\\end\{(?:itemize|enumerate)\}/gi, "")
    .replace(/\[<[+-]*>\]/g, "");
}
