import {
  corregirCatalanAEspanol,
  esSubtituloGenerico,
  normalizarMayusculasTitulo,
  quitarAsignaturaDelTitulo,
} from "./utilidades-nombres.js";

export function sanearTitulosTema(value, tituloApartado = "", tituloTema = "") {
  let latex = String(value ?? "");

  latex = latex.replace(/\\resumen\{([\s\S]*?)\}/g, (match, cuerpo) => {
    if (!/^\s*(?:tema|apartado|secci[oó]n)\s*\d/i.test(String(cuerpo))) {
      return match;
    }
    let contenido = String(cuerpo);
    let anterior;
    do {
      anterior = contenido;
      contenido = contenido.replace(
        /^\s*(?:tema|apartado|secci[oó]n)\s*\d+(?:[.\-]\d+)*\s*[:.\-–—]\s*[^\\{}]*(?:\\\s*)?/i,
        "",
      );
    } while (contenido !== anterior);
    return contenido.trim()
      ? `\\resumen{${contenido.trim()}}`
      : "%%RESUMEN_VACIO%%";
  });

  latex = latex.replace(/%%RESUMEN_VACIO%%[ \t]*([^\n]*)/g, (_match, resto) => {
    const texto = String(resto ?? "").trim();
    return texto ? `\\resumen{${texto}}` : "";
  });

  latex = latex.replace(
    /\\secciongrande\{\s*\\secciongrande\{([^{}]*)\}\s*\}/g,
    "\\secciongrande{$1}",
  );

  const tituloLimpio = String(tituloApartado ?? "").trim();
  const normalizar = (texto) =>
    String(texto ?? "")
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const temaNormalizado = normalizar(tituloTema);
  latex = latex.replace(/\\secciongrande\{([^{}]*)\}/g, (match, titulo) => {
    const esRotulo = /^\s*(?:tema|apartado|secci[oó]n)\s*\d+(?:[.\-]\d+)*\s*[:.\-–—]/i.test(titulo);
    const esNombreTema =
      Boolean(temaNormalizado) && normalizar(titulo) === temaNormalizado;
    if (esRotulo || esNombreTema) {
      return tituloLimpio ? `\\secciongrande{${tituloLimpio}}` : "";
    }
    return match;
  });

  return latex;
}

