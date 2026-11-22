import { Agent } from "undici";
import translateLib from "translate";
import { config } from "./configuracion.js";
import { detectarCatalan, normalizarMayusculasTitulo, esTextoDeRazonamiento } from "./apuntes.js";

export async function traducirTextoGoogle(texto = "") {
  if (!texto || typeof texto !== "string" || !texto.trim()) return texto;
  const limpio = texto.trim();
  const esCat = detectarCatalan(limpio);

  // Intentar primero con sl=ca si se detecta catalán, o sl=auto en caso general
  const fuentes = esCat ? ["ca", "auto"] : ["auto", "ca"];
  for (const sl of fuentes) {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=es&dt=t&q=` + encodeURIComponent(limpio);
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const datos = await res.json();
        const resultado = datos?.[0]?.map((s) => s[0]).join("");
        if (resultado && resultado.trim()) {
          const resLimpio = resultado.trim();
          if (!detectarCatalan(resLimpio) || resLimpio !== limpio) {
            return resLimpio;
          }
        }
      }
    } catch {}
  }

  try {
    translateLib.engine = "google";
    const res = await translateLib(limpio, { from: "ca", to: "es" });
    if (res && res.trim()) return res.trim();
  } catch {}
  return limpio;
}

const agenteOllama = new Agent({
  headersTimeout: config.timeoutMs,
  bodyTimeout: config.timeoutMs,
});

export async function comprobarModelo(modeloObjetivo = config.model) {
  try {
    const response = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`Ollama status ${response.status}`);
    const rawModels = (await response.json()).models ?? [];
    const models = rawModels.map((item) => item.name ?? "").filter(Boolean);
    const target = modeloObjetivo || config.model;
    const modelAvailable = models.some(
      (name) =>
        name === target ||
        name.startsWith(`${target}:`) ||
        target.startsWith(`${name}:`) ||
        name.replace(/:latest$/, "") === target.replace(/:latest$/, "")
    );
    return {
      connected: true,
      modelAvailable,
      model: target,
      models,
    };
  } catch (err) {
    if (config.nvidiaApiKey) {
      return {
        connected: true,
        modelAvailable: true,
        model: config.nvidiaModel,
        models: [config.nvidiaModel, "nvidia/llama-3.1-nemotron-70b-instruct"],
        provider: "nvidia",
      };
    }
    return { connected: false, modelAvailable: false, models: [] };
  }
}

async function consultarNvidia({ system, user, signal, formatoJson = true, modelo = null }) {
  if (!config.nvidiaApiKey) {
    throw new Error("No hay conexión con Ollama y no se ha configurado NVIDIA_API_KEY.");
  }
  const url = `${config.nvidiaBaseUrl}/chat/completions`;
  const modelosAIntentar = Array.from(
    new Set([
      modelo,
      config.nvidiaModel,
      "nvidia/nemotron-3.5-bolt-e4b",
      "mistralai/mistral-large-4-1t-a52b",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "poolside/laguna-xs-2.1",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
    ])
  ).filter(Boolean);

  let lastError = null;
  for (const mod of modelosAIntentar) {
    const body = {
      model: mod,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: config.maxTokens > 0 ? config.maxTokens : 8192,
    };
    if (formatoJson) {
      body.response_format = { type: "json_object" };
    }
    const timeoutLimit = AbortSignal.timeout(config.timeoutMs);
    const signalPeticion = signal ? AbortSignal.any([signal, timeoutLimit]) : timeoutLimit;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.nvidiaApiKey}`,
        },
        body: JSON.stringify(body),
        signal: signalPeticion,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        lastError = new Error(`NVIDIA NIM (${mod}) respondió ${res.status}: ${errText.slice(0, 500)}`);
        if (res.status === 404 || res.status === 410) {
          console.warn(`⚠️ Modelo ${mod} no disponible en NVIDIA NIM (${res.status}), probando alternativo...`);
          continue;
        }
        throw lastError;
      }
      const json = await res.json();
      let content = (json.choices?.[0]?.message?.content || "").trim();
      if (!content || esTextoDeRazonamiento(content) || /^let me\b|^i need to\b|^thinking\b/i.test(content)) {
        console.warn(`⚠️ Modelo ${mod} devolvió razonamiento/pensamiento en inglés, probando siguiente modelo...`);
        continue;
      }
      return {
        message: { content },
        done_reason: json.choices?.[0]?.finish_reason === "length" ? "length" : "stop",
      };
    } catch (e) {
      lastError = e;
      if (modelosAIntentar.indexOf(mod) < modelosAIntentar.length - 1) continue;
      throw e;
    }
  }
  throw lastError || new Error("No se pudo obtener respuesta de NVIDIA NIM.");
}

