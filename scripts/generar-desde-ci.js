import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { config } from "../js/modulos/configuracion.js";
import {
  traducirTextoGoogle,
  traducirLatexAEspanolConGoogle,
  consultarModeloIA,
} from "../js/modulos/modelo.js";
import {
  detectarCatalan,
  crearNombreArchivo,
  deducirTituloRealista,
  normalizarMayusculasTitulo,
  esTextoDeRazonamiento,
} from "../js/modulos/apuntes/utilidades-nombres.js";
import {
  sistemaApuntes,
  detectarApartadosEnTexto,
  dividirTextoPorApartados,
} from "../js/modulos/instrucciones.js";
import { normalizarResultadoIA } from "../js/modulos/apuntes/normalizacion-ia.js";
import {
  guardarGeneracion,
  asegurarEstructuraTema,
  asegurarDocumentoTema,
} from "../js/modulos/apuntes/persistencia.js";

async function traducirTextoLargoSiEsCatalan(texto) {
  if (!texto || typeof texto !== "string" || !texto.trim()) return texto;
  if (!detectarCatalan(texto)) return texto;

  console.log("🌐 Detectado contenido en catalán/valenciano en la fuente. Traduciendo al español...");
  const lineas = texto.split("\n");
  const bloques = [];
  let actual = [];
  let longitud = 0;

  for (const l of lineas) {
    if (longitud + l.length > 1200) {
      bloques.push(actual.join("\n"));
      actual = [l];
      longitud = l.length;
    } else {
      actual.push(l);
      longitud += l.length + 1;
    }
  }
  if (actual.length) bloques.push(actual.join("\n"));

  const traducidos = [];
  for (const b of bloques) {
    if (detectarCatalan(b)) {
      try {
        const t = await traducirTextoGoogle(b);
        traducidos.push(t && t.trim() ? t.trim() : b);
      } catch {
        traducidos.push(b);
      }
    } else {
      traducidos.push(b);
    }
  }
  return traducidos.join("\n");
}

