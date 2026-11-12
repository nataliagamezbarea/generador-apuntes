import { spawn } from "node:child_process";
import { constants as permisos } from "node:fs";
import {
  access,
  copyFile,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as esperar } from "node:timers/promises";
import { formatearProgresoDescarga, limpiarSalida } from "./formato-salida.js";
import { detectarGeneradorIniciado } from "./deteccion-generador.js";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivoEntorno = path.join(raiz, ".env");
const archivoComposicion = path.join(raiz, "docker", "composicion.yaml");
const proyectoDocker = path.join(raiz, "docker");
const paginaCarga = path.join(raiz, "interfaz", "cargando.html");
const estado = {
  mensaje: "Preparando el generador de apuntes…",
  progreso: 0,
  registros: [],
  listo: false,
  error: "",
  direccion: "",
  rutaApuntes: "",
  carpetaValida: false,
  iniciando: false,
};
let puertoWeb = "8000";
let urlWeb = `http://127.0.0.1:${puertoWeb}`;

function actualizar(mensaje, progreso) {
  estado.mensaje = mensaje;
  if (progreso !== undefined) estado.progreso = progreso;
}

function registrar(texto) {
  for (const linea of limpiarSalida(texto)) {
    const progresoDescarga = formatearProgresoDescarga(linea);
    if (progresoDescarga) {
      const porcentaje = Number(progresoDescarga.match(/\d+/)?.[0] ?? 0);
      actualizar(
        progresoDescarga,
        Math.min(95, 60 + Math.floor(porcentaje * 0.35)),
      );
      if (estado.registros.at(-1)?.startsWith("Descarga del modelo:")) {
        estado.registros[estado.registros.length - 1] = progresoDescarga;
      } else {
        estado.registros.push(progresoDescarga);
      }
      continue;
    }
    if (estado.registros.at(-1) !== linea) {
      estado.registros.push(linea);
    }
  }
  estado.registros = estado.registros.slice(-12);
}

