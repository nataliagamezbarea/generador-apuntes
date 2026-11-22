import { extraerTitulosDiapositiva } from "./division-material.js";
import { compactarReferenciaBiblioteca } from "./referencia-biblioteca.js";

export function crearPromptApuntes({
  asignatura,
  tema,
  tituloTema,
  apartado,
  tituloApartado,
  instruccionEstudiante,
  material,
  temasExistentes,
  investigacion,
  parteMaterial,
  referenciaBiblioteca,
}) {
  const titulosDiapositiva = extraerTitulosDiapositiva(material);
  const inventarioTitulos = titulosDiapositiva.length
    ? titulosDiapositiva.map((titulo, indice) => `${indice + 1}. ${titulo}`).join("\n")
    : "No se han podido detectar automáticamente; identifícalos directamente en el material completo.";
  const numeracionTema = tema
    ? `NÚMERO DE TEMA (mantener exactamente): ${tema}`
    : "NÚMERO DE TEMA: detectar según el material; si corresponde a un tema existente, devuelve su número en tema_existente; si no, devuelve 0.";
  const numeracionApartado = apartado
    ? `NÚMERO DE APARTADO (mantener exactamente): ${tema}.${apartado}`
    : "NÚMERO DE APARTADO: automático; propone un apartado descriptivo dentro del tema detectado.";
  const estructuraTemas = temasExistentes
    ? `ESTRUCTURA DE TEMAS EXISTENTES (solo para asignar el número y organizar; no es fuente de contenido):
${temasExistentes}`
    : "";
  return `ASIGNATURA: ${asignatura}
${numeracionTema}
TÍTULO/PISTA DEL TEMA: ${tituloTema ? `${tituloTema} (TRADUCIR OBLIGATORIAMENTE AL ESPAÑOL ESTÁNDAR EN EL JSON)` : "(inferir a partir del contenido en español)"}
${numeracionApartado}
TÍTULO/PISTA DEL APARTADO: ${tituloApartado ? `${tituloApartado} (TRADUCIR OBLIGATORIAMENTE AL ESPAÑOL ESTÁNDAR EN EL JSON)` : "(inferir y crear a partir del contenido en español)"}

NUMERACIÓN Y TÍTULOS: conserva los números explícitos. Si el número de tema es automático, selecciona el tema existente que mejor corresponda al contenido o indica que debe crearse uno nuevo. Si el apartado es automático, crea un apartado nuevo bajo el tema elegido. En el JSON devuelve solo nombres descriptivos, sin repetir prefijos numéricos.

POSICIÓN DEL NOMBRE DEL TEMA Y ANTI-REPETICIÓN (OBLIGATORIO):
- El nombre del tema ("titulo_tema") va SOLO en el campo "titulo_tema". El nombre del apartado va en "titulo_subtema" y en "archivos[].titulo".
- El nombre del tema YA se muestra en el título del documento: PROHIBIDO repetirlo como \\\\secciongrande{...} o como entrada del índice. El \\\\secciongrande es SIEMPRE el título del apartado concreto.
- PROHIBIDO escribir el nombre del tema o rótulos como «Tema 1: ...» o «Tema 2.1: ...» dentro de \\\\resumen{...}.
- NUNCA incluyas el nombre de la carpeta, la asignatura o el curso como título visible del documento.
- Cada \\\\resumen, \\\\subtituloA y \\\\subtituloB debe aparecer UNA sola vez. PROHIBIDO repetir listados, párrafos o secciones ya explicadas.

TRADUCCIÓN OBLIGATORIA Y TOTAL AL ESPAÑOL ESTÁNDAR:
Todos los campos del JSON ("titulo_tema", "titulo_subtema", "archivos[].titulo", "archivos[].nombre" y "latex") DEBEN estar 100% en español estándar de España.
Si la pista, el título o el material están en catalán o en otro idioma, TRADÚCELOS OBLIGATORIAMENTE al español estándar:
- "titulo_tema" en español estándar (ej: "Arquitecturas y herramientas", NUNCA "Arquitectures i Eines").
- "titulo_subtema" y "archivos[].titulo" en español estándar (ejemplos obligatorios: "Modelos de ejecución del código", "Lenguajes de programación en entorno cliente", "Mecanismos de ejecución de código en un navegador web", "Capacidades y limitaciones de ejecución", "Integración del código con las etiquetas HTML", "Herramientas de programación sobre clientes web"). PROHIBIDO DEJAR PALABRAS EN CATALÁN como "entorn", "mecanismes", "capacitats", "eines", "model", "clients", "execucio", "etiquetes", "programacio".
- En "archivos[].nombre" pon slugs cortos de 1 a 3 palabras clave conceptuales en español estándar (ej: "modelos-ejecucion", "entorno-cliente", "mecanismos-ejecucion", "capacidades-limitaciones", "herramientas-cliente"). NUNCA uses términos en catalán como "model", "entorn", "eines", "clients", "execucio".

LONGITUD Y DESARROLLO DIDÁCTICO:
- Desarrolla cada concepto con la profundidad que el material permita: qué es, para qué sirve, cómo funciona internamente, sus pasos o componentes, cuándo se aplica, condiciones y excepciones, diferencias frente a conceptos cercanos, errores frecuentes y preguntas de autoevaluación.
- Escribiendo con naturalidad y en párrafos completos. No te limites a resumir en 2 líneas; extensos no están prohibidos, pero sí está penalizado el contenido vacío o excesivamente resumido.
- INCLUYE DE FORMA NATURAL los cuadros de examen \\\\nota{Para el examen}{...} cuando ayuden a aprender, analizando por qué la opción correcta es válida y por qué cada una de las alternativas falsas es incorrecta.
- Usa listas con viñetas (-) o barras verticales (|) para agrupar componentes de una misma estructura, sabiendo que estos se convertirán automáticamente al formato LaTeX WEC durante la conversión.
- Distingue los datos del material de las aclaraciones añadidas; apóyate en las fuentes fiables disponibles y no presentes como hecho una ampliación dudosa. Define el vocabulario técnico la primera vez que aparezca.

INVENTARIO DE TÍTULOS INTERNOS DETECTADOS EN LAS DIAPOSITIVAS (DEBES CONSERVARLOS EN ESTE ORDEN):
${inventarioTitulos}
Este inventario complementa, no sustituye, la lectura del material. Cada título representa un bloque temático que debe aparecer como encabezado LaTeX propio; no lo conviertas en una viñeta ni lo omitas.

- Punto CRÍTICO: Cada título de esta lista debe conservarse como \\subtituloA{...} o \\subtituloB{...} en el LaTeX final. ESTÁ TERMINANTEMENTE PROHIBIDO generar un único \\secciongrande{...} para todo el apartado. NO fusiones títulos de diapositiva distintos en un solo bloque. Si el material tiene 9 títulos de diapositiva, debes tener 9 encabezados LaTeX individuales (mezcla de \\subtituloA y \\subtituloB), NO un único bloque.

- Cada título de esta lista representa un bloque temático independiente que debe aparecer con su propio encabezado LaTeX. No los combines, no los elimines y no los sustituyas por encabezados genéricos. Cada uno debe desarrollarse como un \\subtituloA{...} suelto o bajo un subtítulo común, pero siempre conservando su identidad individual.

Propón títulos concretos a partir del material: cada título de esta lista representa un bloque temático independiente que debe aparecer con su propio encabezado LaTeX. No los combines, no los elimines y no los sustituyas por encabezados genéricos como "Titulo" o "Concepto principal". Cada uno debe desarrollarse como un \\subtituloA{...} suelto o bajo un subtítulo común, pero siempre conservando su identidad individual. PROHIBIDO usar la palabra "titulo" como texto literal en el LaTeX; usa siempre las macros \\subtituloA o \\subtituloB.

${estructuraTemas}

REGLAS DE SALIDA:
- Devuelve únicamente el objeto JSON con la estructura solicitada, sin bloques de código markdown (\`\`\`json) envolventes ni texto explicativo previo o posterior.
- Todos los campos de texto deben estar redactados en español estándar de España, con ortografía y tipografía académicas correctas.

INSTRUCCIÓN ESPECÍFICA DEL ESTUDIANTE:
${instruccionEstudiante || "Elabora unos apuntes universitarios completos, rigurosos y pedagógicos, adaptados al formato LaTeX del curso."}

INVESTIGACIÓN COMPLEMENTARIA:
${investigacion || "No se ha realizado investigación complementaria; básate exclusivamente en el material proporcionado."}

CATÁLOGO DE MACROS LATEX DE LA BIBLIOTECA:
${compactarReferenciaBiblioteca(referenciaBiblioteca) || "Usa exclusivamente las macros oficiales de la biblioteca WEC."}

MATERIAL DOCENTE FUENTE:
<<<MATERIAL
${material}
MATERIAL>>>

${parteMaterial ? `\n\n${parteMaterial}` : ""}`;
}

