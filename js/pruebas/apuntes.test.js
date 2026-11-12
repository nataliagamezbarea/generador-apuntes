import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "../modulos/configuracion.js";
import {
  aplicarEstilosLatex,
  normalizarResultadoIA,
  listarAsignaturas,
  componenteSeguro,
  guardarGeneracion,
  analizarApuntesExistentes,
  inspeccionarReemplazosGeneracion,
  crearNombreArchivo,
  crearCarpetaAsignatura,
  esTituloDePlantilla,
  sanearTitulosTema,
} from "../modulos/apuntes.js";
import { consultarModeloIA, analizarJson } from "../modulos/modelo.js";
import {
  dividirMaterial,
  dividirCodigoEnBloques,
  dividirMaterialConImagenes,
  procesarEnParalelo,
  crearPromptApuntes,
  crearPromptCodigoPorTemas,
  cargarReferenciaBiblioteca,
  sistemaApuntes,
  sistemaCodigoPorTemas,
  detectarApartadosEnTexto,
  dividirTextoPorApartados,
  extraerTitulosDiapositiva,
  evaluarCoberturaMaterial,
} from "../modulos/instrucciones.js";
import {
  analizarResultadosWeb,
  buscarFuentesOpcionales,
  crearConsultasInvestigacion,
  esUrlWebSegura,
} from "../modulos/investigacion.js";
import { detectarGeneradorIniciado } from "../deteccion-generador.js";
import {
  formatearDuracion,
  formatearProgresoDescarga,
  limpiarSalida,
} from "../formato-salida.js";
import { buscarImagenAbierta } from "../modulos/imagenes.js";
import { combinarArchivos } from "../seleccion-archivos.js";
import { esBibliotecaTerceraParte } from "../modulos/material.js";
import {
  crearTrabajoEtapas,
  listarTrabajosEtapas,
} from "../modulos/trabajos-etapas.js";

function crearZipAlmacenado(nombre, texto) {
  const nombreBytes = Buffer.from(nombre, "utf8");
  const contenido = Buffer.from(texto, "utf8");
  let crc = 0xffffffff;
  for (const byte of contenido) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30 + nombreBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contenido.length, 18);
  local.writeUInt32LE(contenido.length, 22);
  local.writeUInt16LE(nombreBytes.length, 26);
  nombreBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nombreBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(contenido.length, 20);
  central.writeUInt32LE(contenido.length, 24);
  central.writeUInt16LE(nombreBytes.length, 28);
  nombreBytes.copy(central, 46);
  const final = Buffer.alloc(22);
  final.writeUInt32LE(0x06054b50, 0);
  final.writeUInt16LE(1, 8);
  final.writeUInt16LE(1, 10);
  final.writeUInt32LE(central.length, 12);
  final.writeUInt32LE(local.length + contenido.length, 16);
  return Buffer.concat([local, contenido, central, final]);
}

test("añadir archivos conserva la selección y evita duplicados sin mezclar carpetas", () => {
  const primero = {
    name: "tema.pdf",
    size: 10,
    lastModified: 1,
    webkitRelativePath: "proyecto/tema.pdf",
  };
  const duplicado = { ...primero };
  const mismoNombreOtraCarpeta = {
    ...primero,
    webkitRelativePath: "otro/tema.pdf",
  };
  assert.deepEqual(
    combinarArchivos([primero], [duplicado, mismoNombreOtraCarpeta]),
    [primero, mismoNombreOtraCarpeta],
  );
});

test("extrae solo el cuerpo cuando la IA devuelve un documento LaTeX completo envuelto por una macro", () => {
  const resultado = normalizarResultadoIA(
    {
      archivos: [{
        titulo: "Modelos de ejecución",
        latex: String.raw`\secciongrande{\documentclass[12pt]{article}
\usepackage{fontspec}
\begin{document}
\section{Modelos de ejecución}
\definition{Técnica}{Explicación}
\begin{consola}
curl https://ejemplo.test
\end{consola}
\end{document}}`,
      }],
    },
    { subject: "WEC", theme: 1, subtheme: 1 },
  );
  const latex = resultado.archivos[0].latex;
  assert.doesNotMatch(latex, /documentclass|usepackage|begin\{document\}|end\{document\}/);
  assert.match(latex, /\\secciongrande\{Modelos de ejecución\}/);
  assert.match(latex, /\\definicion\{Técnica\}/);
  assert.match(latex, /\\begin\{consola\}/);
});

test("convierte macros inglesas a los nombres oficiales de la biblioteca WEC", () => {
  const latex = aplicarEstilosLatex(String.raw`\definition{Técnica}{Texto}\section{Apartado}`);
  assert.match(latex, /\\definicion\{Técnica\}/);
  // \section es el nivel superior de LaTeX: equivale a \secciongrande
  // (título principal del archivo), no a \seccion.
  assert.match(latex, /\\secciongrande\{Apartado\}/);
  assert.doesNotMatch(latex, /\\definition\b|\\section\b/);
});

test("corrige el comando de sección grande mal escrito por la IA", () => {
  assert.equal(
    aplicarEstilosLatex(String.raw`\sectiongrande{Condicionales}`),
    String.raw`\secciongrande{Condicionales}`,
  );
});

test("convierte tablas LaTeX crudas al estilo de tablas WEC", () => {
  const latex = aplicarEstilosLatex(String.raw`
\begin{table}[h]
\centering
\begin{tabular}{|c|c|}
\hline
\textbf{Concepto} & \textbf{Resultado} \\
\hline
Uno & Dos \\
\hline
\end{tabular}
\caption{Comparación}
\end{table}`);
  assert.match(latex, /\\tabla\[L\{5\.2cm\}L\{5\.2cm\}\]/);
  assert.match(latex, /\\tablacab\{Concepto\} & \\tablacab\{Resultado\}/);
  assert.match(latex, /\\midrule/);
  assert.doesNotMatch(latex, /begin\{tabular\}/);
});

test("solo ofrece reemplazar archivos vinculados a fuentes y salidas del informe JSON", async () => {
  const notesRootAnterior = config.notesRoot;
  const reportsRootAnterior = config.generationReportsRoot;
  const carpeta = await mkdtemp(path.join(os.tmpdir(), "reemplazos-generacion-"));
  config.notesRoot = path.join(carpeta, "apuntes");
  config.generationReportsRoot = path.join(carpeta, "informes");
  const salida = "WEC2/Tema 1/Tema 1.1/if.tex";
  const directorioSalida = path.join(config.notesRoot, path.dirname(salida));
  const rutaInforme = path.join(
    config.generationReportsRoot,
    "WEC2",
    "tema-1-apartado-1",
    "ultima-generacion.json",
  );
  const resultado = {
    archivos: [{ nombre: "if", titulo: "Condicional if", latex: "\\secciongrande{if}" }],
  };
  try {
    await mkdir(directorioSalida, { recursive: true });
    await mkdir(path.dirname(rutaInforme), { recursive: true });
    await writeFile(path.join(directorioSalida, "if.tex"), "apunte anterior", "utf8");

    await writeFile(
      rutaInforme,
      JSON.stringify({
        archivos_procesados_detalle: [{ nombre: "texto-pegado.txt" }],
        archivos_generados: [{ path: salida }],
      }),
    );
    assert.deepEqual(
      await inspeccionarReemplazosGeneracion({
        result: resultado,
        subject: "WEC2",
        theme: 1,
        subtheme: 1,
        fingerprint: "nueva-huella",
        inputFiles: [{ originalname: "otro-archivo.txt" }],
      }),
      [],
    );

    await writeFile(
      rutaInforme,
      JSON.stringify({
        archivos_procesados_detalle: [{ nombre: "texto-pegado.txt" }],
        archivos_generados: [],
      }),
    );
    assert.deepEqual(
      await inspeccionarReemplazosGeneracion({
        result: resultado,
        subject: "WEC2",
        theme: 1,
        subtheme: 1,
        fingerprint: "nueva-huella",
        inputFiles: [{ originalname: "texto-pegado.txt" }],
      }),
      [],
    );

    await writeFile(
      rutaInforme,
      JSON.stringify({
        archivos_procesados_detalle: [{ nombre: "texto-pegado.txt" }],
        archivos_generados: [{ path: salida }],
      }),
    );
    const reemplazos = await inspeccionarReemplazosGeneracion({
      result: resultado,
      subject: "WEC2",
      theme: 1,
      subtheme: 1,
      fingerprint: "nueva-huella",
      inputFiles: [{ originalname: "texto-pegado.txt" }],
    });
    assert.equal(reemplazos.length, 1);
    assert.equal(reemplazos[0].path, salida);
  } finally {
    config.notesRoot = notesRootAnterior;
    config.generationReportsRoot = reportsRootAnterior;
    await rm(carpeta, { recursive: true, force: true });
  }
});

