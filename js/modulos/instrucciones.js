/**
 * Módulo de instrucciones, prompts y segmentación didáctica para el generador de apuntes.
 * Fachada modular que reexporta:
 * - Prompts del sistema: apuntes, código, mejora y reescritura didáctica (prompts-sistema.js)
 * - Constructores de prompts: creación de prompts de apuntes y de código (prompts-construccion.js)
 * - Segmentación y análisis de material: apartados, diapositivas y bloques (division-material.js)
 * - Referencia de la biblioteca LaTeX: carga local y GitHub (referencia-biblioteca.js)
 */

export * from "./instrucciones/prompts-sistema.js";
export * from "./instrucciones/division-material.js";
export * from "./instrucciones/referencia-biblioteca.js";
export * from "./instrucciones/prompts-construccion.js";