export function crearPromptCodigoPorTemas({
  asignatura,
  temasExistentes,
  temarioPDF,
  material,
  instruccionEstudiante,
  referenciaBiblioteca,
}) {
  return `ASIGNATURA: ${asignatura}

OBJETIVO: convierte exclusivamente el código fuente recibido en explicaciones de estudio y asígnalas a los temas y apartados que mejor correspondan al temario PDF adjunto en esta misma solicitud. Examina el código por partes conceptuales: una condición, un bucle, una función, una clase o un procedimiento relacionado puede ser un bloque distinto. Mantén juntos los fragmentos que se necesitan para entender una misma idea; no separes una condición de su cuerpo ni un bucle de su iteración. No clasifiques por nombre de archivo, orden, extensión o por encontrar una palabra suelta: decide por el comportamiento y el propósito que muestra el código. Un archivo puede aportar contenido a varios temas.

TEMAS Y APARTADOS YA ESTABLECIDOS POR LOS PDF:
${temasExistentes || "(todavía no hay temas; infiere el tema apropiado del código)"}

CONCEPTOS Y APARTADOS QUE SE ACABAN DE GENERAR A PARTIR DE LOS PDF:
${temarioPDF || "(no se han generado apartados desde PDF)"}

INSTRUCCIÓN DEL ESTUDIANTE:
${instruccionEstudiante.trim() || "Explica de forma completa y didáctica cada idea distinta del código que ayude a entender los temas."}

- FORMATO LATEX ESTRICTO:
  - Cada macro LaTeX debe cerrarse correctamente con llaves balanceadas \\subtituloA{...} y \\subtituloB{...}.
  - NUNCA uses \\section, \\subsection de latex estándar; usa SOLO macros de la biblioteca WEC: \\secciongrande, \\seccion, \\subtituloA, \\subtituloB.
  - NUNCA dejes líneas en blanco dentro de \\resumen{...}, \\nota{...}{...}, \\subtituloA{...}, \\subtituloB{...} y dentro de cada ítem de \\lista{...}.
  - Los argumentos de las macros deben estar entre llaves balanceadas: no dejes argumentos desbalanceados.
  - NUNCA escribas la palabra 'titulo' como texto literal en el LaTeX; usa siempre las macros \\subtituloA o \\subtituloB.
  - Los subtítulos, viñetas y cajas heredan el color de su sección principal.

CONTRATO DE FIDELIDAD Y COBERTURA TOTAL (SE COMPRUEBA ANTES DE ACEPTAR LA RESPUESTA):

REGLAS:
- ASIGNACIÓN ESTRICTA A TEMAS DE LOS PDF: Los temas válidos están estrictamente limitados a los temas definidos por los PDF. NO crees temas nuevos bajo ningún concepto ni uses tema_existente: 0. Si un fragmento de código, práctica, ejercicio o documento menciona otro número o tema o una materia no separada en los PDF, NO lo separes en un tema nuevo: clasifícalo y colócalo obligatoriamente dentro del tema existente de los PDF al que corresponda su materia y propósito conceptual. Todos los apartados deben quedar dentro de los temas ya definidos por los PDF.
- Devuelve una entrada por cada bloque de código conceptualmente distinto que merezca apuntes. Si distintos fragmentos del mismo archivo pertenecen a temas diferentes, sepáralos y asigna cada uno por su significado.
- Para cada entrada, usa obligatoriamente en tema_existente el número del tema existente de los PDF al que pertenece el bloque. Indica titulo_tema (el del tema existente), titulo_subtema y un título específico para ese bloque.
- Explica el código en español con ejemplos breves y originales. Conserva los identificadores, las palabras reservadas y la sintaxis originales del lenguaje; cada ejemplo debe ser código válido de ese mismo lenguaje. No mezcles sintaxis de distintos lenguajes de programación, no traduzcas código ni inventes comportamientos.
- Incluye solo los fragmentos mínimos de código fuente necesarios para explicar la idea; no copies el archivo entero. No omitas condiciones, ramas, estado o relaciones necesarias para entenderlos.
- Sigue la referencia visual de WEC y DAW Tema 1: secciones principales con \\secciongrande; cada concepto nuevo avanza al siguiente color de la paleta. Usa \\resumen para la idea central, \\seccion para las secciones temáticas con su barra de color, \\definicion y \\definicionpar para las tarjetas de definiciones, \\lista y \\pasos para viñetas y pasos, \\nota para avisos de examen, y \\cmd{...} para términos o comandos en línea. No dejes todas las ideas bajo un solo encabezado ni fuerces un solo color.
- Si incluyes código, debe ser un bloque real \\begin{codigo}...\\end{codigo}; no lo sustituyas por ecuación, texto o negrita. Escribe exactamente \\begin{codigo} sin corchetes de argumentos (sin [javascript]). Conserva llaves, líneas y sangría del original; no aplanes las instrucciones anidadas. Para terminal usa \\begin{consola}...\\end{consola} sin argumentos.
- ESCAPADO Y MACROS: Escapa siempre \\&, \\%, \\_, \\# y \\$ en texto explicativo. No uses entornos ajenos ni markdown. Usa siempre \\cmd{...} para nombres de variables, etiquetas o funciones en línea.
- Usa tablas comparativas \\tabla con \\tablacab y \\midrule solo cuando una comparación sea más clara en filas y columnas, como en los ejemplos de WEC. Las listas, cajas y subtítulos deben usar las macros coloreadas de la biblioteca y heredar el color de su sección.
- Usa exclusivamente las macros y entornos del catálogo LaTeX. Escribe una sección principal con \\secciongrande por idea diferenciada, \\seccion para las divisiones temáticas y subtítulos adecuados.
- Devuelve únicamente JSON válido con este formato:
{"apartados":[{"tema_existente":1,"titulo_tema":"...","titulo_subtema":"...","titulo":"...","nombre":"...","conceptos":["..."],"latex":"..."}]}

CATÁLOGO DE MACROS LATEX:
${compactarReferenciaBiblioteca(referenciaBiblioteca) || "(no disponible)"}

MATERIAL DE CÓDIGO. Las cabeceras incluyen la ruta del archivo dentro del ZIP o proyecto; úsala como referencia, no como criterio para adivinar el tema:
<<<CODIGO
${material}
CODIGO>>>`;
}
