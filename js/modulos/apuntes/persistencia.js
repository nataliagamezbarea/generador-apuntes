import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../configuracion.js";
import { buscarImagenAbierta } from "../imagenes.js";
import {
  componenteSeguro,
  crearNombreArchivo,
  escaparLatex,
  escaparTextoLatex,
  limpiarNombreInstitucion,
} from "./utilidades-nombres.js";

async function existeArchivo(file) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
import {
  obtenerInformeGeneracion,
  rutaInformeGeneracion,
} from "./informes.js";
import {
  desglosarBloquesPorSubtitulos,
  inferirSubtemaDeBloque,
  stemArchivoGenerado,
} from "./bloques.js";
import {
  aplicarEstilosLatex,
  limpiarLatex,
} from "./estilos-latex.js";

export async function inspeccionarReemplazosGeneracion({
  result,
  subject,
  theme,
  subtheme,
  fingerprint,
  inputFiles = [],
}) {
  const informe = await obtenerInformeGeneracion(subject, theme, subtheme);
  const fuentesAnalizadas = new Set(
    (informe?.archivos_procesados_detalle ?? []).map((archivo) => archivo.nombre),
  );
  const archivosRegistrados = new Set(
    (informe?.archivos_generados ?? []).map((archivo) => archivo.path),
  );
  const archivosConHuella = new Set(
    informe?.fingerprint === fingerprint ? archivosRegistrados : [],
  );
  if (
    !inputFiles.some((archivo) => fuentesAnalizadas.has(archivo.originalname))
  )
    return [];

  result.archivos = desglosarBloquesPorSubtitulos(result.archivos);
  const contadorSubtemasInsp = new Map();
  for (const block of result.archivos) {
    const bloqueSubtema = inferirSubtemaDeBloque(block, subtheme);
    const contadorActual = (contadorSubtemasInsp.get(bloqueSubtema) || 0) + 1;
    contadorSubtemasInsp.set(bloqueSubtema, contadorActual);
    block.orden = contadorActual;
    block.numeroArchivoEnSubtema = contadorActual;
  }

  const existentes = [];
  for (const [index, block] of result.archivos.entries()) {
    const bloqueSubtema = inferirSubtemaDeBloque(block, subtheme);
    const subDir = path.join(
      config.notesRoot,
      componenteSeguro(subject),
      `Tema ${theme}`,
      `Tema ${theme}.${bloqueSubtema}`,
    );
    const filename = `${stemArchivoGenerado(block, theme, bloqueSubtema, index)}.tex`;
    const target = path.join(subDir, filename);
    const relativeTarget = path
      .relative(config.notesRoot, target)
      .split(path.sep)
      .join("/");
    if (!archivosRegistrados.has(relativeTarget)) continue;
    try {
      const contenido = await readFile(target, "utf8");
      if (archivosConHuella.has(relativeTarget)) continue;
      const hash = createHash("sha256").update(contenido).digest("hex");
      existentes.push({
        path: path.relative(config.notesRoot, target).split(path.sep).join("/"),
        sha256: hash,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return existentes;
}

export async function guardarGeneracion({
  result,
  fingerprint,
  subject,
  theme,
  subtheme,
  inputFiles,
  material,
  existingCount,
  replaceExisting = false,
  expectedExistingFiles = {},
  archivosCambiados = [],
}) {
  const subjectDir = path.join(config.notesRoot, componenteSeguro(subject));
  const themeDir = path.join(subjectDir, `Tema ${theme}`);
  const subDir = path.join(themeDir, `Tema ${theme}.${subtheme}`);
  await mkdir(themeDir, { recursive: true });
  const created = [];
  const warnings = [];
  const written = [];
  const imagenesIncluidas = [];
  const sugerenciasUsadas = new Set();

  await asegurarEstructuraAsignatura(subjectDir);
  await asegurarEstructuraTema(themeDir);
  const informeAnterior = await obtenerInformeGeneracion(
    subject,
    theme,
    subtheme,
  );
  const archivosConHuella = new Set(
    informeAnterior?.fingerprint === fingerprint
      ? (informeAnterior.archivos_generados ?? []).map((archivo) => archivo.path)
      : [],
  );

  result.archivos = desglosarBloquesPorSubtitulos(result.archivos);
  const contadorSubtemas = new Map();
  for (const block of result.archivos) {
    const bloqueSubtema = inferirSubtemaDeBloque(block, subtheme);
    const contadorActual = (contadorSubtemas.get(bloqueSubtema) || 0) + 1;
    contadorSubtemas.set(bloqueSubtema, contadorActual);
    block.orden = contadorActual;
    block.numeroArchivoEnSubtema = contadorActual;
  }

  for (const [index, block] of result.archivos.entries()) {
    const bloqueSubtema = inferirSubtemaDeBloque(block, subtheme);
    const subDir = path.join(themeDir, `Tema ${theme}.${bloqueSubtema}`);
    await mkdir(subDir, { recursive: true });
    const stem = stemArchivoGenerado(block, theme, bloqueSubtema, index);
    const filename = `${stem}.tex`;
    const target = path.join(subDir, filename);
    const relativeTarget = path
      .relative(config.notesRoot, target)
      .split(path.sep)
      .join("/");
    let outputPath = target;
    if (await existeArchivo(target)) {
      const existing = await readFile(target, "utf8");
      if (archivosConHuella.has(relativeTarget)) {
        outputPath = target;
      } else if (replaceExisting) {
        const expectedHash = expectedExistingFiles[relativeTarget];
        if (expectedHash) {
          const actualHash = createHash("sha256").update(existing).digest("hex");
          if (expectedHash !== actualHash) {
            throw Object.assign(
              new Error(
                `El archivo ${relativeTarget} cambió mientras confirmabas la sustitución. No se ha sobrescrito.`,
              ),
              { status: 409 },
            );
          }
        }
        outputPath = target;
      } else {
        let suffix = 2;
        while (await existeArchivo(path.join(subDir, `${stem}-${suffix}.tex`))) {
          const candidato = path.join(subDir, `${stem}-${suffix}.tex`);
          const relativoCandidato = path
            .relative(config.notesRoot, candidato)
            .split(path.sep)
            .join("/");
          if (archivosConHuella.has(relativoCandidato)) {
            outputPath = candidato;
            break;
          }
          suffix += 1;
        }
        if (outputPath === target)
          outputPath = path.join(subDir, `${stem}-${suffix}.tex`);
      }
    } else if (replaceExisting && expectedExistingFiles[relativeTarget]) {
      throw Object.assign(
        new Error(
          `El archivo ${relativeTarget} cambió mientras confirmabas la sustitución. No se ha sobrescrito.`,
        ),
        { status: 409 },
      );
    }
    
    const figuraAbierta = await adjuntarImagenAbierta({
      imagenes: result.imagenes ?? [],
      stem: path.basename(outputPath, ".tex"),
      titulo: block.titulo,
      directorio: subDir,
      warnings,
      imagenesIncluidas,
      sugerenciasUsadas,
    });
    const diagramas = imagenesDelApartado(result.imagenes, stem, block.titulo);
    let latexBloque = block.latex.trim();
    const indiceEnSubtema = (block.orden || (index + 1)) - 1;
    if (indiceEnSubtema > 0) {
      latexBloque = latexBloque
        .replace(/\\secciongrande\*?(?:\[[^\]]*\])?\{([^}]+)\}\s*/g, "")
        .replace(/\\resumen\*?(?:\[[^\]]*\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*/g, "");
    }
    const latexLimpio = aplicarEstilosLatex(latexBloque, subject);
    const latex = `${latexLimpio}${figuraAbierta ? `\n\n${figuraAbierta}` : ""}${diagramas ? `\n\n${diagramas}` : ""}\n`;
    await writeFile(outputPath, latex, "utf8");
    written.push({
      titulo: block.titulo,
      archivo: outputPath,
      relativo: path
        .relative(config.notesRoot, outputPath)
        .split(path.sep)
        .join("/"),
    });
  }

  if (replaceExisting) {
    const rutasNuevas = new Set(written.map((w) => path.resolve(w.archivo)));
    if (informeAnterior?.archivos_generados) {
      for (const viejo of informeAnterior.archivos_generados) {
        if (!viejo.path) continue;
        const absViejo = path.resolve(config.notesRoot, viejo.path);
        if (!rutasNuevas.has(absViejo)) {
          try {
            await rm(absViejo, { force: true });
          } catch {}
        }
      }
    }
    for (const [sub] of contadorSubtemas.entries()) {
      const subDirAfectado = path.join(themeDir, `Tema ${theme}.${sub}`);
      try {
        const archivosEnSubDir = await readdir(subDirAfectado);
        for (const arch of archivosEnSubDir) {
          if (!arch.endsWith(".tex")) continue;
          const absArch = path.resolve(subDirAfectado, arch);
          if (!rutasNuevas.has(absArch)) {
            try {
              await rm(absArch, { force: true });
            } catch {}
          }
        }
      } catch {}
    }
  }

  const themeDocument = await asegurarDocumentoTema(
    themeDir,
    subject,
    theme,
    result.titulo_tema,
  );
  if (themeDocument.created) created.push(themeDocument.path);
  const report = {
    fingerprint,
    generado: new Date().toISOString(),
    asignatura: subject,
    tema: theme,
    subtema: subtheme,
    titulo_tema: result.titulo_tema,
    titulo_subtema: result.titulo_subtema,
    conceptos_clave: result.conceptos_clave,
    cobertura: result.cobertura,
    fuentes: result.fuentes,
    imagenes: imagenesIncluidas,
    archivos_procesados: inputFiles.map((file) => file.originalname),
    archivos_procesados_detalle: inputFiles.map((file) => ({
      nombre: file.originalname,
      bytes: file.size,
      sha256: createHash("sha256").update(file.buffer).digest("hex"),
    })),
    archivos_cambiados: archivosCambiados,
    documentos_leidos: material.documents.length,
    imagenes_ocr: material.imagesOcr,
    paginas_enviadas_a_vision: material.visuals.length,
    apuntes_existentes: { files: existingCount },
    archivos_generados: written.map((file) => ({
      titulo: file.titulo,
      path: file.relativo,
    })),
    tema_documento: path
      .relative(config.notesRoot, themeDocument.path)
      .split(path.sep)
      .join("/"),
    avisos: [...material.warnings, ...warnings],
  };
  const reportDirectory = path.dirname(
    await rutaInformeGeneracion(subject, theme, subtheme),
  );
  await mkdir(reportDirectory, { recursive: true });
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(
    path.join(reportDirectory, "ultima-generacion.json"),
    reportText,
    "utf8",
  );
  await writeFile(path.join(reportDirectory, "cobertura.json"), reportText, "utf8");
  const historyDirectory = path.join(reportDirectory, "historial");
  await mkdir(historyDirectory, { recursive: true });
  await writeFile(
    path.join(historyDirectory, `${Date.now()}-${fingerprint}.json`),
    reportText,
    "utf8",
  );
  return {
    report,
    salida: {
      subject_dir: subjectDir,
      theme_dir: themeDir,
      sub_dir: subDir,
      theme_document: themeDocument.path,
      created,
      written,
      skipped: [],
      warnings,
    },
  };
}

export async function adjuntarImagenAbierta({
  imagenes,
  stem,
  titulo,
  directorio,
  warnings,
  imagenesIncluidas,
  sugerenciasUsadas,
}) {
  if (imagenesIncluidas.length >= 3) return "";
  const indice = imagenes.findIndex((imagen, itemIndice) => {
    if (sugerenciasUsadas.has(itemIndice) || !String(imagen.consulta ?? "").trim())
      return false;
    const asociado = String(imagen.apartado ?? imagen.archivo ?? "");
    return !asociado || asociado === stem || asociado === titulo;
  });
  if (indice < 0) return "";
  sugerenciasUsadas.add(indice);
  const sugerencia = imagenes[indice];

  try {
    const imagen = await buscarImagenAbierta(sugerencia.consulta);
    if (!imagen) return "";
    const nombreImagen = `${stem}-imagen.${imagen.extension}`;
    await writeFile(path.join(directorio, nombreImagen), imagen.data);
    const descripcion = escaparTextoLatex(
      String(sugerencia.descripcion ?? imagen.descripcion ?? titulo).slice(0, 300),
    );
    const atribucion = escaparTextoLatex(
      `${imagen.autor}. ${imagen.licencia}. Fuente: ${imagen.fuenteUrl}`,
    );
    imagenesIncluidas.push({
      archivo: nombreImagen,
      titulo: imagen.titulo,
      autor: imagen.autor,
      licencia: imagen.licencia,
      licencia_url: imagen.licenciaUrl?.href ?? "",
      fuente_url: imagen.fuenteUrl,
    });
    return [
      "\\begin{figure}[htbp]",
      "\\centering",
      `\\includegraphics[width=0.8\\linewidth]{${nombreImagen}}`,
      `\\caption{${descripcion}}`,
      `\\small\\textit{${atribucion}}`,
      "\\end{figure}",
    ].join("\n");
  } catch (error) {
    warnings.push(
      `No se pudo añadir una imagen con licencia abierta para «${titulo}»: ${error.message}`,
    );
    return "";
  }
}

export function imagenesDelApartado(imagenes = [], slug, titulo) {
  if (!Array.isArray(imagenes)) return "";
  return imagenes
    .flatMap((imagen) => {
      if (String(imagen.tikz ?? "").trim()) return [];
      const asociado = String(imagen.apartado ?? imagen.archivo ?? "");
      if (asociado && asociado !== slug && asociado !== titulo) return [];
      const tikz = limpiarLatex(imagen.tikz ?? "");
      if (!tikz) return [];
      const descripcion = String(imagen.descripcion ?? "").replace(
        /[#$%&_]/g,
        "\\$&",
      );
      const dibujo = tikz.includes("\\begin{tikzpicture}")
        ? tikz
        : `\\begin{tikzpicture}\n${tikz}\n\\end{tikzpicture}`;
      return [
        `\\begin{figure}[htbp]\n\\centering\n${dibujo}\n${descripcion ? `\\caption{${descripcion}}` : ""}\n\\end{figure}`,
      ];
    })
    .join("\n\n");
}

export async function asegurarEstructuraAsignatura(subjectDir) {
  await mkdir(subjectDir, { recursive: true });
  const preamblePath = path.join(subjectDir, "preambulo.tex");
  await asegurarCargaLatex(subjectDir);
  const preambuloWec = String.raw`% =====================================================================
%  PREAMBULO.TEX - estilos completos WEC de bibliotecas_latex
% =====================================================================
\AtBeginDocument{\ifcsname spanishdeactivate\endcsname\spanishdeactivate{<>}\fi}
\newcommand{\subt}[1]{\par\Needspace{4\baselineskip}\vspace{2mm}\noindent{\bfseries\color{primary}#1}\par\vspace{1mm}}
\newcommand{\cmd}[1]{\texttt{\detokenize{#1}}}
\definecolor{codeForeground}{HTML}{243247}
\definecolor{codeString}{HTML}{8A4B08}
\definecolor{codeComment}{HTML}{58745C}
\definecolor{consoleBackground}{HTML}{F1F4F8}
\definecolor{codeBackgroundA}{HTML}{F1F7FF}
\definecolor{codeBackgroundB}{HTML}{EFF9F5}
\definecolor{codeBackgroundC}{HTML}{F7F2FC}
\definecolor{codeBackgroundD}{HTML}{FFF7ED}
\definecolor{codeBackgroundE}{HTML}{F0F8FA}
\definecolor{codeBackgroundF}{HTML}{FFF3F5}
\definecolor{codeKeywordA}{HTML}{2457A6}
\definecolor{codeKeywordB}{HTML}{19704F}
\definecolor{codeKeywordC}{HTML}{7046A3}
\definecolor{codeKeywordD}{HTML}{A45B12}
\definecolor{codeKeywordE}{HTML}{117184}
\definecolor{codeKeywordF}{HTML}{A63F5B}
\def\codeCurrentBackground{codeBackgroundA}
\def\codeCurrentKeyword{codeKeywordA}
\newcounter{codePaletteIndex}
\newcommand{\nextCodePalette}{%
  \stepcounter{codePaletteIndex}%
  \ifnum\value{codePaletteIndex}>6\setcounter{codePaletteIndex}{1}\fi
  \ifcase\value{codePaletteIndex}\or
    \gdef\codeCurrentBackground{codeBackgroundA}\gdef\codeCurrentKeyword{codeKeywordA}\or
    \gdef\codeCurrentBackground{codeBackgroundB}\gdef\codeCurrentKeyword{codeKeywordB}\or
    \gdef\codeCurrentBackground{codeBackgroundC}\gdef\codeCurrentKeyword{codeKeywordC}\or
    \gdef\codeCurrentBackground{codeBackgroundD}\gdef\codeCurrentKeyword{codeKeywordD}\or
    \gdef\codeCurrentBackground{codeBackgroundE}\gdef\codeCurrentKeyword{codeKeywordE}\or
    \gdef\codeCurrentBackground{codeBackgroundF}\gdef\codeCurrentKeyword{codeKeywordF}%
  \fi}
\AddToHook{cmd/secciongrande/after}{\nextCodePalette}
\AddToHook{cmd/seccion/after}{\nextCodePalette}
\AddToHook{cmd/subtitulo/after}{\nextCodePalette}
\AddToHook{cmd/subtituloA/after}{\nextCodePalette}
\AddToHook{cmd/subtituloB/after}{\nextCodePalette}
\ifcsname codigo\endcsname\else
\newtcblisting{codigo}{listing only, breakable, colback=\codeCurrentBackground, colframe=primary!28!white,
  boxrule=0pt, arc=3pt, left=6pt, right=6pt, top=4pt, bottom=4pt,
  listing options={language=Java, basicstyle=\ttfamily\footnotesize\color{codeForeground},
    keywordstyle=\color{\codeCurrentKeyword}\bfseries,
    morekeywords={const,let,var,of,async,await,undefined,null,true,false,console,document,window,localStorage,fetch,Promise,script,html,head,body,noscript,div,span,p,ul,li,input,form,button,type,src,id,class},
    stringstyle=\color{codeString}, commentstyle=\color{codeComment}\itshape,
    showstringspaces=false, breaklines=true, columns=fullflexible, keepspaces=true, upquote=true}}
\fi
\ifcsname consola\endcsname\else
\newtcblisting{consola}{listing only, breakable, colback=consoleBackground, colframe=primary!22!white,
  boxrule=0pt, arc=3pt, left=6pt, right=6pt, top=4pt, bottom=4pt,
  listing options={basicstyle=\ttfamily\footnotesize\color{codeForeground}, breaklines=true,
    columns=fullflexible, keepspaces=true, upquote=true}}
\fi
\newcolumntype{L}[1]{>{\raggedright\arraybackslash}p{#1}}
`;
  if (!(await existeArchivo(preamblePath))) {
    await writeFile(preamblePath, preambuloWec, "utf8");
  } else {
    const anterior = await readFile(preamblePath, "utf8");
    if (!anterior.includes("newtcblisting{codigo}")) {
      await writeFile(preamblePath, preambuloWec, "utf8");
    }
  }
}

export async function asegurarEstructuraTema(themeDir) {
  await mkdir(themeDir, { recursive: true });
  await asegurarCargaLatex(themeDir);
  await asegurarEstilosGenerador(themeDir);
}

export async function asegurarEstilosGenerador(themeDir) {
  const file = path.join(themeDir, "generador-estilos.tex");
  const estilos = String.raw`% Generador de apuntes: integración con la biblioteca oficial WEC.
% La paleta y las macros visuales (titulo, secciongrande, seccion,
% subtituloA/B, resumen, lista, pasos, definicion, nota, tabla...) proceden
% de bibliotecas_latex/cabecera.tex. Aquí se sincronizan los colores
% del resaltado de código y el índice automático clicable con hyperref.
\providecommand{\cmd}[1]{\texttt{\detokenize{#1}}}
\providecommand{\phantomsection}{}
\providecommand{\subnota}[2]{\nota{#1}{#2}}
\providecommand{\subnotasin}[2]{\nota{#1}{#2}}
\AtBeginDocument{\ifcsname spanishdeactivate\endcsname\spanishdeactivate{<>}\fi}
\providecommand{\subt}[1]{\par\Needspace{4\baselineskip}\vspace{2mm}\noindent{\bfseries\color{primary}#1}\par\vspace{1mm}}
\providecolor{codeForeground}{HTML}{243247}
\providecolor{codeString}{HTML}{8A4B08}
\providecolor{codeComment}{HTML}{58745C}
\providecolor{codeBackground}{HTML}{F1F7FF}
\providecolor{codeKeyword}{HTML}{2457A6}
\providecolor{consoleBackground}{HTML}{F1F4F8}
\providecolor{primary}{HTML}{0B4F6C}
\providecolor{coloractual}{HTML}{0B4F6C}
\providecommand{\subtituloreal}{primary}
\providecommand{\subtitulocolor}{primary}
\providecommand{\pickcolor}[1]{}

\newcommand{\actualizarColoresCodigo}{%
  \colorlet{codeBackground}{\coloractual!7!white}%
  \colorlet{codeKeyword}{\coloractual!80!black}%
}
\newcommand{\iniciarPaletaSecciones}{\pickcolor{\coloractual}}
\AddToHook{cmd/titulo/after}{\iniciarPaletaSecciones\actualizarColoresCodigo}
\AddToHook{cmd/secciongrande/after}{\actualizarColoresCodigo}

% --- CORRECCIÓN DE TÍTULOS MULTILÍNEA EN BARRAS OFICIALES WEC ---
\ifcsname sectionheader\endcsname
  \ifcsname bartitleboxlen\endcsname\else\newlength{\bartitleboxlen}\fi
  \renewcommand{\sectionheader}[4][primary]{%
    \edef\sectionheadercolor{#1}%
    \setlength{\barleftlen}{#2}%
    \settowidth{\bartextlen}{\headingfontxb#4\color{\sectionheadercolor} #3}%
    \setlength{\barrightlen}{\dimexpr\linewidth - \barleftlen - \bartextlen - 0.9cm\relax}%
    \ifdim\barrightlen>0.7cm
      \noindent\barrule[\sectionheadercolor]{\barleftlen}\hspace{4mm}{\headingfontxb#4\color{\sectionheadercolor} #3}\hspace{4mm}\barrule[\sectionheadercolor]{\barrightlen}\par
    \else
      \setlength{\bartitleboxlen}{\dimexpr\linewidth - 2\barleftlen - 8mm\relax}%
      \noindent\parbox[c]{\barleftlen}{\barrule[\sectionheadercolor]{\barleftlen}}\hspace{4mm}%
      \parbox[c]{\bartitleboxlen}{\centering\headingfontxb#4\color{\sectionheadercolor} #3}\hspace{4mm}%
      \parbox[c]{\barleftlen}{\barrule[\sectionheadercolor]{\barleftlen}}\par
    \fi
  }
\fi

% --- ÍNDICE AUTOMÁTICO CLICABLE CON HYPERREF (PRESERVANDO ESTILOS OFICIALES WEC) ---
\ifcsname secciongrande\endcsname
  \AddToHook{cmd/secciongrande/before}{\phantomsection}
\else
  \DeclareDocumentCommand{\secciongrande}{o m}{%
    \par\Needspace{8\baselineskip}%
    \phantomsection
    \addcontentsline{toc}{section}{#2}%
    \vspace{4mm}\noindent{\fontsize{15}{18}\selectfont\bfseries\color{primary}#2}\par
    \nopagebreak\vspace{2mm}\nopagebreak
  }
\fi

\ifcsname seccion\endcsname
  \AddToHook{cmd/seccion/before}{\phantomsection}
\else
  \DeclareDocumentCommand{\seccion}{o m}{%
    \par\Needspace{6\baselineskip}%
    \phantomsection
    \addcontentsline{toc}{section}{#2}%
    \vspace{3mm}\noindent{\fontsize{13}{16}\selectfont\bfseries\color{primary}#2}\par
    \nopagebreak\vspace{2mm}\nopagebreak
  }
\fi

\ifcsname subtituloA\endcsname
  \let\origsubtituloA\subtituloA
  \renewcommand{\subtituloA}[1]{%
    \phantomsection
    \addcontentsline{toc}{subsection}{#1}%
    \origsubtituloA{#1}%
  }
\else
  \DeclareDocumentCommand{\subtituloA}{m}{%
    \par\Needspace{5\baselineskip}%
    \phantomsection
    \addcontentsline{toc}{subsection}{#1}%
    \vspace{3mm}\noindent{\fontsize{12}{15}\selectfont\bfseries\color{primary}#1}\par
    \nopagebreak\vspace{2mm}\nopagebreak
  }
\fi

\ifcsname subtituloB\endcsname
  \let\origsubtituloB\subtituloB
  \renewcommand{\subtituloB}[1]{%
    \phantomsection
    \addcontentsline{toc}{subsubsection}{#1}%
    \origsubtituloB{#1}%
  }
\else
  \DeclareDocumentCommand{\subtituloB}{m}{%
    \par\Needspace{4\baselineskip}%
    \phantomsection
    \addcontentsline{toc}{subsubsection}{#1}%
    \vspace{2mm}\noindent{\fontsize{11}{14}\selectfont\bfseries\color{primary}#1}\par
    \nopagebreak\vspace{2mm}\nopagebreak
  }
\fi

\lstdefinelanguage{JavaScript}{
  sensitive=true,
  morekeywords={const,let,var,of,async,await,undefined,null,true,false,function,return,if,else,for,while,switch,case,break,continue,new,class,extends,import,export,default,try,catch,throw},
  morecomment=[l]{//},
  morecomment=[s]{/*}{*/},
  morestring=[b]",
  morestring=[b]'
}
\ifcsname codigo\endcsname\else
\newtcblisting{codigo}[1][Java]{listing only,breakable,colback=codeBackground,colframe=\coloractual!28!white,boxrule=0pt,arc=3pt,left=6pt,right=6pt,top=4pt,bottom=4pt,listing options={language=#1,basicstyle=\ttfamily\footnotesize\color{codeForeground},keywordstyle=\color{codeKeyword}\bfseries,morekeywords={const,let,var,of,async,await,undefined,null,true,false,console,document,window,localStorage,fetch,Promise,script,html,head,body,noscript,div,span,p,ul,li,input,form,button,type,src,id,class},stringstyle=\color{codeString},commentstyle=\color{codeComment}\itshape,showstringspaces=false,breaklines=true,columns=fullflexible,keepspaces=true,tabsize=4,upquote=true}}
\fi
\ifcsname consola\endcsname\else
\newtcblisting{consola}{listing only,breakable,colback=consoleBackground,colframe=primary!22!white,boxrule=0pt,arc=3pt,left=6pt,right=6pt,top=4pt,bottom=4pt,listing options={basicstyle=\ttfamily\footnotesize\color{codeForeground},breaklines=true,columns=fullflexible,keepspaces=true,upquote=true}}
\fi

% --- Fallbacks para macros oficiales de la biblioteca en entornos mínimos ---
\providecommand{\paletaAzul}{}
\providecommand{\usarfondo}{}
\providecommand{\titulo}[2]{\begin{center}{\LARGE\bfseries #1}\\[3mm]{\large\bfseries #2}\end{center}\vspace{4mm}}
\providecommand{\coloractual}{blue}
\providecommand{\primary}{blue}
\providecommand{\headingfont}{\bfseries}
\providecommand{\headingfontxb}{\bfseries}
\providecommand{\resumen}[1]{\par\vspace{2mm}\noindent\fbox{\parbox{\dimexpr\linewidth-2\fboxsep-2\fboxrule}{\textbf{Resumen:} #1}}\par\vspace{2mm}}
\providecommand{\definicion}[2]{\par\vspace{2mm}\noindent\fbox{\parbox{\dimexpr\linewidth-2\fboxsep-2\fboxrule}{\textbf{#1:}\ #2}}\par\vspace{2mm}}
\providecommand{\definicionpar}[2]{\par\vspace{2mm}\noindent\fbox{\parbox{\dimexpr\linewidth-2\fboxsep-2\fboxrule}{\textbf{#1:}\ #2}}\par\vspace{2mm}}
\providecommand{\nota}[2]{\par\vspace{2mm}\noindent\fbox{\parbox{\dimexpr\linewidth-2\fboxsep-2\fboxrule}{\textbf{#1:}\ #2}}\par\vspace{2mm}}
\providecommand{\alertas}[1]{\par\vspace{2mm}\noindent\fbox{\parbox{\dimexpr\linewidth-2\fboxsep-2\fboxrule}{\textbf{Alerta:}\ #1}}\par\vspace{2mm}}
\providecommand{\rectangulos}[1]{#1}
\ifcsname lista\endcsname\else
\ExplSyntaxOn
\DeclareDocumentCommand{\lista}{m}{%
  \begin{itemize}%
    \seq_set_split:Nnn \l_tmpa_seq { | } { #1 }%
    \seq_map_inline:Nn \l_tmpa_seq {%
      \tl_set:Nn \l_tmpa_tl { ##1 }%
      \tl_trim_spaces:N \l_tmpa_tl
      \tl_if_empty:NF \l_tmpa_tl {%
        \item \l_tmpa_tl
      }%
    }%
  \end{itemize}%
}
\ExplSyntaxOff
\fi
\providecommand{\pasos}[1]{\begin{enumerate}#1\end{enumerate}}
\providecommand{\tabla}[2][]{#2}
\providecommand{\inputcarpeta}[1]{%
  \immediate\write18{find "#1" -name "*.tex" 2>/dev/null | sort -V | sed 's/.*/\\input{&}/' > "/tmp/in-#1.tex"}%
  \IfFileExists{/tmp/in-#1.tex}{\input{/tmp/in-#1.tex}}{}%
}
`;

  if (await existeArchivo(file)) {
    const anterior = await readFile(file, "utf8");
    const estiloWecActualConIndice =
      anterior.startsWith(
        "% Generador de apuntes: integración con la biblioteca oficial WEC.\n",
      ) &&
      anterior.includes("DeclareDocumentCommand{\\secciongrande}") &&
      anterior.includes("DeclareDocumentCommand{\\seccion}") &&
      anterior.includes("\\addcontentsline{toc}{section}{#2}") &&
      anterior.includes("\\providecommand{\\pickcolor}") &&
      anterior.includes("DeclareDocumentCommand{\\lista}");
    if (estiloWecActualConIndice) return;
  }
  await writeFile(file, estilos, "utf8");
}

export async function asegurarCargaLatex(directory) {
  const loadPath = path.join(directory, "carga.tex");
  const libraryPath =
    path.relative(directory, config.latexLibrary).split(path.sep).join("/") ||
    ".";
  const legacyPath = String.raw`\def\apuntesrutalib{/data/bibliotecas_latex}`;
  const replacement = String.raw`\def\apuntesrutalib{${libraryPath}}`;
  let content;
  try {
    content = await readFile(loadPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    content = "";
  }
  if (!content) {
    content = String.raw`\def\apuntesrutalib{${libraryPath}}
\IfFileExists{\apuntesrutalib/cabecera.tex}{%
  \def\bibliotecasDir{\apuntesrutalib}%
  \input{\apuntesrutalib/cabecera}%
}{%
  \IfFileExists{../../../bibliotecas_latex/cabecera.tex}{%
    \def\bibliotecasDir{../../../bibliotecas_latex}%
    \input{../../../bibliotecas_latex/cabecera}%
  }{%
    \IfFileExists{../../bibliotecas_latex/cabecera.tex}{%
      \def\bibliotecasDir{../../bibliotecas_latex}%
      \input{../../bibliotecas_latex/cabecera}%
    }{%
      \IfFileExists{./bibliotecas_latex/cabecera.tex}{%
        \def\bibliotecasDir{./bibliotecas_latex}%
        \input{./bibliotecas_latex/cabecera}%
      }{%
        \IfFileExists{/data/bibliotecas_latex/cabecera.tex}{%
          \def\bibliotecasDir{/data/bibliotecas_latex}%
          \input{/data/bibliotecas_latex/cabecera}%
        }{%
          \usepackage[spanish]{babel}
          \usepackage{xcolor}
          \usepackage{tikz}
          \usepackage{needspace}
          \usepackage{amsmath,amssymb}
          \usepackage{listings}
          \usepackage{array}
          \usepackage[most]{tcolorbox}
          \tcbuselibrary{listings,skins,breakable}
          \typeout{Aviso: bibliotecas_latex no encontrada, usando macros autonomas WEC}%
        }%
      }%
    }%
  }%
}
`;
    await writeFile(loadPath, content, "utf8");
  } else if (!content.includes("\\usepackage[spanish]{babel}") || content.includes(legacyPath)) {
    const updatedContent = String.raw`\def\apuntesrutalib{${libraryPath}}
\IfFileExists{\apuntesrutalib/cabecera.tex}{%
  \def\bibliotecasDir{\apuntesrutalib}%
  \input{\apuntesrutalib/cabecera}%
}{%
  \IfFileExists{../../../bibliotecas_latex/cabecera.tex}{%
    \def\bibliotecasDir{../../../bibliotecas_latex}%
    \input{../../../bibliotecas_latex/cabecera}%
  }{%
    \IfFileExists{../../bibliotecas_latex/cabecera.tex}{%
      \def\bibliotecasDir{../../bibliotecas_latex}%
      \input{../../bibliotecas_latex/cabecera}%
    }{%
      \IfFileExists{./bibliotecas_latex/cabecera.tex}{%
        \def\bibliotecasDir{./bibliotecas_latex}%
        \input{./bibliotecas_latex/cabecera}%
      }{%
        \IfFileExists{/data/bibliotecas_latex/cabecera.tex}{%
          \def\bibliotecasDir{/data/bibliotecas_latex}%
          \input{/data/bibliotecas_latex/cabecera}%
        }{%
          \usepackage[spanish]{babel}
          \usepackage{xcolor}
          \usepackage{tikz}
          \usepackage{needspace}
          \usepackage{amsmath,amssymb}
          \usepackage{listings}
          \usepackage{array}
          \usepackage[most]{tcolorbox}
          \tcbuselibrary{listings,skins,breakable}
          \typeout{Aviso: bibliotecas_latex no encontrada, usando macros autonomas WEC}%
        }%
      }%
    }%
  }%
}
`;
    await writeFile(loadPath, updatedContent, "utf8");
  }
}

export async function asegurarDocumentoTema(themeDir, subject, theme, title) {
  const target = path.join(themeDir, `tema${theme}.tex`);
  const styleInput = "\\input{generador-estilos.tex}";
  const children = (await readdir(themeDir, { withFileTypes: true }))
    .filter(
      (item) =>
        item.isDirectory() &&
        new RegExp(`^Tema ${theme}\\.\\d+$`, "i").test(item.name),
    );

  const recolectarInputsDeCarpetas = async (carpetas) => {
    const lineas = [];
    for (const c of carpetas) {
      const subDir = path.join(themeDir, c);
      try {
        const archivos = (await readdir(subDir, { withFileTypes: true }))
          .filter((f) => f.isFile() && f.name.endsWith(".tex"))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        if (archivos.length > 0) {
          for (const arch of archivos) {
            lineas.push(`\\input{${c}/${arch.name}}`);
          }
        } else {
          lineas.push(`\\inputcarpeta{${c}}`);
        }
      } catch {
        lineas.push(`\\inputcarpeta{${c}}`);
      }
    }
    return lineas;
  };

  const paquetesRequeridos = [
    "\\documentclass[11pt,a4paper]{extarticle}",
    "\\IfFileExists{../../bibliotecas_latex/estilo.tex}{%",
    "  \\providecommand{\\bibliotecasDir}{../../bibliotecas_latex}%",
    "  \\input{\\bibliotecasDir/estilo}%",
    "}{%",
    "  \\IfFileExists{../../../bibliotecas_latex/estilo.tex}{%",
    "    \\providecommand{\\bibliotecasDir}{../../../bibliotecas_latex}%",
    "    \\input{\\bibliotecasDir/estilo}%",
    "  }{%",
    "    \\IfFileExists{./bibliotecas_latex/estilo.tex}{%",
    "      \\providecommand{\\bibliotecasDir}{./bibliotecas_latex}%",
    "      \\input{\\bibliotecasDir/estilo}%",
    "    }{%",
    "      \\usepackage[spanish,es-tabla]{babel}",
    "      \\usepackage[table]{xcolor}",
    "      \\usepackage{needspace}",
    "      \\usepackage{amsmath,amssymb}",
    "      \\usepackage{array,booktabs}",
    "      \\usepackage{tikz}",
    "      \\usepackage[most]{tcolorbox}",
    "      \\tcbuselibrary{listings,skins,breakable}",
    "      \\usepackage{listings}",
    "    }%",
    "  }%",
    "}",
    "\\usepackage[hidelinks]{hyperref}",
    styleInput,
  ];

  if (!(await existeArchivo(target))) {
    const sortedChildren = children.sort(
      (a, b) =>
        Number(a.name.split(".").at(-1)) - Number(b.name.split(".").at(-1)),
    );
    const carpetasNombres = sortedChildren.map((item) => item.name);
    const inputLines = await recolectarInputsDeCarpetas(carpetasNombres);
    const bookmark = crearNombreArchivo(`${subject}-tema${theme}`, 80);
    const content = [
      ...paquetesRequeridos,
      "\\begin{document}",
      "\\paletaAzul",
      `\\titulo{TEMA ${theme}}{${escaparLatex(limpiarNombreInstitucion(title))}}`,
      "\\usarfondo",
      "\\renewcommand{\\contentsname}{Índice}",
      "\\setcounter{tocdepth}{2}",
      `\\pdfbookmark[0]{Índice}{${bookmark}}`,
      "{\\color{black}\\tableofcontents}",
      "\\clearpage",
      ...inputLines,
      "\\end{document}",
      "",
    ].join("\n");
    await writeFile(target, content, "utf8");
    return { path: target, created: true };
  }
  {
    const original = await readFile(target, "utf8");
    const beginDocument = original.indexOf("\\begin{document}");
    const endDocument = original.indexOf("\\end{document}");
    if (beginDocument < 0 || (endDocument >= 0 && endDocument < beginDocument))
      throw new Error(`El documento ${target} no tiene una estructura LaTeX válida.`);
    const preamble = original.slice(0, beginDocument);
    const body = original.slice(
      beginDocument + "\\begin{document}".length,
      endDocument < 0 ? original.length : endDocument,
    );

    const carpetasEnDoc = [
      ...original.matchAll(/\\input(?:carpeta)?\{([^}]+)\}/g),
    ].map((m) => {
      const p = m[1];
      return p.includes("/") ? p.split("/")[0] : p;
    }).filter((c) => new RegExp(`^Tema ${theme}\\.\\d+$`, "i").test(c));

    const carpetasEnDisco = children.map((item) => item.name);
    const todasLasCarpetas = Array.from(
      new Set([...carpetasEnDoc, ...carpetasEnDisco]),
    ).sort((a, b) => {
      const numA = Number(a.split(".").at(-1)) || 0;
      const numB = Number(b.split(".").at(-1)) || 0;
      return numA - numB;
    });

    const inputLines = await recolectarInputsDeCarpetas(todasLasCarpetas);

    const preambleLines = preamble
      .split("\n")
      .filter(
        (line) =>
          line.trim() !== styleInput &&
          !/^\\input(?:carpeta)?\{[^{}]+\}$/.test(line.trim()),
      );
    const normalizedBody = body
      .split("\n")
      .filter(
        (line) =>
          line.trim() !== styleInput &&
          !/^\\input(?:carpeta)?\{[^{}]+\}$/.test(line.trim()),
      )
      .join("\n")
      .replace(
        /(?:\{\s*)*\\color\{black\}\s*\\tableofcontents(?:\s*\})*|\\tableofcontents/,
        "{\\color{black}\\tableofcontents}",
      );
    const bodyConIndice = normalizedBody.includes("\\setcounter{tocdepth}{2}")
      ? normalizedBody
      : normalizedBody.replace(
          "{\\color{black}\\tableofcontents}",
          "\\setcounter{tocdepth}{2}\n{\\color{black}\\tableofcontents}",
        );
    let bodySinCarpeta = bodyConIndice.replace(
      /\\titulo\{[^{}]*·\s*TEMA\s*\d+\}\{([^{}]*)\}/,
      `\\titulo{TEMA ${theme}}{$1}`,
    );
    if (title && !/^tema\s*\d+$/i.test(title.trim())) {
      bodySinCarpeta = bodySinCarpeta.replace(
        /\\titulo\{TEMA\s*\d+\}\{[^{}]*\}/,
        `\\titulo{TEMA ${theme}}{${escaparLatex(limpiarNombreInstitucion(title))}}`,
      );
    }
    const bodyLines = bodySinCarpeta.split("\n");
    const clearPageIndex = bodyLines.findIndex((line) =>
      line.includes("\\clearpage"),
    );
    const insertionIndex =
      clearPageIndex >= 0
        ? clearPageIndex + 1
        : bodyLines.findIndex((line) => line.trim()) + 1;
    bodyLines.splice(insertionIndex, 0, ...inputLines);

    // Asegurar paquetes esenciales y biblioteca oficial WEC en preámbulo
    const finalPreamble = paquetesRequeridos.slice(0, -1).join("\n");
    const updatedPreamble = `${finalPreamble}\n${styleInput}\n`;
    const updated = `${updatedPreamble}\\begin{document}${bodyLines.join("\n")}${
      endDocument < 0 ? "" : `\\end{document}${original.slice(endDocument + "\\end{document}".length)}`
    }`;
    if (updated !== original) {
      await writeFile(target, updated, "utf8");
    }
  }
  return { path: target, created: false };
}
