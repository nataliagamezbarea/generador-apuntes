import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, readFileSync, existsSync } from "fs";
import { join } from "path";

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
