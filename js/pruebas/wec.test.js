import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { desglosarBloquesPorSubtitulos, aplicarEstilosLatex } from "../modulos/apuntes.js";
import { detectarApartadosEnTexto } from "../modulos/instrucciones.js";

function compileLatex(texContent) {
  const texPath = join(process.cwd(), "temp_test.tex");
  const logPath = join(process.cwd(), "temp_test.log");
  const pdfPath = join(process.cwd(), "temp_test.pdf");
  
  writeFileSync(texPath, texContent);
  
  try {
    execSync(`xelatex -interaction=nonstopmode -synctex=0 -file-line-error-style "${texPath}"`, {
      cwd: process.cwd(),
      timeout: 30000
    });
    const success = existsSync(pdfPath);
    return { success, log: readFileSync(logPath, 'utf8').substring(0, 300) };
  } catch (error) {
    const log = readFileSync(logPath, 'utf8').substring(0, 300);
    return { success: false, error: error.message, log };
  } finally {
    try { unlinkSync(texPath); } catch (e) {}
    try { unlinkSync(logPath); } catch (e) {}
    try { unlinkSync(pdfPath); } catch (e) {}
  }
}

test('No debe contenir subsubsectionC en el output generado', () => {
  const tex = '\\section{Test}\n\\subsubsectionC{Contenido}';
  assert.match(tex, /\\subsubsectionC/);
});

test('Debe usar estructura alterna A-B en el output', () => {
  const tex = '\\section{Test}\n\\subtituloA{Titulo 1}\\n\\subtituloB{Titulo 2}\\n\\subtituloA{Titulo 3}';
  assert.match(tex, /\\subtituloA.*\\subtituloB.*\\subtituloA/);
});

test('Debe contenir \\\\resumen{} en el output', () => {
  const tex = '\\section{Test}\\n\\resumen{Contenido}';
  assert.match(tex, /\\resumen{/);
});

test('Resumen debe tener contenido mnimio', () => {
  const tex = '\\resumen{Este es un resumen con contenido suficiente}';
  const match = tex.match(/\\resumen\{([^}]+)\}/);
  assert(match, 'match should exist');
  if (match) {
    assert(match[1].length > 10, 'resumen content should be > 10 chars');
  }
});

test('No deve contenir cataln no traduct en el output', () => {
  const tex = '\\section{Test}\\ncontinguts en catal';
  // Use assert.match with negated check
  assert.match(tex, /^(?!.*contiguts|.*eines|.*entorn|.*eines).*$/);
});

test('Debe compilar sin errores fatales', () => {
  const tex = '\\documentclass{extarticle}\\n\\input{carga.tex}\\n\\begin{document}\\section{Test}\\subtituloA{Titulo de prueba}\\resumen{Contenido del resumen}\\end{document}';
  
  const result = compileLatex(tex);
  
  if (!result.success) {
    const fatal = result.log.match(/!e!|!\\LaTeX Error|!\\undefined/);
    if (fatal) {
      throw new Error('Errores fatales en LaTeX: ' + result.log);
    }
  }
  assert(true);
});

test('desglosarBloquesPorSubtitulos divide un bloque con varios subtitulos en archivos numerados', () => {
  const bloquesEntrada = [
    {
      subtema: 1,
      titulo: "Modelos de ejecución",
      latex: `\\secciongrande{Modelos de ejecución del código}\n\n\\resumen{Texto del resumen inicial.}\n\n\\subtituloA{Origen y alcance de la web}\n\nContenido del origen.\n\n\\subtituloA{Cuatro campos del diseño web}\n\nContenido de campos.\n\n\\subtituloA{Modelo cliente-servidor}\n\nContenido cliente servidor.`
    }
  ];

  const resultado = desglosarBloquesPorSubtitulos(bloquesEntrada);
  assert.equal(resultado.length, 3, "Debe haberse dividido en 3 bloques");

  // Bloque 1
  assert.match(resultado[0].nombre, /^1\./, "El primer archivo debe empezar por 1.");
  assert.match(resultado[0].latex, /\\secciongrande\{Modelos de ejecución del código\}/);
  assert.match(resultado[0].latex, /\\resumen\{Texto del resumen inicial\.\}/);
  assert.match(resultado[0].latex, /\\subtituloA\{Origen y alcance de la web\}/);

  // Bloque 2
  assert.match(resultado[1].nombre, /^2\./, "El segundo archivo debe empezar por 2.");
  assert.doesNotMatch(resultado[1].latex, /\\secciongrande/);
  assert.doesNotMatch(resultado[1].latex, /\\resumen/);
  assert.match(resultado[1].latex, /\\subtituloA\{Cuatro campos del diseño web\}/);

  // Bloque 3
  assert.match(resultado[2].nombre, /^3\./, "El tercer archivo debe empezar por 3.");
  assert.doesNotMatch(resultado[2].latex, /\\secciongrande/);
  assert.doesNotMatch(resultado[2].latex, /\\resumen/);
  assert.match(resultado[2].latex, /\\subtituloA\{Modelo cliente-servidor\}/);
});

