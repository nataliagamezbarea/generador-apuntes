// ============================================================
// BALANCEO Y ESTRUCTURACIÓN DE SINTAXIS LATEX WEC
// ============================================================

export function balancearEntornoVerbatim(texto, nombreEntorno) {
  const beginRegex = new RegExp(`\\\\begin\\{${nombreEntorno}\\}(\\[[^\\]]*\\])?`, "g");
  const endRegex = new RegExp(`\\\\end\\{${nombreEntorno}\\}`, "g");
  const tokens = [];
  let m;
  while ((m = beginRegex.exec(texto)) !== null) {
    tokens.push({ type: "begin", index: m.index, length: m[0].length, full: m[0] });
  }
  while ((m = endRegex.exec(texto)) !== null) {
    tokens.push({ type: "end", index: m.index, length: m[0].length, full: m[0] });
  }
  tokens.sort((a, b) => a.index - b.index);

  if (tokens.length === 0) return texto;

  let abierto = false;
  let resultadoFinal = "";
  let lastIndex = 0;

  for (const token of tokens) {
    resultadoFinal += texto.slice(lastIndex, token.index);
    lastIndex = token.index + token.length;

    if (token.type === "begin") {
      if (abierto) {
        resultadoFinal += `\\end{${nombreEntorno}}\n\n${token.full}`;
      } else {
        resultadoFinal += token.full;
        abierto = true;
      }
    } else if (token.type === "end") {
      if (abierto) {
        resultadoFinal += token.full;
        abierto = false;
      }
    }
  }

  resultadoFinal += texto.slice(lastIndex);
  if (abierto) {
    resultadoFinal += `\n\\end{${nombreEntorno}}\n`;
  }
  return resultadoFinal;
}

export function balancearLlavesLatex(texto) {
  const partes = [];
  const verbatimRegex = /(\\begin\{(?:codigo|consola)\}(?:\[[^\]]*\])?[\s\S]*?\\end\{(?:codigo|consola)\})/gi;
  let ultimoIndice = 0;
  let coincidencia;
  let resultadoFinal = "";

  while ((coincidencia = verbatimRegex.exec(texto)) !== null) {
    const antes = texto.slice(ultimoIndice, coincidencia.index);
    partes.push({ tipo: "latex", contenido: antes });
    partes.push({ tipo: "verbatim", contenido: coincidencia[0] });
    ultimoIndice = verbatimRegex.lastIndex;
  }
  partes.push({ tipo: "latex", contenido: texto.slice(ultimoIndice) });

  let abiertas = 0;
  for (const parte of partes) {
    if (parte.tipo === "verbatim") {
      resultadoFinal += parte.contenido;
      continue;
    }
    let limpio = "";
    for (let i = 0; i < parte.contenido.length; i++) {
      const char = parte.contenido[i];
      const prev = i > 0 ? parte.contenido[i - 1] : "";
      if (char === "{" && prev !== "\\") {
        abiertas++;
        limpio += char;
      } else if (char === "}" && prev !== "\\") {
        if (abiertas > 0) {
          abiertas--;
          limpio += char;
        }
      } else {
        limpio += char;
      }
    }
    resultadoFinal += limpio;
  }

  if (abiertas > 0) {
    resultadoFinal += "}".repeat(abiertas);
  }
  return resultadoFinal;
}

