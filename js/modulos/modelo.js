import { Agent } from "undici";
import { config } from "./configuracion.js";
import { detectarCatalan } from "./apuntes.js";

const agenteOllama = new Agent({
  headersTimeout: config.timeoutMs,
  bodyTimeout: config.timeoutMs,
});

export async function comprobarModelo() {
  const response = await fetch(`${config.ollamaUrl}/api/tags`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) return { connected: false, modelAvailable: false };
  const models =
    (await response.json()).models?.map((item) => item.name ?? "") ?? [];
  return {
    connected: true,
    modelAvailable: models.some(
      (name) => name === config.model || name.startsWith(`${config.model}:`),
    ),
  };
}

export async function consultarModeloIA(
  system,
  user,
  images = [],
  signal,
  modeloPersonalizado = null,
) {
  const fechaLimite = Date.now() + config.timeoutMs;
  const modeloEfectivo = modeloPersonalizado || config.model;
  const mensajes = [
    { role: "system", content: system },
    {
      role: "user",
      content: user,
      ...(images.length ? { images: images.map((image) => image.data) } : {}),
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
          repeat_penalty: 1.2,
          repeat_last_n: 128,
          top_p: 0.9,
          num_predict: config.maxTokens,
          num_ctx: config.contextSize,
        },
      }),
      signal: signalPeticion,
    });
    if (!response.ok) {
      const detalle = (await response.text()).slice(0, 500);
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

  let data = await consultar(true);
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

export async function traducirLatexAEspanolConIA(latex = "", signal) {
  if (!latex || typeof latex !== "string" || !latex.trim()) return latex;
  if (esEntornoPruebas()) return latex;
  const sistemaTraductor = `Eres un traductor técnico y corrector académico experto en español estándar de España.
Tu tarea es revisar TODO el contenido LaTeX y dejar en español cualquier texto que esté en catalán, valenciano, inglés u otro idioma. Si una frase ya está en español correcto, consérvala sin cambios innecesarios.
REGLAS INNEGOCIABLES:
- Traduce también los títulos internos, subtítulos, encabezados, pies, listas, tablas, notas y explicaciones, no solo el primer párrafo.
- Conserva exactamente la estructura, el orden, las macros, sus argumentos, las llaves, los entornos y los saltos de línea LaTeX (\\secciongrande, \\seccion, \\subtitulo, \\subtituloA, \\subtituloB, \\resumen, \\definicion, \\lista, \\nota, \\begin{codigo}...\\end{codigo}, etc.). No elimines ni resumas contenido.
- NO traduzcas ni modifiques código fuente, identificadores, rutas, nombres de variables, palabras reservadas, comandos HTML/CSS/JavaScript, URLs ni texto literal dentro de bloques de código/consola/verbatim.
- No traduzcas términos técnicos universales cuando su forma inglesa sea la denominación estándar (DOM, CSS, HTML, JavaScript, HTTP, URL, URI, JIT, sandbox, CORS, XSS).
- No inventes información ni cambies el significado técnico. Devuelve el LaTeX completo, no un resumen.
Devuelve únicamente un JSON con la propiedad "latex" que contenga el texto íntegro revisado:`;

  // Blindar el código real: el traductor nunca recibe su contenido, solo marcas.
  // Así se evita que traduzca identificadores, cambie comillas o rompa sintaxis.
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
      `Revisa y traduce íntegramente al español estándar este LaTeX, preservando estructura y código. Las marcas ZZBLOQUECODIGOnFINZZ son bloques de código protegidos: consérvalas exactamente y en el mismo lugar.\n\n${latexProtegido}`,
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
        traducido = traducido.replace(`ZZBLOQUECODIGO${i}FINZZ`, bloquesProtegidos[i]);
      }
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
    const respuesta = await consultarModeloIA(
      `Eres un traductor técnico y profesor universitario. Tu tarea es revisar el título y el slug (nombre de archivo de 1 a 3 palabras clave en minúsculas con guiones) de unos apuntes. Si contienen palabras en catalán o en otro idioma (como "capacitats", "eines", "entorn", "renderitzat", "execucio", "fitxers", "clients", etc.), tradúcelas obligatoriamente al español estándar de España ("capacidades", "herramientas", "entorno", "renderizado", "ejecucion", "archivos", "clientes", etc.). Si ya están en español estándar, devuélvelos en español. Devuelve únicamente un JSON con {"titulo": "...", "nombre": "..."}.`,
      `Título: ${titulo}\nNombre del archivo: ${nombre}`,
      [],
      signal
    );
    const nuevoTitulo = (typeof respuesta?.titulo === "string" && respuesta.titulo.trim()) ? respuesta.titulo.trim() : titulo;
    const nuevoNombre = (typeof respuesta?.nombre === "string" && respuesta.nombre.trim()) ? respuesta.nombre.trim() : nombre;
    return {
      titulo: nuevoTitulo,
      nombre: nuevoNombre,
    };
  } catch {
    return { titulo, nombre };
  }
}
