import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";

const cacheReferenciasGithub = new Map();
const tiempoLimiteGithubMs = 20_000;
const maximoArchivoBibliotecaGithubBytes = 50 * 1024 * 1024;
const maximoFuenteLatexGithubBytes = 4 * 1024 * 1024;

export function compactarReferenciaBiblioteca(referencia = "") {
  if (!referencia) return "";
  const marcaGuia = "GUÍA DE USO DE LAS MACROS PRINCIPALES";
  const posGuia = referencia.indexOf(marcaGuia);
  if (posGuia === -1) {
    return referencia.trim();
  }
  const posArchivos = referencia.search(/\n-\s+[a-zA-Z0-9_\-\/]+\.tex/);
  if (posArchivos !== -1 && posArchivos > posGuia) {
    return referencia.slice(posGuia, posArchivos).trim();
  }
  return referencia.slice(posGuia).trim();
}

export async function cargarReferenciaBiblioteca(raiz, solicitar = fetch) {
  const fuentes = esRepositorioGithub(raiz)
    ? await cargarFuentesGithub(raiz, solicitar)
    : await cargarFuentesLocales(raiz);
  if (!fuentes.length)
    throw new Error(`No hay archivos .tex en la biblioteca LaTeX: ${raiz}`);

  const entradas = await Promise.all(
    fuentes.map(({ ruta, contenido }) => {
      const fuente = contenido;
      const comentarios = fuente
        .split(/\r?\n/)
        .filter((linea) => /^\s*%/.test(linea))
        .map((linea) => linea.replace(/^\s*%\s?/, "").trim())
        .filter(Boolean);
      const comandos = [
        ...fuente.matchAll(
          /\\(?:newcommand|renewcommand|providecommand)\*?\s*\{\\?([A-Za-z@]+)\}(?:\[(\d+)\])?|\\(?:NewDocumentCommand|RenewDocumentCommand|newenvironment|renewenvironment|newtcblisting)\s*\{\\?([A-Za-z@]+)\}|\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@]+)/g,
        ),
      ]
        .filter((match) => {
          const inicioLinea = fuente.lastIndexOf("\n", match.index - 1) + 1;
          return !fuente.slice(inicioLinea, match.index).trimStart().startsWith("%");
        })
        .map(([, nombreMacro, argumentos, nombreEntorno, nombreDefinido]) => {
          const nombre = nombreMacro ?? nombreEntorno ?? nombreDefinido;
          return argumentos
            ? `\\${nombre} (${argumentos} argumentos)`
            : `\\${nombre}`;
        })
        .filter((comando) => !comando.includes("\\__") && !comando.includes("\\_"));
      return [
        `- ${ruta}`,
        comentarios.length
          ? `  Documentación de uso: ${comentarios.join(" ").replace(/\s+/g, " ")}`
          : "",
        comandos.length
          ? `  Comandos y entornos definidos: ${[...new Set(comandos)].join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  );
  return String.raw`Se han leído ${fuentes.length} archivos fuente .tex. Las fuentes tipográficas binarias no son instrucciones ni macros.
GUÍA DE USO DE LAS MACROS PRINCIPALES (REFERENCIA WEC Y DAW TEMA 1):
- Estructura: \secciongrande{Título} abre el apartado o tema principal y avanza el color de la paleta. Para cualquier subtítulo interno usa \subtituloA{Título} (o \subtituloB para detalles): es un subtítulo normal, sin barras y sin entrada en el índice. PROHIBIDO usar \seccion{Título} en el contenido generado porque dibuja una barra de color horizontal y añade una subsección al índice.
- Resumen: \resumen{Texto} coloca una caja pastel destacada con la idea central bajo el título de la sección grande.
- Definiciones: \definicion{Término}{Definición} crea una tarjeta destacada con pestaña; \definicionpar{Término}{Definición} es la tarjeta para encadenar definiciones paralelas de opciones, conceptos o tecnologías. Usa \cmd{...} para términos, comandos o código en línea.
- Pilares y rectángulos: \rectangulos{ {Título 1}{Texto 1} {Título 2}{Texto 2} ... } para 2, 3 o 4 conceptos paralelos; \rectangulosdoble{Concepto A}{\lista{...}}{Concepto B}{\lista{...}} para comparar dos conceptos opuestos.
- Avisos: \nota{Para el examen}{Texto} o \nota{Idea clave}{Texto} es una caja con barra lateral para aclaraciones o excepciones; \alertas{Texto} para advertencias concretas.
- Listas y pasos: \lista{**Etiqueta 1:** Elemento uno|**Etiqueta 2:** Elemento dos} crea viñetas con viñeta coloreada y negrita; \pasos{**Paso 1:** Paso uno|**Paso 2:** Paso dos} pasos numerados coloreados.
- Tablas: \tabla[L{5cm}L{11cm}]{\tablacab{Criterio} & \tablacab{Opción} \\ \midrule Dato & Valor \\} (\tablacab para cabeceras y \midrule tras ellas).
- Código y terminal: \begin{codigo}[Lenguaje] ... \end{codigo} para código fuente y \begin{consola} ... \end{consola} para terminal.
- Énfasis: \textbf{...} o **...** para negrita y \cmd{...} para código, comandos, rutas, etiquetas o nombres técnicos en línea.
${entradas.join("\n")}`;
}

async function cargarFuentesLocales(directorio) {
  const archivos = await listarFuentesLatex(directorio);
  return Promise.all(
    archivos.map(async (archivo) => ({
      ruta: path.relative(directorio, archivo).split(path.sep).join("/"),
      contenido: await readFile(archivo, "utf8"),
    })),
  );
}

function esRepositorioGithub(raiz) {
  return typeof raiz === "string" && /^https:\/\/github\.com\//i.test(raiz);
}

async function cargarFuentesGithub(urlRepositorio, solicitar) {
  const url = new URL(urlRepositorio);
  const partes = url.pathname.split("/").filter(Boolean);
  if (
    url.hostname !== "github.com" ||
    url.search ||
    url.hash ||
    partes.length !== 2
  ) {
    throw new Error(
      `La biblioteca GitHub debe ser una URL de repositorio, por ejemplo https://github.com/usuario/repositorio: ${urlRepositorio}`,
    );
  }

  const [propietario, nombreRepositorio] = partes;
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(propietario)}/${encodeURIComponent(nombreRepositorio)}/git/trees/main?recursive=1`;
  const respuestaArbol = await fetchGithub(apiUrl, solicitar);
  if (!respuestaArbol.ok) {
    if (
      respuestaArbol.status === 403 ||
      respuestaArbol.status === 429 ||
      respuestaArbol.status >= 500
    ) {
      try {
        const fuentes = await descargarBibliotecaGithubComoZip(
          propietario,
          nombreRepositorio,
          solicitar,
        );
        if (fuentes.length) return fuentes;
      } catch (error) {
        throw new Error(
          `GitHub no pudo consultar el árbol de la biblioteca (${respuestaArbol.status}) ni descargar el ZIP de respaldo: ${error.message}`,
          { cause: error },
        );
      }
    }
    throw new Error(
      `GitHub no pudo consultar el árbol de la biblioteca (${respuestaArbol.status}): ${apiUrl}`,
    );
  }
  const arbol = await respuestaArbol.json();
  if (arbol.truncated) {
    throw new Error(`GitHub devolvió un árbol incompleto para ${urlRepositorio}`);
  }
  if (!arbol.sha || !Array.isArray(arbol.tree)) {
    throw new Error(`GitHub devolvió un árbol inválido para ${urlRepositorio}`);
  }

  const claveCache = `${propietario}/${nombreRepositorio}@${arbol.sha}`;
  if (cacheReferenciasGithub.has(claveCache))
    return cacheReferenciasGithub.get(claveCache);

  const promesaFuentes = descargarFuentesGithub(
    propietario,
    nombreRepositorio,
    arbol.sha,
    arbol.tree,
    solicitar,
  );
  cacheReferenciasGithub.set(claveCache, promesaFuentes);
  try {
    return await promesaFuentes;
  } catch (error) {
    cacheReferenciasGithub.delete(claveCache);
    throw error;
  }
}

async function descargarBibliotecaGithubComoZip(
  propietario,
  repositorio,
  solicitar,
) {
  const url = `https://codeload.github.com/${encodeURIComponent(propietario)}/${encodeURIComponent(repositorio)}/zip/refs/heads/main`;
  const respuesta = await fetchGithub(url, solicitar);
  if (!respuesta.ok)
    throw new Error(`GitHub respondió ${respuesta.status} al descargar el ZIP.`);

  const fragmentos = [];
  let bytes = 0;
  for await (const fragmento of respuesta.body) {
    bytes += fragmento.length;
    if (bytes > maximoArchivoBibliotecaGithubBytes)
      throw new Error("El ZIP de la biblioteca supera el tamaño máximo permitido.");
    fragmentos.push(fragmento);
  }
  return leerFuentesLatexDeZip(Buffer.concat(fragmentos));
}

function leerFuentesLatexDeZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true },
      (errorAbrir, zip) => {
        if (errorAbrir) {
          reject(new Error(`GitHub devolvió un ZIP inválido: ${errorAbrir.message}`));
          return;
        }
        const fuentes = [];
        let terminada = false;
        const fallar = (error) => {
          if (terminada) return;
          terminada = true;
          zip.close();
          reject(error);
        };
        zip.on("error", fallar);
        zip.on("end", () => {
          if (terminada) return;
          terminada = true;
          resolve(fuentes.sort((a, b) => a.ruta.localeCompare(b.ruta)));
        });
        zip.on("entry", (entrada) => {
          const marcador = "bibliotecas_latex/";
          const inicio = entrada.fileName.indexOf(marcador);
          const ruta = inicio < 0 ? "" : entrada.fileName.slice(inicio + marcador.length);
          if (
            !ruta ||
            ruta.endsWith("/") ||
            ruta.split("/").some((parte) => parte === "." || parte === "..") ||
            path.posix.extname(ruta).toLowerCase() !== ".tex"
          ) {
            zip.readEntry();
            return;
          }
          if (entrada.uncompressedSize > maximoFuenteLatexGithubBytes) {
            fallar(new Error(`El archivo ${ruta} supera el tamaño máximo permitido.`));
            return;
          }
          zip.openReadStream(entrada, (errorFlujo, flujo) => {
            if (errorFlujo) {
              fallar(new Error(`No se pudo leer ${ruta} del ZIP: ${errorFlujo.message}`));
              return;
            }
            const partes = [];
            let bytesFuente = 0;
            flujo.on("data", (parte) => {
              bytesFuente += parte.length;
              if (bytesFuente > maximoFuenteLatexGithubBytes) {
                flujo.destroy(
                  new Error(`El archivo ${ruta} supera el tamaño máximo permitido.`),
                );
                return;
              }
              partes.push(parte);
            });
            flujo.on("error", fallar);
            flujo.on("end", () => {
              fuentes.push({
                ruta,
                contenido: Buffer.concat(partes).toString("utf8"),
              });
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

async function descargarFuentesGithub(
  propietario,
  repositorio,
  sha,
  arbol,
  solicitar,
) {
  const prefijoBiblioteca = "bibliotecas_latex/";
  const rutas = arbol
    .filter(
      (entrada) =>
        entrada.type === "blob" &&
        entrada.path.startsWith(prefijoBiblioteca) &&
        path.posix.extname(entrada.path).toLowerCase() === ".tex",
    )
    .map((entrada) => entrada.path)
    .sort((a, b) => a.localeCompare(b));
  const fuentes = [];
  for (let inicio = 0; inicio < rutas.length; inicio += 8) {
    const lote = rutas.slice(inicio, inicio + 8);
    fuentes.push(
      ...(await Promise.all(
        lote.map(async (rutaCompleta) => {
          const rutaCodificada = rutaCompleta
            .split("/")
            .map(encodeURIComponent)
            .join("/");
          const urlRaw = `https://raw.githubusercontent.com/${encodeURIComponent(propietario)}/${encodeURIComponent(repositorio)}/${sha}/${rutaCodificada}`;
          const respuesta = await fetchGithub(urlRaw, solicitar);
          if (!respuesta.ok) {
            throw new Error(
              `GitHub no pudo descargar ${rutaCompleta} (${respuesta.status})`,
            );
          }
          return {
            ruta: rutaCompleta.slice(prefijoBiblioteca.length),
            contenido: await respuesta.text(),
          };
        }),
      )),
    );
  }
  return fuentes;
}

function fetchGithub(url, solicitar) {
  return solicitar(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "generador-apuntes",
    },
    signal: AbortSignal.timeout(tiempoLimiteGithubMs),
  });
}

async function listarFuentesLatex(directorio) {
  const entradas = await readdir(directorio, { withFileTypes: true });
  const archivos = [];
  for (const entrada of entradas) {
    const ruta = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      archivos.push(...(await listarFuentesLatex(ruta)));
    } else if (
      entrada.isFile() &&
      path.extname(entrada.name).toLowerCase() === ".tex"
    ) {
      archivos.push(ruta);
    }
  }
  return archivos.sort((a, b) => a.localeCompare(b));
}

export async function procesarEnParalelo(elementos, concurrencia, procesar) {
  const resultados = new Array(elementos.length);
  let siguiente = 0;
  let falloEncontrado = false;
  let fallo;
  const trabajador = async () => {
    while (siguiente < elementos.length && !falloEncontrado) {
      const indice = siguiente;
      siguiente += 1;
      try {
        resultados[indice] = await procesar(elementos[indice], indice);
      } catch (error) {
        falloEncontrado = true;
        fallo ??= error;
      }
    }
  };
  const cantidadTrabajadores = Math.max(
    1,
    Math.min(elementos.length, concurrencia),
  );
  await Promise.all(
    Array.from({ length: cantidadTrabajadores }, () => trabajador()),
  );
  if (fallo) throw fallo;
  return resultados;
}