test("filtra dependencias Three.js vendorizadas sin excluir código del proyecto", () => {
  assert.equal(esBibliotecaTerceraParte("demo/lib/three.module.js"), true);
  assert.equal(esBibliotecaTerceraParte("demo/lib/addons/controls/OrbitControls.js"), true);
  assert.equal(esBibliotecaTerceraParte("demo/src/three.module.js"), false);
  assert.equal(esBibliotecaTerceraParte("demo/lib/mi-codigo.js"), false);
});

test("los nombres se limpian y se convierten en nombres de archivo", () => {
  assert.equal(componenteSeguro("  Acceso / Datos "), "Acceso - Datos");
  assert.equal(crearNombreArchivo("Árbol y programación"), "arbol-y-programacion");
  assert.throws(() => componenteSeguro("   "));
});

test("ignora directorios de trabajos sin estado al listar pendientes", async () => {
  const informesAnteriores = config.generationReportsRoot;
  const carpeta = await mkdtemp(path.join(os.tmpdir(), "trabajos-etapas-"));
  config.generationReportsRoot = carpeta;
  const raizTrabajos = path.join(carpeta, ".procesamiento");
  try {
    await mkdir(
      path.join(raizTrabajos, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
      { recursive: true },
    );
    await crearTrabajoEtapas({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      subject: "WEC",
      opciones: {},
      archivos: [],
    });

    const trabajos = await listarTrabajosEtapas("WEC");
    assert.deepEqual(trabajos.map((trabajo) => trabajo.id), [
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ]);
  } finally {
    config.generationReportsRoot = informesAnteriores;
    await rm(carpeta, { recursive: true, force: true });
  }
});

test("solo elimina órdenes LaTeX peligrosas y mantiene macros de apuntes", () => {
  const result = normalizarResultadoIA(
    {
      archivos: [
        {
          titulo: "Conceptos",
          latex: "\\documentclass{article}\\seccion{Base}\\write18{bad}",
        },
      ],
      conceptos_clave: ["Base de datos"],
    },
    { subject: "Datos", theme: 1, subtheme: 1 },
  );
  assert.match(result.archivos[0].latex, /\\seccion\{Base\}/);
  assert.doesNotMatch(result.archivos[0].latex, /documentclass|write18/);
  assert.equal(result.cobertura[0].estado, "pendiente");
});

test("identifica los campos recibidos cuando la IA no devuelve LaTeX", () => {
  assert.throws(
    () =>
      normalizarResultadoIA(
        { resumen: "Idea general", cobertura: [] },
        { subject: "WEC", theme: 1, subtheme: 1 },
      ),
    (error) =>
      error.code === "EMPTY_LATEX_BLOCKS" &&
      /Campos recibidos: resumen, cobertura/.test(error.message),
  );
});

test("elimina TikZ no validado y conserva su descripción para no romper la compilación", () => {
  const latex = normalizarResultadoIA(
    {
      archivos: [
        {
          titulo: "Color",
          latex:
            "\\section{Color}\\begin{figure}\\begin{tikzpicture}\\node {X};\\end{tikzpicture}\\caption{Paleta de ejemplo}\\end{figure}\\seccion{Contraste}",
        },
      ],
    },
    { subject: "Diseño", theme: 1, subtheme: 1 },
  ).archivos[0].latex;
  assert.match(latex, /Paleta de ejemplo/);
  assert.match(latex, /\\seccion\{Contraste\}/);
  assert.doesNotMatch(latex, /tikzpicture|\\begin\{figure\}/);
});

test("convierte los títulos LaTeX estándar a macros de sección de la biblioteca", () => {
  const latex = aplicarEstilosLatex(
    String.raw`\section{Idea central}\subsection{Funcionamiento}\subsubsection{Caso especial}`,
  );
  assert.equal(
    latex,
    String.raw`\secciongrande{Idea central}\seccion{Funcionamiento}\subtituloA{Caso especial}`,
  );
});

test("convierte los subsubsección inventados con sufijo A/B a subtituloA/B", () => {
  const latex = aplicarEstilosLatex(
    "\\subsubsectionA{Técnicas en diseño web}\n\\subsubsectionB{Detalle}",
  );
  assert.equal(
    latex,
    "\\subtituloA{Técnicas en diseño web}\n\\subtituloB{Detalle}",
  );
});

test("elimina preámbulo de documento completo y restos de portada o \\item sueltos", () => {
  const latex = aplicarEstilosLatex(
    String.raw`\secciongrande{\documentclass[12pt]{article}\usepackage[utf8]{inputenc}\title{Prueba}\author{Autor}\begin{document}\maketitle\secciongrande{Tema}\item Primer punto\end{document}}`,
  );
  assert.doesNotMatch(
    latex,
    /documentclass|begin\{document\}|end\{document\}|\\title\b|\\author\b|\\maketitle\b|\\item\b/,
  );
  assert.match(latex, /\\secciongrande\{Tema\}/);
});

test("cierra un \\cmd que la IA dejó abierto antes de una negrita", () => {
  const latex = aplicarEstilosLatex(
    String.raw`- **Entre \cmd{</head>:** Este es el encabezado.`,
  );
  assert.match(latex, /\\cmd\{<\/head>\}:\*\*/);
});

test("adapta las secciones eliminando la asignatura repetida y convirtiendo listas y código al estilo WEC", () => {
  const latex = aplicarEstilosLatex(
    String.raw`\secciongrande{Condicionales en Programación}\seccion{Cómo funcionan en Programación}
\begin{itemize}
\item Primer elemento
\item Segundo elemento
\end{itemize}
` + "```javascript\nconst x = 1;\n```",
    "Programación",
  );
  assert.match(latex, /\\secciongrande\{Condicionales\}/);
  assert.match(latex, /\\seccion\{Cómo funcionan\}/);
  assert.match(latex, /\\lista\{\s*Primer elemento\|\s*Segundo elemento\s*\}/);
  assert.match(latex, /\\begin\{codigo\}\[javascript\]/);
  const resultado = normalizarResultadoIA(
    {
      tema_existente: 3,
      titulo_tema: "Condicionales en Programación",
      titulo_subtema: "Decisiones en Programación",
      archivos: [
        {
          titulo: "Condicionales en Programación",
          latex: String.raw`\secciongrande{Condicionales en Programación}`,
        },
      ],
    },
    { subject: "Programación", theme: 1, subtheme: 1 },
  );
  assert.equal(resultado.tema_existente, 3);
  assert.equal(resultado.titulo_tema, "Condicionales");
  assert.equal(resultado.titulo_subtema, "Decisiones");
  assert.equal(resultado.archivos[0].titulo, "Condicionales");
  assert.match(resultado.archivos[0].latex, /\\secciongrande\{Condicionales\}/);
});

test("detecta y sustituye títulos de plantilla por el título real del apartado", () => {
  assert.equal(esTituloDePlantilla("El título del apartado"), true);
  assert.equal(esTituloDePlantilla("Título del apartado en español"), true);
  assert.equal(esTituloDePlantilla("Los lenguajes del cliente"), false);

  const resultado = normalizarResultadoIA(
    {
      archivos: [
        {
          titulo: "El título del apartado",
          latex:
            "\\secciongrande{Título del apartado en español}\n\n\\resumen{Síntesis del apartado.}\n\nExplicación del contenido con detalle suficiente para conservar la información del material original.",
        },
      ],
    },
    {
      subject: "Desarrollo web",
      theme: 1,
      subtheme: 2,
      themeTitle: "Tema 1",
      subthemeTitle: "Lenguajes de programación del cliente",
    },
  );
  assert.equal(
    resultado.archivos[0].titulo,
    "Lenguajes de programación del cliente",
  );
  assert.match(
    resultado.archivos[0].latex,
    /\\secciongrande\{Lenguajes de programación del cliente\}/,
  );
  assert.doesNotMatch(resultado.archivos[0].latex, /Título del apartado/);
});

test("la validación de cobertura detecta respuestas incompletas o sin la introducción", () => {
  const material = [
    "INTRODUCCIÓ",
    "L'origen i l'abast de la web",
    "• La web es basa en l'hipertext i el consorci W3C manté els estàndards.",
    "",
    "1.2 · LLENGUATGES DE PROGRAMACIÓ EN ENTORN CLIENT",
    "Dos entorns d'execució",
    "• Els llenguatges de client s'executen al navegador i els de servidor al servidor.",
    "",
    "1.2 · LLENGUATGES DE PROGRAMACIÓ EN ENTORN CLIENT",
    "Client i servidor es complementen",
    "• Els dos entorns es complementen per crear un lloc web dinàmic.",
  ].join("\n");

  const incompleto = evaluarCoberturaMaterial(
    {
      archivos: [
        {
          latex:
            "\\secciongrande{El título del apartado}\n\n\\subtituloA{Entornos}",
        },
      ],
    },
    material,
  );
  assert.ok(incompleto.some((problema) => /demasiado breve/i.test(problema)));
  assert.ok(incompleto.some((problema) => /títulos genéricos/i.test(problema)));
  assert.ok(incompleto.some((problema) => /introducción/i.test(problema)));
  assert.ok(incompleto.some((problema) => /títulos de diapositiva/i.test(problema)));

  const textoLargo = "Explicación desarrollada del contenido. ".repeat(20);
  const completo = evaluarCoberturaMaterial(
    {
      archivos: [
        {
          latex: [
            "\\secciongrande{Lenguajes de programación en el cliente}",
            "\\resumen{Los lenguajes de cliente y servidor se complementan.}",
            "\\subtituloA{Introducción: origen y alcance de la web}",
            textoLargo,
            "\\subtituloA{Dos entornos de ejecución}",
            textoLargo,
            "\\subtituloA{Cliente y servidor se complementan}",
            textoLargo,
          ].join("\n"),
        },
      ],
    },
    material,
  );
  assert.deepEqual(completo, []);

  const conCatalan = evaluarCoberturaMaterial(
    {
      archivos: [
        {
          latex: [
            "\\secciongrande{Eines de programació}",
            "\\resumen{Els llenguatges es complementen.}",
            "\\subtituloA{Dos entorns d'execució}",
            textoLargo,
            "\\subtituloA{Client i servidor es complementen}",
            textoLargo,
          ].join("\n"),
        },
      ],
    },
    material,
  );
  assert.ok(conCatalan.some((problema) => /catalán/i.test(problema)));
});

test("el prompt usa el material actual y la organización, sin incorporar apuntes previos", () => {
  const prompt = crearPromptApuntes({
    asignatura: "Programación",
    tema: 2,
    apartado: 1,
    tituloTema: "Estructuras",
    tituloApartado: "Árboles",
    instruccionEstudiante: "",
    material: "x".repeat(100),
    conceptosExistentes: "NO DEBE USARSE COMO CONTENIDO PREVIO",
    temasExistentes: "Tema 1",
    investigacion: "Fuente: https://developer.mozilla.org/es/docs/Web/JavaScript",
    referenciaBiblioteca: "estilo/cajas/nota.tex: \\nota (2 argumentos)",
  });
  assert.doesNotMatch(prompt, /NO DEBE USARSE COMO CONTENIDO PREVIO/);
  assert.match(prompt, /Tema 1/);
  assert.match(prompt, /solo para asignar el número y organizar/);
  assert.match(prompt, /developer\.mozilla\.org/);
  assert.match(prompt, /x{100}/);
  assert.match(prompt, /estilo\/cajas\/nota\.tex/);
  assert.match(prompt, /NÚMERO DE TEMA \(mantener exactamente\): 2/);
  assert.match(prompt, /NÚMERO DE APARTADO \(mantener exactamente\): 2\.1/);
  assert.match(prompt, /Propón títulos concretos a partir del material/);
  assert.match(sistemaApuntes, /No consultes ni uses apuntes anteriores como fuente, contexto, resumen o comprobación de cobertura/);
  assert.match(sistemaApuntes, /no mezcles lenguajes ni inventes fragmentos de código si la fuente no contiene código o no especifica el lenguaje/i);
  assert.match(prompt, /\\lista/);
  assert.match(sistemaApuntes, /hace avanzar la paleta y cambia el color como en WEC/);
  assert.match(sistemaApuntes, /primera sección debe quedar en un color distinto al título del tema/);
  assert.match(sistemaApuntes, /cada una debe empezar con \\secciongrande/);
  assert.match(sistemaApuntes, /No metas todo el apartado bajo una única sección genérica/);
  assert.match(sistemaApuntes, /subtítulos, las viñetas y las cajas heredan el color/);
  assert.match(sistemaApuntes, /cada fragmento necesario como código real en un bloque/);
  assert.match(sistemaApuntes, /Conserva el orden de las líneas, llaves, paréntesis y niveles de indentación del material/);
  assert.match(sistemaApuntes, /nunca lo conviertas en ecuación, texto en línea, negrita ni descripción/);
  assert.match(sistemaApuntes, /Crea tablas solo cuando comparar o sintetizar datos equivalentes/);
  assert.match(sistemaApuntes, /\\tabla, \\tablacab y \\midrule como en los apuntes WEC/);
  assert.match(sistemaApuntes, /Añade viñetas solo cuando agrupen contenido de forma más clara que la prosa/);
  const promptCodigo = crearPromptCodigoPorTemas({
    asignatura: "WEC",
    temasExistentes: "Tema 1",
    temarioPDF: "Condiciones",
    material: "if (activo) {\\n  ejecutar();\\n}",
    instruccionEstudiante: "",
    referenciaBiblioteca: "codigo y tabla",
  });
  assert.match(promptCodigo, /referencia visual de WEC/);
  assert.match(promptCodigo, /bloque real.*codigo/s);
  assert.match(promptCodigo, /\\tabla.*\\tablacab.*\\midrule/s);
  assert.match(sistemaCodigoPorTemas, /avance por la paleta WEC/);
  assert.match(prompt, /EJEMPLO DE LATEX VÁLIDO DE LA BIBLIOTECA/);
  assert.match(prompt, /\\secciongrande\{Concepto principal\}/);
  assert.match(prompt, /\\resumen\{/);
  assert.match(prompt, /\\subtituloA\{/);
  assert.match(prompt, /\\begin\{codigo\}/);
  assert.match(prompt, /cobertura/);
  assert.match(prompt, /todo concepto y detalle relevante debe estar explicado/);
  assert.match(sistemaApuntes, /cobertura/);
  assert.match(sistemaApuntes, /Comprueba cada afirmación/);
  assert.match(sistemaApuntes, /profesor experto en la materia concreta/);
  assert.match(sistemaApuntes, /texto legible detectado dentro de una imagen mediante OCR forma parte del material/);
  assert.match(sistemaApuntes, /explica con redacción original todos sus datos e ideas relevantes/);
  assert.match(sistemaApuntes, /alternativa pertinente con licencia reutilizable/);
  assert.match(sistemaApuntes, /añade la explicación necesaria/);
  assert.match(sistemaApuntes, /no significa reescribir cada oración por separado/);
  assert.match(sistemaApuntes, /al menos un apartado útil.*LaTeX desarrollado/s);
  assert.match(sistemaApuntes, /Está prohibido saltarse una frase o un párrafo/);
  assert.match(sistemaApuntes, /ningún párrafo puede quedar sin tratar/);
  assert.match(sistemaApuntes, /\\definicion\{Término\}\{Definición\}/);
  assert.match(sistemaApuntes, /\\definicionpar\{Término\}\{Definición\}/);
  assert.match(prompt, /\\definicion\{Término\}\{Definición/);
  assert.match(sistemaApuntes, /no eludir derechos ni afirmar que el resultado queda libre de derechos/);
  assert.match(sistemaApuntes, /LaTeX CON DISEÑO.*No escribas preámbulo/s);
  assert.match(sistemaApuntes, /Si el número es 0, infiere la organización desde el material/);
  assert.match(sistemaApuntes, /devuelve su número en "tema_existente"/);

  const promptAutomatico = crearPromptApuntes({
    asignatura: "Programación",
    tema: 0,
    apartado: 0,
    tituloTema: "",
    tituloApartado: "",
    instruccionEstudiante: "",
    material: "Material de prueba",
    conceptosExistentes: "",
    temasExistentes: "- Tema 1: Fundamentos",
    investigacion: "",
    referenciaBiblioteca: "",
  });
  assert.match(promptAutomatico, /NÚMERO DE TEMA: detectar según el material/);
  assert.match(promptAutomatico, /NÚMERO DE APARTADO: automático/);
  assert.match(promptAutomatico, /tema_existente/);
});

test("carga la documentación y los comandos de todos los fuentes TeX", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biblioteca-latex-"));
  try {
    await mkdir(path.join(directory, "estilo", "cajas"), { recursive: true });
    await writeFile(
      path.join(directory, "estilo", "cajas", "nota.tex"),
      "% Uso: \\nota{Título}{Texto}\n\\newcommand{\\nota}[2]{#1#2}\n",
    );
    await writeFile(
      path.join(directory, "estilo", "paleta.tex"),
      "\\newcommand{\\paletaAzul}{...}\n\\def\\colorTema{blue}\n",
    );

    const referencia = await cargarReferenciaBiblioteca(directory);
    assert.match(referencia, /Se han leído 2 archivos fuente/);
    assert.match(referencia, /estilo\/cajas\/nota\.tex/);
    assert.match(referencia, /Uso: \\nota\{Título\}\{Texto\}/);
    assert.match(referencia, /\\nota \(2 argumentos\)/);
    assert.match(referencia, /estilo\/paleta\.tex/);
    assert.match(referencia, /\\paletaAzul/);
    assert.match(referencia, /\\colorTema/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lee directamente de GitHub solo las fuentes TeX de la biblioteca", async () => {
  const solicitudes = [];
  const solicitar = async (url, opciones) => {
    solicitudes.push({ url, opciones });
    if (url.includes("/git/trees/")) {
      return {
        ok: true,
        json: async () => ({
          sha: "commit-de-prueba",
          tree: [
            { type: "blob", path: "bibliotecas_latex/estilo.tex" },
            { type: "blob", path: "bibliotecas_latex/estilo/cajas.tex" },
            { type: "blob", path: "bibliotecas_latex/fonts/fuente.otf" },
            { type: "blob", path: "otro/ajeno.tex" },
          ],
        }),
      };
    }
    return {
      ok: true,
      text: async () =>
        url.endsWith("/estilo.tex")
          ? "% Estilo\n\\newcommand{\\estilo}{...}"
          : "\\newcommand{\\caja}[1]{#1}",
    };
  };

  const referencia = await cargarReferenciaBiblioteca(
    "https://github.com/prueba/apuntes-latex",
    solicitar,
  );
  assert.equal(solicitudes.length, 3);
  assert.match(solicitudes[0].url, /api\.github\.com\/repos\/prueba\/apuntes-latex/);
  assert.ok(solicitudes.every(({ opciones }) => opciones.signal));
  assert.match(referencia, /Se han leído 2 archivos fuente/);
  assert.match(referencia, /estilo\/cajas\.tex/);
  assert.match(referencia, /\\caja \(1 argumentos\)/);
  assert.doesNotMatch(referencia, /fuente\.otf|ajeno\.tex/);
});

test("informa los errores de GitHub en vez de continuar con un catálogo vacío", async () => {
  await assert.rejects(
    cargarReferenciaBiblioteca("https://github.com/prueba/repositorio", async () => ({
      ok: false,
      status: 503,
    })),
    /503/,
  );
});

test("usa el ZIP de GitHub sin clonar cuando la API está limitada", async () => {
  const solicitudes = [];
  const zip = crearZipAlmacenado(
    "apuntes-latex-main/bibliotecas_latex/estilo.tex",
    "\\newcommand{\\estilo}{...}",
  );
  const referencia = await cargarReferenciaBiblioteca(
    "https://github.com/prueba/apuntes-latex",
    async (url) => {
      solicitudes.push(url);
      if (url.includes("api.github.com"))
        return new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
        });
      return new Response(zip, { status: 200 });
    },
  );
  assert.equal(solicitudes.length, 2);
  assert.match(solicitudes[1], /codeload\.github\.com\/prueba\/apuntes-latex/);
  assert.match(referencia, /Se han leído 1 archivos fuente/);
  assert.match(referencia, /estilo\.tex/);
  assert.match(referencia, /\\estilo/);
});

test("divide el material extenso en partes contiguas sin omitir texto", () => {
  const material = `INICIO${" concepto".repeat(5000)} FIN`;
  const partes = dividirMaterial(material);
  assert.equal(partes.length, 8);
  assert.ok(partes.every((parte) => parte.length <= 6000));
  assert.equal(partes.join(""), material);
});

test("divide código en límites de línea y conserva funciones con sus llaves", () => {
  const codigo = [
    "function condicional() {",
    "  if (activo) {",
    "    ejecutar();",
    "  }",
    "}",
    "",
    "function repetir() {",
    "  for (const item of items) {",
    "    procesar(item);",
    "  }",
    "}",
  ].join("\n");
  const partes = dividirCodigoEnBloques(codigo, 55);
  assert.equal(partes.join("\n\n"), codigo);
  assert.ok(partes.every((parte) => !parte.includes("function condicional") || parte.includes("ejecutar();")));
  assert.ok(partes.every((parte) => !parte.includes("function repetir") || parte.includes("procesar(item);")));
});

test("mantiene cada archivo JSON completo al preparar código", () => {
  const codigo = `${"  \"clave\": 1,\n".repeat(2000)}`;
  const partes = dividirCodigoEnBloques(codigo, 80, true);
  assert.equal(partes.length, 1);
  assert.equal(partes[0], codigo.trim());
});

test("no corta funciones Python por la indentación al alcanzar el límite", () => {
  const codigo = [
    "def procesar_elementos(elementos):",
    "    if elementos:",
    ...Array.from({ length: 12 }, (_, indice) => `        paso_${indice}()`),
    "    return elementos",
    "",
    "def otra_funcion():",
    "    return True",
  ].join("\n");
  const partes = dividirCodigoEnBloques(codigo, 80);
  assert.equal(partes.length, 2);
  assert.match(partes[0], /def procesar_elementos/);
  assert.match(partes[0], /return elementos/);
  assert.match(partes[1], /def otra_funcion/);
});

test("agrupa imágenes reales en bloques y conserva todo el texto", () => {
  const material = "concepto ".repeat(6000);
  const imagenes = Array.from({ length: 51 }, (_, indice) => ({
    data: `imagen-${indice}`,
  }));
  const bloques = dividirMaterialConImagenes(material, imagenes);
  assert.ok(bloques.length >= Math.ceil(imagenes.length / 4));
  assert.ok(bloques.length <= 15);
  assert.ok(bloques.every((bloque) => bloque.imagenes.length <= 4));
  assert.equal(
    bloques.map((bloque) => bloque.texto).join(""),
    material,
  );
  assert.deepEqual(
    bloques.flatMap((bloque) => bloque.imagenes),
    imagenes,
  );
});

test("conserva las imágenes aunque el PDF no tenga texto extraíble", () => {
  const imagenes = Array.from({ length: 5 }, (_, indice) => ({
    data: `imagen-${indice}`,
  }));
  const bloques = dividirMaterialConImagenes("", imagenes);

  assert.deepEqual(bloques.map((bloque) => bloque.texto), ["", ""]);
  assert.deepEqual(
    bloques.flatMap((bloque) => bloque.imagenes),
    imagenes,
  );
});

test("procesa hasta 50 partes simultáneas y conserva su orden", async () => {
  let activas = 0;
  let maximoActivas = 0;
  const entradas = Array.from({ length: 60 }, (_, indice) => `parte ${indice}`);
  const resultados = await procesarEnParalelo(
    entradas,
    50,
    async (elemento, indice) => {
      activas += 1;
      maximoActivas = Math.max(maximoActivas, activas);
      await new Promise((resolver) => setTimeout(resolver, 5));
      activas -= 1;
      return `${indice}:${elemento}`;
    },
  );
  assert.equal(maximoActivas, 50);
  assert.deepEqual(
    resultados,
    entradas.map((elemento, indice) => `${indice}:${elemento}`),
  );
});

test("limita la concurrencia configurada a 50 llamadas", () => {
  const salida = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const { config } = await import("./js/modulos/configuracion.js"); process.stdout.write(String(config.parallelRequests));',
    ],
    {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      env: { ...process.env, CONCURRENCIA_IA: "75" },
      encoding: "utf8",
    },
  );
  assert.equal(salida, "50");
});

test("permite salida ilimitada de Ollama y límites explícitos", () => {
  const ejecutar = (valor) =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { config } = await import("./js/modulos/configuracion.js"); process.stdout.write(String(config.maxTokens));',
      ],
      {
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
        env: {
          ...process.env,
          ...(valor === undefined ? { TOKENS_MAX_IA: "" } : { TOKENS_MAX_IA: valor }),
        },
        encoding: "utf8",
      },
    );
  assert.equal(ejecutar("-1"), "-1");
  assert.equal(ejecutar("4096"), "4096");
  assert.equal(ejecutar(undefined), "-1");
});

