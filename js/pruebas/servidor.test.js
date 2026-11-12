import assert from "node:assert/strict";
import { createServer } from "node:http";
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
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  analizarListaImagenesPdf,
  esImagenPdfRelevante,
  textoPdf,
} from "../modulos/material.js";
import { detectarBloquesCodigo } from "../modulos/deteccion-codigo.js";

const raizAplicacion = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Imagen de prueba con contenido (ruido determinista): una imagen de un solo
// color se descarta a propósito por no aportar información.
function imagenConContenido(bytes) {
  const datos = Buffer.alloc(bytes);
  let estado = 123456789;
  for (let i = 0; i < bytes; i += 1) {
    estado ^= estado << 13;
    estado ^= estado >>> 17;
    estado ^= estado << 5;
    datos[i] = estado & 255;
  }

  return datos;
}

test("detecta código válido sin clasificar texto con palabras parecidas", () => {
  const resultado = detectarBloquesCodigo(
    [
      "Una constante importante explica el concepto.",
      "",
      "const alumno = { nombre: 'Ana', nota: 8 };",
      "console.log(alumno.nombre);",
      "",
      "El texto continúa después del ejemplo.",
    ].join("\n"),
  );

  assert.deepEqual(resultado.bloques, [
    "const alumno = { nombre: 'Ana', nota: 8 };\nconsole.log(alumno.nombre);",
  ]);
  assert.match(resultado.texto, /Una constante importante/);
  assert.match(resultado.texto, /El texto continúa/);
});

test("extrae código incrustado dentro de una línea de texto", () => {
  const resultado = detectarBloquesCodigo(
    "Texto introductorio: const total = 2 + 2; y explicación posterior.",
  );

  assert.deepEqual(resultado.bloques, ["const total = 2 + 2;"]);
  assert.equal(
    resultado.texto,
    "Texto introductorio:  y explicación posterior.",
  );
});

function crearPdfTexto(
  texto,
  incluirImagen = false,
  anchoImagen = 160,
  altoImagen = 120,
) {
  const escapar = (valor) =>
    valor.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const lineas = String(texto).match(/.{1,80}/g) ?? [""];
  const altoPagina = Math.max(792, lineas.length * 16 + 40);
  const contenido = [
    `BT /F1 14 Tf 50 ${altoPagina - 30} Td`,
    ...lineas.map((linea, indice) =>
      `${indice ? "0 -16 Td " : ""}(${escapar(linea)}) Tj`,
    ),
    "ET",
    ...(incluirImagen ? ["q 100 0 0 100 400 600 cm /Im0 Do Q"] : []),
  ].join(" ");
  const objetos = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${altoPagina}] /Resources << /Font << /F1 5 0 R >>${incluirImagen ? " /XObject << /Im0 6 0 R >>" : ""} >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(contenido)} >>\nstream\n${contenido}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  if (incluirImagen) {
    objetos.push(
      Buffer.concat([
        Buffer.from(
          `6 0 obj\n<< /Type /XObject /Subtype /Image /Width ${anchoImagen} /Height ${altoImagen} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${anchoImagen * altoImagen * 3} >>\nstream\n`,
          "ascii",
        ),
        imagenConContenido(anchoImagen * altoImagen * 3),
        Buffer.from("\nendstream\nendobj\n", "ascii"),
      ]),
    );
  }
  const partes = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  let longitud = partes[0].length;
  for (const [indice, objeto] of objetos.entries()) {
    offsets.push(longitud);
    const bytes = Buffer.isBuffer(objeto)
      ? objeto
      : Buffer.from(`${indice + 1} 0 obj\n${objeto}\nendobj\n`, "ascii");
    partes.push(bytes);
    longitud += bytes.length;
  }
  const xref = longitud;
  const filas = [
    "xref",
    `0 ${objetos.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
  ];
  partes.push(
    Buffer.from(
      `${filas.join("\n")}\ntrailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      "ascii",
    ),
  );
  return Buffer.concat(partes);
}

test("usa el texto extraíble del PDF sin generar OCR ni imágenes", async () => {
  const texto = "Texto de prueba extraible del PDF. ".repeat(8);
  const resultado = await textoPdf("texto.pdf", crearPdfTexto(texto));

  assert.match(resultado.text, /Texto de prueba extraible del PDF/);
  assert.equal(resultado.imagesOcr, 0);
  assert.deepEqual(resultado.visuals, []);
});