async function consultarIAApartado({
  asignatura,
  tema,
  tituloTema,
  subtema,
  subtemaTitulo,
  instrucciones,
  textoFuente,
  modeloConfigurado,
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
2. 100% ESPAÑOL ESTÁNDAR: Todo el contenido DEBE estar en castellano. Cero catalán o valenciano.
3. FORMATO DE TÍTULOS: Usa mayúscula inicial y minúsculas (tipo oración), respetando siglas técnicas (HTML, CSS, JS, DOM, XML, W3C, V8, SOP, CORS, XSS). PROHIBIDO mayúsculas sostenidas o signos de exclamación al final.
4. CÓDIGO LIMPIO: No uses entidades HTML (&lt; o &gt;); escribe siempre el código real dentro de \\begin{codigo}...\\end{codigo}.
5. MACROS WEC: Usa \\secciongrande, \\resumen, \\subtituloA, \\subtituloB, \\definicion, \\rectangulos, \\lista con elementos separados por | (**Concepto:** Explicación), \\nota{Para el examen}{...}. No coloques subtítulos dentro de \\lista ni dejes viñetas vacías.
6. Devuelve únicamente el JSON, sin texto explicativo adicional.`;

  const sistemaConciso = "Eres un profesor experto en informática. Redacta apuntes docentes estructurados, rigurosos y exhaustivos para LaTeX con las macros oficiales WEC (\\secciongrande, \\resumen, \\definicion, \\subtituloA, \\lista, \\nota{Para el examen}{...}, \\begin{codigo}...\\end{codigo}). Todo en español estándar (cero catalán ni inglés). Devuelve EXCLUSIVAMENTE un JSON válido con campos titulo_tema, titulo_subtema, conceptos_clave y archivos (cada uno con subtema, nombre, titulo y latex en español). Cero rodeos, solo el JSON puro.";

  try {
    const raw = await consultarModeloIA(
      sistemaConciso,
      prompt,
      [],
      null,
      modeloConfigurado
    );
    return normalizarResultadoIA(raw, {
      subject: asignatura,
      theme: String(tema),
      subtheme: String(subtema),
      themeTitle: tituloTema,
      subthemeTitle: subtemaTitulo,
    });
  } catch (e) {
    console.warn(`Aviso consultando IA para apartado ${subtema}:`, e.message);
    return null;
  }
}

async function main() {
  const asignatura = process.env.ASIGNATURA || "General";
  const tema = process.env.TEMA || "1";
  let titulo = process.env.TITULO || `Tema ${tema}`;
  const subtema = process.env.SUBTEMA || "1";
  let instrucciones = process.env.INSTRUCCIONES || "";
  let textoFuente = process.env.TEXTO_FUENTE || "";
  const apiKey = process.env.NVIDIA_API_KEY || "";
  const modeloConfigurado =
    process.env.NVIDIA_MODELO || "nvidia/nemotron-3.5-bolt-e4b";

  console.log(`=== Generando apuntes modulares en GitHub Actions ===`);
  console.log(`Asignatura: ${asignatura}`);
  console.log(`Tema: ${tema} - ${titulo}`);
  console.log(`Subtema inicial: ${subtema}`);
  console.log(`Modelo preferido: ${modeloConfigurado}`);

  // Configurar las rutas de apuntes para que apunten a apuntes-generados
  const dirSalidaAsignatura = path.join(process.cwd(), "apuntes-generados", asignatura);
  const dirSalidaTema = path.join(dirSalidaAsignatura, `Tema ${tema}`);
  config.notesRoot = path.join(process.cwd(), "apuntes-generados");
  config.latexLibrary = path.join(process.cwd(), "bibliotecas_latex");

  await fs.mkdir(dirSalidaAsignatura, { recursive: true });
  await fs.mkdir(dirSalidaTema, { recursive: true });

  // 1. DEDUCCIÓN Y TRADUCCIÓN AUTOMÁTICA DEL MATERIAL AL ESPAÑOL ESTÁNDAR
  if (!titulo || /^tema\s*\d+$/i.test(titulo.trim())) {
    const deducido = deducirTituloRealista(textoFuente, tema, titulo);
    if (deducido && !/^tema\s*\d+$/i.test(deducido.trim())) {
      titulo = deducido;
      console.log(`✓ Título realista deducido de la fuente: "${titulo}"`);
    }
  }

  if (detectarCatalan(titulo)) {
    console.log(`🌐 Traduciendo título "${titulo}" al español...`);
    try {
      const trad = await traducirTextoGoogle(titulo);
      if (trad && trad.trim()) {
        titulo = trad.trim();
        console.log(`✓ Título traducido: "${titulo}"`);
      }
    } catch (e) {
      console.warn("Aviso al traducir título:", e.message);
    }
  }
  titulo = normalizarMayusculasTitulo(titulo);

  if (detectarCatalan(instrucciones)) {
    try {
      const trad = await traducirTextoGoogle(instrucciones);
      if (trad && trad.trim()) instrucciones = trad.trim();
    } catch (_) {}
  }

  if (detectarCatalan(textoFuente)) {
    try {
      textoFuente = await traducirTextoLargoSiEsCatalan(textoFuente);
      console.log("✓ Material fuente traducido con éxito al español.");
    } catch (e) {
      console.warn("Aviso al traducir material fuente:", e.message);
    }
  }

  let contenidoLatexDirecto = (process.env.CONTENIDO_LATEX || "").trim();
  let resultadoIA = null;
  let errorNvidia = "";

  if (contenidoLatexDirecto && (contenidoLatexDirecto.startsWith("{") || contenidoLatexDirecto.startsWith("```json"))) {
    try {
      const matchJ = contenidoLatexDirecto.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      const strJ = matchJ ? matchJ[1].trim() : contenidoLatexDirecto.trim();
      const parsed = JSON.parse(strJ);
      if (parsed && (parsed.archivos || parsed.latex)) {
        resultadoIA = normalizarResultadoIA(parsed, {
          subject: asignatura,
          theme: String(tema),
          subtheme: String(subtema),
          themeTitle: titulo,
        });
        console.log("✓ Estructura de bloques JSON recibida directamente desde la interfaz web.");
      }
    } catch (eJson) {
      console.warn("Aviso al parsear JSON recibido:", eJson.message);
    }
  }

  if (!resultadoIA && (contenidoLatexDirecto || textoFuente.includes("\\documentclass"))) {
    console.log("✓ Usando contenido LaTeX preexistente proporcionado.");
    const texBase = contenidoLatexDirecto || textoFuente;
    resultadoIA = {
      titulo_tema: titulo,
      titulo_subtema: titulo,
      archivos: [
        {
          subtema: String(subtema),
          nombre: `1.${crearNombreArchivo(titulo)}`,
          titulo,
          latex: texBase,
        },
      ],
    };
  } else if (!resultadoIA && !apiKey) {
    throw new Error(
      "Falta la clave NVIDIA_API_KEY en configuracion_privada de Supabase. No se puede generar con IA."
    );
  } else if (!resultadoIA) {
    const apartadosDetectados = detectarApartadosEnTexto(textoFuente);
    if (apartadosDetectados.length >= 2) {
      console.log(`Detectados ${apartadosDetectados.length} apartados estructurados en el material:`);
      for (const a of apartadosDetectados) {
        console.log(`  - Apartado ${a.tema}.${a.subtema}: ${a.titulo}`);
      }
      const bloques = dividirTextoPorApartados(textoFuente, [], apartadosDetectados);
      const todosLosArchivos = [];

      for (let i = 0; i < bloques.length; i++) {
        const blq = bloques[i];
        const apInfo = apartadosDetectados[i] || { subtema: i + 1, titulo: `Apartado ${i + 1}` };
        const subtemaId = String(apInfo.subtema || i + 1);
        const subtemaTitulo = apInfo.titulo || `Apartado ${subtemaId}`;

        console.log(`\n🤖 Redactando con IA Apartado ${tema}.${subtemaId}: "${subtemaTitulo}"...`);
        const resApartado = await consultarIAApartado({
          asignatura,
          tema,
          tituloTema: titulo,
          subtema: subtemaId,
          subtemaTitulo,
          instrucciones,
          textoFuente: blq.texto,
          apiKey,
          modeloConfigurado,
        });

        if (resApartado?.archivos?.length) {
          for (const arch of resApartado.archivos) {
            arch.subtema = subtemaId;
            todosLosArchivos.push(arch);
            console.log(`  ✓ Generado fragmento: Tema ${tema}.${subtemaId}/${arch.nombre || "seccion"}.tex — ${arch.titulo}`);
          }
        }
      }

      if (todosLosArchivos.length > 0) {
        resultadoIA = {
          titulo_tema: titulo,
          titulo_subtema: titulo,
          archivos: todosLosArchivos,
        };
        console.log(`✓ Total de archivos modulares generados por apartados: ${todosLosArchivos.length}`);
      }
    }
  }

  if (!resultadoIA && apiKey) {
    console.log("Conectando con NVIDIA NIM API para generación estructurada...");

    const promptUsuario = `Asignatura: "${asignatura}"
Tema ${tema}: "${titulo}"
Subtema / Apartado: ${subtema || "1"}

Instrucciones del alumno:
${instrucciones || "Elabora unos apuntes universitarios completos, rigurosos, divididos por apartados y subtemas, con explicaciones paso a paso, ejemplos de código y notas de examen."}

Material o resumen de partida:
${textoFuente || "Elabora el temario estándar oficial para esta asignatura y tema."}

FORMATO DE SALIDA OBLIGATORIO:
Devuelve EXCLUSIVAMENTE un objeto JSON válido con este formato exacto:
{
  "tema_existente": 0,
  "titulo_tema": "${titulo}",
  "titulo_subtema": "Título formal del apartado en español",
  "conceptos_clave": ["Concepto 1", "Concepto 2"],
  "archivos": [
    {
      "subtema": "1",
      "nombre": "1.slug-del-apartado",
      "titulo": "Título formal del apartado en español",
      "latex": "\\secciongrande{Título del apartado}\\n\\n\\resumen{Síntesis sustancial de la teoría en 3 a 5 líneas sin frases vacías ni metalenguaje.}\\n\\n\\definicion{Concepto}{Definición técnica formal.}\\n\\n\\subtituloA{Detalle conceptual}\\n\\n\\lista{\\n  **Elemento 1:** Explicación técnica.\\n  **Elemento 2:** Explicación técnica.\\n}\\n\\n\\nota{Para el examen}{Pregunta con respuesta razonada.}"
    }
  ]
}

REGLAS CRÍTICAS DE CALIDAD:
1. Divide el tema en subtemas ordenados (ej. subtema 1, subtema 2...) y cada subtema en sus archivos numerados secuencialmente (1.<slug>, 2.<slug>).
2. Todo el contenido debe estar 100% en ESPAÑOL ESTÁNDAR (castellano). Prohibido utilizar palabras en catalán en títulos, slugs o explicaciones.
3. El primer archivo de cada subtema debe incluir \\secciongrande{...} y \\resumen{...}. Los archivos siguientes usan \\subtituloA{...}.
4. No envuelvas la respuesta en texto conversacional; entrega únicamente el JSON.`;

    const modelosAIntentar = Array.from(
      new Set([
        modeloConfigurado,
        "nvidia/nemotron-3.5-bolt-e4b",
        "mistralai/mistral-large-4-1t-a52b",
        "nvidia/nemotron-3-ultra-550b-a55b",
        "poolside/laguna-xs-2.1",
        "nvidia/nemotron-3.5-lightning-30b-a3b",
      ])
    ).filter(Boolean);

    for (const mod of modelosAIntentar) {
      console.log(`Intentando llamada con modelo: ${mod}...`);
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
              { role: "system", content: sistemaApuntes },
              { role: "user", content: promptUsuario },
            ],
            temperature: 0.2,
            max_tokens: 8192,
          }),
        });

        if (!resp.ok) {
          const detalle = await resp.text();
          errorNvidia = `NVIDIA NIM (${mod}) HTTP ${resp.status}: ${detalle}`;
          console.warn(`⚠️ ${errorNvidia}`);
          if (resp.status === 410 || resp.status === 404) {
            continue;
          }
          break;
        }

        const data = await resp.json();
        const rawContent = (data.choices?.[0]?.message?.content || "").trim();

        if (!rawContent || esTextoDeRazonamiento(rawContent) || /^let me\b|^i need to\b|^thinking\b/i.test(rawContent)) {
          console.warn(`⚠️ Respuesta no utilizable o razonamiento en inglés de ${mod}, probando siguiente modelo...`);
          continue;
        }

        // Extraer bloque JSON
        const matchJson = rawContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        const jsonCandidato = matchJson ? matchJson[1].trim() : rawContent;

        try {
          const parsed = JSON.parse(jsonCandidato);
          if (parsed && (parsed.archivos || parsed.latex)) {
            resultadoIA = normalizarResultadoIA(parsed, {
              subject: asignatura,
              theme: String(tema),
              subtheme: String(subtema),
              themeTitle: titulo,
            });
            console.log(`✓ JSON procesado y normalizado correctamente con modelo: ${mod}`);
            errorNvidia = "";
            break;
          }
        } catch (eParse) {
          console.warn(`⚠️ Error parseando JSON de ${mod}: ${eParse.message}. Probando siguiente modelo...`);
          continue;
        }
      } catch (e) {
        errorNvidia = `Error de conexión con NVIDIA NIM (${mod}): ${e.message}`;
        console.error(`❌ ERROR: ${errorNvidia}`);
      }
    }
  }

  // Si no se obtuvo resultado, crear un bloque didáctico de respaldo válido
  if (!resultadoIA || !resultadoIA.archivos || !resultadoIA.archivos.length) {
    console.log("Generando bloque base de respaldo estructurado...");
    const slug = crearNombreArchivo(titulo || "apuntes");
    resultadoIA = {
      titulo_tema: titulo,
      titulo_subtema: titulo,
      archivos: [
        {
          subtema: String(subtema || "1"),
          nombre: `1.${slug}`,
          titulo,
          latex: `\\secciongrande{${titulo}}

\\resumen{
  Apuntes elaborados para la asignatura \\textbf{${asignatura}}, correspondientes al Tema ${tema}: ${titulo}.
}

\\definicion{Concepto Fundamental}{
  Definición técnica y formal correspondiente al contenido de este tema.
}

\\subtituloA{Contenido principal del tema}

\\lista{
  **Introducción:** Fundamentos y contexto de partida.|
  **Desarrollo:** Conceptos esenciales explicados paso a paso.|
  **Conclusión:** Resumen y síntesis para el examen.
}

\\nota{Para el examen}{
  Recuerda estudiar en detalle las definiciones y la estructura técnica de este tema.
}`,
        },
      ],
    };
  }

  // 2. VERIFICACIÓN Y TRADUCCIÓN FINAL DE CADA FRAGMENTO LATEX
  for (const block of resultadoIA.archivos) {
    if (detectarCatalan(block.latex)) {
      console.log(`🌐 Traduciendo residuo catalán en fragmento: ${block.nombre || block.titulo}...`);
      try {
        block.latex = await traducirLatexAEspanolConGoogle(block.latex);
      } catch (errTrad) {
        console.warn("Aviso al traducir fragmento LaTeX:", errTrad.message);
      }
    }
    if (detectarCatalan(block.titulo)) {
      try {
        block.titulo = await traducirTextoGoogle(block.titulo);
      } catch (_) {}
    }
  }

  // 3. ESCRITURA MODULAR ARCHIVO POR ARCHIVO (IDÉNTICO A LOCAL)
  console.log("Guardando estructura modular en disco archivo por archivo...");
  const guardado = await guardarGeneracion({
    result: resultadoIA,
    fingerprint: `ci-${Date.now()}`,
    subject: asignatura,
    theme: String(tema),
    subtheme: String(subtema || "1"),
    inputFiles: [],
    material: { documents: [], visuals: [], warnings: [] },
    replaceExisting: true,
  });

  const archivosEscritos = guardado.salida?.written || [];
  for (const w of archivosEscritos) {
    console.log(`✓ Escrito archivo: ${w.relativo || w.archivo}`);
  }

  // Asegurar estructura del tema (carga.tex, generador-estilos.tex, temaX.tex)
  await asegurarEstructuraTema(dirSalidaTema);
  await asegurarDocumentoTema(dirSalidaTema, asignatura, String(tema), titulo);

  // Generar también un documento maestro tema-X.tex compatible con pdflatex directo
  const inputArchivos = archivosEscritos
    .map((w) => {
      const rel = path.relative(dirSalidaTema, w.archivo).replace(/\\/g, "/");
      return `\\input{${rel}}`;
    })
    .join("\n");

  const maestroLatex = `\\documentclass[a4paper,11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[spanish]{babel}
\\usepackage{amsmath,amssymb}
\\usepackage{geometry}
\\usepackage{hyperref}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage{tcolorbox}
\\input{generador-estilos.tex}

\\geometry{top=2.5cm, bottom=2.5cm, left=2.5cm, right=2.5cm}

\\title{\\textbf{${asignatura}}\\\\ \\large Tema ${tema}: ${titulo}}
\\author{Generador Automático de Apuntes}
\\date{\\today}

\\begin{document}
\\maketitle
\\tableofcontents
\\newpage

${inputArchivos || "\\section{Contenido}\\nSin apartados."}

\\end{document}`;

  const rutaMaestroTema = path.join(dirSalidaTema, `tema-${tema}.tex`);
  const rutaMaestroRaiz = path.join(dirSalidaAsignatura, `tema-${tema}.tex`);
  await fs.writeFile(rutaMaestroTema, maestroLatex, "utf8");
  await fs.writeFile(rutaMaestroRaiz, maestroLatex, "utf8");

  // 4. COMPILACIÓN A PDF
  console.log("Compilando apuntes a PDF...");
  let compilado = false;

  // Intento 1: compilar temaX.tex con xelatex (estilo oficial WEC si bibliotecas_latex existe)
  try {
    const rutaTemaX = path.join(dirSalidaTema, `tema${tema}.tex`);
    if (await fs.stat(rutaTemaX).catch(() => null)) {
      console.log(`Intentando compilar ${rutaTemaX} con xelatex (pase 1)...`);
      execSync(`xelatex -shell-escape -interaction=nonstopmode tema${tema}.tex`, {
        cwd: dirSalidaTema,
        stdio: "pipe",
        timeout: 60000,
      });
      console.log(`Compilando con xelatex (pase 2 para generar el índice completo)...`);
      execSync(`xelatex -shell-escape -interaction=nonstopmode tema${tema}.tex`, {
        cwd: dirSalidaTema,
        stdio: "pipe",
        timeout: 60000,
      });
      const pdfTemaX = path.join(dirSalidaTema, `tema${tema}.pdf`);
      if (await fs.stat(pdfTemaX).catch(() => null)) {
        compilado = true;
        console.log("✓ Compilación con xelatex exitosa (índice y referencias actualizados).");
      }
    }
  } catch (errXelatex) {
    console.log("Aviso: xelatex no completó, probando con pdflatex autónomo:", errXelatex.message);
  }

  // Intento 2: si no compiló, compilar tema-X.tex con pdflatex
  if (!compilado) {
    try {
      console.log(`Compilando documento con pdflatex...`);
      execSync(`pdflatex -interaction=nonstopmode tema-${tema}.tex`, {
        cwd: dirSalidaTema,
        stdio: "pipe",
        timeout: 60000,
      });
      execSync(`pdflatex -interaction=nonstopmode tema-${tema}.tex`, {
        cwd: dirSalidaTema,
        stdio: "pipe",
        timeout: 60000,
      });
      compilado = true;
      console.log("✓ Compilación con pdflatex exitosa.");
    } catch (errPdflatex) {
      console.warn("Aviso en la compilación con pdflatex:", errPdflatex.message);
    }
  }

  // 5. DISTRIBUIR LOS ARCHIVOS PDF GENERADOS A TODAS LAS RUTAS CONVENIDAS
  const nombresPdf = [`tema${tema}.pdf`, `tema-${tema}.pdf`, `Tema ${tema}.pdf`];
  let rutaPdfOrigen = "";
  for (const n of nombresPdf) {
    const cand = path.join(dirSalidaTema, n);
    if (await fs.stat(cand).catch(() => null)) {
      rutaPdfOrigen = cand;
      break;
    }
  }

  if (rutaPdfOrigen) {
    console.log(`✓ Localizado PDF generado en: ${rutaPdfOrigen}`);
    for (const nom of [
      `tema${tema}.pdf`,
      `tema-${tema}.pdf`,
      `Tema ${tema}.pdf`,
    ]) {
      await fs.copyFile(rutaPdfOrigen, path.join(dirSalidaTema, nom)).catch(() => {});
      await fs.copyFile(rutaPdfOrigen, path.join(dirSalidaAsignatura, nom)).catch(() => {});
    }
    console.log("✓ PDF propagado a todas las rutas de la asignatura y del tema.");
  } else {
    console.warn("⚠️ No se encontró archivo PDF compilado tras los intentos de compilación.");
  }

  console.log("=== Generación modular finalizada correctamente ===");
}

main().catch((err) => {
  console.error("Error fatal en generador CI:", err);
  process.exit(1);
});
