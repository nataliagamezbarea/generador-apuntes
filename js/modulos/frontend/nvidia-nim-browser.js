// ============================================================
// REDACCIÓN CON IA (NVIDIA NIM) EN NAVEGADOR
// ============================================================

import { esTextoDeRazonamiento } from "../apuntes/utilidades-nombres.js";

export function preRepararJsonLatex(jsonStr) {
  if (!jsonStr || typeof jsonStr !== "string") return jsonStr;
  return jsonStr
    .replace(
      /(?<!\\)\\(begin|textbf|textit|texttt|textcolor|tabla|tablacab|resumen|seccion|secciongrande|subtitulo|subtituloA|subtituloB|definicion|definicionpar|rectangulos|lista|pasos|nota|alertas|cmd|textless|textgreater)(?=[^a-zA-Z]|$)/g,
      "\\\\$1",
    )
    .replace(/(?<!\\)\\([a-zA-Z]+)(?=[^a-zA-Z"\\\/bfnrtu]|$)/g, "\\\\$1")
    .replace(/\*\*([^*\n]+?)\*\*/g, "\\\\textbf{$1}");
}

export async function consultarNvidiaNIMApartadoBrowser({
  apiKey,
  modelo,
  asignatura,
  tema,
  tituloTema,
  subtema,
  subtemaTitulo,
  instrucciones,
  textoFuente,
}) {
  const prompt = `Asignatura: "${asignatura}"
Tema ${tema}: "${tituloTema}"
Subtema / Apartado ${tema}.${subtema}: "${subtemaTitulo}"

Instrucciones del alumno:
${instrucciones || "Elabora unos apuntes universitarios completos, rigurosos y pedagógicos para este apartado, con explicaciones paso a paso, ejemplos de código y notas de examen."}

Material fuente del apartado:
${textoFuente || "Elabora el temario oficial para este apartado."}

FORMATO DE SALIDA OBLIGATORIO:
Devuelve EXCLUSIVAMENTE un objeto JSON válido con este formato:
{
  "tema_existente": 0,
  "titulo_tema": "${tituloTema}",
  "titulo_subtema": "${subtemaTitulo}",
  "conceptos_clave": ["Concepto 1", "Concepto 2"],
  "archivos": [
    {
      "subtema": "${subtema}",
      "nombre": "1.slug-del-apartado",
      "titulo": "${subtemaTitulo}",
      "latex": "\\secciongrande{${subtemaTitulo}}\\n\\n\\resumen{Síntesis sustancial de la teoría en 3 a 5 líneas sin frases vacías ni metalenguaje.}\\n\\n\\definicion{Concepto Técnico}{Definición técnica formal.}\\n\\n\\subtituloA{Detalle conceptual}\\n\\n\\lista{\\n  **Elemento 1:** Explicación técnica detallada.\\n  **Elemento 2:** Explicación técnica detallada.\\n}\\n\\n\\nota{Para el examen}{Pregunta de autoevaluación con respuesta razonada.}"
    }
  ]
}

REGLAS CRÍTICAS:
1. DESARROLLO EXHAUSTIVO Y COMPLETO: Debes incluir y explicar detalladamente TODOS los conceptos, componentes, clasificaciones, listas, sintaxis, código y preguntas de autoevaluación del material fuente. PROHIBIDO omitir puntos o resumir en exceso.
2. 100% ESPAÑOL ESTÁNDAR: Todo el contenido DEBE estar en castellano formal y riguroso. Cero catalán o valenciano.
3. FORMATO DE TÍTULOS: Usa mayúscula inicial y minúsculas (tipo oración), respetando siglas técnicas (HTML, CSS, JS, DOM, XML, W3C, V8, SOP, CORS, XSS). PROHIBIDO mayúsculas sostenidas o signos de exclamación al final.
4. CÓDIGO LIMPIO: No uses entidades HTML (&lt; o &gt;); escribe siempre el código real dentro de \\begin{codigo}...\\end{codigo}.
5. MACROS WEC: Usa \\secciongrande, \\resumen, \\subtituloA, \\subtituloB, \\definicion, \\rectangulos, \\lista con elementos separados por | (**Concepto:** Explicación), \\nota{Para el examen}{...}. No coloques subtítulos dentro de \\lista ni dejes viñetas vacías.
6. Devuelve únicamente el JSON, sin texto explicativo adicional.`;

  const modelosAIntentar = Array.from(
    new Set([
      "nvidia/nemotron-3.5-bolt-e4b",
      modelo,
      "mistralai/mistral-large-4-1t-a52b",
      "meta/llama-3.1-70b-instruct",
    ])
  ).filter(Boolean);

  for (const mod of modelosAIntentar) {
    try {
      const resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: mod,
          messages: [
            {
              role: "system",
              content: "Eres un profesor experto en informática. Redacta apuntes estructurados, exhaustivos y rigurosos para LaTeX con las macros oficiales WEC. Todo en español estándar (cero catalán ni inglés). Devuelve EXCLUSIVAMENTE un JSON válido con campos titulo_tema, titulo_subtema, conceptos_clave y archivos.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 8192,
        }),
      });

      if (!resp.ok) continue;

      const data = await resp.json();
      const rawContent = (data.choices?.[0]?.message?.content || "").trim();
      if (!rawContent || esTextoDeRazonamiento(rawContent) || /^let me\b|^i need to\b|^thinking\b/i.test(rawContent)) {
        continue;
      }
      const matchJ = rawContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      let strJson = matchJ ? matchJ[1].trim() : rawContent;
      strJson = preRepararJsonLatex(strJson);
      try {
        const parsed = JSON.parse(strJson);
        if (parsed && (parsed.archivos || parsed.latex)) {
          return parsed;
        }
      } catch (_) {
        const start = strJson.indexOf("{");
        const end = strJson.lastIndexOf("}");
        if (start >= 0 && end > start) {
          try {
            const parsed = JSON.parse(strJson.slice(start, end + 1));
            if (parsed && (parsed.archivos || parsed.latex)) {
              return parsed;
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return null;
}