test("la respuesta de la IA admite JSON rodeado de bloque markdown", () => {
  assert.deepEqual(analizarJson('```json\n{"ok":true}\n```'), { ok: true });
});

test("marca para reintento una respuesta que no contiene JSON válido", () => {
  assert.throws(
    () => analizarJson("No puedo devolver ese formato."),
    (error) =>
      error.code === "INVALID_JSON" &&
      /La IA no devolvió JSON válido/.test(error.message),
  );
});

test("marca para reintento una respuesta JSON que no es un objeto", () => {
  assert.throws(
    () =>
      normalizarResultadoIA([], {
        subject: "WEC",
        theme: 1,
        subtheme: 1,
      }),
    (error) =>
      error.code === "INVALID_JSON_OBJECT" &&
      error.message === "La IA no devolvió un objeto JSON.",
  );
});

test("continúa la respuesta si Ollama la interrumpe antes de completar el JSON", async () => {
  const fetchAnterior = globalThis.fetch;
  const limiteAnterior = config.maxTokens;
  const solicitudes = [];
  config.maxTokens = -1;
  globalThis.fetch = async (_url, opciones) => {
    const cuerpo = JSON.parse(opciones.body);
    solicitudes.push(cuerpo);
    const respuesta = solicitudes.length === 1
      ? { message: { content: '{"ok":' }, done_reason: "length" }
      : { message: { content: "true}" }, done_reason: "stop" };
    return new Response(JSON.stringify(respuesta), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    assert.deepEqual(await consultarModeloIA("sistema", "solicitud"), {
      ok: true,
    });
    assert.equal(solicitudes.length, 2);
    assert.equal(solicitudes[0].options.num_predict, -1);
    assert.equal(solicitudes[0].format, "json");
    assert.equal(solicitudes[1].format, undefined);
    assert.ok(
      solicitudes[1].messages.some(
        (mensaje) =>
          mensaje.role === "assistant" && mensaje.content === '{"ok":',
      ),
    );
    assert.match(
      solicitudes[1].messages.at(-1).content,
      /Continúa exactamente desde el último carácter/,
    );
  } finally {
    globalThis.fetch = fetchAnterior;
    config.maxTokens = limiteAnterior;
  }
});

test("explica cuando Ollama trunca una respuesta JSON", () => {
  assert.throws(
    () => analizarJson('{"archivos":[{"latex":"texto incompleto', "length"),
    /truncó al alcanzar el límite de salida de Ollama/,
  );
  assert.throws(
    () => analizarJson("respuesta inválida"),
    /La respuesta contenía .* bytes y terminó con: respuesta inválida/,
  );
});

test("la salida de descarga limpia controles de terminal y presenta el progreso", () => {
  const salida =
    ":   9% ▕█                 ▏ 511 MB/6.0 GB   11 MB/s   7m43s\u001b[K\u001b[?25h\u001b[?2026l";
  const lineas = limpiarSalida(salida);
  assert.equal(
    formatearProgresoDescarga(lineas[0]),
    "Descarga del modelo: 9 % · 511 MB de 6.0 GB · 11 MB/s · restan 7m43s",
  );
  assert.equal(
    limpiarSalida("\u001b[1GDescargando\u001b[K\rNuevo estado").join(" "),
    "Descargando Nuevo estado",
  );
});

test("formatea el tiempo estimado en horas, minutos y segundos", () => {
  assert.equal(formatearDuracion(8), "8 s");
  assert.equal(formatearDuracion(125), "2 min 5 s");
  assert.equal(formatearDuracion(3661), "1 h 1 min 1 s");
});

test("busca y descarga imágenes de Commons solo con licencia reutilizable", async () => {
  const fetchAnterior = globalThis.fetch;
  const solicitudes = [];
  globalThis.fetch = async (entrada) => {
    const url = new URL(entrada);
    solicitudes.push(url);
    if (url.hostname === "commons.wikimedia.org")
      return new Response(
        JSON.stringify({
          query: {
            pages: [{
              title: "File:Diagrama de prueba.png",
              imageinfo: [{
                thumburl: "https://upload.wikimedia.org/imagen.png",
                extmetadata: {
                  LicenseShortName: { value: "CC BY-SA 4.0" },
                  LicenseUrl: {
                    value: "https://creativecommons.org/licenses/by-sa/4.0/",
                  },
                  Artist: { value: "<a>Autora de prueba</a>" },
                  ImageDescription: { value: "Ilustración educativa" },
                },
              }],
            }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    return {
      ok: true,
      url: url.href,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Buffer.from("imagen"),
    };
  };
  try {
    const imagen = await buscarImagenAbierta("concepto educativo");
    assert.equal(imagen.licencia, "CC BY-SA 4.0");
    assert.equal(imagen.autor, "Autora de prueba");
    assert.equal(imagen.extension, "png");
    assert.equal(imagen.data.toString(), "imagen");
    assert.equal(solicitudes.length, 2);
  } finally {
    globalThis.fetch = fetchAnterior;
  }
});

test("omite resultados de imagen sin licencia abierta", async () => {
  const fetchAnterior = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        query: {
          pages: [{
            title: "File:Imagen restringida.jpg",
            imageinfo: [{
              thumburl: "https://upload.wikimedia.org/restringida.jpg",
              extmetadata: {
                LicenseShortName: { value: "CC BY-NC 4.0" },
                LicenseUrl: {
                  value: "https://creativecommons.org/licenses/by-nc/4.0/",
                },
              },
            }],
          }],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  try {
    assert.equal(await buscarImagenAbierta("foto restringida"), null);
  } finally {
    globalThis.fetch = fetchAnterior;
  }
});

test("detecta el generador ya abierto aunque Ollama siga descargando el modelo", async () => {
  const consultar = async () =>
    new Response(
      JSON.stringify({
        provider: "ollama local",
        model: "qwen2.5vl:7b",
        modelAvailable: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  assert.equal(
    await detectarGeneradorIniciado(
      "http://127.0.0.1:8001",
      "qwen2.5vl:7b",
      consultar,
    ),
    true,
  );
  assert.equal(
    await detectarGeneradorIniciado(
      "http://127.0.0.1:8001",
      "otro-modelo",
      consultar,
    ),
    false,
  );
});

test("las páginas ilustradas se envían a Ollama como imágenes locales", async () => {
  const fetchOriginal = globalThis.fetch;
  let solicitud;
  globalThis.fetch = async (_url, opciones) => {
    solicitud = JSON.parse(opciones.body);
    return new Response(
      JSON.stringify({ message: { content: '{"ok":true}' } }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  try {
    assert.deepEqual(
      await consultarModeloIA("sistema", "analiza el diagrama", [{ data: "aW1hZ2Vu" }]),
      { ok: true },
    );
    assert.equal(solicitud.messages[1].images[0], "aW1hZ2Vu");
    assert.equal(solicitud.options.num_ctx, config.contextSize);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("explica cuando la solicitud supera el contexto disponible del modelo", async () => {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error:
          "request (43403 tokens) exceeds the available context size (4096 tokens), try increasing it",
      }),
      { status: 400 },
    );
  try {
    await assert.rejects(
      consultarModeloIA("sistema", "material extenso"),
      /solicitó 43403 tokens y su contexto disponible es 4096/s,
    );
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("los resultados web aceptan fuentes HTTPS de distintos sitios", () => {
  assert.equal(
    esUrlWebSegura("https://developer.mozilla.org/es/docs/Web/JavaScript"),
    true,
  );
  assert.equal(esUrlWebSegura("http://example.com/"), false);
  assert.equal(esUrlWebSegura("javascript:alert(1)"), false);
  assert.equal(esUrlWebSegura("https://es.wikipedia.org/wiki/JavaScript"), false);
  assert.deepEqual(
    analizarResultadosWeb(
      `<rss><channel>
        <item><title>Objetos &amp; JSON</title>
          <link>https://developer.mozilla.org/es/docs/Web/JavaScript</link>
          <description>Un &lt;ejemplo&gt; práctico.</description>
        </item>
        <item><title>Enlace inseguro</title>
          <link>http://example.com/</link>
          <description>No se debe aceptar.</description>
        </item>
        <item><title>Wikipedia</title>
          <link>https://es.wikipedia.org/wiki/JavaScript</link>
          <description>Se excluye para buscar otras webs.</description>
        </item>
      </channel></rss>`,
      3,
    ),
    [
      {
        titulo: "Objetos & JSON",
        url: "https://developer.mozilla.org/es/docs/Web/JavaScript",
        resumen: "Un <ejemplo> práctico.",
      },
    ],
  );
});

test("una búsqueda web fallida avisa y permite continuar sin fuentes", async () => {
  const avisos = [];
  const fuentes = await buscarFuentesOpcionales(
    ["objetos JSON"],
    avisos,
    async () => {
      throw new Error("buscador no disponible.");
    },
  );
  assert.deepEqual(fuentes, []);
  assert.equal(avisos.length, 2);
  assert.match(avisos.join(" "), /se continúa con el material local/);
});

test("una consulta web sin resultados no invalida las otras fuentes", async () => {
  const avisos = [];
  const fuente = {
    titulo: "JSON",
    url: "https://developer.mozilla.org/es/docs/Web/JavaScript/Reference/Global_Objects/JSON",
    resumen: "Descripción",
  };
  const fuentes = await buscarFuentesOpcionales(
    ["objetos", "JSON"],
    avisos,
    async (consulta) => (consulta === "objetos" ? [] : [fuente]),
  );
  assert.deepEqual(fuentes, [fuente]);
  assert.deepEqual(avisos, []);
});

test("la investigación web deduce consultas de todos los archivos del material", () => {
  const consultas = crearConsultasInvestigacion({
    asignatura: "Programación",
    tituloTema: "Estructuras de datos",
    tituloApartado: "Árboles binarios",
    material: {
      documents: [
        {
          text: "Los árboles binarios permiten organizar datos. La búsqueda binaria recorre cada nodo.",
        },
        {
          text: "Los nodos conectan ramas y permiten recorrer el árbol de forma ordenada.",
        },
      ],
    },
  });
  assert.equal(consultas.length, 2);
  assert.match(consultas[0], /Estructuras de datos/);
  assert.match(consultas.join(" "), /arboles/);
  assert.match(consultas.join(" "), /nodos/);
});

test("la última generación y cobertura quedan guardadas y se pueden reutilizar", async () => {
  const anterior = config.notesRoot;
  const informesAnteriores = config.generationReportsRoot;
  const bibliotecaAnterior = config.latexLibrary;
  const carpeta = await mkdtemp(path.join(os.tmpdir(), "prueba-apuntes-"));
  config.notesRoot = path.join(carpeta, "apuntes");
  config.generationReportsRoot = path.join(carpeta, "informes-generacion");
  config.latexLibrary = path.join(carpeta, "bibliotecas_latex");
  try {
    const material = {
      documents: [{ name: "tema.txt", text: "Idea" }],
      imagesOcr: 0,
      visuals: [],
      warnings: [],
    };
    const resultado = normalizarResultadoIA(
      {
        titulo_tema: "Fundamentos",
        archivos: [
          {
            titulo: "Idea básica",
            nombre: "1.1-idea",
            latex: "\\secciongrande{Idea}",
            conceptos: ["Idea"],
          },
        ],
        conceptos_clave: ["Idea"],
        cobertura: [
          { concepto: "Idea", estado: "incluido", apartado: "Idea básica" },
        ],
      },
      { subject: "Programación", theme: 1, subtheme: 1 },
    );
    const guardado = await guardarGeneracion({
      result: resultado,
      fingerprint: "huella-de-prueba",
      subject: "Programación",
      theme: 1,
      subtheme: 1,
      inputFiles: [{
        originalname: "tema.txt",
        size: 4,
        buffer: Buffer.from("Idea"),
      }],
      material,
      existingCount: 0,
    });

    const directorio = path.join(
      config.notesRoot,
      "Programación",
      "Tema 1",
      "Tema 1.1",
    );
    const informes = path.join(
      config.generationReportsRoot,
      "Programación",
      "tema-1-apartado-1",
    );
    const cobertura = JSON.parse(
      await readFile(path.join(informes, "cobertura.json"), "utf8"),
    );
    const ultima = JSON.parse(
      await readFile(path.join(informes, "ultima-generacion.json"), "utf8"),
    );
    await assert.rejects(
      readFile(path.join(directorio, "ultima-generacion.json"), "utf8"),
      { code: "ENOENT" },
    );
    assert.equal(cobertura.fingerprint, "huella-de-prueba");
    assert.equal(ultima.cobertura[0].estado, "incluido");
    assert.equal(ultima.titulo_tema, "Fundamentos");
    assert.equal(guardado.report.archivos_generados.length, 1);
    const cargaAsignatura = path.join(
      config.notesRoot,
      "Programación",
      "carga.tex",
    );
    const cargaTema = path.join(config.notesRoot, "Programación", "Tema 1", "carga.tex");
    assert.match(await readFile(cargaAsignatura, "utf8"), /apuntesrutalib\{\.\.\/\.\.\/bibliotecas_latex\}/);
    assert.match(await readFile(cargaTema, "utf8"), /apuntesrutalib\{\.\.\/\.\.\/\.\.\/bibliotecas_latex\}/);
    await writeFile(
      cargaTema,
      (await readFile(cargaTema, "utf8")).replace(
        /\.\.\/\.\.\/\.\.\/bibliotecas_latex/,
        "/data/bibliotecas_latex",
      ),
    );
    const rutaDocumentoTema = path.join(
      config.notesRoot,
      "Programación",
      "Tema 1",
      "tema1.tex",
    );
    await writeFile(
      rutaDocumentoTema,
      [
        "\\documentclass{article}",
        "\\input{carga.tex}",
        "\\input{generador-estilos.tex}",
        "\\inputcarpeta{Tema 1.1}",
        "\\begin{document}",
        "\\titulo{Programación}{Fundamentos}",
        "\\tableofcontents",
        "\\clearpage",
        "\\end{document}",
        "",
      ].join("\n"),
    );
    await guardarGeneracion({
      result: resultado,
      fingerprint: "huella-de-prueba",
      subject: "Programación",
      theme: 1,
      subtheme: 1,
      inputFiles: [{
        originalname: "tema.txt",
        size: 4,
        buffer: Buffer.from("Idea"),
      }],
      material,
      existingCount: 0,
    });
    assert.match(
      await readFile(cargaTema, "utf8"),
      /apuntesrutalib\{\.\.\/\.\.\/\.\.\/bibliotecas_latex\}/,
    );
    const temaDocumento = await readFile(rutaDocumentoTema, "utf8");
    assert.match(temaDocumento, /\\input\{generador-estilos\.tex\}/);
    assert.match(temaDocumento, /\{\\color\{black\}\\tableofcontents\}/);
    assert.doesNotMatch(temaDocumento, /\\inputcarpeta\{Tema 1\.1\}[\s\S]*\\begin\{document\}/);
    assert.match(
      temaDocumento,
      /\\clearpage[\s\S]*\\inputcarpeta\{Tema 1\.1\}[\s\S]*\\end\{document\}/,
    );
    assert.equal(
      (temaDocumento.match(/\\inputcarpeta\{Tema 1\.1\}/g) ?? []).length,
      1,
    );
    const estilos = await readFile(
      path.join(config.notesRoot, "Programación", "Tema 1", "generador-estilos.tex"),
      "utf8",
    );
    assert.match(estilos, /newtcblisting\{codigo\}\[1\]\[Java\]/);
    assert.match(estilos, /newtcblisting\{consola\}/);
    assert.match(estilos, /colback=codeBackground/);
    assert.match(estilos, /language=#1/);
    assert.match(estilos, /tabsize=4/);
    assert.match(estilos, /keywordstyle=/);
    assert.match(estilos, /AddToHook.*secciongrande/);
    assert.doesNotMatch(estilos, /AddToHook\{cmd\/subtitulo/);
    assert.match(estilos, /\\coloractual!7!white/);
    assert.match(estilos, /\\coloractual!80!black/);
    assert.match(estilos, /iniciarPaletaSecciones/);
    assert.match(estilos, /lstdefinelanguage\{JavaScript\}/);
    assert.doesNotMatch(estilos, /codePaletteIndex|codeBackgroundA/);
    const lista = await analizarApuntesExistentes("Programación");
    assert.equal(lista.files, 1);
  } finally {
    config.notesRoot = anterior;
    config.generationReportsRoot = informesAnteriores;
    config.latexLibrary = bibliotecaAnterior;
    await rm(carpeta, { recursive: true, force: true });
  }
});

test("guarda una foto de licencia abierta con su atribución visible", async () => {
  const anterior = config.notesRoot;
  const informesAnteriores = config.generationReportsRoot;
  const bibliotecaAnterior = config.latexLibrary;
  const fetchAnterior = globalThis.fetch;
  const carpeta = await mkdtemp(path.join(os.tmpdir(), "imagen-apuntes-"));
  config.notesRoot = path.join(carpeta, "apuntes");
  config.generationReportsRoot = path.join(carpeta, "informes");
  config.latexLibrary = path.join(carpeta, "bibliotecas");
  globalThis.fetch = async (entrada) => {
    const url = new URL(entrada);
    if (url.hostname === "commons.wikimedia.org")
      return new Response(
        JSON.stringify({
          query: {
            pages: [{
              title: "File:Foto de prueba.png",
              imageinfo: [{
                thumburl: "https://upload.wikimedia.org/commons/foto.png",
                extmetadata: {
                  LicenseShortName: { value: "CC BY 4.0" },
                  LicenseUrl: {
                    value: "https://creativecommons.org/licenses/by/4.0/",
                  },
                  Artist: { value: "Autora" },
                  ImageDescription: { value: "Foto relevante" },
                },
              }],
            }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    return {
      ok: true,
      url: url.href,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Buffer.from("foto"),
    };
  };
  try {
    const result = normalizarResultadoIA(
      {
        archivos: [{
          titulo: "Concepto básico",
          nombre: "concepto-basico",
          latex: "\\secciongrande{Concepto básico}\nExplicación propia.",
          conceptos: ["Concepto"],
        }],
        imagenes: [{
          apartado: "Concepto básico",
          consulta: "concepto básico educativo",
          descripcion: "Representación del concepto",
        }],
      },
      { subject: "Programación", theme: 1, subtheme: 1 },
    );
    const guardado = await guardarGeneracion({
      result,
      fingerprint: "imagen-con-licencia",
      subject: "Programación",
      theme: 1,
      subtheme: 1,
      inputFiles: [{
        originalname: "tema.txt",
        size: 4,
        buffer: Buffer.from("Idea"),
      }],
      material: {
        documents: [{ name: "tema.txt", text: "Idea" }],
        imagesOcr: 0,
        visuals: [],
        warnings: [],
      },
      existingCount: 0,
    });

    const nota = await readFile(guardado.salida.written[0].archivo, "utf8");
    const nombreImagen = guardado.report.imagenes[0].archivo;
    const directorio = path.dirname(guardado.salida.written[0].archivo);
    assert.match(nota, /\\includegraphics/);
    assert.match(nota, /Autora/);
    assert.match(nota, /CC BY 4\.0/);
    assert.equal(
      (await readFile(path.join(directorio, nombreImagen))).toString(),
      "foto",
    );
    assert.match(guardado.report.imagenes[0].fuente_url, /commons\.wikimedia\.org/);
  } finally {
    globalThis.fetch = fetchAnterior;
    config.notesRoot = anterior;
    config.generationReportsRoot = informesAnteriores;
    config.latexLibrary = bibliotecaAnterior;
    await rm(carpeta, { recursive: true, force: true });
  }
});

test("reintentar el guardado reutiliza el archivo con la misma huella sin duplicarlo", async () => {
  const anterior = config.notesRoot;
  const informesAnteriores = config.generationReportsRoot;
  const bibliotecaAnterior = config.latexLibrary;
  const carpeta = await mkdtemp(path.join(os.tmpdir(), "reintento-apuntes-"));
  config.notesRoot = path.join(carpeta, "apuntes");
  config.generationReportsRoot = path.join(carpeta, "informes");
  config.latexLibrary = path.join(carpeta, "bibliotecas");
  try {
    const directorio = path.join(
      config.notesRoot,
      "Programación",
      "Tema 1",
      "Tema 1.1",
    );
    await mkdir(directorio, { recursive: true });
    const archivoExistente = path.join(directorio, "1-1-idea.tex");
    await writeFile(archivoExistente, "Apunte existente.");
    const result = normalizarResultadoIA(
      {
        archivos: [
          {
            titulo: "Idea",
            nombre: "1.1-idea",
            conceptos: ["Idea"],
            latex: "\\secciongrande{Idea}\nExplicación.",
          },
        ],
      },
      { subject: "Programación", theme: 1, subtheme: 1 },
    );
    const options = {
      result,
      fingerprint: "huella-reintentable",
      subject: "Programación",
      theme: 1,
      subtheme: 1,
      inputFiles: [{
        originalname: "tema.txt",
        size: 4,
        buffer: Buffer.from("Idea"),
      }],
      material: {
        documents: [{ name: "tema.txt", text: "Idea" }],
        warnings: [],
        imagesOcr: 0,
        visuals: [],
      },
      existingCount: 0,
    };
    const primero = await guardarGeneracion(options);
    const reintento = await guardarGeneracion(options);
    assert.equal(
      reintento.report.archivos_generados[0].path,
      primero.report.archivos_generados[0].path,
    );
    const apunteGenerado = await readFile(
      path.join(config.notesRoot, primero.report.archivos_generados[0].path),
      "utf8",
    );
    assert.doesNotMatch(
      apunteGenerado,
      /Generado por el Generador|Generador fingerprint|% Asignatura:|Contenido original creado/,
    );
    assert.equal(await readFile(archivoExistente, "utf8"), "Apunte existente.");
    assert.equal(
      (await readdir(directorio)).filter((nombre) =>
        nombre.startsWith("1-1-idea"),
      ).length,
      2,
    );
  } finally {
    config.notesRoot = anterior;
    config.generationReportsRoot = informesAnteriores;
    config.latexLibrary = bibliotecaAnterior;
    await rm(carpeta, { recursive: true, force: true });
  }
});

test("las listas recuperan los nombres de temas y apartados desde LaTeX existente", async () => {
  const carpetaAnterior = config.notesRoot;
  const carpetaTemporal = await mkdtemp(
    path.join(os.tmpdir(), "lista-apuntes-"),
  );
  config.notesRoot = carpetaTemporal;
  try {
    const tema = path.join(carpetaTemporal, "Programación", "Tema 4");
    const apartado = path.join(tema, "Tema 4.2");
    const apartadoAntiguo = path.join(tema, "Tema4.3");
    await mkdir(apartado, { recursive: true });
    await mkdir(apartadoAntiguo, { recursive: true });
    await writeFile(
      path.join(tema, "tema4.tex"),
      "\\secciongrande{Estructuras de datos}\n",
    );
    await writeFile(
      path.join(apartado, "4.2-arboles.tex"),
      "\\secciongrande{Árboles binarios}\n",
    );
    await writeFile(
      path.join(apartadoAntiguo, "4.3-grafos.tex"),
      "\\secciongrande{Grafos}\n",
    );
    await writeFile(
      path.join(apartadoAntiguo, "4.5-colas.tex"),
      "\\secciongrande{Colas}\n",
    );
    await writeFile(
      path.join(tema, "4.4-tablas-hash.tex"),
      "\\secciongrande{Tablas hash}\n",
    );
    await writeFile(
      path.join(tema, "4.4-dispersion.tex"),
      "\\secciongrande{Funciones de dispersión}\n",
    );
    const asignaturas = await listarAsignaturas();
    assert.deepEqual(asignaturas[0].temas[0], {
      numero: 4,
      nombre: "Tema 4",
      titulo: "Estructuras de datos",
      apartados: [
        { numero: 2, nombre: "Árboles binarios" },
        { numero: 3, nombre: "Grafos" },
        { numero: 4, nombre: "Funciones de dispersión · Tablas hash" },
        { numero: 5, nombre: "Colas" },
      ],
    });
  } finally {
    config.notesRoot = carpetaAnterior;
    await rm(carpetaTemporal, { recursive: true, force: true });
  }
});

test("las asignaturas creadas vacías aparecen y no se confunden con carpetas Tema", async () => {
  const carpetaAnterior = config.notesRoot;
  const carpetaTemporal = await mkdtemp(
    path.join(os.tmpdir(), "lista-asignaturas-vacias-"),
  );
  config.notesRoot = carpetaTemporal;
  try {
    await crearCarpetaAsignatura("Matemáticas");
    await mkdir(path.join(carpetaTemporal, "Tema 1"));
    assert.deepEqual(await listarAsignaturas(), [
      { nombre: "Matemáticas", temas: [] },
    ]);
  } finally {
    config.notesRoot = carpetaAnterior;
    await rm(carpetaTemporal, { recursive: true, force: true });
  }
});

test("no descarta la introducción anterior al primer apartado numerado", () => {
  const material = "PORTADA\n\nINTRODUCCIÓN\n\nContexto inicial.\n\n1.1 · MODELOS DE EJECUCIÓN\n\nContenido del apartado 1.1.\n\n1.2 · LENGUAJES CLIENTE\n\nContenido del apartado 1.2.";
  const apartados = detectarApartadosEnTexto(material);
  const bloques = dividirTextoPorApartados(material, [], apartados);
  assert.equal(bloques.length, 2);
  assert.match(bloques[0].texto, /INTRODUCCIÓN/);
  assert.match(bloques[0].texto, /Contenido del apartado 1\.1/);
});

test("extrae los títulos de cada diapositiva dentro de un mismo apartado", () => {
  const material = "1.3 · MECANISMOS DE EJECUCIÓN\n\nLa arquitectura del navegador\n\nTexto.\n\n1.3 · MECANISMOS DE EJECUCIÓN\n\nArquitectura de referencia (1/2)\n\nTexto.\n\n1.3 · MECANISMOS DE EJECUCIÓN\n\nLos motores de JavaScript";
  assert.deepEqual(extraerTitulosDiapositiva(material), [
    "La arquitectura del navegador",
    "Arquitectura de referencia (1/2)",
    "Los motores de JavaScript",
  ]);
});

test("el prompt exige conservar los títulos internos y la jerarquía de diapositivas", () => {
  const prompt = crearPromptApuntes({
    asignatura: "WEC",
    tema: 1,
    apartado: 3,
    material: "Arquitectura de referencia (1/2)\nMotor de renderizado\nArquitectura de referencia (2/2)\nParser XML",
  });
  assert.match(prompt, /JERARQUÍA REAL DE LAS DIAPOSITIVAS/);
  assert.match(prompt, /INVENTARIO DE TÍTULOS INTERNOS DETECTADOS/);
  assert.match(prompt, /\\subtituloA/);
  assert.match(prompt, /ni los elimines/);
  assert.match(prompt, /Para CADA párrafo o viñeta/);
  assert.match(prompt, /No inventes explicaciones/);
  assert.match(prompt, /diapositivas sin numeración, sin viñetas o sin puntos/);
});

test("procesa el temario completo de las 27 diapositivas de Tema 1 dividiéndolo en apartados dinámicos sin reemplazos estáticos", () => {
  const textoDiapositivas = `
DESENVOLUPAMENT WEB EN ENTORN CLIENT
Tema 1
Selecció d'arquitectures i d'eines de programació
2n DAW
Col·legi Sant Josep Obrer

INTRODUCCIÓ
L'origen i l'abast de la web
• En els seus orígens, per a crear una pàgina web només feia falta l'HTML : amb les seves marques es creava un document senzill que qualsevol navegador podia visualitzar.
• Aquestes pàgines s'allotjaven en un servidor connectat 24 hores al dia i els 365 dies de l'any, i es transmetien als equips que les demanaven.
• La web està basada en l'hipertext : una paraula o frase que, en accedir a ella, ens condueix a informació relacionada.
• Davant el seu enorme auge es va crear el consorci W3C, organització que es responsabilitza de desenvolupar i mantenir els estàndards web.
• Un programador web ha de dominar totes les fases d'un projecte: captar les necessitats del client, definir objectius i estratègia, desenvolupar la interfície gràfica i elaborar prototips i la presentació final. És imprescindible conèixer l'ordre de cada fase.
• Per tot això, el desenvolupament web és un camp multidisciplinari.

1.1 · MODELS D'EXECUCIÓ DE CODI
Els quatre camps del disseny web
• Visual. L'aspecte visual d'una pàgina web és dels aspectes més importants: el seu objectiu és la comunicació i intentar atreure els clients.
• Tecnologia. Decidir com s'implementarà el lloc i quines tecnologies utilitzar és un dels aspectes més influents.
• Distribució. Un altre aspecte al qual hem de prestar especial atenció és la velocitat i fiabilitat de la transmissió de dades.
• Propòsit. Tot lloc web ha de tenir un objectiu: finalitat econòmica o informativa.

1.1 · MODELS D'EXECUCIÓ DE CODI
El model client-servidor
Avui dia, l'arquitectura dels llocs web es basa en el model client-servidor, amb tres elements comuns:
1. Servidor. En ell tenim instal·lats els elements maquinari i programari, les tècniques incrustades i els llenguatges de programació. Suport multi fils.
2. Màquina client. Programes que realitzen la petició de sol·licitud web a través dels navegadors: HTML, CSS, JavaScript i controls ActiveX.
3. Connectivitat de la xarxa i les característiques utilitzades per al lloc web.
L'objectiu d'un navegador és presentar la informació en llenguatge HTML allotjada en un servidor.

POSA'T A PROVA
Comprovem l'après · 1.1
On tindrem implementats els diferents programes per a realitzar peticions de sol·licitud al servidor?
a) Màquina servidor
b) Màquina client
c) Màquina de connectivitat

1.2 · LLENGUATGES DE PROGRAMACIÓ EN ENTORN CLIENT
Dos entorns d'execució
• Entorn client: executats pels clients en un navegador web.
• Entorn servidor: llenguatges que s'executen en el servidor.
Client i servidor es complementen:
• Formulari web abans d'emmagatzemar a la base de dades: validació en client i emmagatzematge en servidor.
Les quatre capes en el client: contingut -> estructura -> presentació -> comportament (JavaScript).

1.3 · MECANISMES D'EXECUCIÓ DE CODI EN UN NAVEGADOR WEB
L'arquitectura del navegador
• Arquitectura de referència amb 8 components: interfície d'usuari, motor del cercador, motor de renderitzat, subsistema de comunicacions, intèrpret de JavaScript, parser XML, component de visualització, persistència de dades.
• Motors de JavaScript: V8 (Chrome, Edge, Node.js), SpiderMonkey (Firefox), JavaScriptCore (Safari). Compilació JIT a codi màquina.

1.4 · CAPACITATS I LIMITACIONS D'EXECUCIÓ
Per què JavaScript en el client?
• No pot escriure fitxers al servidor. Lloc web navegable sense JS.
• Sandbox de seguretat: no pot llegir ni escriure fitxers del disc. Política del mateix origen (SOP) i CORS. Risc de XSS.

POSA'T A PROVA
Comprovem l'après · 1.4
En quin dels següents casos no ofereix solucions JavaScript?
a) Donar resposta a l'usuari des d'un formulari
b) Escriure fitxers en el servidor

1.5 · PROGRAMACIÓ DE SCRIPTS
On i com col·locar els scripts
• Encapçalat (<head>) i cos (<body>). Etiqueta contenedora <script> i </script>.
• Primer script: document.write("¡Hola Onliner!");

1.6 · INTEGRACIÓ DEL CODI AMB LES ETIQUETES HTML
Integració: en línia o en fitxer extern
• Codi en línia vs fitxer extern (src="elteucodi.js"). Rutes relatives, absolutes i remotes.
• Etiqueta <noscript> i sintaxi CDATA per a XHTML.

1.7 · EINES DE PROGRAMACIÓ SOBRE CLIENTS WEB
Triar l'editor de codi i navegadors
• Editors de codi: Notepad++, Eclipse, NetBeans.
• Validació W3C (validator.w3.org).
• Seguretat: el teu codi sempre es veu; les claus d'API mai van al client.
`;

  const apartados = detectarApartadosEnTexto(textoDiapositivas);
  assert.equal(apartados.length, 7);
  assert.equal(apartados[0].tema, 1);
  assert.equal(apartados[0].subtema, 1);
  assert.equal(apartados[1].subtema, 2);
  assert.equal(apartados[2].subtema, 3);
  assert.equal(apartados[3].subtema, 4);
  assert.equal(apartados[4].subtema, 5);
  assert.equal(apartados[5].subtema, 6);
  assert.equal(apartados[6].subtema, 7);

  const bloques = dividirTextoPorApartados(textoDiapositivas, [], apartados);
  assert.equal(bloques.length, 7);
  // La portada y la introducción aportan contexto/contenido y no se descartan.
  assert.match(bloques[0].texto, /DESENVOLUPAMENT WEB EN ENTORN CLIENT/);
  assert.match(bloques[0].texto, /Selecció d'arquitectures i d'eines de programació/);
  assert.match(bloques[0].texto, /L'origen i l'abast de la web/);
  assert.match(bloques[0].texto, /només feia falta l'HTML/);
  assert.match(bloques[0].texto, /consorci W3C/);
  for (const b of bloques) {
    assert.doesNotMatch(b.texto, /Col[·.]legi\s+Sant\s+Josep\s+Obrer/);
    assert.doesNotMatch(b.texto, /\b2n\s+DAW\b/);
  }

  const latexCrudoConFallos = `\\secciongrande{El modelo cliente-servidor}
\\resumen{El modelo cliente-servidor distribuye las tareas entre proveedores y demandantes de recursos.}
\\subtituloA{Servidor}\\nEl servidor aloja recursos.
\\subtituloA{Maquina cliente}\\nEl cliente realiza peticiones.
\\begin{codigo}\\n<script>\\nconsole.log("test");\\n</script>\\n\\end{codigo}
\\begin{codigo}\\n<script>\\nconsole.log("test");\\n</script>\\n\\end{codigo}
`;
  const latexCorregido = aplicarEstilosLatex(latexCrudoConFallos);
  assert.doesNotMatch(latexCorregido, /\\n/);
  assert.equal((latexCorregido.match(/console\.log/g) || []).length, 1);
});

test("el nombre del tema nunca queda dentro de \\resumen ni como \\secciongrande", () => {
  const latex = String.raw`\secciongrande{Arquitecturas y herramientas}
\resumen{Tema 1: Arquitecturas i Eines \ Tema 2.1: Models d'execució de codi} La web moderna conecta cliente y servidor.
\subtituloA{Elementos principales}`;
  const limpio = sanearTitulosTema(
    latex,
    "Modelos de ejecución del código",
    "Arquitecturas y herramientas",
  );
  assert.match(limpio, /\\secciongrande\{Modelos de ejecución del código\}/);
  assert.match(limpio, /\\resumen\{La web moderna conecta cliente y servidor\.\}/);
  assert.doesNotMatch(limpio, /\\resumen\{[^}]*Tema 1/);
  assert.doesNotMatch(limpio, /\\secciongrande\{[^}]*Arquitecturas y herramientas/);
  const anidado = sanearTitulosTema(
    String.raw`\secciongrande{\secciongrande{Arquitecturas y herramientas}}`,
    "Los motores de JavaScript",
    "Arquitecturas y herramientas",
  );
  assert.equal(anidado, "\\secciongrande{Los motores de JavaScript}");
});

test("elimina párrafos idénticos repetidos sin tocar los bloques de código", () => {
  const parrafo = "El servidor atiende peticiones y el cliente las genera en el navegador, de modo que ambos extremos se necesitan para completar cada operación web.";
  const latex = [
    "\\secciongrande{Modelo cliente-servidor}",
    parrafo,
    parrafo,
    "\\begin{codigo}",
    'console.log("uno");',
    "",
    'console.log("dos");',
    "\\end{codigo}",
  ].join("\n\n");
  const limpio = aplicarEstilosLatex(latex);
  assert.equal((limpio.match(/El servidor atiende peticiones/g) || []).length, 1);
  assert.match(limpio, /console\.log\("uno"\);[\s\S]*console\.log\("dos"\);/);
});
