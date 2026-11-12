import test from "node:test";
import assert from "node:assert/strict";
import { convertirMarkdownALatexWec } from "../modulos/apuntes.js";
import { crearPromptApuntes } from "../modulos/instrucciones.js";

test("convierte la jerarquía Markdown en macros oficiales WEC", () => {
  const latex = convertirMarkdownALatexWec(`# Arquitectura del navegador

> **Resumen:** El navegador coordina la carga y representación de los recursos.

## Componentes principales

### Interfaz de usuario
La interfaz conecta al usuario con los controles del navegador.

#### Funciones principales
- Barras de herramientas.
- Preferencias de configuración.

### Motor de renderizado
Interpreta HTML y CSS para presentar el documento.
`);
  assert.match(latex, /\\secciongrande\{Arquitectura del navegador\}/);
  assert.match(latex, /\\seccion\{Componentes principales\}/);
  assert.match(latex, /\\subtituloA\{Interfaz de usuario\}/);
  assert.match(latex, /\\subtituloB\{Funciones principales\}/);
  assert.match(latex, /\\lista\{/);
  assert.match(latex, /\\subtituloA\{Motor de renderizado\}/);
});

test("mantiene los bloques de código WEC separados de las macros de contenido", () => {
  const latex = convertirMarkdownALatexWec(`# Integración con HTML

### Código de ejemplo
\`\`\`javascript
const mensaje = "Hola";
console.log(mensaje);
\`\`\`
`);
  assert.match(latex, /\\begin\{codigo\}/);
  assert.match(latex, /const mensaje = "Hola";/);
  assert.match(latex, /\\end\{codigo\}/);
});

test("el prompt exige la jerarquía y el índice del WEC", () => {
  const prompt = crearPromptApuntes({ material: "Diapositiva de ejemplo" });
  assert.match(prompt, /\\secciongrande/);
  assert.match(prompt, /\\subtituloA/);
  assert.match(prompt, /\\subtituloB/);
  assert.match(prompt, /\\tableofcontents/);
});
