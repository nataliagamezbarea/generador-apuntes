# Adaptación del generador al sistema WEC

## Qué cambia

- La salida LaTeX usa las macros de `bibliotecas_latex`, no una plantilla alternativa.
- Jerarquía de encabezados:
  - `\secciongrande`: título principal de cada archivo.
  - `\seccion`: bloque de segundo nivel que se registra como subsección en el índice.
  - `\subtituloA`: título de diapositiva o subapartado.
  - `\subtituloB`: detalle subordinado.
- El estilo del tema registra `\secciongrande` y `\seccion` en el índice con `\addcontentsline`, compatible con los enlaces de `hyperref`.
- El índice general se genera con `\tableofcontents` y profundidad 2, como en el WEC de referencia. Los subtítulos A/B permanecen en el desarrollo para no saturar el índice.
- Los bloques de código y consola conservan el entorno WEC; el preámbulo alterna las seis paletas de fondo y resaltado.
- El prompt exige conservar los títulos reales de las diapositivas, en orden, sin convertirlos en viñetas ni sustituirlos por encabezados genéricos.
- La carpeta temporal de subidas se aísla por usuario para evitar errores de permisos entre ejecuciones.

## Biblioteca necesaria

El generador sigue usando la biblioteca externa `bibliotecas_latex` configurada en `RUTA_BIBLIOTECA_LATEX` (o la ruta indicada en `.env`). La lectura de macros para la IA usa el repositorio configurado en `BIBLIOTECA_LATEX_GITHUB`. El ZIP de ejemplo no contiene la carpeta completa de la biblioteca, así que esta adaptación no inventa ni duplica sus fuentes: utiliza las macros originales de la instalación del usuario.

## Comprobaciones

- `npm run comprobar`: correcto.
- `npm run probar`: 68 pruebas superadas, 0 fallidas.
- Pruebas nuevas: conversión de los cuatro niveles de encabezados a macros WEC, conservación de bloques de código, validación de cobertura (introducción, títulos de diapositiva, catalán y extensión) y sustitución de títulos de plantilla.
- No se ha podido ejecutar una generación real con Ollama ni compilar un PDF de salida real en este entorno; para eso se necesita el modelo local y la instalación de `bibliotecas_latex` configurada en el equipo.

- Se evita envolver o redefinir `\\secciongrande`/`\\seccion` después de añadir hooks; el índice queda a cargo de la macro original de WEC y se conserva `hyperref`.
- Se preservan los títulos temáticos de portada y el contenido introductorio anterior al primer apartado numerado.
- La instrucción final de generación obliga a revisar todas las diapositivas, incluso las que no tienen numeración ni viñetas, y a reescribir cada idea fielmente sin omisiones ni invenciones.
- La respuesta de la IA se valida antes de guardarla: si es demasiado breve respecto al material, pierde la introducción, deja títulos de plantilla («Título del apartado»), conserva catalán o reduce el número de encabezados por debajo de las diapositivas detectadas, se repite la generación con una revisión de cobertura explícita.
- El saneador LaTeX elimina preámbulos de documento completo, TikZ no validado, `\item` sueltos, llaves descompensadas, `\cmd` sin cerrar y restos de portada antes de escribir cada archivo.
- La traducción final al español se rechaza si recorta el texto más de un 20 %, pierde macros estructurales o deja llaves descompensadas; en ese caso se conserva la versión original.