function ejecutar(comando, argumentos, mensaje) {
  actualizar(mensaje);
  return new Promise((resolve, reject) => {
    let salidaError = "";
    const salidaPendiente = { stdout: "", stderr: "" };
    const proceso = spawn("/usr/bin/sudo", ["-n", comando, ...argumentos], {
      cwd: raiz,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proceso.stdout.setEncoding("utf8");
    proceso.stderr.setEncoding("utf8");
    const procesarDatos = (flujo) => (datos) => {
      salidaPendiente[flujo] += datos;
      const lineas = salidaPendiente[flujo].split(/[\r\n]+/);
      salidaPendiente[flujo] = lineas.pop() ?? "";
      registrar(lineas.join("\n"));
      if (flujo === "stderr") salidaError += datos;
    };
    proceso.stdout.on("data", procesarDatos("stdout"));
    proceso.stderr.on("data", procesarDatos("stderr"));
    proceso.once("error", reject);
    proceso.once("close", (codigo) => {
      registrar(`${salidaPendiente.stdout}\n${salidaPendiente.stderr}`);
      if (codigo === 0) {
        resolve();
        return;
      }
      const detalle =
        limpiarSalida(salidaError).join("\n") ||
        estado.registros.slice(-8).join("\n");
      reject(
        new Error(detalle || `${comando} terminó con el código ${codigo}.`),
      );
    });
  });
}

function comandoCompose(argumentos, mensaje) {
  return ejecutar(
    "docker",
    [
      "compose",
      "--project-directory",
      proyectoDocker,
      "--env-file",
      archivoEntorno,
      "-f",
      archivoComposicion,
      ...argumentos,
    ],
    mensaje,
  );
}

function valorEntorno(texto, nombre, predeterminado) {
  const coincidencia = texto.match(new RegExp(`^${nombre}=(.*)$`, "m"));
  const valor = coincidencia?.[1]?.trim();
  if (!valor) return predeterminado;
  if (valor.startsWith('"') && valor.endsWith('"')) {
    try {
      return JSON.parse(valor);
    } catch {
      return valor.slice(1, -1);
    }
  }
  return valor.replace(/^'(.*)'$/, "$1");
}

function resolverRutaApuntes(textoEntorno) {
  const rutaConfigurada = valorEntorno(
    textoEntorno,
    "RUTA_APUNTES",
    "../../apuntes-privados",
  );
  return path.isAbsolute(rutaConfigurada)
    ? path.resolve(rutaConfigurada)
    : path.resolve(proyectoDocker, rutaConfigurada);
}

async function seleccionarCarpetaApuntes(rutaInicial) {
  let rutaDialogo = rutaInicial;
  try {
    if (!(await stat(rutaDialogo)).isDirectory()) rutaDialogo = raiz;
  } catch {
    rutaDialogo = raiz;
  }
  return new Promise((resolve, reject) => {
    const selector = spawn(
      "zenity",
      [
        "--file-selection",
        "--directory",
        "--title=Selecciona la carpeta raíz de apuntes privados",
        `--filename=${rutaDialogo}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let rutaSeleccionada = "";
    let salidaError = "";
    selector.stdout.setEncoding("utf8");
    selector.stderr.setEncoding("utf8");
    selector.stdout.on("data", (datos) => {
      rutaSeleccionada += datos;
    });
    selector.stderr.on("data", (datos) => {
      salidaError += datos;
    });
    selector.once("error", (error) => {
      reject(
        new Error(
          error.code === "ENOENT"
            ? "No se encontró el selector de carpetas Zenity. Instala zenity para elegir los apuntes privados."
            : `No se pudo abrir el selector de carpetas: ${error.message}`,
        ),
      );
    });
    selector.once("close", (codigo) => {
      if (codigo === 0) {
        const seleccion = rutaSeleccionada.trim();
        resolve(seleccion ? path.resolve(seleccion) : null);
      } else if (codigo === 1) {
        resolve(null);
      } else {
        reject(
          new Error(
            limpiarSalida(salidaError).join("\n") ||
              `El selector de carpetas terminó con el código ${codigo}.`,
          ),
        );
      }
    });
  });
}

async function guardarRutaApuntes(textoEntorno, ruta) {
  const linea = `RUTA_APUNTES=${JSON.stringify(ruta)}`;
  const actualizado = /^RUTA_APUNTES\s*=.*$/m.test(textoEntorno)
    ? textoEntorno.replace(/^RUTA_APUNTES\s*=.*$/m, linea)
    : `${textoEntorno.trimEnd()}\n${linea}\n`;
  const temporal = `${archivoEntorno}.${process.pid}.tmp`;
  await writeFile(temporal, actualizado, "utf8");
  await rename(temporal, archivoEntorno);
  return actualizado;
}

async function comprobarPuertoDisponible(puerto) {
  const comprobacion = net.createServer();
  await new Promise((resolve, reject) => {
    comprobacion.once("error", reject);
    comprobacion.listen(Number(puerto), "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    comprobacion.close((error) => (error ? reject(error) : resolve())),
  );
}

function abrirNavegador(direccion) {
  const navegador = spawn("firefox", [direccion], {
    detached: true,
    stdio: "ignore",
  });
  navegador.on("error", () => {
    const fallback = spawn("xdg-open", [direccion], {
      detached: true,
      stdio: "ignore",
    });
    fallback.on("error", (error) =>
      registrar(`No se pudo abrir el navegador: ${error.message}`),
    );
    fallback.unref();
  });
  navegador.unref();
}

async function comprobarCarpetaApuntes(ruta) {
  try {
    if (!(await stat(ruta)).isDirectory()) throw new Error();
    await access(ruta, permisos.R_OK | permisos.W_OK | permisos.X_OK);
  } catch {
    throw new Error(
      `La carpeta seleccionada no existe o no tienes permisos de lectura y escritura: ${ruta}.`,
    );
  }
}

async function abrirPaginaDeCarga(rutaInicial) {
  let rutaSeleccionada = rutaInicial;
  let solicitarInicio;
  const inicioSolicitado = new Promise((resolve) => {
    solicitarInicio = resolve;
  });
  const servidor = createServer(async (peticion, respuesta) => {
    if (peticion.url === "/estado") {
      respuesta.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      respuesta.end(JSON.stringify(estado));
      return;
    }
    if (peticion.url === "/seleccionar-carpeta" && peticion.method === "POST") {
      try {
        const seleccion = await seleccionarCarpetaApuntes(rutaSeleccionada);
        if (!seleccion) {
          respuesta.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          respuesta.end(JSON.stringify({ cancelado: true }));
          return;
        }
        await comprobarCarpetaApuntes(seleccion);
        rutaSeleccionada = seleccion;
        estado.rutaApuntes = seleccion;
        estado.carpetaValida = true;
        respuesta.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        respuesta.end(JSON.stringify({ ruta: seleccion }));
      } catch (error) {
        respuesta.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        respuesta.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (peticion.url === "/iniciar" && peticion.method === "POST") {
      if (estado.iniciando) {
        respuesta.writeHead(409, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        respuesta.end(JSON.stringify({ error: "El generador ya se está iniciando." }));
        return;
      }
      if (!estado.carpetaValida) {
        respuesta.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        respuesta.end(
          JSON.stringify({ error: "Elige una carpeta válida de apuntes privados." }),
        );
        return;
      }
      estado.iniciando = true;
      respuesta.writeHead(202, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      respuesta.end(JSON.stringify({ iniciando: true }));
      solicitarInicio(rutaSeleccionada);
      return;
    }
    if (
      peticion.url === "/css/cargando.css" ||
      peticion.url === "/js/cargando.js" ||
      peticion.url === "/js/formato-salida.js"
    ) {
      const recurso = peticion.url.endsWith(".css")
        ? path.join(raiz, "css", "cargando.css")
        : path.join(
            raiz,
            "js",
            peticion.url === "/js/cargando.js"
              ? "cargando.js"
              : "formato-salida.js",
          );
      try {
        const contenido = await readFile(recurso);
        respuesta.writeHead(200, {
          "content-type": peticion.url.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        respuesta.end(contenido);
      } catch (error) {
        respuesta.writeHead(500);
        respuesta.end(`No se pudo cargar el recurso: ${error.message}`);
      }
      return;
    }
    if (peticion.url === "/" || peticion.url === "/cargando.html") {
      try {
        const html = await readFile(paginaCarga);
        respuesta.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        respuesta.end(html);
      } catch (error) {
        respuesta.writeHead(500);
        respuesta.end(`No se pudo abrir la página de carga: ${error.message}`);
      }
      return;
    }
    respuesta.writeHead(404);
    respuesta.end("No encontrado");
  });
  await new Promise((resolve, reject) => {
    servidor.once("error", reject);
    servidor.listen(0, "127.0.0.1", resolve);
  });
  estado.rutaApuntes = rutaInicial;
  try {
    await comprobarCarpetaApuntes(rutaInicial);
    estado.carpetaValida = true;
  } catch {
    estado.carpetaValida = false;
  }
  const direccion = `http://127.0.0.1:${servidor.address().port}/`;
  abrirNavegador(direccion);
  return { servidor, inicioSolicitado };
}

async function iniciar() {
  try {
    try {
      await access(archivoEntorno);
    } catch {
      await copyFile(path.join(raiz, ".env.ejemplo"), archivoEntorno);
      registrar(`Se creó la configuración inicial: ${archivoEntorno}`);
    }

    let textoEntorno = await readFile(archivoEntorno, "utf8");
    puertoWeb = valorEntorno(textoEntorno, "PUERTO_WEB", "8000");
    if (
      !/^\d+$/.test(puertoWeb) ||
      Number(puertoWeb) < 1 ||
      Number(puertoWeb) > 65535
    ) {
      throw new Error("PUERTO_WEB debe ser un número entre 1 y 65535.");
    }
    urlWeb = `http://127.0.0.1:${puertoWeb}`;

    const modelo = valorEntorno(textoEntorno, "MODELO_IA", "qwen2.5vl:7b");
    if (!/^[a-zA-Z0-9._:/-]+$/.test(modelo)) {
      throw new Error(
        "MODELO_IA solo puede contener letras, números, punto, guion, dos puntos o barra.",
      );
    }

    const rutaInicial = resolverRutaApuntes(textoEntorno);
    const cargador = await abrirPaginaDeCarga(rutaInicial);
    const rutaSeleccionada = await cargador.inicioSolicitado;
    await comprobarCarpetaApuntes(rutaSeleccionada);
    const rutaCambio = rutaSeleccionada !== rutaInicial;
    if (rutaCambio) {
      textoEntorno = await guardarRutaApuntes(textoEntorno, rutaSeleccionada);
      registrar(`Se guardó la carpeta de apuntes: ${rutaSeleccionada}`);
    }

    const generadorIniciado = await detectarGeneradorIniciado(urlWeb, modelo);
    if (generadorIniciado && !rutaCambio) {
      estado.direccion = `http://localhost:${puertoWeb}`;
      estado.listo = true;
      actualizar("El generador ya está iniciado. Abriendo la aplicación…", 100);
      setTimeout(() => cargador.servidor.close(), 5000);
      return;
    }

    if (!rutaCambio) {
      try {
        await comprobarPuertoDisponible(puertoWeb);
      } catch {
        throw new Error(
          `El puerto ${puertoWeb} ya está ocupado por otra aplicación. No se cambiará de puerto automáticamente. Cierra esa aplicación o configura PUERTO_WEB en ${archivoEntorno}.`,
        );
      }
    }

    try {
      await ejecutar(
        "docker",
        ["compose", "version"],
        "Comprobando Docker y Docker Compose…",
      );
      await ejecutar("docker", ["info"], "Comprobando el servicio de Docker…");
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(
          "No encuentro Docker. Comprueba que Docker Engine esté instalado.",
        );
      }
      if (/permission denied|access denied/i.test(error.message)) {
        throw new Error(
          "Docker está instalado, pero tu sesión no tiene permiso para usarlo todavía. Cierra la sesión de Linux y vuelve a entrar; después abre este acceso directo otra vez.",
        );
      }
      throw new Error(`Docker no está respondiendo: ${error.message}`);
    }

    actualizar("Comprobando la configuración de Docker Compose…", 8);
    await comandoCompose(
      ["config", "--quiet"],
      "Comprobando la configuración de Docker Compose…",
    );
    actualizar("Construyendo la aplicación e iniciando los contenedores…", 12);
    await comandoCompose(
      ["up", "--build", "-d"],
      "Construyendo la aplicación e iniciando los contenedores…",
    );

    let ollamaListo = false;
    for (let intento = 0; intento < 60; intento += 1) {
      try {
        await comandoCompose(
          ["exec", "-T", "ollama", "ollama", "list"],
          "Esperando a que arranque Ollama…",
        );
        ollamaListo = true;
        break;
      } catch {
        actualizar("Esperando a que arranque Ollama…", 45);
        await esperar(2000);
      }
    }
    if (!ollamaListo) {
      throw new Error(
        "Ollama no ha arrancado. Revisa los registros del servicio Ollama.",
      );
    }

    const modelos = await new Promise((resolve, reject) => {
      const argumentos = [
        "compose",
        "--project-directory",
        proyectoDocker,
        "--env-file",
        archivoEntorno,
        "-f",
        archivoComposicion,
        "exec",
        "-T",
        "ollama",
        "ollama",
        "list",
      ];
      const proceso = spawn("/usr/bin/sudo", ["-n", "docker", ...argumentos], {
        cwd: raiz,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let salida = "";
      let error = "";
      proceso.stdout.setEncoding("utf8");
      proceso.stderr.setEncoding("utf8");
      proceso.stdout.on("data", (datos) => {
        salida += datos;
      });
      proceso.stderr.on("data", (datos) => {
        error += datos;
      });
      proceso.once("error", reject);
      proceso.once("close", (codigo) =>
        codigo === 0 ? resolve(salida) : reject(new Error(error)),
      );
    });

    if (
      !modelos
        .split(/\r?\n/)
        .some((linea) => linea.trim().split(/\s+/)[0] === modelo)
    ) {
      actualizar(
        `Descargando el modelo ${modelo}… La primera vez puede tardar varios minutos.`,
        60,
      );
      await comandoCompose(
        ["exec", "-T", "ollama", "ollama", "pull", modelo],
        `Descargando el modelo ${modelo}…`,
      );
    }

    let lista = false;
    for (let intento = 0; intento < 90; intento += 1) {
      actualizar("Esperando a que la aplicación y el modelo estén listos…", 95);
      try {
        const respuesta = await fetch(`${urlWeb}/api/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (respuesta.ok && (await respuesta.json()).modelAvailable === true) {
          lista = true;
          break;
        }
      } catch {
        // Se vuelve a intentar mientras terminan de arrancar la aplicación y el modelo.
      }
      await esperar(2000);
    }
    if (!lista) {
      throw new Error(
        "La aplicación no respondió con el modelo listo. Revisa que Docker tenga memoria suficiente.",
      );
    }

    estado.direccion = `http://localhost:${puertoWeb}`;
    estado.listo = true;
    actualizar("¡Todo listo! Abriendo el generador de apuntes…", 100);
    setTimeout(() => cargador.servidor.close(), 5000);
  } catch (error) {
    estado.error = error.message;
    estado.listo = false;
    actualizar("No se pudo iniciar el generador.", estado.progreso);
    registrar(error.message);
  }
}

iniciar();