export function extraerMacrosDeResumen(contenido) {
  let salida = "";
  let posicion = 0;
  while (posicion < contenido.length) {
    const inicio = contenido.indexOf("\\resumen{", posicion);
    if (inicio === -1) {
      salida += contenido.slice(posicion);
      break;
    }
    salida += contenido.slice(posicion, inicio);
    const apertura = inicio + "\\resumen".length;
    let fin = apertura;
    let profundidad = 0;
    for (; fin < contenido.length; fin++) {
      const c = contenido[fin];
      if (c === "\\") {
        fin++;
        continue;
      }
      if (c === "{") profundidad++;
      else if (c === "}") {
        profundidad--;
        if (profundidad === 0) break;
      }
    }
    if (fin >= contenido.length) {
      salida += contenido.slice(inicio);
      break;
    }
    const cuerpo = contenido.slice(apertura + 1, fin);
    const macrosExtraidas = [];

    function extraerMacro(nombreMacro, numArgs = 1) {
      let pos = 0;
      let resultado = "";
      const patron = `\\${nombreMacro}{`;
      while (pos < cuerpoRestante.length) {
        const idx = cuerpoRestante.indexOf(patron, pos);
        if (idx === -1) {
          resultado += cuerpoRestante.slice(pos);
          break;
        }
        resultado += cuerpoRestante.slice(pos, idx);
        let cur = idx + patron.length - 1;
        let bloqueCompleto = `\\${nombreMacro}`;
        let valido = true;
        for (let arg = 0; arg < numArgs; arg++) {
          if (cuerpoRestante[cur] !== "{") {
            valido = false;
            break;
          }
          let f = cur;
          let prof = 0;
          for (; f < cuerpoRestante.length; f++) {
            const ch = cuerpoRestante[f];
            if (ch === "\\") { f++; continue; }
            if (ch === "{") prof++;
            else if (ch === "}") {
              prof--;
              if (prof === 0) break;
            }
          }
          if (f >= cuerpoRestante.length) {
            valido = false;
            break;
          }
          bloqueCompleto += cuerpoRestante.slice(cur, f + 1);
          cur = f + 1;
          while (cur < cuerpoRestante.length && /\s/.test(cuerpoRestante[cur])) cur++;
        }
        if (valido) {
          macrosExtraidas.push(bloqueCompleto.trim());
          pos = cur;
        } else {
          resultado += cuerpoRestante.slice(idx, idx + patron.length);
          pos = idx + patron.length;
        }
      }
      cuerpoRestante = resultado;
    }

    let cuerpoRestante = cuerpo;
    extraerMacro("definicionpar", 2);
    extraerMacro("definicion", 2);
    extraerMacro("nota", 2);
    extraerMacro("alertas", 1);
    extraerMacro("lista", 1);
    extraerMacro("pasos", 1);
    extraerMacro("subtituloA", 1);
    extraerMacro("subtituloB", 1);
    extraerMacro("rectangulos", 1);

    const resumenLimpio = cuerpoRestante.replace(/\r?\n\s*\r?\n+/g, " ").replace(/\s+/g, " ").trim();
    if (resumenLimpio) {
      salida += `\\resumen{\n  ${resumenLimpio}\n}\n\n`;
    }
    if (macrosExtraidas.length > 0) {
      salida += macrosExtraidas.join("\n\n") + "\n\n";
    }
    posicion = fin + 1;
  }
  return salida;
}

export function estructurarTextoPlano(texto) {
  const bloques = [];
  let protegido = texto.replace(/(\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\})/g, (m) => {
    if (/\\begin\{codigo\}\s*(?:\/\/|#|<!--)?\s*No hay c[oó]digo[^\n]*\s*\\end\{codigo\}/i.test(m)) {
      return "";
    }
    const token = `@@@ESTRUC_VERBATIM_${bloques.length}@@@`;
    bloques.push(m);
    return token;
  });

  protegido = protegido.replace(/(?:^|\n)\s*(?:\*\*(?:Definici[oó]n(?:\s+de)?|Concepto):\s*([^*\n]+)\*\*|Definici[oó]n(?:\s+de\s+|\s*:\s*)([A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóú0-9_ -]{1,40}):?)\s*([^\n]+(?:\n[^\n\\]+)*)/gi, (_m, t1, t2, desc) => {
    const termino = (t1 || t2).trim();
    return `\n\n\\definicion{${termino}}{${desc.trim()}}\n\n`;
  });

  protegido = protegido.replace(/(?:^|\n)\s*(?:\*\*(?:Para el examen|Ojo para el examen|Examen):\*\*|(?:Para el examen|Ojo para el examen|Examen):)\s*([^\n]+(?:\n[^\n\\]+)*)/gi, (_m, desc) => {
    return `\n\n\\nota{Para el examen}{${desc.trim()}}\n\n`;
  });

  protegido = protegido.replace(/(?:^|\n)\s*(?:\*\*(?:Alerta|Advertencia|Importante|Seguridad):\*\*|(?:Alerta|Advertencia|Importante|Seguridad):)\s*([^\n]+(?:\n[^\n\\]+)*)/gi, (_m, desc) => {
    return `\n\n\\alertas{${desc.trim()}}\n\n`;
  });

  const parrafos = protegido.split(/\n\s*\n/);
  const parrafosDivididos = [];
  for (const p of parrafos) {
    const trimP = p.trim();
    if (trimP.startsWith("\\") || trimP.startsWith("%") || trimP.startsWith("@@@ESTRUC_VERBATIM") || trimP.length < 350) {
      parrafosDivididos.push(p);
      continue;
    }
    const itemsNumerados = [...trimP.matchAll(/(?:^|\s)(?:[1-9]\.|\([1-9]\))\s*([A-ZÁÉÍÓÚ][^.\n]+[.!?])/g)];
    if (itemsNumerados.length >= 2) {
      const itemsLista = itemsNumerados.map(m => m[1].trim());
      parrafosDivididos.push(`\\lista{\n  ${itemsLista.join(" |\n  ")}\n}`);
      continue;
    }

    const oraciones = trimP.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
    if (oraciones && oraciones.length >= 3) {
      let acumulado = "";
      let oracionesLote = [];
      for (const o of oraciones) {
        acumulado += o;
        oracionesLote.push(o.trim());
        if (acumulado.length >= 200 && oracionesLote.length >= 2) {
          parrafosDivididos.push(oracionesLote.join(" "));
          acumulado = "";
          oracionesLote = [];
        }
      }
      if (oracionesLote.length > 0) {
        parrafosDivididos.push(oracionesLote.join(" "));
      }
    } else {
      parrafosDivididos.push(p);
    }
  }
  protegido = parrafosDivididos.join("\n\n");

  return protegido.replace(/@@@ESTRUC_VERBATIM_(\d+)@@@/g, (_m, i) => bloques[Number(i)]);
}