test("extrae y envía la imagen incrustada aunque la página ya tenga texto", async () => {
  const texto = "Texto de pagina que debe conservarse sin sustituir. ".repeat(8);
  const resultado = await textoPdf(
    "pagina-con-imagen.pdf",
    crearPdfTexto(texto, true),
  );

  assert.match(resultado.text, /Texto de pagina que debe conservarse/);
  assert.equal(resultado.visuals.length, 1);
  assert.match(resultado.visuals[0].name, /página 1 · imagen 1/);
  const imagen = Buffer.from(resultado.visuals[0].data, "base64");
  assert.deepEqual([...imagen.subarray(0, 8)], [
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  assert.equal(imagen.readUInt32BE(16), 160);
  assert.equal(imagen.readUInt32BE(20), 120);
});

test("ignora los recursos gráficos diminutos y conserva el texto del PDF", async () => {
  const texto = "El contenido textual se conserva aunque el gráfico sea decorativo. ".repeat(4);
  const resultado = await textoPdf(
    "pagina-con-icono.pdf",
    crearPdfTexto(texto, true, 2, 2),
  );

  assert.match(resultado.text, /contenido textual se conserva/);
  assert.deepEqual(resultado.visuals, []);
});

test("identifica imágenes reales y descarta máscaras y recursos pequeños", () => {
  const paginas = analizarListaImagenesPdf([
    " page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio",
    " 1 0 image 640 480 rgb 3 8 jpeg yes 5 0 100 100 20K 3%",
    " 1 1 smask 640 480 gray 1 8 image no 5 0 100 100 2K 1%",
    " 1 2 image 23 757 rgb 3 8 image no 7 0 101 100 73B 0.1%",
  ].join("\n"));

  assert.deepEqual(paginas.get(1), [
    { tipo: "image", ancho: 640, alto: 480 },
    { tipo: "smask", ancho: 640, alto: 480 },
    { tipo: "image", ancho: 23, alto: 757 },
  ]);
  assert.equal(esImagenPdfRelevante(paginas.get(1)[0]), true);
  assert.equal(esImagenPdfRelevante(paginas.get(1)[1]), false);
  assert.equal(esImagenPdfRelevante(paginas.get(1)[2]), false);
});

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

test("la web genera apuntes, guarda el informe, reutiliza la última generación y permite mejorar LaTeX", async (t) => {
  const carpetaPruebas = await mkdtemp(
    path.join(os.tmpdir(), "servidor-apuntes-"),
  );
  const carpetaApuntes = path.join(carpetaPruebas, "apuntes-privados");
  const carpetaInformes = path.join(carpetaPruebas, "informes-generacion");
  let llamadasIA = 0;
  let etapaPdfVisibleEnCodigo = false;
  let promptCodigoConTemaPdf = false;
  let promptCodigoConFuente = false;
  let promptCodigoConCondicion = false;
  let fallarUnaVezPdfEtapas = false;
  let fallarUnaVezPdfSinApartados = false;
  let fallarUnaVezCodigoEtapas = false;
  let fallarUnaVezSinApartadosNormal = false;
  const ordenEtapas = [];
  const instruccionesRecibidas = [];
  const rellenoPrueba = (prompt) =>
    "Explicación de prueba. ".repeat(
      Math.max(1, Math.ceil(prompt.length / 22)),
    );
  const servidorIA = createServer(async (peticion, respuesta) => {
    if (peticion.url === "/api/tags") {
      respuesta.writeHead(200, { "content-type": "application/json" });
      respuesta.end(JSON.stringify({ models: [{ name: "qwen2.5vl:7b" }] }));
      return;
    }
    if (peticion.url === "/api/chat") {
      let contenido = "";
      for await (const trozo of peticion) contenido += trozo;
      const datos = JSON.parse(contenido);
      llamadasIA += 1;
      instruccionesRecibidas.push(datos.messages[1].content);
      if (datos.messages[1].content.includes("PRUEBA_CANCELACION")) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          respuesta.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (respuesta.destroyed) return;
      }
      const prompt = datos.messages[1].content;
      const temaAutomatico = prompt.includes(
        "NÚMERO DE TEMA: detectar según el material",
      );
      let salida;
      if (prompt.includes("OBJETIVO: convierte exclusivamente el código fuente recibido")) {
        ordenEtapas.push("codigo");
        const pdfGuardado = path.join(
          carpetaApuntes,
          "Etapas",
          "Tema 1",
          "Tema 1.1",
          "1-1-fundamentos.tex",
        );
        etapaPdfVisibleEnCodigo = await readdir(path.dirname(pdfGuardado))
          .then((archivos) =>
            archivos.some((archivo) => archivo.startsWith("1-1-fundamentos")),
          )
          .catch(() => false);
        if (fallarUnaVezCodigoEtapas) {
          fallarUnaVezCodigoEtapas = false;
          respuesta.writeHead(503, { "content-type": "application/json" });
          respuesta.end(JSON.stringify({ error: "Fallo transitorio simulado." }));
          return;
        }
        promptCodigoConTemaPdf = /Conceptos: Idea principal/.test(prompt);
        promptCodigoConCondicion = /if \(activo\)/.test(prompt);
        promptCodigoConFuente =
          /proyecto\.zip\/src\/condicional\.js/.test(prompt);
        salida = {
          apartados: [
            {
              tema_existente: 1,
              titulo_tema: "Fundamentos de programación",
              titulo_subtema: "Aplicación práctica",
              titulo: "Condicional if",
              nombre: "condicional-if",
              conceptos: ["Ejecución condicional"],
              latex:
                "\\secciongrande{Condicionales}\nEl bloque se ejecuta si la condición es verdadera.",
            },
          ],
        };
      } else if (prompt.includes("ETAPA_PDF:")) {
        if (fallarUnaVezPdfEtapas) {
          fallarUnaVezPdfEtapas = false;
          respuesta.writeHead(500, { "content-type": "application/json" });
          respuesta.end(
            JSON.stringify({
              error: "prediction aborted, token repeat limit reached",
            }),
          );
          return;
        }
        if (
          fallarUnaVezPdfSinApartados &&
          !prompt.includes("CORRECCIÓN OBLIGATORIA")
        ) {
          fallarUnaVezPdfSinApartados = false;
          salida = { resumen: "Respuesta sin apartados LaTeX." };
        } else {
          if (prompt.includes("CORRECCIÓN OBLIGATORIA"))
            instruccionesRecibidas.push("REINTENTO_DE_FORMATO");
          salida = {
            tema_existente: 0,
            titulo_tema: "Fundamentos de programación",
            titulo_subtema: "Aplicación práctica",
            conceptos_clave: ["Idea principal"],
            cobertura: [
              {
                concepto: "Idea principal",
                estado: "incluido",
                apartado: "Aplicación práctica",
              },
            ],
            archivos: [
              {
                titulo: "Fundamentos",
                nombre: "1.1-fundamentos",
                conceptos: ["Idea principal"],
                latex:
                  "\\secciongrande{Fundamentos}\n\\resumen{Síntesis de prueba.}\nTexto de prueba para comprender. " +
                  rellenoPrueba(prompt),
              },
            ],
            imagenes: [],
            fuentes: [],
          };
        }
        ordenEtapas.push("pdf");
      } else if (prompt.includes("TEXTO SELECCIONADO")) {
        salida = {
          explicacion: "Explicación sencilla.",
          reemplazo_latex: "\\seccion{Idea explicada}",
          anadido_latex: "\\nota{Ejemplo}{Un ejemplo original.}",
        };
      } else if (
        fallarUnaVezSinApartadosNormal &&
        !prompt.includes("CORRECCIÓN OBLIGATORIA")
      ) {
        fallarUnaVezSinApartadosNormal = false;
        salida = { resumen: "Respuesta sin apartados LaTeX." };
      } else {
        if (prompt.includes("CORRECCIÓN OBLIGATORIA"))
          instruccionesRecibidas.push("REINTENTO_NORMAL");
        salida = {
          tema_existente: temaAutomatico ? 1 : 0,
          titulo_tema: "Fundamentos de programación",
          titulo_subtema: temaAutomatico
            ? "Aplicación práctica"
            : "Conceptos básicos y aplicación",
          conceptos_clave: ["Idea principal"],
          cobertura: [
            {
              concepto: "Idea principal",
              estado: "incluido",
              apartado: "Fundamentos",
            },
          ],
          archivos: [
            {
              titulo: "Fundamentos",
              nombre: "1.1-fundamentos",
              conceptos: ["Idea principal"],
              latex:
                "\\secciongrande{Fundamentos}\n\\resumen{Síntesis de prueba.}\nTexto de prueba para comprender. " +
                rellenoPrueba(prompt),
            },
          ],
          imagenes: [],
          fuentes: [],
        };
      }
      respuesta.writeHead(200, { "content-type": "application/json" });
      respuesta.end(
        JSON.stringify({ message: { content: JSON.stringify(salida) } }),
      );
      return;
    }
    respuesta.writeHead(404);
    respuesta.end();
  });
  await new Promise((resolve) => servidorIA.listen(0, "127.0.0.1", resolve));
  const puertoIA = servidorIA.address().port;
  const servidorWeb = createServer();
  await new Promise((resolve) => servidorWeb.listen(0, "127.0.0.1", resolve));
  const puertoWeb = servidorWeb.address().port;
  await new Promise((resolve) => servidorWeb.close(resolve));

  const proceso = spawn(process.execPath, ["js/servidor.js"], {
    cwd: raizAplicacion,
    env: {
      ...process.env,
      PORT: String(puertoWeb),
      RUTA_APUNTES_CONTENEDOR: carpetaApuntes,
      RUTA_INFORMES_GENERACION: carpetaInformes,
      DIRECCION_OLLAMA: `http://127.0.0.1:${puertoIA}`,
      MODELO_IA: "qwen2.5vl:7b",
      CONCURRENCIA_IA: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let registros = "";
  proceso.stdout.on("data", (chunk) => {
    registros += chunk.toString();
  });
  proceso.stderr.on("data", (chunk) => {
    registros += chunk.toString();
  });
  t.after(async () => {
    proceso.kill("SIGTERM");
    servidorIA.close();
    await rm(carpetaPruebas, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${puertoWeb}`;
  let listo = false;
  for (let intento = 0; intento < 60; intento += 1) {
    if (proceso.exitCode !== null) break;
    try {
      const respuesta = await fetch(`${base}/api/health`);
      if (respuesta.ok) {
        listo = true;
        break;
      }
    } catch {
      await sleep(100);
    }
  }
  assert.equal(
    listo,
    true,
    `El servidor no inició correctamente: ${registros}`,
  );

  const portada = await fetch(base);
  assert.equal(portada.status, 200);
  const paginaGeneradorHtml = await portada.text();
  assert.match(paginaGeneradorHtml, /Generador de apuntes/);
  assert.match(paginaGeneradorHtml, /id="selector-tema"/);
  assert.match(paginaGeneradorHtml, /TEMA · OPCIONAL/);
  assert.match(paginaGeneradorHtml, /APARTADO · OPCIONAL/);
  assert.doesNotMatch(paginaGeneradorHtml, /id="selector-tema"[^>]*required/);
  assert.doesNotMatch(paginaGeneradorHtml, /id="selector-apartado"[^>]*required/);
  assert.match(paginaGeneradorHtml, /id="sustituir-existentes"/);
  assert.match(
    paginaGeneradorHtml,
    /únicamente los archivos y el texto que\s+añadas ahora/,
  );
  assert.doesNotMatch(
    paginaGeneradorHtml,
    /todas las asignaturas y temas/,
  );
  const htmlCargaEnDisco = await readFile(
    path.join(raizAplicacion, "interfaz", "cargando.html"),
    "utf8",
  );
  assert.match(htmlCargaEnDisco, /id="ruta-apuntes"/);
  assert.match(htmlCargaEnDisco, /id="elegir-carpeta"/);
  assert.match(htmlCargaEnDisco, /id="iniciar-generador"/);
  assert.match(paginaGeneradorHtml, /id="selector-apartado"/);
  assert.match(paginaGeneradorHtml, /id="lista-pasos-progreso"/);
  assert.match(paginaGeneradorHtml, /id="detalle-progreso"/);
  assert.match(
    paginaGeneradorHtml,
    /<label\s+id="boton-elegir-archivos"[\s\S]*?<input\s+id="selector-archivos"\s+type="file"/,
  );
  assert.match(
    paginaGeneradorHtml,
    /<label\s+id="boton-elegir-carpeta"[\s\S]*?<input\s+id="selector-carpeta"\s+type="file"\s+multiple\s+webkitdirectory/,
  );
  assert.match(paginaGeneradorHtml, /id="texto-fuente"/);
  assert.doesNotMatch(paginaGeneradorHtml, /id="texto-fuente"[\s\S]*?maxlength=/);
  assert.match(paginaGeneradorHtml, /Selecciona o arrastra PDF, ZIP o código/);
  const interfazGenerador = await fetch(`${base}/js/interfaz.js`);
  assert.equal(interfazGenerador.status, 200);
  const codigoInterfazGenerador = await interfazGenerador.text();
  assert.match(codigoInterfazGenerador, /zonaArchivos\.addEventListener\("drop"/);
  assert.match(codigoInterfazGenerador, /guardarBorradorFuentes/);
  const persistenciaGenerador = await fetch(
    `${base}/js/persistencia-archivos.js`,
  );
  assert.equal(persistenciaGenerador.status, 200);
  assert.doesNotMatch(
    paginaGeneradorHtml,
    /La IA trabaja en tu equipo; los iconos se cargan desde un CDN/,
  );
  assert.doesNotMatch(paginaGeneradorHtml, /research-query|research-field/);
  assert.match(
    paginaGeneradorHtml,
    /cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome/,
  );
  assert.match(paginaGeneradorHtml, /fa-book-open/);
  const paginaMejorar = await fetch(`${base}/mejorar`);
  assert.equal(paginaMejorar.status, 200);
  const paginaMejorarHtml = await paginaMejorar.text();
  assert.match(
    paginaMejorarHtml,
    /cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome/,
  );
  assert.match(paginaMejorarHtml, /fa-arrow-left/);
  for (const id of [
    "selector-asignatura",
    "selector-apunte",
    "contenido-apunte",
    "consulta",
    "archivos-apoyo",
    "boton-mejorar",
    "estado-modelo",
    "panel-error",
  ]) {
    assert.ok(
      paginaMejorarHtml.includes(`id="${id}"`),
      `Falta el identificador traducido ${id}.`,
    );
  }
  assert.match(paginaGeneradorHtml, /href="\/css\/estilos\.css"/);
  assert.match(paginaGeneradorHtml, /src="\/js\/interfaz\.js(?:\?v=[^"]*)?"/);
  const scriptInterfaz = await fetch(`${base}/js/interfaz.js`);
  assert.equal(scriptInterfaz.status, 200);
  const codigoInterfaz = await scriptInterfaz.text();
  assert.match(codigoInterfaz, /selectorCarpeta\.addEventListener\("change"/);
  assert.doesNotMatch(codigoInterfaz, /selector(?:Archivos|Carpeta)\.click\(\)/);
  assert.match(codigoInterfaz, /datos\.append\("source_text", textoFuente\.value\)/);
  assert.match(codigoInterfaz, /solo con los apuntes de esta asignatura/);
  const scriptMejorar = await fetch(`${base}/js/mejorar.js`);
  assert.equal(scriptMejorar.status, 200);
  const hojaEstilos = await fetch(`${base}/css/estilos.css`);
  assert.equal(hojaEstilos.status, 200);
  assert.match(
    await hojaEstilos.text(),
    /\.upload-card input\[type="file"\]\s*\{[^}]*position:\s*static;[^}]*width:\s*100%;[^}]*height:\s*auto;/s,
  );
  assert.match(codigoInterfaz, /Se ha activado el selector de archivos de Brave/);
  assert.match(codigoInterfaz, /Detectar tema según el material/);
  assert.match(codigoInterfaz, /\/api\/staged-generations\/\$\{encodeURIComponent\(id\)\}\/save/);
  assert.match(codigoInterfaz, /Historial completo de/);
  const estiloCarga = await fetch(`${base}/css/cargando.css`);
  assert.equal(estiloCarga.status, 200);
  const scriptCarga = await fetch(`${base}/js/cargando.js`);
  assert.equal(scriptCarga.status, 200);
  assert.match(await scriptCarga.text(), /formatearProgresoDescarga/);
  const utilidadSalida = await fetch(`${base}/js/formato-salida.js`);
  assert.equal(utilidadSalida.status, 200);
  const paginaCarga = await fetch(`${base}/interfaz/cargando.html`);
  assert.equal(paginaCarga.status, 200);
  const htmlCarga = await paginaCarga.text();
  assert.match(htmlCarga, /cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome/);
  assert.match(htmlCarga, /fa-book-open/);
  assert.match(htmlCarga, /href="\/css\/cargando\.css"/);
  assert.match(htmlCarga, /src="\/js\/cargando\.js"/);
  assert.doesNotMatch(htmlCarga, /<style\b|<script\s*>/);

  const rutaApunteMismaAsignatura = path.join(
    carpetaApuntes,
    "Programación",
    "Tema 2",
    "Tema 2.1",
    "previo.tex",
  );
  const rutaApunteOtraAsignatura = path.join(
    carpetaApuntes,
    "OtraAsignatura",
    "Tema 1",
    "Tema 1.1",
    "ajeno.tex",
  );
  await mkdir(path.dirname(rutaApunteMismaAsignatura), { recursive: true });
  await mkdir(path.dirname(rutaApunteOtraAsignatura), { recursive: true });
  await writeFile(
    rutaApunteMismaAsignatura,
    "\\secciongrande{Idea exclusiva de Programación}\n\nEsta asignatura ya explicó el concepto que debe reconocerse como previo.",
  );
  await writeFile(
    rutaApunteOtraAsignatura,
    "\\secciongrande{Contenido ajeno de otra materia}\n\nEsta frase de otra asignatura no debe enviarse al contexto de generación.",
  );

  async function generar() {
    const formulario = new FormData();
    formulario.append("progress_id", "11111111-1111-4111-8111-111111111111");
    formulario.append("subject", "Programación");
    formulario.append("tema", "1");
    formulario.append("tema_nombre", "Fundamentos");
    formulario.append("subtema", "1");
    formulario.append("subtema_nombre", "Conceptos básicos");
    formulario.append("user_prompt", "Explica los conceptos.");
    formulario.append(
      "files",
      new Blob(["Idea original del tema"], { type: "text/plain" }),
      "tema.txt",
    );
    return fetch(`${base}/api/generate`, { method: "POST", body: formulario });
  }

  const respuestaGeneracion = await generar();
  assert.equal(respuestaGeneracion.status, 200);
  const respuestaProgreso = await fetch(
    `${base}/api/progress/11111111-1111-4111-8111-111111111111`,
  );
  assert.equal(respuestaProgreso.status, 200);
  const progresoFinal = await respuestaProgreso.json();
  assert.equal(progresoFinal.fase, "completado");
  assert.match(progresoFinal.detalle, /LaTeX guardado/);
  const resultado = await respuestaGeneracion.json();
  assert.equal(resultado.cobertura[0].estado, "incluido");
  assert.equal(resultado.salida.written.length, 1);
  assert.equal(resultado.cached, false);
  assert.equal(resultado.titulo_tema, "Fundamentos");
  assert.equal(resultado.titulo_subtema, "Conceptos básicos y aplicación");
  assert.match(instruccionesRecibidas[0], /NÚMERO DE TEMA \(mantener exactamente\): 1/);
  assert.match(instruccionesRecibidas[0], /TÍTULO\/PISTA DEL TEMA: Fundamentos/);
  assert.match(instruccionesRecibidas[0], /NÚMERO DE APARTADO \(mantener exactamente\): 1\.1/);
  assert.match(instruccionesRecibidas[0], /TÍTULO\/PISTA DEL APARTADO: Conceptos básicos/);
  assert.doesNotMatch(
    instruccionesRecibidas[0],
    /Esta asignatura ya explicó el concepto que debe reconocerse como previo/,
  );
  assert.doesNotMatch(instruccionesRecibidas[0], /Contenido ajeno de otra materia/);
  const respuestaAsignaturas = await fetch(`${base}/api/subjects`);
  const asignaturasGeneradas = (await respuestaAsignaturas.json()).asignaturas;
  const asignaturaGenerada = asignaturasGeneradas.find(
    (asignatura) => asignatura.nombre === "Programación",
  );
  assert.equal(asignaturaGenerada.temas[0].titulo, "Fundamentos");
  assert.deepEqual(asignaturaGenerada.temas[0].apartados, [
    { numero: 1, nombre: "Conceptos básicos y aplicación" },
  ]);
  const informe = path.join(
    carpetaInformes,
    "Programación",
    "tema-1-apartado-1",
  );
  const ultima = JSON.parse(
    await readFile(path.join(informe, "ultima-generacion.json"), "utf8"),
  );
  const cobertura = JSON.parse(
    await readFile(path.join(informe, "cobertura.json"), "utf8"),
  );
  assert.equal(ultima.fingerprint, cobertura.fingerprint);
  assert.equal(ultima.titulo_tema, "Fundamentos");
  assert.equal(ultima.titulo_subtema, "Conceptos básicos y aplicación");
  await assert.rejects(
    readFile(
      path.join(
        carpetaApuntes,
        "Programación",
        "Tema 1",
        "Tema 1.1",
        "ultima-generacion.json",
      ),
      "utf8",
    ),
    { code: "ENOENT" },
  );

  const respuestaRepetida = await generar();
  assert.equal(respuestaRepetida.status, 200);
  const repetido = await respuestaRepetida.json();
  assert.equal(repetido.cached, true);
  assert.equal(repetido.salida.written.length, 1);
  assert.equal(llamadasIA, 1);

  const formularioTexto = new FormData();
  formularioTexto.append("subject", "Programación");
  formularioTexto.append("tema", "2");
  formularioTexto.append("tema_nombre", "Texto pegado");
  formularioTexto.append("subtema", "1");
  formularioTexto.append("subtema_nombre", "Fuente directa");
  const materialLargo =
    "INICIO DEL TEXTO PEGADO" +
    " concepto".repeat(20000) +
    " FINAL DEL TEXTO PEGADO";
  formularioTexto.append("source_text", materialLargo);
  const respuestaTexto = await fetch(`${base}/api/generate`, {
    method: "POST",
    body: formularioTexto,
  });
  assert.equal(respuestaTexto.status, 200);
  assert.equal((await respuestaTexto.json()).archivos_procesados, 1);
  assert.equal(llamadasIA, 33);
  assert.match(
    instruccionesRecibidas.slice(1).join("\n"),
    /INICIO DEL TEXTO PEGADO/,
  );
  assert.match(
    instruccionesRecibidas.slice(1).join("\n"),
    /FINAL DEL TEXTO PEGADO/,
  );

  const idCancelacion = "22222222-2222-4222-8222-222222222222";
  const formularioCancelacion = new FormData();
  formularioCancelacion.append("progress_id", idCancelacion);
  formularioCancelacion.append("subject", "Cancelada");
  formularioCancelacion.append("tema", "1");
  formularioCancelacion.append("tema_nombre", "Prueba de cancelación");
  formularioCancelacion.append("subtema", "1");
  formularioCancelacion.append("subtema_nombre", "Cancelación");
  formularioCancelacion.append("source_text", "PRUEBA_CANCELACION");
  const generacionCancelada = fetch(`${base}/api/generate`, {
    method: "POST",
    body: formularioCancelacion,
  });
  let estadoCancelacion;
  for (let intento = 0; intento < 100; intento += 1) {
    const consulta = await fetch(`${base}/api/progress/${idCancelacion}`);
    if (consulta.ok) {
      estadoCancelacion = await consulta.json();
      if (estadoCancelacion.fase === "ia") break;
    }
    await sleep(20);
  }
  assert.equal(estadoCancelacion?.fase, "ia");
  const detener = await fetch(
    `${base}/api/progress/${idCancelacion}/cancel`,
    { method: "POST" },
  );
  assert.equal(detener.status, 200);
  const respuestaCancelada = await generacionCancelada;
  assert.equal(respuestaCancelada.status, 499);
  const progresoCancelado = await fetch(
    `${base}/api/progress/${idCancelacion}`,
  );
  assert.equal((await progresoCancelado.json()).fase, "cancelado");
  assert.deepEqual(
    (await (await fetch(`${base}/api/subjects`)).json()).asignaturas.map(
      (item) => item.nombre,
    ),
    ["OtraAsignatura", "Programación"],
  );

  const archivoRelativo = resultado.salida.written[0].relativo;
  const notaAbierta = await fetch(
    `${base}/api/notes/content?path=${encodeURIComponent(archivoRelativo)}`,
  );
  assert.equal(notaAbierta.status, 200);
  const contenidoOriginal = await notaAbierta.json();

  const formularioMejora = new FormData();
  formularioMejora.append("path", archivoRelativo);
  formularioMejora.append("selectedText", "Texto de prueba para comprender.");
  formularioMejora.append("question", "Explícalo mejor.");
  const respuestaMejora = await fetch(`${base}/api/improve`, {
    method: "POST",
    body: formularioMejora,
  });
  assert.equal(respuestaMejora.status, 200);
  const propuesta = await respuestaMejora.json();
  assert.match(propuesta.reemplazo_latex, /Idea explicada/);

  const guardar = await fetch(`${base}/api/notes/content`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: archivoRelativo,
      content: contenidoOriginal.content.replace(
        propuesta.selectedText,
        propuesta.reemplazo_latex,
      ),
      expectedSha256: contenidoOriginal.sha256,
    }),
  });
  assert.equal(guardar.status, 200);
  const conflicto = await fetch(`${base}/api/notes/content`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: archivoRelativo,
      content: "sobrescritura",
      expectedSha256: contenidoOriginal.sha256,
    }),
  });
  assert.equal(conflicto.status, 409);

  const asignaturas = await fetch(`${base}/api/subjects`);
  assert.deepEqual(
    (await asignaturas.json()).asignaturas.map((item) => item.nombre),
    ["OtraAsignatura", "Programación"],
  );
  const carpetaAsignatura = await fetch(`${base}/api/subjects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nombre: "Matemáticas" }),
  });
  assert.equal(carpetaAsignatura.status, 201);
  assert.deepEqual(await carpetaAsignatura.json(), { nombre: "Matemáticas" });
  assert.ok((await readdir(carpetaApuntes)).includes("Matemáticas"));
  const asignaturasActualizadas = await fetch(`${base}/api/subjects`);
  assert.deepEqual(
    (await asignaturasActualizadas.json()).asignaturas.map((item) => item.nombre),
    ["Matemáticas", "OtraAsignatura", "Programación"],
  );

  const generarAutomaticamente = async (contenido, progressId, reemplazar) => {
    const formulario = new FormData();
    formulario.append("progress_id", progressId);
    formulario.append("subject", "Programación");
    formulario.append("tema", "0");
    formulario.append("tema_nombre", "");
    formulario.append("subtema", "0");
    formulario.append("subtema_nombre", "");
    formulario.append("replace_existing", String(reemplazar));
    formulario.append(
      "files",
      new Blob([contenido], { type: "text/plain" }),
      "tema.txt",
    );
    return fetch(`${base}/api/generate`, {
      method: "POST",
      body: formulario,
    });
  };
  const automaticoId = "33333333-3333-4333-8333-333333333333";
  const generacionAutomatica = await generarAutomaticamente(
    "Material nuevo del tema existente.",
    automaticoId,
    false,
  );
  assert.equal(generacionAutomatica.status, 200);
  const resultadoAutomatico = await generacionAutomatica.json();
  assert.ok(
    instruccionesRecibidas.some((instruccion) =>
      instruccion.includes("MATERIAL MUY BREVE"),
    ),
  );
  assert.equal(resultadoAutomatico.tema, 1);
  assert.equal(resultadoAutomatico.subtema, 2);
  assert.equal(resultadoAutomatico.titulo_tema, "Fundamentos");
  assert.equal(resultadoAutomatico.titulo_subtema, "Aplicación práctica");
  assert.match(
    instruccionesRecibidas.at(-1),
    /NÚMERO DE TEMA: detectar según el material/,
  );
  assert.match(instruccionesRecibidas.at(-1), /- Tema 1: Fundamentos/);

  const reemplazoId = "44444444-4444-4444-8444-444444444444";
  const generacionConAviso = await generarAutomaticamente(
    "Material actualizado del tema existente.",
    reemplazoId,
    true,
  );
  assert.equal(generacionConAviso.status, 202);
  const avisoReemplazo = await generacionConAviso.json();
  assert.equal(avisoReemplazo.pendiente_confirmacion, true);
  assert.deepEqual(avisoReemplazo.archivos_cambiados, ["tema.txt"]);
  assert.deepEqual(avisoReemplazo.archivos_a_sustituir, [
    "Programación/Tema 1/Tema 1.2/1-1-fundamentos.tex",
  ]);
  const confirmacionReemplazo = await fetch(
    `${base}/api/generate/${reemplazoId}/save`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace_existing: true }),
    },
  );
  assert.equal(confirmacionReemplazo.status, 200);
  const reemplazoGuardado = await confirmacionReemplazo.json();
  assert.equal(reemplazoGuardado.tema, 1);
  assert.equal(reemplazoGuardado.subtema, 2);

  fallarUnaVezSinApartadosNormal = true;
  const reintentoNormalId = "66666666-6666-4666-8666-666666666666";
  const generacionReintentada = await generarAutomaticamente(
    "PRUEBA_REINTENTO_SIN_LATEX",
    reintentoNormalId,
    false,
  );
  assert.equal(generacionReintentada.status, 200);
  assert.ok(instruccionesRecibidas.includes("REINTENTO_NORMAL"));
  assert.equal(reemplazoGuardado.archivos_cambiados[0], "tema.txt");

  const historialCompleto = await fetch(
    `${base}/api/history?subject=Programaci%C3%B3n`,
  );
  assert.equal(historialCompleto.status, 200);
  const generaciones = (await historialCompleto.json()).historial;
  assert.equal(generaciones.length, 5);
  assert.ok(
    generaciones.every((informe) =>
      informe.archivos_procesados_detalle?.every(
        (archivo) => archivo.sha256.length === 64,
      ),
    ),
  );

  const trabajoId = "55555555-5555-4555-8555-555555555555";
  const solicitudEtapas = new FormData();
  solicitudEtapas.append("progress_id", trabajoId);
  solicitudEtapas.append("subject", "Etapas");
  solicitudEtapas.append("tema", "0");
  solicitudEtapas.append("subtema", "0");
  solicitudEtapas.append("replace_existing", "false");
  solicitudEtapas.append(
    "files",
    new Blob([
      crearPdfTexto("Condicionales de programación. ".repeat(100)),
    ], { type: "application/pdf" }),
    "condicionales.pdf",
  );
  solicitudEtapas.append(
    "files",
    new Blob([
      crearZipAlmacenado(
        "src/condicional.js",
        "function comprobar(activo) {\\n  if (activo) {\\n    ejecutar();\\n  }\\n}",
      ),
    ], { type: "application/zip" }),
    "proyecto.zip",
  );
  fallarUnaVezPdfEtapas = true;
  fallarUnaVezCodigoEtapas = true;
  const inicioEtapas = await fetch(`${base}/api/staged-generations`, {
    method: "POST",
    body: solicitudEtapas,
  });
  const cuerpoInicioEtapas = await inicioEtapas.json();
  assert.equal(
    inicioEtapas.status,
    202,
    `${JSON.stringify(cuerpoInicioEtapas)}\n${registros}`,
  );
  assert.deepEqual(cuerpoInicioEtapas, {
    id: trabajoId,
    estado: "pendiente",
  });
  let resultadoEtapas;
  for (let intento = 0; intento < 600; intento += 1) {
    const estadoRespuesta = await fetch(
      `${base}/api/staged-generations/${trabajoId}`,
    );
    assert.equal(estadoRespuesta.status, 200);
    resultadoEtapas = await estadoRespuesta.json();
    if (
      resultadoEtapas.estado === "completado" ||
      (resultadoEtapas.estado === "pendiente" && resultadoEtapas.error)
    )
      break;
    await sleep(50);
  }
  assert.equal(
    resultadoEtapas.estado,
    "completado",
    resultadoEtapas.error || registros,
  );
  assert.equal(etapaPdfVisibleEnCodigo, true);
  assert.deepEqual(
    ordenEtapas,
    ["pdf", "pdf", "pdf", "codigo", "codigo"],
  );
  assert.equal(etapaPdfVisibleEnCodigo, true);
  assert.equal(promptCodigoConTemaPdf, true);
  assert.equal(promptCodigoConFuente, true);
  assert.equal(promptCodigoConCondicion, true);
  assert.deepEqual(
    resultadoEtapas.resultados.map((item) => item.fase),
    ["pdf", "codigo"],
  );
  assert.deepEqual(
    resultadoEtapas.resultados.map((item) => `${item.tema}.${item.subtema}`),
    ["1.1", "1.1"],
  );
  const trabajoReintentoId = "66666666-6666-4666-8666-666666666666";
  fallarUnaVezPdfSinApartados = true;
  const solicitudReintentoFormato = new FormData();
  solicitudReintentoFormato.append("progress_id", trabajoReintentoId);
  solicitudReintentoFormato.append("subject", "EtapasReintento");
  solicitudReintentoFormato.append("tema", "1");
  solicitudReintentoFormato.append("subtema", "1");
  solicitudReintentoFormato.append("replace_existing", "false");
  solicitudReintentoFormato.append(
    "files",
    new Blob([crearPdfTexto("Texto para comprobar el reintento. ".repeat(20))], {
      type: "application/pdf",
    }),
    "reintento.pdf",
  );
  solicitudReintentoFormato.append(
    "files",
    new Blob([
      crearZipAlmacenado("src/index.js", "console.log('prueba');"),
    ], { type: "application/zip" }),
    "reintento.zip",
  );
  const inicioReintentoFormato = await fetch(
    `${base}/api/staged-generations`,
    { method: "POST", body: solicitudReintentoFormato },
  );
  assert.equal(inicioReintentoFormato.status, 202);
  let resultadoReintentoFormato;
  for (let intento = 0; intento < 200; intento += 1) {
    const estadoRespuesta = await fetch(
      `${base}/api/staged-generations/${trabajoReintentoId}`,
    );
    assert.equal(estadoRespuesta.status, 200);
    resultadoReintentoFormato = await estadoRespuesta.json();
    if (
      resultadoReintentoFormato.estado === "completado" ||
      (resultadoReintentoFormato.estado === "pendiente" &&
        resultadoReintentoFormato.error)
    )
      break;
    await sleep(50);
  }
  assert.equal(
    resultadoReintentoFormato.estado,
    "completado",
    resultadoReintentoFormato.error,
  );
  assert.ok(
    instruccionesRecibidas.some((instruccion) =>
      instruccion.includes("CORRECCIÓN OBLIGATORIA"),
    ),
  );
  const carpetaApartadoEtapas = path.join(
    carpetaApuntes,
    "Etapas",
    "Tema 1",
    "Tema 1.1",
  );
  const archivosEtapas = await readdir(carpetaApartadoEtapas);
  assert.equal(
    archivosEtapas.filter(
      (archivo) => archivo.endsWith(".tex") && archivo !== "carga.tex",
    ).length,
    4,
  );
});
