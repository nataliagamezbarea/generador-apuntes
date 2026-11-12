# Corrección del error LaTeX WEC

## Qué se ha corregido

- Si el modelo devuelve un documento completo (`\\documentclass`, preámbulo y `\\begin{document}`), el generador extrae únicamente el cuerpo antes de guardar el fragmento.
- Se elimina el caso defectuoso en el que `\\secciongrande{` envolvía accidentalmente `\\documentclass`.
- Se normalizan `\\definition` y `\\definitionpar` a las macros WEC `\\definicion` y `\\definicionpar`.
- `generador-estilos.tex` ya no redefine `\\secciongrande` ni `\\seccion` con `\\def` después de registrar hooks. La macro WEC original conserva su argumento opcional, su entrada en el índice y la compatibilidad con `hyperref`; solo se mantiene el hook de color.
- Los fragmentos siguen usando los entornos WEC `codigo` y `consola`, definidos por `generador-estilos.tex`.

## Cómo compilar los apuntes WEC

Los archivos dentro de `Tema 1/Tema 1.1/*.tex` son **fragmentos**, no documentos LaTeX independientes. No se debe ejecutar `latexmk` directamente sobre `models-execucion.tex`.

El documento principal del tema es `Tema 1/tema1.tex`. Desde la carpeta `Tema 1`, compila:

```bash
latexmk -xelatex -interaction=nonstopmode -file-line-error tema1.tex
```

Ese documento carga `carga.tex`, la biblioteca `bibliotecas_latex`, `generador-estilos.tex`, el índice y los fragmentos de cada apartado. La ruta de `bibliotecas_latex` debe estar correctamente configurada en `carga.tex` (el generador la configura desde la ruta indicada en sus ajustes).

## Verificación

`npm run comprobar` valida la sintaxis JavaScript. Para ejecutar la batería completa de pruebas, instala primero las dependencias con `npm install` y ejecuta `npm run probar`. La compilación final debe hacerse en el equipo que contiene la biblioteca WEC real.


## Fidelidad del contenido de las diapositivas

- La limpieza del OCR elimina datos administrativos (centro y curso), pero conserva el título del ámbito, el título del tema y la introducción.
- La primera parte incluye el contenido anterior al primer apartado numerado.
- El prompt exige tratar también diapositivas sin numeración o viñetas, conservar cada idea de cada párrafo y comprobar que no se omite ninguna. La reescritura debe mantener el significado sin copiar literalmente ni inventar explicaciones.