export function convertirCodigoWec(value) {
  return value
    .replace(/([^\n])\s*\\end\{(codigo|consola)\}/g, "$1\n\\end{$2}")
    .replace(
      /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g,
      (_match, lang, code) => {
        const limpia = code
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\]\]>/g, "")
          .replace(/^\s*\n+/, "")
          .replace(/^(?:javascript|html|css|python|java|bash|sql|cpp|c)\s*\n/i, "")
          .trimEnd();
        const etiqueta = lang ? `[${lang}]` : "";
        return `\\begin{codigo}${etiqueta}\n${limpia}\n\\end{codigo}`;
      },
    )
    .replace(
      /\\begin\{lstlisting\}(?:\[(?:language=)?([a-zA-Z0-9_-]+)\])?([\s\S]*?)\\end\{lstlisting\}/gi,
      (_match, lang, code) => {
        const limpia = code
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\]\]>/g, "")
          .replace(/^\s*\n+/, "")
          .replace(/^(?:javascript|html|css|python|java|bash|sql|cpp|c)\s*\n/i, "")
          .trimEnd();
        const etiqueta = lang ? `[${lang}]` : "";
        return `\\begin{codigo}${etiqueta}\n${limpia}\n\\end{codigo}`;
      },
    )
    .replace(
      /\\begin\{codigo\}(?:\[([^\]]*)\])?([\s\S]*?)\\end\{codigo\}/gi,
      (_match, lang, code) => {
        const limpia = code
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\]\]>/g, "")
          .replace(/^\s*\n+/, "")
          .replace(/^(?:javascript|html|css|python|java|bash|sql|cpp|c)\s*\n/i, "")
          .trimEnd();
        const etiqueta = lang ? `[${lang}]` : "";
        return `\\begin{codigo}${etiqueta}\n${limpia}\n\\end{codigo}`;
      },
    )
    .replace(
      /\\begin\{verbatim\}([\s\S]*?)\\end\{verbatim\}/gi,
      (_match, code) => `\\begin{consola}\n${code.trimEnd()}\n\\end{consola}`,
    )
    .replace(
      /\\begin\{consola\}(?:\[[^\]]*\]|\{[^}]*\})+/g,
      "\\begin{consola}",
    );
}

export function convertirTablasWec(value) {
  return value.replace(
    /(?:\\begin\{table\}(?:\[[^\]]*\])?\s*(?:\\centering\s*)?)?\\begin\{tabular\}\{([^}]*)\}([\s\S]*?)\\end\{tabular\}(?:\s*\\caption\{[^{}]*\}\s*)?(?:\\end\{table\})?/gi,
    (_match, columns, body) => {
      const filas = body
        .replace(/\\hline/g, "")
        .split(/\\\\\s*/)
        .map((fila) => fila.trim())
        .filter(Boolean);
      if (filas.length < 2) return _match;
      const cabecera = filas.shift();
      const encabezado = cabecera
        .replace(/\\textbf\{([^{}]*)\}/g, "$1")
        .trim();
      const filasWec = filas.map((fila) => fila.trim()).join("\n");
      const anchos = columns
        .replace(/[|]/g, "")
        .split("")
        .map((tipo) => (tipo === "c" || tipo === "l" || tipo === "r" ? "L{5.2cm}" : "L{5.2cm}"))
        .join("");
      const encabezadosWec = encabezado
        .split(/\s*&\s*/)
        .map((celda) => `\\tablacab{${celda.replace(/[{}]/g, "")}}`)
        .join(" & ");
      return `\\tabla[${anchos}]{\n${encabezadosWec} \\\\\n\\midrule\n${filasWec}\n}`;
    },
  );
}

export function asegurarSeccionPrincipal(latex, titulo) {
  if (/\\secciongrande\s*\{/.test(latex)) return latex;
  let enc = titulo;
  if (typeof enc === "object" && enc !== null) {
    enc = enc.titulo || enc.title || enc.texto || enc.nombre || "";
  }
  const encabezado = String(enc ?? "").trim() || "Apuntes";
  if (/^\[object\s+Object\]$/i.test(encabezado)) {
    return latex;
  }
  return `\\secciongrande{${encabezado}}\n\n${latex}`;
}
