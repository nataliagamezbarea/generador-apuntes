import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

async function main() {
  const asignatura = process.env.ASIGNATURA || "General";
  const tema = process.env.TEMA || "1";
  const titulo = process.env.TITULO || `Tema ${tema}`;
  const subtema = process.env.SUBTEMA || "0";
  const instrucciones = process.env.INSTRUCCIONES || "";
  const textoFuente = process.env.TEXTO_FUENTE || "";
  const apiKey = process.env.NVIDIA_API_KEY || "";
  const modeloConfigurado = process.env.NVIDIA_MODELO || "google/gemma-3-12b-it";

  console.log(`=== Generando apuntes en GitHub Actions ===`);
  console.log(`Asignatura: ${asignatura}`);
  console.log(`Tema: ${tema} - ${titulo}`);
  console.log(`Modelo preferido: ${modeloConfigurado}`);

  let contenidoLatex = (process.env.CONTENIDO_LATEX || "").trim();
  let errorNvidia = "";

  if (!contenidoLatex && textoFuente.includes("\\documentclass")) {
    contenidoLatex = textoFuente.trim();
  }

  if (contenidoLatex) {
    console.log("✓ Usando contenido LaTeX proporcionado directamente.");
  } else if (!apiKey) {
    throw new Error("Falta la clave NVIDIA_API_KEY en configuracion_privada de Supabase. No se puede generar con IA.");
  } else {
    console.log("Conectando con NVIDIA NIM API...");
    const prompt = `Eres un profesor experto en informática y redactor de apuntes universitarios en LaTeX.
Genera unos apuntes completos, rigurosos y perfectamente estructurados en formato LaTeX para la asignatura "${asignatura}", Tema ${tema}: "${titulo}".

Instrucciones del alumno:
${instrucciones || "Apuntes detallados, con explicaciones paso a paso, ejemplos de código y formato impecable."}

Material o resumen de partida:
${textoFuente || "Elabora el temario estándar oficial para esta asignatura y tema."}

FORMATO DE SALIDA OBLIGATORIO:
Devuelve un documento LaTeX completo y válido que compile directamente, empezando por \\documentclass{article} y terminando con \\end{document}.
Usa los paquetes babel [spanish], inputenc [utf8], amsmath, hyperref, listings y geometry.
No incluyas explicaciones antes o después del código LaTeX; entrega solo el código LaTeX entre triples comillas invertidas.`;

    const modelosAIntentar = Array.from(
      new Set([
        modeloConfigurado,
        "google/gemma-3-12b-it",
        "mistralai/mistral-large-4-1t-a52b",
        "nvidia/nemotron-3.5-lightning-30b-a3b",
        "z-ai/glm-5.3-flash",
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
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            max_tokens: 4096,
          }),
        });

        if (!resp.ok) {
          const detalle = await resp.text();
          errorNvidia = `NVIDIA NIM (${mod}) HTTP ${resp.status}: ${detalle}`;
          console.warn(`⚠️ ${errorNvidia}`);
          // Si el modelo está obsoleto/retirado (410) o no encontrado (404), prueba el siguiente
          if (resp.status === 410 || resp.status === 404) {
            continue;
          }
          break;
        }

        const data = await resp.json();
        const rawText = data.choices?.[0]?.message?.content || "";
        const match = rawText.match(/```(?:latex|tex)?([\s\S]*?)```/i);
        contenidoLatex = match ? match[1].trim() : rawText.trim();
        console.log(`✓ Apuntes generados con éxito por la IA de NVIDIA NIM usando modelo: ${mod}`);
        errorNvidia = "";
        break;
      } catch (e) {
        errorNvidia = `Error de conexión con NVIDIA NIM (${mod}): ${e.message}`;
        console.error(`❌ ERROR: ${errorNvidia}`);
      }
    }
  }

  // Si no hay API key o falló, generar plantilla básica válida de LaTeX informando del estado
  if (!contenidoLatex || !contenidoLatex.includes("\\documentclass")) {
    console.log("Generando documento LaTeX base de respaldo...");
    const avisoLatex = errorNvidia
      ? `\\begin{tcolorbox}[colback=red!5!white,colframe=red!75!black,title=Aviso sobre la IA de NVIDIA]
${errorNvidia.replace(/[_%$#&{}]/g, "\\$&")}
\\\\ \\small Para resolverlo, revisa la clave \\textbf{nvidia\\_api\\_key} en Supabase (tabla \\texttt{configuracion\\_privada}, esquema \\texttt{grados-informaticos}).
\\end{tcolorbox}`
      : "";

    contenidoLatex = `\\documentclass[a4paper,11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[spanish]{babel}
\\usepackage{amsmath,amssymb}
\\usepackage{geometry}
\\usepackage{hyperref}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage{tcolorbox}

\\geometry{top=2.5cm, bottom=2.5cm, left=2.5cm, right=2.5cm}

\\title{\\textbf{${asignatura}}\\\\ \\large Tema ${tema}: ${titulo}}
\\author{Generador Automático de Apuntes}
\\date{\\today}

\\begin{document}
\\maketitle

${avisoLatex}

\\tableofcontents
\\newpage

\\section{Introducción y Objetivos}
Estos apuntes han sido generados automáticamente para la asignatura \\textbf{${asignatura}}.

\\section{Contenido del Tema}
${textoFuente ? textoFuente.replace(/[\\$%&#_{}~^]/g, "\\$&") : "Contenido pendiente de procesar con IA."}

\\section{Resumen y Conclusiones}
Resumen clave de los conceptos estudiados en este tema.

\\end{document}`;
  }

  const dirSalida = path.join(process.cwd(), "apuntes-generados", asignatura);
  await fs.mkdir(dirSalida, { recursive: true });

  const nombreArchivo = `tema-${tema}.tex`;
  const rutaTex = path.join(dirSalida, nombreArchivo);
  await fs.writeFile(rutaTex, contenidoLatex, "utf8");
  console.log(`✓ Archivo LaTeX guardado en: ${rutaTex}`);

  // Compilar con pdflatex
  try {
    console.log("Compilando con pdflatex...");
    execSync(`pdflatex -interaction=nonstopmode -output-directory="${dirSalida}" "${rutaTex}"`, {
      stdio: "inherit",
    });
    console.log("✓ Compilación a PDF completada con éxito.");
  } catch (errCompil) {
    console.warn("Aviso en la compilación LaTeX (revisar paquetes):", errCompil.message);
  }

  console.log("=== Proceso finalizado correctamente ===");
}

main().catch((err) => {
  console.error("Error fatal en generador CI:", err);
  process.exit(1);
});