export function limpiarLatex(value) {
  let latex = String(value ?? "").trim();
  if (/^```(?:latex|tex)?\s*/i.test(latex)) {
    latex = latex
      .replace(/^```(?:latex|tex)?\s*/i, "")
      .replace(/\s*```$/, "");
  }

  const envolturaWecMalformada = /^\s*\\(?:secciongrande|seccion|subtituloA|subtituloB)\s*\{\s*(?=\\documentclass\b)/i.test(latex);
  latex = latex.replace(
    /^\s*\\(?:secciongrande|seccion|subtituloA|subtituloB)\s*\{\s*(?=\\documentclass\b)/i,
    "",
  );
  const beginDocument = latex.search(/\\begin\s*\{\s*document\s*\}/i);
  if (beginDocument >= 0) {
    const bodyStartMatch = /\\begin\s*\{\s*document\s*\}/i.exec(latex.slice(beginDocument));
    const bodyStart = beginDocument + bodyStartMatch[0].length;
    const endMatch = /\\end\s*\{\s*document\s*\}/i.exec(latex.slice(bodyStart));
    latex = latex.slice(bodyStart, endMatch ? bodyStart + endMatch.index : undefined);
  } else {
    latex = latex
      .replace(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
      .replace(/\\usepackage(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
      .replace(/\\RequirePackage(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
      .replace(/\\(?:input|include)\s*\{(?:carga|generador-estilos|preambulo|[^{}]*\.sty)[^{}]*\}/gi, "");
  }

  latex = latex
    .replace(/\\(?:begin|end)\s*\{\s*document\s*\}/gi, "")
    .replace(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
    .replace(/\\usepackage(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
    .replace(/\\RequirePackage(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/gi, "")
    .replace(/\\write18\s*\{[^{}]*\}/gi, "")
    .replace(/\\immediate\s*\\write[^\n]*/gi, "")
    .replace(/\\(?:openout|read|catcode)[^\n]*/gi, "")
    .replace(/\\(?:input|include)\s*\{(?:carga|generador-estilos|preambulo)[^{}]*\}/gi, "")
    .replace(/^\s*\\end\s*\{\s*document\s*\}\s*$/gim, "")
    .replace(/\/\/--><!\]\]>/g, "")
    .replace(/<!\[CDATA\[\/\/><!--/g, "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<!--\/\/-->/g, "")
    .trim();

  latex = latex.replace(/\\begin\{(codigo|consola)\}([\s\S]*?)\\end\{\1\}/g, (_m, env, code) => {
    const clean = code
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\]\]>/g, "");
    return `\\begin{${env}}${clean}\\end{${env}}`;
  });

  if (envolturaWecMalformada) latex = latex.replace(/}\s*$/, "").trim();

  latex = latex.replace(
    /^\s*\\(?:secciongrande|seccion|subtituloA|subtituloB)\s*\{\s*(?=\\(?:title|author|date|maketitle|tableofcontents))/i,
    "",
  );
  return latex;
}

export function convertirMarkdownALatexWec(contenido = "") {
  if (!contenido || typeof contenido !== "string") return "";
  let texto = contenido
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\/\/--><!\]\]>/g, "")
    .replace(/<!\[CDATA\[\/\/><!--/g, "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<!--\/\/-->/g, "")
    .trim();

  const verbatimBlocks = [];
  texto = texto.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (_match, lang, code) => {
    const l = (lang || "").toLowerCase();
    const token = `%%VERBATIM_BLOCK_${verbatimBlocks.length}%%`;
    const cleanCode = code
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\]\]>/g, "")
      .replace(/^\s*\n+/, "")
      .replace(/^(?:javascript|html|css|python|java|bash|sql|cpp|c)\s*\n/i, "")
      .trimEnd();
    if (["bash", "sh", "shell", "terminal", "consola", "console"].includes(l)) {
      verbatimBlocks.push(`\\begin{consola}\n${cleanCode}\n\\end{consola}`);
    } else {
      verbatimBlocks.push(`\\begin{codigo}\n${cleanCode}\n\\end{codigo}`);
    }
    return token;
  });

  texto = texto.replace(/\\begin\{(?:codigo|consola)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{(?:codigo|consola)\}/gi, (_match, code) => {
    const token = `%%VERBATIM_BLOCK_${verbatimBlocks.length}%%`;
    const cleanCode = code
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\]\]>/g, "")
      .replace(/^\s*\n+/, "")
      .replace(/^(?:javascript|html|css|python|java|bash|sql|cpp|c)\s*\n/i, "")
      .trimEnd();
    verbatimBlocks.push(`\\begin{codigo}\n${cleanCode}\n\\end{codigo}`);
    return token;
  });

  const latexMacroBlocks = [];
  function protegerMacro(str, macroNombre) {
    const patron = `\\${macroNombre}{`;
    let salida = "";
    let pos = 0;
    while (pos < str.length) {
      const idx = str.indexOf(patron, pos);
      if (idx === -1) {
        salida += str.slice(pos);
        break;
      }
      salida += str.slice(pos, idx);
      const apertura = idx + patron.length - 1;
      let fin = apertura;
      let prof = 0;
      for (; fin < str.length; fin++) {
        const c = str[fin];
        if (c === "\\") { fin++; continue; }
        if (c === "{") prof++;
        else if (c === "}") {
          prof--;
          if (prof === 0) break;
        }
      }
      if (fin >= str.length) {
        salida += str.slice(idx);
        break;
      }
      let finTotal = fin + 1;
      if (["definicion", "definicionpar", "nota"].includes(macroNombre)) {
        let segundoInicio = finTotal;
        while (segundoInicio < str.length && /\s/.test(str[segundoInicio])) segundoInicio++;
        if (segundoInicio < str.length && str[segundoInicio] === "{") {
          let prof2 = 0;
          let fin2 = segundoInicio;
          for (; fin2 < str.length; fin2++) {
            const c = str[fin2];
            if (c === "\\") { fin2++; continue; }
            if (c === "{") prof2++;
            else if (c === "}") {
              prof2--;
              if (prof2 === 0) break;
            }
          }
          if (fin2 < str.length) finTotal = fin2 + 1;
        }
      }
      const token = `%%LATEX_MACRO_${latexMacroBlocks.length}%%`;
      latexMacroBlocks.push(str.slice(idx, finTotal));
      salida += token;
      pos = finTotal;
    }
    return salida;
  }

  const macrosAProteger = [
    "lista",
    "pasos",
    "rectangulos",
    "rectangulosdoble",
    "definicion",
    "definicionpar",
    "nota",
    "alertas",
    "resumen",
    "tabla",
  ];
  for (const m of macrosAProteger) {
    texto = protegerMacro(texto, m);
  }

  texto = texto.replace(/(?:^|\n)((?:\|[^\n]+\|\r?\n)+\|[ \t]*[-:]+[-| :]*\|\r?\n(?:\|[^\n]+\|\r?\n?)+)/g, (match, bloque) => {
    const lineas = bloque.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lineas.length < 3) return match;
    const parsearFila = (fila) => fila.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
    const cabeceras = parsearFila(lineas[0]);
    const numCols = cabeceras.length;
    if (numCols === 0) return match;
    const anchoCol = (16.0 / numCols).toFixed(1);
    const spec = cabeceras.map(() => `L{${anchoCol}cm}`).join("");
    const cabeceraWec = cabeceras.map(c => `\\tablacab{${c}}`).join(" & ") + " \\\\";
    const filasDatos = lineas.slice(2).map(fila => {
      const celdas = parsearFila(fila);
      return celdas.join(" & ") + " \\\\";
    }).join("\n");
    return `\n\\tabla[${spec}]{\n${cabeceraWec}\n\\midrule\n${filasDatos}\n}\n`;
  });

  texto = texto.replace(/(^[ \t]*(?:\d+[.)]?|[-*•]))\s*\r?\n+[ \t]*(?=[A-Za-zÁÉÍÓÚáéíóúñÑ`"'\*\<\\\$])/gm, "$1 ");

  texto = texto
    .replace(/^####\s+(?:subt[ií]tulo(?:\s+[a-z0-9]+)?\s*[:.\-–—]\s*)?(.+)$/gmi, "\n\\subtituloB{$1}\n\n")
    .replace(/^###\s+(?:subt[ií]tulo(?:\s+[a-z0-9]+)?\s*[:.\-–—]\s*)?(.+)$/gmi, "\n\\subtituloA{$1}\n\n")
    .replace(/^##\s+(?:secci[oó]n(?:\s+[a-z0-9]+)?\s*[:.\-–—]\s*)?(.+)$/gmi, "\n\\seccion{$1}\n\n")
    .replace(/^#\s+(?:t[ií]tulo\s*[:.\-–—]\s*)?(.+)$/gmi, "\n\\secciongrande{$1}\n\n");

  texto = texto.replace(/^>\s*(?:\*\*Resumen:?\*\*|\[!SUMMARY\])\s*([\s\S]+?)(?=\n\n|\n[^\s>]|$)/gmi, (_m, body) => {
    let limpio = body.replace(/^>\s*/gm, "").trim();
    const partesFuera = [];
    limpio = limpio.replace(/(?:^|\n)((?:[*-]\s+|\d+\.\s+)[^\n]+(?:\n(?:[*-]\s+|\d+\.\s+)[^\n]+)*)/g, (_mList, listBlock) => {
      partesFuera.push(listBlock.trim());
      return "";
    });
    limpio = limpio.replace(/(?:^|\n)(\*\*Definici[oó]n[^\n]*\n[\s\S]*?)(?=\n\n|\n\*\*|$)/gi, (_mDef, defBlock) => {
      partesFuera.push(defBlock.trim());
      return "";
    });
    limpio = limpio.trim();
    const resumenTex = limpio ? `\\resumen{${limpio}}` : "";
    const fueraTex = partesFuera.length > 0 ? "\n\n" + partesFuera.join("\n\n") : "";
    return `${resumenTex}${fueraTex}`;
  });

  texto = texto.replace(/^>\s*\*\*Definici[oó]n\s*(?:par)?\s*(?:\[([^\]]+)\]:?|:\s*([^:\n]+)[:\-]?)\*\*\s*([\s\S]+?)(?=\n\n|\n[^\s>]|$)/gmi, (_m, t1, t2, desc) => {
    const termino = (t1 || t2 || "Concepto").trim();
    const explicacion = desc.replace(/^>\s*/gm, "").trim();
    return `\\definicion{${termino}}{${explicacion}}`;
  });

  texto = texto.replace(/^\*\*Definici[oó]n\s*(?:par)?\s*(?:\[([^\]]+)\]:?|:\s*([^:\n]+)[:\-]?)\*\*\s*([\s\S]+?)(?=\n\n|\n[A-Z#\-\*]|$)/gmi, (_m, t1, t2, desc) => {
    const termino = (t1 || t2 || "Concepto").trim();
    const explicacion = desc.trim();
    return `\\definicion{${termino}}{${explicacion}}`;
  });

  texto = texto.replace(/^>\s*(?:\*\*(?:Para el examen|Examen|Posa'?t a prova|Autoevaluaci[oó]n|Comprovem l'apr[eè]s):?\*\*|\[!(?:NOTE|TIP)\])\s*([\s\S]+?)(?=\n\n|\n[^\s>]|$)/gmi, (_m, body) => {
    return `\\nota{Para el examen}{${body.replace(/^>\s*/gm, "").trim()}}`;
  });

  texto = texto.replace(/^>\s*(?:\*\*(?:Alerta|Advertencia|Importante|Seguridad):?\*\*|\[!(?:WARNING|CAUTION|IMPORTANT)\])\s*([\s\S]+?)(?=\n\n|\n[^\s>]|$)/gmi, (_m, body) => {
    return `\\alertas{${body.replace(/^>\s*/gm, "").trim()}}`;
  });

  texto = texto.replace(/^>\s+([\s\S]+?)(?=\n\n|\n[^\s>]|$)/gm, (_m, body) => {
    const clean = body.replace(/^>\s*/gm, "").trim();
    if (!clean) return "";
    return `\\alertas{${clean}}`;
  });

  texto = texto.replace(
    /(?:^|\n)\s*(?:\*\*)?(?:[1-9][.)]|\d+\.)(?:\*\*)?\s*([A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóú0-9_ -]{1,35}):\s*([\s\S]+?)(?=(?:\n\s*(?:\*\*)?(?:[1-9][.)]|\d+\.)(?:\*\*)?\s*[A-ZÁÉÍÓÚ]|\n\n|$))/g,
    (match, key, val) => {
      const k = key.trim();
      if (/^(https?|nota|definici[oó]n|ejemplo|resumen|c[oó]digo|tabla|figura)$/i.test(k)) {
        return match;
      }
      return `\n- **${k}:** ${val.trim()}`;
    }
  );

  texto = texto.replace(/(?:^|\n)((?:^[ \t]*\d+\.\s+[^\n]+\r?\n?)+)/gm, (match, bloque) => {
    const items = bloque
      .trim()
      .split(/\r?\n/)
      .map(linea => linea.replace(/^[ \t]*\d+\.\s*/, "").trim())
      .filter(Boolean);
    if (items.length === 0) return match;
    return `\n\\pasos{\n  ${items.join(" |\n  ")}\n}\n`;
  });

  texto = texto.replace(/(?:^|\n)((?:^[ \t]*[*-]\s+[^\n]+\r?\n?)+)/gm, (match, bloque) => {
    const items = bloque
      .trim()
      .split(/\r?\n/)
      .map(linea => linea.replace(/^[ \t]*[*-]\s*/, "").replace(/\|\s*$/, "").trim())
      .filter(Boolean);
    if (items.length === 0) return match;
    return `\n\\lista{\n  ${items.join(" |\n  ")}\n}\n`;
  });

  // Convertir secuencias de **Término:** Descripción a \lista oficial WEC
  texto = texto.replace(/(?:(?:^|\n|\n\n)\s*\*\*([^*:\n]{2,60}):\*\*[\s\S]+?)(?=(?:\n\n(?!\s*\*\*)|\\(?:seccion|subtitulo|resumen|definicion|nota|begin)|$))/g, (bloque) => {
    const items = [];
    const regex = /\*\*([^*:\n]{2,60}):\*\*\s*([\s\S]+?)(?=(?:\s*\*\*([^*:\n]{2,60}):\*\*)|$)/g;
    let m;
    while ((m = regex.exec(bloque)) !== null) {
      const term = m[1].trim();
      const desc = m[2].trim().replace(/\s*\n\s*/g, " ");
      if (term && desc && !/^(?:nota|definici[oó]n|resumen|ejemplo)$/i.test(term)) {
        items.push(`**${term}:** ${desc}`);
      }
    }
    if (items.length >= 2) {
      return `\n\\lista{\n  ${items.join(" |\n  ")}\n}\n`;
    }
    return bloque;
  });

  texto = texto.replace(/`([^`\n]+)`/g, (_m, code) => `\\cmd{${code}}`);
  texto = texto.replace(/(?<!\\cmd\{)<(\/?[a-zA-Z0-9_-]+(?: [^>]*)?)>(?!\})/g, "\\cmd{<$1>}");

  for (let i = 0; i < verbatimBlocks.length; i++) {
    texto = texto.replace(`%%VERBATIM_BLOCK_${i}%%`, verbatimBlocks[i]);
  }

  for (let i = 0; i < latexMacroBlocks.length; i++) {
    texto = texto.replace(`%%LATEX_MACRO_${i}%%`, latexMacroBlocks[i]);
  }

  texto = texto
    .replace(/\\begin\{narrow\}(?:\[[^\]]*\]|\{[^{}]*\})*\s*/gi, "")
    .replace(/\\end\{narrow\}\s*/gi, "")
    .replace(/\\label\{[^{}]*\}\s*/gi, "");

  return texto.replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizarNotas(texto) {
  let pos = 0;
  let resultado = "";
  const listaNotas = [];

  while (pos < texto.length) {
    const idx = texto.indexOf("\\nota{", pos);
    if (idx === -1) {
      resultado += texto.slice(pos);
      break;
    }
    resultado += texto.slice(pos, idx);
    const cur = idx + 5;

    let prof1 = 0;
    let end1 = cur;
    for (; end1 < texto.length; end1++) {
      const ch = texto[end1];
      if (ch === "\\") { end1++; continue; }
      if (ch === "{") prof1++;
      else if (ch === "}") {
        prof1--;
        if (prof1 === 0) break;
      }
    }
    if (end1 >= texto.length) {
      resultado += texto.slice(idx);
      break;
    }
    const titulo = texto.slice(cur + 1, end1);

    let start2 = end1 + 1;
    while (start2 < texto.length && /\s/.test(texto[start2])) start2++;
    if (start2 >= texto.length || texto[start2] !== "{") {
      resultado += texto.slice(idx, start2);
      pos = start2;
      continue;
    }

    let prof2 = 0;
    let end2 = start2;
    for (; end2 < texto.length; end2++) {
      const ch = texto[end2];
      if (ch === "\\") { end2++; continue; }
      if (ch === "{") prof2++;
      else if (ch === "}") {
        prof2--;
        if (prof2 === 0) break;
      }
    }
    if (end2 >= texto.length) {
      resultado += texto.slice(idx);
      break;
    }
    let cuerpo = texto.slice(start2 + 1, end2);

    cuerpo = cuerpo
      .trim()
      .replace(/^\s*(?:\*\*)?(?:Para el examen|Examen|Ojo para el examen|Comprovem l'apr[eè]s|Posa'?t a prova)[:\s-]*(?:\*\*)?\s*/i, "")
      .replace(/([^\n])\s+([a-d]\)\s+)/gi, "$1\n$2")
      .replace(/(?:\s*)(?:\\textbf\{\s*Respuesta[^}]*\}|(?:extbf|(?<!\\)\b)Respuesta(?:\s+correcta)?)\s*[:—-]*/gi, () => "\n\n\\textbf{Respuesta:} ")
      .replace(/(?:\\textbf\{\s*Respuesta:\s*\}\s*)+/g, "\\textbf{Respuesta:} ")
      .trim();

    if (listaNotas.length > 0) {
      const ultima = listaNotas[listaNotas.length - 1];
      const entreMedias = resultado.slice(ultima.finResultado);
      if (/^\s*$/.test(entreMedias) && ultima.titulo.trim().toLowerCase() === titulo.trim().toLowerCase()) {
        resultado = resultado.slice(0, ultima.inicioResultado);
        const cuerpoFusionado = `${ultima.cuerpo}\n\n\\vspace{2.5mm}\\hrulefill\\vspace{2.5mm}\n\n${cuerpo}`;
        const notaStr = `\\nota{${ultima.titulo}}{\n${cuerpoFusionado}\n}`;
        ultima.cuerpo = cuerpoFusionado;
        ultima.inicioResultado = resultado.length;
        resultado += notaStr;
        ultima.finResultado = resultado.length;
        pos = end2 + 1;
        continue;
      }
    }

    const inicioRes = resultado.length;
    const notaStr = `\\nota{${titulo}}{\n${cuerpo}\n}`;
    resultado += notaStr;
    listaNotas.push({
      titulo,
      cuerpo,
      inicioResultado: inicioRes,
      finResultado: resultado.length
    });
    pos = end2 + 1;
  }

  return resultado;
}

export function aplicarEstilosLatex(value, subject = "") {
  let resultado = limpiarLatex(value);

  resultado = resultado
    .replace(/\\maketitle\b/g, "")
    .replace(/\\tableofcontents\b/g, "")
    .replace(/\\(?:title|author|date)\s*\{[^{}]*\}/g, "")
    .replace(/\\t(?=[A-ZÁÉÍÓÚÑ])/g, "");

  resultado = resultado
    .replace(/\\definitionpar\b/g, "\\definicionpar")
    .replace(/\\definition\b/g, "\\definicion")
    .replace(/\\sectiongrande\b/g, "\\secciongrande")
    .replace(/\\rista\b/g, "\\lista")
    .replace(/\\subtitulo\b/g, "\\subtituloA");

  resultado = resultado.replace(/\\n(?!(?:ota|ode|abla|ewcommand|ewenvironment|ewlist|ewline|ormalsize|oindent|umber|egrita)\b)/g, "\n");

  resultado = resultado
    .replace(/\\+b\\begin/g, "\\begin")
    .replace(/[\x08]\s*egin/g, "\\begin")
    .replace(/(?:^|\s)egin\{secciongrande\}/g, "\\secciongrande")
    .replace(/(?:^|\s)egin\{seccion\}/g, "\\seccion")
    .replace(/(?:^|\s)egin\{/g, (m) => m.replace("egin{", "\\begin{"))
    .replace(/(?:^|\s)end\{/g, (m) => m.replace("end{", "\\end{"))
    .replace(/(?:[\x00-\x1f\s]|\b|\\)extbf\s*\{+/g, " \\textbf{")
    .replace(/(?:[\x00-\x1f\s]|\b|\\)extbf\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+:)/g, " \\textbf{$1}")
    .replace(/(?:[\x00-\x1f\s]|\b|\\)extcolor\s*\{+/g, " \\textcolor{")
    .replace(/\\(textbf|textit|cmd|nota|definicion)\s*\{{2,}/g, "\\$1{")
    .replace(/(?:[\x00-\x1f\s]|\b)eginconsola/g, "\\begin{consola}")
    .replace(/(?:[\x00-\x1f\s]|\b)eginhtml/g, "\\begin{codigo}")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/^[><]{2,4}\s*/gm, "")
    .replace(/(?:^|\n)\s*[.•·]\s*([A-Za-zÁÉÍÓÚÑáéíóúñ][^:\n]{1,60}:)/g, "\n\n**$1**")
    .replace(/(?:^|\n)\s*[•·]\s*$/gm, "");

  resultado = resultado.replace(
    /(?:\\begin\{codigo\}|```[a-z]*)\s*[\s\S]*?(?:def\s+visual|def\s+tecnologia|def\s+distribucio)[\s\S]*?(?:\\end\{codigo\}|```)/gi,
    () => `\\rectangulos{
  {Visual}{Aspecto visual atractivo y comunicativo, centrado en la experiencia del usuario y su retención futura.}
  {Tecnología}{Decisiones sobre cómo implementar la página (estática o dinámica), lenguajes y bases de datos a emplear.}
  {Distribución}{Velocidad y fiabilidad para transmitir datos al cliente final sin interrupciones mediante protocolos eficientes.}
  {Propósito}{Objetivo fundamental del sitio web: modelo de negocio, comercio electrónico o difusión informativa.}
}`
  );

  resultado = resultado
    .replace(/ZZBLOQUECODIGO\w*FINZZ/g, "")
    .replace(/%%PROTECTED_CODE_\w*%%/g, "")
    .replace(/\bClient-Servidor\b/gi, "Cliente-Servidor")
    .replace(/\bClient\s+Servidor\b/gi, "Cliente Servidor");

  resultado = resultado
    .replace(/(?:\\begin|egin)\{secciongrande\}\{([^{}]*)\}/gi, "\\secciongrande{$1}")
    .replace(/(?:\\begin|egin)\{seccion\}\{([^{}]*)\}/gi, "\\seccion{$1}")
    .replace(/(?:\\begin|egin)\{subtitulo(?:A|B)?\}\{([^{}]*)\}/gi, "\\subtituloA{$1}")
    .replace(/(?:\\begin|egin)\{resumen\}\s*([\s\S]*?)\s*(?:\\end|end)\{resumen\}/gi, "\\resumen{$1}")
    .replace(/\\end\{secciongrande\}/gi, "")
    .replace(/\\end\{seccion\}/gi, "")
    .replace(/\\end\{subtitulo(?:A|B)?\}/gi, "");

  resultado = resultado
    .replace(/\\begin\{consola\}(?:\}+)?(?:\[[^\]]*\]|\{[^}]*\})*/g, "\\begin{consola}")
    .replace(/\\begin\{codigo\}(?:\}+)?\[Lenguaje\](?:\{[^}]*\})*/g, "\\begin{codigo}")
    .replace(/\\begin\{codigo\}\}+/g, "\\begin{codigo}")
    .replace(/\\begin\{lista\}(?:\}+)?\{[^{}]*\}/g, "\\begin{itemize}")
    .replace(/\\end\{lista\}/g, "\\end{itemize}")
    .replace(/\\begin\{lista\}/gi, "")
    .replace(/\\end\{lista\}/gi, "")
    .replace(/(?:\\|\b)o(?:t|tr)a(?=\s*\{)/gi, "\\nota")
    .replace(/\\secciongrande\{\[object\s+Object\]\}\s*/gi, "")
    .replace(/\[object\s+Object\]/gi, "");

  resultado = resultado
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\/\/--><!\]\]>/g, "")
    .replace(/<!\[CDATA\[\/\/><!--/g, "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<!--\/\/-->/g, "")
    .replace(/(?:^|\n|\s)\]\]+(?=\s|[.,;:]|$)/g, " ");

  // Reparar listas cerradas prematuramente como: \lista{ ... }. Licencias: ...
  resultado = resultado.replace(
    /\\lista\{([^{}]*)\}\s*[.·•]\s*([A-Za-zÁÉÍÓÚáéíóúñÑ][^:\n]{1,50}:[^\n]+)/g,
    (_m, items, resto) => `\\lista{\n  ${items.trim()} |\n  ${resto.trim()}\n}`
  );

  while (/\\lista\{[\s\S]*?\\lista\{/.test(resultado)) {
    resultado = resultado.replace(/\\lista\{([\s\S]*?)\\lista\{([\s\S]*?)\}([\s\S]*?)\}/g, (_m, antes, dentro, despues) => {
      const parteAntes = antes.trim();
      const parteDentro = dentro.trim();
      const parteDespues = despues.trim();
      return `\\lista{\n  ${parteAntes ? parteAntes + " |\n  " : ""}${parteDentro}${parteDespues ? " |\n  " + parteDespues : ""}\n}`;
    });
  }

  resultado = resultado.replace(/\\lista\{([^{}]*)\}/gs, (_m, contenidoLista) => {
    const subtitulos = [];
    let limpio = contenidoLista.replace(/\\(subtitulo[AB]?|seccion(?:grande)?)\{([^{}]*)\}/g, (_sm, smacro, stit) => {
      subtitulos.push(`\\${smacro}{${stit}}`);
      return "";
    });

    let items = limpio
      .split(/\s*\|\s*|\n{2,}/)
      .map((it) => it.trim())
      .filter((it) => it.length > 0 && !/^[-*•·.\s]+$/.test(it));

    items = items.map((it) => {
      let s = it.replace(/^[.\-•*·]\s*/, "");
      if (/^[A-Za-zÁÉÍÓÚáéíóúñÑ][^:]{1,40}:/.test(s) && !s.startsWith("**") && !s.startsWith("\\textbf")) {
        s = s.replace(/^([^:]+):/, "**$1:**");
      }
      return s;
    });

    const listaStr = items.length ? `\\lista{\n  ${items.join(" |\n  ")}\n}` : "";
    return (subtitulos.length ? subtitulos.join("\n\n") + "\n\n" : "") + listaStr;
  });

  // Eliminar viñetas huérfanas y corregir items con punto inicial (. Licencias:)
  resultado = resultado
    .replace(/(?:^|\n)\s*[•·\-*]\s*(?=\n|$)/g, "\n")
    .replace(/(^|\n)\s*[.·•]\s*([A-Za-zÁÉÍÓÚáéíóúñÑ][^:\n]{1,40}:)/g, "$1**$2**")
    .replace(/(^|\s)\]\]+(?=\s|[.,;:]|$)/g, "$1");

  resultado = resultado.replace(/(^|[\n|])\s*([A-Za-z0-9ÁÉÍÓÚáéíóúñÑ][^:\n|]{1,60}):\*\*/g, "$1**$2:**");

  // Detectar y convertir secuencias sueltas de **Término:** Descripción a \lista oficial WEC
  resultado = resultado.replace(/(?:(?:^|\n|\n\n)\s*\*\*([^*:\n]{2,60}):\*\*[\s\S]+?)(?=(?:\n\n(?!\s*\*\*)|\\(?:seccion|subtitulo|resumen|definicion|nota|begin)|$))/g, (bloque) => {
    const items = [];
    const regex = /\*\*([^*:\n]{2,60}):\*\*\s*([\s\S]+?)(?=(?:\s*\*\*([^*:\n]{2,60}):\*\*)|$)/g;
    let m;
    while ((m = regex.exec(bloque)) !== null) {
      const term = m[1].trim();
      const desc = m[2].trim().replace(/\s*\n\s*/g, " ");
      if (term && desc && !/^(?:nota|definici[oó]n|resumen|ejemplo)$/i.test(term)) {
        items.push(`**${term}:** ${desc}`);
      }
    }
    if (items.length >= 2) {
      return `\n\\lista{\n  ${items.join(" |\n  ")}\n}\n`;
    }
    return bloque;
  });

  resultado = resultado
    .replace(/\\b?end\{codigo\}/gi, "\\end{codigo}")
    .replace(/\\bend\b/gi, "\\end");

  resultado = normalizarNotas(resultado);

  resultado = resultado
    .replace(/\\definicion\{([^{}]*)\}\{([^{}]*)\}/gs, (_m, tit, cont) => `\\definicion{${tit}}{${cont.replace(/\n\s*\n+/g, "\n")}}`)
    .replace(/\\resumen\{([^{}]*)\}/gs, (_m, cont) => `\\resumen{${cont.replace(/\n\s*\n+/g, "\n")}}`);

  resultado = resultado
    .replace(/(?:\\begin|egin)\{definicion\}\{([^}]+)\}\{([^}]+)\}\s*\\end\{definicion\}/gi, "\\definicion{$1}{$2}")
    .replace(/\\subsecci[oó]n(?=[^a-zA-Z])/g, "\\subtituloA")
    .replace(/\\subsectionA(?=[^a-zA-Z])/g, "\\subtituloA")
    .replace(/\\subsectionB(?=[^a-zA-Z])/g, "\\subtituloB")
    .replace(/\\subsubsectionA(?=[^a-zA-Z])/g, "\\subtituloA")
    .replace(/\\subsubsectionB(?=[^a-zA-Z])/g, "\\subtituloB")
    .replace(/code\[\]\{([^{}]*)\}/g, "\\cmd{$1}")
    .replace(/\\textbf\{%\}/g, "\\textbf{\\%}")
    .replace(/\\textbf:([^:]*):/g, "\\textbf{$1}")
    .replace(/\\subt[ií]tuloA(?=[^a-zA-Z])/g, "\\subtituloA")
    .replace(/\\subt[ií]tuloB(?=[^a-zA-Z])/g, "\\subtituloB")
    .replace(/\\thetema(?=[^a-zA-Z])/g, "")
    .replace(/\\refstepcounter\{[^{}]*\}/g, "")
    .replace(/\\dotfill/g, "-")
    .replace(/\[label=[^\]]*\]\s*\|?/g, "")
    .replace(/\\(?:explicaci[oó]|expliqui|descriu|explica|discuteix|analitzi|mostra|defineix)(?=[^a-zA-Z])/g, "")
    .replace(/\\definicion(?:par)?\[[^\]]*\]\{([^}]+)\}\{([^}]+)\}/g, "\\definicionpar{$1}{$2}")
    .replace(/\\definicion(?:par)?\{([^}]+)\}\{([^}]+)\}\{([^}]+)\}/g, "\\definicionpar{$2}{$3}")
    .replace(/(\\(?:secciongrande|seccion|subtitulo|subtituloA|subtituloB)\{[^}]*\})\s*\\\\/g, "$1\n")
    .replace(/(?:^|\n)\s*\\\\\s*(?=\n|$)/g, "\n")
    .replace(/(?:^|\n)\s*\\\\/g, "\n");

  resultado = resultado
    .replace(/\\begin\{example\}\s*([\s\S]*?)\s*\\end\{example\}/gi, (_match, body) => `\\nota{Ejemplo}{\n${body.trim()}\n}`)
    .replace(/\\begin\{quoting\}\s*([\s\S]*?)\s*\\end\{quoting\}/gi, (_match, body) => `\\alertas{${body.trim()}}`)
    .replace(/\\begin\{narrow\}(?:\[[^\]]*\]|\{[^{}]*\})*\s*/gi, "")
    .replace(/\\end\{narrow\}\s*/gi, "")
    .replace(/\\label\{[^{}]*\}\s*/gi, "")
    .replace(/(?<!\\)\btextbf\{/g, "\\textbf{")
    .replace(/(?<!\\)\btextit\{/g, "\\textit{")
    .replace(/(?<!\\)\btexttt\{/g, "\\texttt{")
    .replace(/\\lstinline(?:\[[^\]]*\])?(?:\|([^|]*)\||\{([^}]*)\})/g, (_match, p1, p2) => `\\cmd{${p1 ?? p2 ?? ""}}`);

  resultado = resultado.replace(/\\resumen\{([^{}]*)\}/gs, (_match, cuerpo) => {
    const limpio = String(cuerpo)
      .replace(
        /(?:^|\s)(?:En|Este|El presente)\s+(?:este\s+)?apartado\s+(?:se\s+)?(?:explica|explican|describe|describen|analiza|analizan|introduce|introducen|presenta|presentan|aborda|abordan)[^.]*\./gi,
        " ",
      )
      .replace(
        /(?:^|\s)A\s+continuación\s+(?:veremos|se\s+muestra|se\s+explica)[^.]*\./gi,
        " ",
      )
      .replace(
        /(?:^|\s)Además,?\s+se\s+(?:proporciona|incluye|presenta)[^.]*\./gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
    return limpio ? `\\resumen{${limpio}}` : "";
  });

  resultado = resultado
    .replace(/(\\definicion(?:par)?\{[^{}]*\}\{[^{}]*?)(?=\\begin\{(?:codigo|consola)\})/gi, (m) => `${m.trimEnd()}\n}\n\n`)
    .replace(/(\\nota\{[^{}]*\}\{[^{}]*?)(?=\\begin\{(?:codigo|consola)\})/gi, (m) => `${m.trimEnd()}\n}\n\n`)
    .replace(/(\\alertas\{[^{}]*?)(?=\\begin\{(?:codigo|consola)\})/gi, (m) => `${m.trimEnd()}\n}\n\n`)
    .replace(/(\\resumen\{[^{}]*?)(?=\\begin\{(?:codigo|consola)\})/gi, (m) => `${m.trimEnd()}\n}\n\n`)
    .replace(/(\\end\{(?:codigo|consola)\}\s*)\}/g, "$1")
    .replace(/\\resumen\{\s*\}/g, "");

  resultado = extraerMacrosDeResumen(resultado);
  resultado = estructurarTextoPlano(resultado);
  resultado = convertirTablasWec(resultado);
  resultado = convertirListasWec(resultado);
  resultado = normalizarListasWec(resultado);
  resultado = convertirCodigoWec(resultado);

  resultado = resultado.replace(/\\item(?:\s+|\[[^\]]*\])/g, "\n");

  resultado = resultado
    .replace(/\\secciongrande\{Concepto principal[^{}]*\}/gi, (_match) =>
      subject ? `\\secciongrande{${subject}}` : "\\secciongrande{Tema}",
    )
    .replace(/\\definicion(?:par)?\{Término\}\{[^}]*\}\s*/gi, "")
    .replace(/\\definicion(?:par)?\{Opción [ABC]\}\{[^}]*\}\s*/gi, "")
    .replace(/\\resumen\{Define (?:la idea central|en 2 o 3 líneas)[^}]*\}\s*/gi, "")
    .replace(/\\nota\{Para el examen\}\{[^}]*known_hosts[^}]*\}\s*/gi, (match) =>
      /ssh|known_hosts/i.test(subject) ? match : "",
    )
    .replace(
      /(\\rectangulos\{(?:\s*\{[^{}]*\}\s*\{[^{}]*\})+\s*)(?=\\seccion(?:grande)?\{)/g,
      "$1}\n\n",
    );

  resultado = resultado
    .replace(/^####\s+(.+)$/gm, "\\subtituloB{$1}")
    .replace(/^###\s+(.+)$/gm, "\\subtituloA{$1}")
    .replace(/^##\s+(.+)$/gm, "\\seccion{$1}")
    .replace(/^#\s+(.+)$/gm, "\\secciongrande{$1}");

  resultado = resultado.replace(/\\tarjeta\{([^}]+)\}\{([^}]+)\}\{([^}]+)\}/g, (_m, t1, t2, t3) => {
    return `\\definicion{${t2.trim()}}{${t3.trim()}}`;
  });

  resultado = resultado
    .replace(
      /\\sectiongrande(?=\s*\{)/g,
      "\\secciongrande",
    )
    .replace(
      /\\section\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g,
      (_match, title) =>
        `\\secciongrande{${quitarAsignaturaDelTitulo(title, subject)}}`,
    )
    .replace(
      /\\subsection\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g,
      (_match, title) =>
        `\\subtituloA{${quitarAsignaturaDelTitulo(title, subject)}}`,
    )
    .replace(
      /\\subsubsection\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g,
      (_match, title) =>
        `\\subtituloA{${quitarAsignaturaDelTitulo(title, subject)}}`,
    )
    .replace(
      /\\(secciongrande|seccion|subtitulo|subtituloA|subtituloB)\{([^{}]*)\}/g,
      (_match, macro, title) => {
        let m = macro;
        if (m === "seccion" && /subt[ií]tulo/i.test(title)) {
          m = "subtituloA";
        }
        let clean = quitarAsignaturaDelTitulo(title, subject)
          .replace(/^(?:subt[ií]tulo(?:\s+[a-z0-9]+)?|secci[oó]n(?:\s+[a-z0-9]+)?|apartado(?:\s+[a-z0-9]+)?|t[ií]tulo)\s*[:.\-–—]\s*/i, "")
          .replace(/<(\/?[a-zA-Z0-9_-]+(?: [^>]*)?)>/g, "\\cmd{<$1>}")
          .replace(/</g, "\\textless ")
          .replace(/>/g, "\\textgreater ")
          .replace(/\s*[:\-–—!¡?¿]+\s*$/g, "")
          .trim();
        clean = normalizarMayusculasTitulo(clean);
        if (clean.length > 0) {
          clean = clean.charAt(0).toUpperCase() + clean.slice(1);
        }
        return `\\${m}{${clean}}`;
      },
    );

  let secciongrandeEncontrada = false;
  resultado = resultado.replace(/\\secciongrande\{([^{}]+)\}/g, (match, title) => {
    if (!secciongrandeEncontrada) {
      secciongrandeEncontrada = true;
      return match;
    }
    return `\\subtituloA{${title}}`;
  });

  resultado = resultado.replace(/(\\(?:secciongrande|subtituloA|subtituloB)\{([^{}]+)\})\s*\n+\s*\\(?:secciongrande|subtituloA|subtituloB)\{\2\}/g, "$1");

  resultado = resultado.replace(
    /\\seccion(?!grande)(?:\[[^\]]*\])?\{([^{}]*)\}/g,
    (_match, titulo) =>
      `\\subtituloA{${quitarAsignaturaDelTitulo(titulo, subject).trim()}}`,
  );

  resultado = resultado.replace(
    /\\subtitulo([AB])\{\s*([^{}]*?)\s*\}/g,
    (match, _nivel, titulo) => (esSubtituloGenerico(titulo) ? "" : match),
  );

  resultado = resultado
    .replace(/\\vspace\*?\{-[^}]*\}\s*/gi, "\n\n")
    .replace(/(\\(?:secciongrande|seccion|subtituloA|subtituloB|titulo)\{[^}]*\})\s*(?:\\vspace\*?\{-[^}]*\}\s*)?/gi, "$1\n\n");

  resultado = resultado.replace(/\n{3,}/g, "\n\n");

  resultado = resultado.replace(/\\lista\{([^{}]+)\}/g, (match, cuerpo) => {
    if (!cuerpo.includes("|")) {
      let limpio = cuerpo.replace(/^(?:Entre\s+(?:ellas|ellos)\s+se\s+encuentran|Estos\s+componentes\s+incluyen|Se\s+encarga\s+de)\s*[:.\-–—\s]+/i, "").trim();
      const items = [];
      const regex = /(?:^|\n|(?<=[.:;]\s+))(?:[1-9]\.?\s*)?([A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóú0-9_ \-()\/\+]{1,45}):\s*([\s\S]+?)(?=(?:(?:\.|\;|\n)\s*(?:[1-9]\.?\s*)?[A-ZÁÉÍÓÚ][A-Za-zÁÉÍÓÚáéíóú0-9_ \-()\/\+]{1,45}:\s+)|\n\n|$)/g;
      let mCoincidencia;
      while ((mCoincidencia = regex.exec(limpio)) !== null) {
        const k = mCoincidencia[1].trim();
        if (!/^(https?|nota|definici[oó]n|ejemplo|resumen|c[oó]digo|tabla|figura)$/i.test(k)) {
          items.push(`**${k}:** ${mCoincidencia[2].trim()}`);
        }
      }
      if (items.length > 1) {
        return `\\lista{\n  ${items.join(" |\n  ")}\n}`;
      }
      const lineas = limpio.split(/\r?\n/).map(l => l.replace(/^[ \t]*[-*]\s*/, "").trim()).filter(Boolean);
      if (lineas.length > 1) {
        return `\\lista{\n  ${lineas.join(" |\n  ")}\n}`;
      }
      const negritas = [...limpio.matchAll(/\*\*([^*]+)\*\*(?::?\s*([^*]*?))(?=\*\*[^*]+\*\*|$)/g)];
      if (negritas.length > 1) {
        return `\\lista{\n  ${negritas.map(m => `**${m[1].trim()}:** ${m[2].trim()}`.replace(/:\*\*\s*:?/, ":**")).join(" |\n  ")}\n}`;
      }
    }
    return match;
  });

  resultado = resultado
    .replace(/\},\s*\\/g, "}\n\n\\")
    .replace(/,\s*\\(seccion(?:grande)?|subtitulo[AB]?|resumen|definicion(?:par)?|nota|lista)\b/g, "\n\n\\$1")
    .replace(/\\(subtitulo[AB]?)\{\s*[•·\-*]\s*/g, "\\$1{")
    .replace(/\\end\{codigo\}\s*,\s*/g, "\\end{codigo}\n\n")
    .replace(/\\begin\{codigo\}(\[[^\]]*\])?\s*,\s*/g, "\\begin{codigo}$1\n")
    .replace(/\\lista\{\s*,\s*/g, "\\lista{\n  ")
    .replace(/\s*,\s*\\nota/g, "\n\n\\nota");

  resultado = resultado.replace(/(\\tabla(?:\[[^\]]*\])?\s*\{[\s\S]*?\})/g, (tablaMatch) => {
    let arreglada = tablaMatch.replace(/^([^\n&%]*&[^\n%]*?)(?<!\\\\)\s*$/gm, "$1 \\\\");
    arreglada = arreglada.replace(/([^\\ \t\r\n%])\s*(\}\s*)$/, "$1 \\\\\n$2");
    return arreglada;
  });

  resultado = resultado
    .replace(/\\subnota\{/g, "\\nota{")
    .replace(/(?:^|\s)\\t(?!(?:ext|abla|itulo|ikz|iny|rue)\w*)(?=[A-Za-zÁÉÍÓÚáéíóú¿¡])/g, " ")
    .replace(/\\t(?=\s*[\}\]])/g, "");

  let primeraSeccionGrandeEncontrada = false;
  resultado = resultado.replace(/\\secciongrande\*?(?:\[[^\]]*\])?\{([^}]+)\}/g, (match, titulo) => {
    if (!primeraSeccionGrandeEncontrada) {
      primeraSeccionGrandeEncontrada = true;
      return match;
    }
    return `\\subtituloA{${titulo}}`;
  });

  let primerResumenEncontrado = false;
  resultado = resultado.replace(/\\resumen\*?(?:\[[^\]]*\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (match, cuerpo) => {
    if (!primerResumenEncontrado) {
      primerResumenEncontrado = true;
      return match;
    }
    return `\n\n${cuerpo.trim()}\n\n`;
  });

  const partesVerbatim = [];
  resultado = resultado.replace(/(\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\}|\\cmd\{[^}]*\})/g, (m) => {
    const placeholder = `@@@VERBATIM${partesVerbatim.length}@@@`;
    partesVerbatim.push(m);
    return placeholder;
  });
  resultado = resultado.replace(/(?<!\\)_/g, "\\_");
  resultado = resultado.replace(/@@@VERBATIM(\d+)@@@/g, (_, i) => partesVerbatim[Number(i)]);

  const partesTablasYVerbatim = [];
  resultado = resultado.replace(
    /(\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\}|\\tabla\[[\s\S]*?\}\s*\}|\\begin\{(?:tabular|table)\}[\s\S]*?\\end\{(?:tabular|table)\}|\\cmd\{[^}]*\})/g,
    (m) => {
      const ph = `@@@TABVERBATIM${partesTablasYVerbatim.length}@@@`;
      partesTablasYVerbatim.push(m);
      return ph;
    }
  );
  resultado = resultado.replace(/(?<!\\)&/g, "\\&");
  resultado = resultado.replace(/@@@TABVERBATIM(\d+)@@@/g, (_, i) => partesTablasYVerbatim[Number(i)]);

  resultado = resultado.replace(/\}{4,}/g, "}\n}");

  resultado = resultado.replace(/(\\begin\{codigo\}[\s\S]*?\\end\{codigo\})(?:\s*\1)+/g, "$1");
  resultado = resultado.replace(/(\\begin\{consola\}[\s\S]*?\\end\{consola\})(?:\s*\1)+/g, "$1");
  resultado = resultado.replace(/(\\end\{codigo\}\s*){2,}/g, "\\end{codigo}\n");

  const bloquesVerbatim = [];
  const conMarcadores = resultado.replace(
    /(\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\})/g,
    (match) => {
      const marcador = `@@@DEDUP_VERBATIM_${bloquesVerbatim.length}@@@`;
      bloquesVerbatim.push(match);
      return marcador;
    },
  );
  const parrafosVistos = new Set();
  resultado = conMarcadores
    .split(/\n{2,}/)
    .filter((parrafo) => {
      const clave = parrafo.trim();
      if (clave.length < 80) return true;
      if (parrafosVistos.has(clave)) return false;
      parrafosVistos.add(clave);
      return true;
    })
    .join("\n\n")
    .replace(/@@@DEDUP_VERBATIM_(\d+)@@@/g, (_match, indice) => bloquesVerbatim[Number(indice)]);

  resultado = resultado
    .replace(/\\lista\{\s*(?:\*\*[^*]+\*\*:?[^\n]*\s*)?\\lista\{/g, "\\lista{")
    .replace(/(?:^|\n)\s*([A-ZÁÉÍÓÚ][a-zA-ZÁÉÍÓÚáéíóú0-9_ \-()\/]+):\*\*/g, "\n  **$1:**");

  resultado = corregirCatalanAEspanol(resultado);

  resultado = resultado
    .replace(/,\s*\\begin\{codigo\}/g, "\n\n\\begin{codigo}")
    .replace(/,\s*\\end\{codigo\}/g, "\n\\end{codigo}\n\n")
    .replace(/,\s*\\begin\{consola\}/g, "\n\n\\begin{consola}")
    .replace(/,\s*\\end\{consola\}/g, "\n\\end{consola}\n\n")
    .replace(/([^\n])\s*\\begin\{codigo\}(\[[^\]]*\])?/g, "$1\n\n\\begin{codigo}$2")
    .replace(/([^\n])\s*\\begin\{consola\}/g, "$1\n\n\\begin{consola}")
    .replace(/([^\n])\s*\\end\{codigo\}/g, "$1\n\\end{codigo}\n\n")
    .replace(/([^\n])\s*\\end\{consola\}/g, "$1\n\\end{consola}\n\n");

  resultado = balancearEntornoVerbatim(resultado, "codigo");
  resultado = balancearEntornoVerbatim(resultado, "consola");

  resultado = resultado
    .replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/gi, "")
    .replace(/\\begin\{(?:table|figure)\}(?:\[[^\]]*\])?/gi, "")
    .replace(/\\end\{(?:table|figure)\}/gi, "")
    .replace(/\\centering\b/g, "")
    .replace(
      /\\caption\*?(?:\[[^\]]*\])?\{([^{}]*)\}/gi,
      (_match, descripcion) => `\n\\textit{${descripcion.trim()}}\n`,
    )
    .replace(/\\begin\{align\*?\}/gi, "")
    .replace(/\\end\{align\*?\}/gi, "");

  resultado = resultado
    .replace(/\\cmd\{([^}\n]*?)(?=:\*\*)/g, "\\cmd{$1}")
    .replace(/\\cmd\{([^}\n]*)$/gm, "\\cmd{$1}");

  resultado = balancearLlavesLatex(resultado);

  resultado = resultado.replace(
    /\\(secciongrande|seccion|subtituloA|subtituloB)\{([^{}]+)\}/g,
    (_m, macro, tit) => `\\${macro}{${normalizarMayusculasTitulo(tit)}}`
  );

  const bloquesCod = [];
  resultado = resultado.replace(/\\begin\{(codigo|consola)\}[\s\S]*?\\end\{\1\}/g, (m) => {
    const placeholder = `%%COD_PROTEGIDO_${bloquesCod.length}%%`;
    bloquesCod.push(m);
    return placeholder;
  });
  resultado = resultado.replace(/\*\*([^*\n]+?)\*\*/g, "\\textbf{$1}");
  for (let i = 0; i < bloquesCod.length; i++) {
    resultado = resultado.replace(`%%COD_PROTEGIDO_${i}%%`, bloquesCod[i]);
  }

  return resultado;
}

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

const INICIO_ITEM = /^(?:\*\*[^*\n]+\*\*|\\textbf\{|[-*]\s+|\d+[.)]\s+)/;

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

  const itemsLimpios = [];
  for (let item of items) {
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