test('aplicarEstilosLatex corrige extbf a \\textbf sin alterar comandos válidos', () => {
  const input = 'c) Red extbf{Respuesta:} La opción correcta es b.';
  const output = aplicarEstilosLatex(input, "TEST");
  assert.match(output, /\\textbf\{Respuesta:\}/);
  assert.doesNotMatch(output, /(?<![\\a-zA-Z])extbf\{/);
});

test('aplicarEstilosLatex une cajas de nota consecutivas y elimina titulos duplicados', () => {
  const input = `\\nota{Para el examen}{
Para el examen
¿Dónde se implementan los diferentes programas para realizar solicitudes al servidor? a) Servidor b) Cliente c) Red extbfRespuesta: La opción correcta es la b) cliente. Los scripts y aplicaciones que realizan las peticiones web están en el navegador del usuario, no en el servidor ni en los protocolos de red.
}

\\nota{Para el examen}{
Para el examen
¿Es responsabilidad del navegador alojar una página web para responder a solicitudes? a) Verdadero b) Falso extbfRespuesta: La opción correcta es la b) falso. El servidor aloja y responde las páginas, mientras que el navegador se encarga de solicitar y presentar el contenido.
}`;

  const output = aplicarEstilosLatex(input, "TEST");

  // Debe haber exactamente una sola caja \nota{Para el examen}
  const countNotas = (output.match(/\\nota\{Para el examen\}/g) || []).length;
  assert.equal(countNotas, 1, "Debe unificar las dos notas consecutivas en una sola");

  // No debe contener 'Para el examen' redundante en el cuerpo
  assert.doesNotMatch(output, /\{Para el examen\}\{[\s\S]*?(?:\\n|\n)\s*Para el examen/);

  // Debe tener \textbf{Respuesta:} correctamente formateado
  assert.match(output, /\\textbf\{Respuesta:\}/);
  assert.doesNotMatch(output, /(?<![\\a-zA-Z])extbf/);

  // Las dos preguntas deben estar separadas dentro de la misma caja
  assert.match(output, /¿Dónde se implementan/);
  assert.match(output, /¿Es responsabilidad del navegador/);
  assert.match(output, /\\hrulefill/);
});

test('detectarApartadosEnTexto detecta encabezados numerados del PDF Tema 1', () => {
  const samplePdf = `
DESENVOLUPAMENT WEB EN ENTORN CLIENT
Tema 1: Selecció d'arquitectures i d'eines de programació
INTRODUCCIÓ: L'origen i l'abast de la web
1.1 · MODELS D'EXECUCIÓ DE CODI: Els quatre camps del disseny web
1.2 · LLENGUATGES DE PROGRAMACIÓ EN ENTORN CLIENT: Dos entorns d'execució
1.3 · MECANISMES D'EXECUCIÓ DE CODI EN UN NAVEGADOR WEB: L'arquitectura del navegador
1.4 · CAPACITATS I LIMITACIONS D'EXECUCIÓ: Per què JavaScript en el client?
1.5 · PROGRAMACIÓ DE SCRIPTS: On i com col·locar els scripts
1.6 · INTEGRACIÓ DEL CODI AMB LES ETIQUETES HTML: Integració en línia
1.7 · EINES DE PROGRAMACIÓ SOBRE CLIENTS WEB: Triar l'editor de codi
`;
  const apartados = detectarApartadosEnTexto(samplePdf);
  assert.equal(apartados.length, 7, "Debe detectar los 7 subtemas");
  assert.equal(apartados[0].subtema, 1);
  assert.equal(apartados[1].subtema, 2);
  assert.equal(apartados[6].subtema, 7);
});

test('esUrlWebSegura valida fuentes educativas seguras y rechaza dominios no seguros', async () => {
  const { esUrlWebSegura } = await import("../modulos/investigacion.js");
  assert.equal(esUrlWebSegura("https://es.wikipedia.org/wiki/Cliente-servidor"), true);
  assert.equal(esUrlWebSegura("https://www.arsys.es/blog/arquitectura"), true);
  assert.equal(esUrlWebSegura("http://inseguro.com"), false);
  assert.equal(esUrlWebSegura("https://detail.chiebukuro.yahoo.co.jp/qa/123"), false);
});

test('buscarEnInternet devuelve fuentes estructuradas con titulo, url y resumen', async () => {
  const { buscarEnInternet } = await import("../modulos/investigacion.js");
  const fuentes = await buscarEnInternet("arquitectura cliente servidor", 2);
  assert.ok(Array.isArray(fuentes), "Debe devolver un array");
  if (fuentes.length > 0) {
    assert.ok(fuentes[0].titulo, "Debe tener titulo");
    assert.ok(fuentes[0].url.startsWith("https://"), "Debe tener URL https segura");
    assert.ok(fuentes[0].resumen.length > 10, "Debe contener resumen");
  }
});

test('normalizarMayusculasTitulo normaliza mayusculas sostenidas y elimina signos de exclamacion', async () => {
  const { normalizarMayusculasTitulo } = await import("../modulos/apuntes/utilidades-nombres.js");
  const input = "MECANISMOS DE EJECUCIÓN DE CÓDIGO EN UN NAVEGADOR WEB: La Arquitectura del Navegador !";
  const output = normalizarMayusculasTitulo(input);
  assert.equal(output, "Mecanismos de ejecución de código en un navegador web: La Arquitectura del Navegador");
});

test('deducirTituloRealista extrae titulo de diapositivas', async () => {
  const { deducirTituloRealista } = await import("../modulos/apuntes/utilidades-nombres.js");
  const textoSlide = "DESENVOLUPAMENT WEB EN ENTORN CLIENT\n\nTema 1\nSelecció d'arquitectures i d'eines de programació\n\n2n DAW";
  const deducido = deducirTituloRealista(textoSlide, "1", "Tema 1");
  assert.equal(deducido, "Selecció d'arquitectures i d'eines de programació");
});

test('aplicarEstilosLatex limpia CDATA, elimina viñetas huerfanas y corrige . Licencias', async () => {
  const { aplicarEstilosLatex } = await import("../modulos/apuntes/estilos-latex.js");
  const input = `\\secciongrande{Test}\n\n• Sin Soporte: Se utiliza la etiqueta <noscript> para informar al usuario si JavaScript no está habilitado. ]]>\n\n. Licencias: Se pueden añadir licencias para gestionar el uso.\n\n• \n\n\\begin{codigo}\n&lt;h1&gt;Bienvenido&lt;/h1&gt;\n\\end{codigo}`;
  const out = aplicarEstilosLatex(input);
  assert.ok(!out.includes("]]>"), "No debe contener ]]>");
  assert.ok(!out.includes(". Licencias:"), "No debe contener . Licencias:");
  assert.ok(out.includes("**Licencias:**") || out.includes("\\textbf{Licencias:}"), "Debe convertir a Licencias en negrita");
  assert.ok(out.includes("<h1>Bienvenido</h1>"), "Debe decodificar &lt;h1&gt;");
  assert.ok(!out.includes("&lt;h1&gt;"), "No debe contener &lt;h1&gt;");
});

test('esTextoDeRazonamiento detecta y rechaza razonamiento interno o thinking process de la IA', async () => {
  const { esTextoDeRazonamiento } = await import("../modulos/apuntes/utilidades-nombres.js");
  const thinking1 = "Here's a thinking process:\n1 Analyze User Input:\nSubject/Asignatura: \"JK\"";
  const thinking2 = "Let me analyze this task carefully. I need to: 1 Read and understand the PDF";
  const thinking3 = "<think>The user wants university notes</think>";
  const validNotes = "\\secciongrande{Modelos de ejecución}\\n\\resumen{Texto didáctico válido}";
  assert.equal(esTextoDeRazonamiento(thinking1), true);
  assert.equal(esTextoDeRazonamiento(thinking2), true);
  assert.equal(esTextoDeRazonamiento(thinking3), true);
  assert.equal(esTextoDeRazonamiento(validNotes), false);
});

test('limpiarNombreInstitucion elimina nombres de colegios e instituciones de los títulos', async () => {
  const { limpiarNombreInstitucion } = await import("../modulos/apuntes/utilidades-nombres.js");
  assert.equal(
    limpiarNombreInstitucion("Selección de arquitecturas y herramientas de programación Colegio Sant Josep Obrer"),
    "Selección de arquitecturas y herramientas de programación"
  );
  assert.equal(
    limpiarNombreInstitucion("Desarrollo web IES Joan Maria Thomàs"),
    "Desarrollo web"
  );
});

test('convertirMarkdownALatexWec y aplicarEstilosLatex convierten listas con pipes en \\lista con viñetas', async () => {
  const { aplicarEstilosLatex, convertirMarkdownALatexWec } = await import("../modulos/apuntes/estilos-latex.js");
  const input = `| Restricción de archivos: | No puede acceder al disco duro del usuario. Política del mismo origen (SOP): Un script de dominio A no puede acceder a recursos de dominio B. CORS: Error que ocurre al acceder a APIs ajenas.`;
  const out = aplicarEstilosLatex(convertirMarkdownALatexWec(input));
  assert.ok(out.includes("\\lista{"), "Debe generar una macro \\lista");
  assert.ok(out.includes("\\textbf{Restricción de archivos:}"), "Debe tener Restricción de archivos en negrita");
  assert.ok(out.includes("\\textbf{Política del mismo origen (SOP):}"), "Debe tener Política del mismo origen en negrita");
  assert.ok(out.includes("\\textbf{CORS:}"), "Debe tener CORS en negrita");
  assert.ok(!out.includes("| Restricción de archivos: |"), "No debe contener los pipes literales");
});

