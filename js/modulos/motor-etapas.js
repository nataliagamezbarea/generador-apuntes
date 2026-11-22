/**
 * Motor de generación por etapas para apuntes universitarios.
 * Fachada modular que reexporta:
 * - Orquestación del ciclo de vida y reanudación de trabajos (orquestacion.js)
 * - Generación de unidades didácticas con IA, reintentos y división (generacion-unidad.js)
 * - Guardado, agrupación, catálogo y extracciones temáticas (guardado-trabajo.js)
 */

export * from "./motor-etapas/orquestacion.js";
export * from "./motor-etapas/generacion-unidad.js";
export * from "./motor-etapas/guardado-trabajo.js";
