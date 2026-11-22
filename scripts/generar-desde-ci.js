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
  const modelo = process.env.NVIDIA_MODELO || "meta/llama-3.1-8b-instruct";

  console.log(`=== Generando apuntes en GitHub Actions ===`);
  console.log(`Asignatura: ${asignatura}`);
  console.log(`Tema: ${tema} - ${titulo}`);
  console.log(`Modelo: ${modelo}`);

  let contenidoLatex = "";
  let errorNvidia = "";

  if (!apiKey) {
    errorNvidia = "No se configuró NVIDIA_API_KEY en los Secrets del repositorio de GitHub (Settings > Secrets and variables > Actions > New repository secret con nombre NVIDIA_API_KEY).";
    console.warn(`⚠️ AVISO: ${errorNvidia}`);
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

    try {
      const resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelo,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 4096,
        }),
      });

      if (!resp.ok) {
        const detalle = await resp.text();
        errorNvidia = `NVIDIA NIM respondió con código HTTP ${resp.status}: ${detalle}`;
        console.error(`❌ ERROR: ${errorNvidia}`);
      } else {
        const data = await resp.json();
        const rawText = data.choices?.[0]?.message?.content || "";
        const match = rawText.match(/```(?:latex|tex)?([\s\S]*?)```/i);
        contenidoLatex = match ? match[1].trim() : rawText.trim();
        console.log("✓ Apuntes generados con éxito por la IA de NVIDIA NIM.");
      }
    } catch (e) {
      errorNvidia = `Error de conexión con NVIDIA NIM: ${e.message}`;
      console.error(`❌ ERROR: ${errorNvidia}`);
    }
  }

  // Si no hay API key o falló, generar plantilla básica válida de LaTeX informando del estado
  if (!contenidoLatex || !contenidoLatex.includes("\\documentclass")) {
    console.log("Generando documento LaTeX base de respaldo...");
    const avisoLatex = errorNvidia
      ? `\\begin{tcolorbox}[colback=red!5!white,colframe=red!75!black,title=Aviso sobre la IA de NVIDIA]
${errorNvidia.replace(/[_%$#&{}]/g, "\\$&")}
\\\\ \\small Para resolverlo, añade o renueva el secreto \\textbf{NVIDIA\\_API\\_KEY} en la configuración de GitHub (Settings $\\rightarrow$ Secrets and variables $\\rightarrow$ Actions).
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
\\usepackage[spanish]{babel}
\\usepackage{amsmath,amssymb}
\\usepackage{geometry}
\\usepackage{hyperref}
\\usepackage{listings}
\\usepackage{xcolor}

\\geometry{top=2.5cm, bottom=2.5cm, left=2.5cm, right=2.5cm}

\\title{\\textbf{${asignatura}}\\\\ \\large Tema ${tema}: ${titulo}}
\\author{Generador Automático de Apuntes}
\\date{\\today}

\\begin{document}
\\maketitle
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
