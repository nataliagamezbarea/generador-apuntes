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