export async function consultarModeloIA(
  system,
  user,
  images = [],
  signal,
  modeloPersonalizado = null,
) {
  const fechaLimite = Date.now() + config.timeoutMs;
  // Si no se especifica modelo personalizado, usar el configurado o el por defecto
  const modeloEfectivo = modeloPersonalizado || config.model || "qwen2.5:14b";
  const esModeloVision = /\b(?:vl|vision|llava|bakllava|minicpm-v|moondream)\b/i.test(modeloEfectivo);
  const imagenesFiltradas = esModeloVision ? images : [];
  const mensajes = [
    { role: "system", content: system },
    {
      role: "user",
      content: user,
      ...(imagenesFiltradas.length ? { images: imagenesFiltradas.map((image) => image.data) } : {}),
    },
  ];
  const consultar = async (formatoJson, temperatura = 0.5) => {
    const tiempoRestante = fechaLimite - Date.now();
    if (tiempoRestante <= 0)
      throw new Error("La IA agotó el tiempo disponible para completar la respuesta.");
    const signalPeticion = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(tiempoRestante)])
      : AbortSignal.timeout(tiempoRestante);
    const response = await fetch(`${config.ollamaUrl}/api/chat`, {
      dispatcher: agenteOllama,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modeloEfectivo,
        stream: false,
        ...(formatoJson ? { format: "json" } : {}),
        messages: mensajes,
        options: {
          temperature: temperatura,
          repeat_penalty: 1.1,
          repeat_last_n: 64,
          top_p: 0.9,
          num_predict: config.maxTokens,
          num_ctx: config.contextSize,
        },
      }),
      signal: signalPeticion,
    });
    if (!response.ok) {
      const detalle = (await response.text()).slice(0, 500);
      if (response.status === 400 && /multimodal/i.test(detalle) && images.length > 0) {
        console.warn(`El modelo ${modeloEfectivo} no admite imágenes multimodales; reintentando sin imágenes...`);
        return await consultarModeloIA(system, user, [], signal, modeloPersonalizado);
      }
      if (response.status === 404 || /not found/i.test(detalle) || /try pulling/i.test(detalle)) {
        console.log(`Modelo ${modeloEfectivo} no encontrado localmente. Descargando automáticamente desde Ollama...`);
        try {
          const pullRes = await fetch(`${config.ollamaUrl}/api/pull`, {
            dispatcher: agenteOllama,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: modeloEfectivo, stream: false }),
          });
          if (pullRes.ok) {
            console.log(`Modelo ${modeloEfectivo} descargado con éxito. Reintentando consulta...`);
            return await consultar(formatoJson, temperatura);
          }
        } catch (ePull) {
          console.error(`Error al descargar ${modeloEfectivo}:`, ePull);
        }
      }
      if (/exceeds the available context size/i.test(detalle)) {
        const solicitud = detalle.match(/request\s+\(([\d,]+)\s+tokens\)/i)?.[1];
        const disponible = detalle.match(
          /available context size\s+\(([\d,]+)\s+tokens\)/i,
        )?.[1];
        throw new Error(
          `Ollama no pudo procesar esta parte: solicitó ${solicitud ?? "más"} tokens y su contexto disponible es ${disponible ?? "menor que la solicitud"} (NUM_CTX_IA configurado: ${config.contextSize.toLocaleString("es-ES")}). Separa el PDF en partes más pequeñas o revisa la memoria disponible para el modelo.`,
        );
      }
      throw Object.assign(
        new Error(`Ollama respondió ${response.status}: ${detalle}`),
        { retryable: response.status === 408 || response.status === 429 || response.status >= 500 },
      );
    }
    const data = await response.json();
    if (typeof data.message?.content !== "string" || !data.message.content.trim())
      throw Object.assign(new Error("El modelo devolvió una respuesta vacía."), {
        code: "INVALID_JSON",
      });
    return data;
  };

  let data;
  const esModeloNvidia =
    Boolean(modeloEfectivo && (
      modeloEfectivo.startsWith("nvidia/") ||
      modeloEfectivo.startsWith("mistralai/") ||
      modeloEfectivo.startsWith("z-ai/") ||
      modeloEfectivo.startsWith("google/") ||
      modeloEfectivo.startsWith("meta/") ||
      modeloEfectivo.startsWith("moonshotai/")
    ));

  if ((config.proveedorIA === "nvidia" || esModeloNvidia) && config.nvidiaApiKey) {
    data = await consultarNvidia({ system, user, signal, formatoJson: true, modelo: modeloEfectivo });
    return analizarJson(data.message.content, data.done_reason);
  }

  try {
    data = await consultar(true);
  } catch (errOllama) {
    if (config.nvidiaApiKey) {
      console.warn("Ollama falló o no está disponible; cambiando a NVIDIA NIM:", errOllama.message);
      data = await consultarNvidia({ system, user, signal, formatoJson: true, modelo: modeloEfectivo });
      return analizarJson(data.message.content, data.done_reason);
    }
    throw errOllama;
  }
  let contenido = data.message.content;
  let necesitaContinuar = data.done_reason === "length";
  const fueTruncada = necesitaContinuar;
  try {
    return analizarJson(contenido, fueTruncada ? "length" : data.done_reason);
  } catch (error) {
    if (!necesitaContinuar) throw error;
  }

  mensajes.push({ role: "assistant", content: contenido });
  while (necesitaContinuar) {
    mensajes.push({
      role: "user",
      content:
        "Tu respuesta anterior quedó interrumpida. Continúa exactamente desde el último carácter, sin repetir lo ya escrito, sin añadir explicaciones ni Markdown y completando el mismo JSON.",
    });
    data = await consultar(false);
    contenido += data.message.content;
    mensajes.push({ role: "assistant", content: data.message.content });
    necesitaContinuar = data.done_reason === "length";
    try {
      return analizarJson(contenido, fueTruncada ? "length" : data.done_reason);
    } catch (error) {
      if (!necesitaContinuar) throw error;
    }
  }
  throw new Error("La IA no pudo completar la respuesta JSON.");
}

export function preRepararJsonLatex(jsonStr) {
  if (!jsonStr || typeof jsonStr !== "string") return jsonStr;
  return jsonStr
    .replace(
      /(?<!\\)\\(begin|textbf|textit|texttt|textcolor|tabla|tablacab|resumen|seccion|secciongrande|subtitulo|subtituloA|subtituloB|definicion|definicionpar|rectangulos|lista|pasos|nota|alertas|cmd|textless|textgreater)(?=[^a-zA-Z]|$)/g,
      "\\\\$1",
    )
    .replace(/(?<!\\)\\([a-zA-Z]+)(?=[^a-zA-Z"\\\/bfnrtu]|$)/g, "\\\\$1");
}

export function analizarJson(text, motivoFinal = "") {
  let cleaned = text
    .trim()
    .replace(/^```(?:json|latex|tex)?\s*/i, "")
    .replace(/\s*```$/, "");
  cleaned = preRepararJsonLatex(cleaned);
  try {
    return JSON.parse(cleaned);
  } catch {
    for (const [open, close] of [
      ["{", "}"],
      ["[", "]"],
    ]) {
      const start = cleaned.indexOf(open);
      const end = cleaned.lastIndexOf(close);
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          continue;
        }
      }
    }
    const detalleFinal =
      motivoFinal === "length"
        ? " La respuesta se truncó al alcanzar el límite de salida de Ollama."
        : "";
    throw Object.assign(
      new Error(
        `La IA no devolvió JSON válido.${detalleFinal} La respuesta contenía ${Buffer.byteLength(text, "utf8").toLocaleString("es-ES")} bytes y terminó con: ${text.slice(-160).replace(/\s+/g, " ")}`,
      ),
      { code: "INVALID_JSON" },
    );
  }
}

function esEntornoPruebas() {
  return (
    process.env.NODE_ENV === "test" ||
    process.execArgv.includes("--test") ||
    Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

export async function detectarCatalanConIA(texto = "", signal) {
  if (!texto || typeof texto !== "string" || texto.trim().length < 3) return false;
  if (esEntornoPruebas()) return false;
  try {
    const respuesta = await consultarModeloIA(
      "Responde en formato JSON con la propiedad booleana 'esCatalan' (true o false). ¿El siguiente texto contiene palabras, títulos u oraciones en catalán o valenciano?",
      texto.slice(0, 1000),
      [],
      signal
    );
    return respuesta?.esCatalan === true;
  } catch {
    return false;
  }
}

function contarMacrosEstructuraLatex(texto = "") {
  const macros = [
    "secciongrande",
    "seccion",
    "subtitulo",
    "subtituloA",
    "subtituloB",
    "resumen",
    "definicion",
    "definicionpar",
    "lista",
    "nota",
    "alertas",
  ];
  const conteo = {};
  for (const macro of macros) {
    conteo[macro] = (texto.match(new RegExp(`\\\\${macro}\\b`, "g")) || []).length;
  }
  conteo.codigo = (texto.match(/\\begin\{codigo\}/g) || []).length;
  conteo.consola = (texto.match(/\\begin\{consola\}/g) || []).length;
  return conteo;
}

function latexTraducidoEsFiel(original = "", traducido = "") {
  if (!traducido || typeof traducido !== "string" || !traducido.trim()) return false;

  // La traducción no debe acortar el contenido de forma significativa.
  const compacto = (texto) => texto.replace(/\s+/g, "");
  if (compacto(traducido).length < compacto(original).length * 0.8) return false;

  // No puede perder ninguna macro estructural (secciones, listas, notas...).
  const macrosOriginal = contarMacrosEstructuraLatex(original);
  const macrosTraducido = contarMacrosEstructuraLatex(traducido);
  for (const [macro, cantidad] of Object.entries(macrosOriginal)) {
    if ((macrosTraducido[macro] || 0) < cantidad) return false;
  }

  // Las llaves deben quedar equilibradas fuera de los bloques verbatim.
  const sinVerbatim = traducido.replace(
    /\\begin\{(?:codigo|consola)\}[\s\S]*?\\end\{(?:codigo|consola)\}/g,
    "",
  );
  let profundidad = 0;
  for (let i = 0; i < sinVerbatim.length; i += 1) {
    const caracter = sinVerbatim[i];
    const anterior = i > 0 ? sinVerbatim[i - 1] : "";
    if (anterior === "\\") continue;
    if (caracter === "{") profundidad += 1;
    else if (caracter === "}") {
      profundidad -= 1;
      if (profundidad < 0) return false;
    }
  }
  if (profundidad !== 0) return false;

  return true;
}

export async function traducirLatexAEspanolConGoogle(latex = "") {
  if (!latex || typeof latex !== "string" || !latex.trim()) return latex;
  if (!detectarCatalan(latex)) return latex;

  // 1. Proteger bloques verbatim (código, consola) para que Google Translate no modifique código
  const bloquesProtegidos = [];
  let protegido = latex.replace(
    /\\begin\{(codigo|consola|verbatim|lstlisting)\}[\s\S]*?\\end\{\1\}/g,
    (bloque) => {
      const marca = `%%PROTECTED_CODE_${bloquesProtegidos.length}%%`;
      bloquesProtegidos.push(bloque);
      return marca;
    },
  );

  // 2. Traducir títulos y argumentos de macros con Google Translate sin API
  const regexTitulos = /\\(secciongrande|seccion|subtituloA|subtituloB)\{([^{}]+)\}/g;
  for (const match of [...protegido.matchAll(regexTitulos)]) {
    const [full, cmd, title] = match;
    if (detectarCatalan(title)) {
      let trad = await traducirTextoGoogle(title);
      trad = normalizarMayusculasTitulo(trad);
      if (trad && trad !== title) {
        protegido = protegido.replace(full, `\\${cmd}{${trad}}`);
      }
    }
  }

  const regexDefinicion = /\\(definicion|definicionpar|nota)\{([^{}]+)\}\{([^{}]+)\}/g;
  for (const match of [...protegido.matchAll(regexDefinicion)]) {
    const [full, cmd, arg1, arg2] = match;
    let trad1 = arg1;
    let trad2 = arg2;
    if (detectarCatalan(arg1)) trad1 = await traducirTextoGoogle(arg1);
    if (detectarCatalan(arg2)) trad2 = await traducirTextoGoogle(arg2);
    if (trad1 !== arg1 || trad2 !== arg2) {
      protegido = protegido.replace(full, `\\${cmd}{${trad1}}{${trad2}}`);
    }
  }

  const regexResumen = /\\(resumen|alertas)\{([^{}]+)\}/g;
  for (const match of [...protegido.matchAll(regexResumen)]) {
    const [full, cmd, arg] = match;
    if (detectarCatalan(arg)) {
      const trad = await traducirTextoGoogle(arg);
      if (trad && trad !== arg) {
        protegido = protegido.replace(full, `\\${cmd}{${trad}}`);
      }
    }
  }

  // 2b. Traducir rectángulos
  const regexRectangulos = /\\rectangulos\{([\s\S]*?)\}/g;
  for (const match of [...protegido.matchAll(regexRectangulos)]) {
    const [full, cuerpo] = match;
    if (detectarCatalan(cuerpo)) {
      const partes = [...cuerpo.matchAll(/\{([^{}]+)\}\{([^{}]+)\}/g)];
      let nuevoCuerpo = cuerpo;
      for (const p of partes) {
        let t1 = p[1];
        let t2 = p[2];
        if (detectarCatalan(t1)) t1 = await traducirTextoGoogle(t1);
        if (detectarCatalan(t2)) t2 = await traducirTextoGoogle(t2);
        nuevoCuerpo = nuevoCuerpo.replace(p[0], `{${t1}}{${t2}}`);
      }
      protegido = protegido.replace(full, `\\rectangulos{${nuevoCuerpo}}`);
    }
  }

  // 3. Traducir listas con catalán
  const regexLista = /\\(lista|pasos)\{([^{}]+)\}/g;
  for (const match of [...protegido.matchAll(regexLista)]) {
    const [full, cmd, cuerpo] = match;
    if (detectarCatalan(cuerpo)) {
      const items = cuerpo.split("|");
      const itemsTrad = [];
      for (const it of items) {
        if (detectarCatalan(it)) {
          itemsTrad.push(await traducirTextoGoogle(it));
        } else {
          itemsTrad.push(it);
        }
      }
      protegido = protegido.replace(full, `\\${cmd}{\n  ${itemsTrad.join(" |\n  ")}\n}`);
    }
  }

  // 4. Si aún queda catalán en párrafos o líneas sueltas
  if (detectarCatalan(protegido)) {
    const lineas = protegido.split("\n");
    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i];
      if (
        l.trim() &&
        !l.trim().startsWith("\\") &&
        !l.includes("%%PROTECTED_CODE_") &&
        detectarCatalan(l)
      ) {
        lineas[i] = await traducirTextoGoogle(l);
      }
    }
    protegido = lineas.join("\n");
  }

  // 5. Restaurar bloques de código protegidos
  for (let i = 0; i < bloquesProtegidos.length; i++) {
    protegido = protegido.replace(`%%PROTECTED_CODE_${i}%%`, bloquesProtegidos[i]);
  }

  return protegido;
}

export async function traducirLatexAEspanolConIA(latex = "", signal) {
  if (!latex || typeof latex !== "string" || !latex.trim()) return latex;
  if (esEntornoPruebas()) return latex;
  if (!detectarCatalan(latex)) {
    return latex;
  }

  // 1. Traducción rápida, fiable y directa con Google Traductor sin API
  try {
    const conGoogle = await traducirLatexAEspanolConGoogle(latex);
    if (!detectarCatalan(conGoogle) || conGoogle !== latex) {
      return conGoogle;
    }
    latex = conGoogle;
  } catch (errGoogle) {
    console.warn(`Traducción inicial con Google omitida: ${errGoogle.message}`);
  }

  if (!detectarCatalan(latex)) return latex;

  const sistemaTraductor = `Eres un traductor técnico y corrector académico experto en español estándar de España.
Tu tarea es revisar TODO el contenido LaTeX y dejar en español cualquier texto que esté en catalán, valenciano, inglés u otro idioma. Si una frase ya está en español correcto, consérvala sin cambios innecesarios.
REGLAS INNEGOCIABLES:
- Traduce también los títulos internos, subtítulos, encabezados, pies, listas, tablas, notas y explicaciones, no solo el primer párrafo.
- Conserva exactamente la estructura, el orden, las macros, sus argumentos, las llaves, los entornos y los saltos de línea LaTeX (\\secciongrande, \\seccion, \\subtitulo, \\subtituloA, \\subtituloB, \\resumen, \\definicion, \\lista, \\nota, \\begin{codigo}...\\end{codigo}, etc.). No elimines ni resumas contenido.
- NO traduzcas ni modifiques código fuente, identificadores, rutas, nombres de variables, palabras reservadas, comandos HTML/CSS/JavaScript, URLs ni texto literal dentro de bloques de código/consola/verbatim.
- No traduzcas términos técnicos universales cuando su forma inglesa sea la denominación estándar (DOM, CSS, HTML, JavaScript, HTTP, URL, URI, JIT, sandbox, CORS, XSS).
- No inventes información ni cambies el significado técnico. Devuelve el LaTeX completo, no un resumen.
Devuelve únicamente un JSON con la propiedad "latex" que contenga el texto íntegro revisado:`;

  const bloquesProtegidos = [];
  const latexProtegido = latex.replace(
    /\\begin\{(codigo|consola|verbatim|lstlisting)\}([\s\S]*?)\\end\{\1\}/g,
    (bloque) => {
      const marca = `ZZBLOQUECODIGO${bloquesProtegidos.length}FINZZ`;
      bloquesProtegidos.push(bloque);
      return marca;
    },
  );
  try {
    const respuesta = await consultarModeloIA(
      sistemaTraductor,
      `Revisa y traduce íntegramente al español estándar este LaTeX, preservando estructura y código. Las marcas ZZBLOQUECODIGO[número]FINZZ son bloques de código protegidos: consérvalas exactamente y en el mismo lugar.\n\n${latexProtegido}`,
      [],
      signal,
    );
    let traducido = "";
    if (typeof respuesta?.latex === "string") {
      traducido = respuesta.latex;
    } else if (typeof respuesta === "string") {
      traducido = respuesta;
    } else if (respuesta && typeof respuesta === "object") {
      traducido = String(respuesta.latex || respuesta.texto || respuesta.contenido || "");
    }
    if (traducido && typeof traducido === "string" && traducido.trim().length > 0) {
      for (let i = 0; i < bloquesProtegidos.length; i += 1) {
        traducido = traducido.replaceAll(`ZZBLOQUECODIGO${i}FINZZ`, bloquesProtegidos[i]);
      }
      // Limpiar cualquier marca residual que la IA haya desvirtuado
      traducido = traducido.replace(/ZZBLOQUECODIGO\w*FINZZ/g, (m) => {
        return bloquesProtegidos[0] || "";
      });
      if (!latexTraducidoEsFiel(latex, traducido)) {
        console.warn(
          "Aviso: la traducción con IA perdía contenido o rompía la estructura; se conserva el LaTeX original.",
        );
        return latex;
      }
      return traducido;
    }
  } catch (err) {
    console.warn(`Aviso: traducción dinámica con IA omitida (${err.message}).`);
  }
  return latex;
}

export async function traducirTituloYNombreConIA({ titulo = "", nombre = "" }, signal) {
  if (!titulo && !nombre) return { titulo, nombre };
  if (esEntornoPruebas()) return { titulo, nombre };
  try {
    let nuevoTitulo = titulo;
    let nuevoNombre = nombre;
    if (titulo) {
      nuevoTitulo = await traducirTextoGoogle(titulo);
      nuevoTitulo = normalizarMayusculasTitulo(nuevoTitulo);
    }
    if (nombre) {
      const nombreConEspacios = nombre.replace(/[-_]+/g, " ");
      const nombreTrad = await traducirTextoGoogle(nombreConEspacios);
      nuevoNombre = nombreTrad
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
    }
    return {
      titulo: nuevoTitulo || titulo,
      nombre: nuevoNombre || nombre,
    };
  } catch {
    return {
      titulo: normalizarMayusculasTitulo(titulo),
      nombre,
    };
  }
}
