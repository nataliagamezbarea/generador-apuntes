const urlBusquedaWeb = "https://www.bing.com/search";
const palabrasVacias = new Set(
  "para porque como cuando donde desde hasta entre sobre tambien puede pueden hace hacer tiene tienen este esta estos estas otro otra todos todas solo cada mismo misma ser estar hay muy mas pero aunque mientras mediante segun ejemplo forma parte caso tipo uso usar utiliza utilizar sirve consiste permite permiten debe deben son con los las del que una uno unos unas por sin esto esta ese esa sus son fue han".split(
    " ",
  ),
);

export function crearConsultasInvestigacion({
  asignatura,
  tituloTema,
  tituloApartado,
  material,
}) {
  const frecuenciasPorDocumento = [];
  for (const documento of material.documents) {
    const frecuencias = new Map();
    const palabras =
      String(documento.text ?? "")
        .normalize("NFKD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .match(/[\p{L}]{4,}/gu) ?? [];
    for (const palabra of palabras) {
      if (palabrasVacias.has(palabra)) continue;
      frecuencias.set(palabra, (frecuencias.get(palabra) ?? 0) + 1);
    }
    frecuenciasPorDocumento.push(
      [...frecuencias]
        .sort(
          (izquierda, derecha) =>
            derecha[1] - izquierda[1] ||
            izquierda[0].localeCompare(derecha[0]),
        )
        .map(([palabra]) => palabra),
    );
  }

  const terminos = [];
  for (let indice = 0; terminos.length < 6; indice += 1) {
    let cantidadEncontrada = 0;
    for (const frecuencias of frecuenciasPorDocumento) {
      if (frecuencias[indice] && !terminos.includes(frecuencias[indice])) {
        terminos.push(frecuencias[indice]);
        cantidadEncontrada += 1;
      }
      if (terminos.length === 6) break;
    }
    if (!cantidadEncontrada) break;
  }

  const contexto = [asignatura, tituloTema, tituloApartado]
    .map((valor) => String(valor ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const consultas = [];
  if (terminos.length)
    consultas.push(`${contexto} ${terminos.slice(0, 3).join(" ")}`);
  if (terminos.length > 3)
    consultas.push(`${contexto} ${terminos.slice(3, 6).join(" ")}`);
  if (!consultas.length && contexto) consultas.push(contexto);
  return consultas.map((consulta) => consulta.trim().slice(0, 300));
}

const dominiosBloqueados = new Set([
  "chiebukuro.yahoo.co.jp",
  "detail.chiebukuro.yahoo.co.jp",
  "zhihu.com",
  "baidu.com",
  "weibo.com",
  "pornhub.com",
  "xvideos.com",
]);

export async function buscarEnWikipedia(consulta, limite = 2, signal) {
  if (!consulta?.trim()) return [];
  const terminosBusqueda = consulta.trim().slice(0, 150);
  const url = `https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(terminosBusqueda)}&utf8=&format=json&srlimit=${Math.min(limite, 5)}`;
  try {
    const respuesta = await fetch(url, {
      headers: { "user-agent": "GeneradorApuntesLocal/1.0 (educational use)" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    if (!respuesta.ok) return [];
    const datos = await respuesta.json();
    const articulos = datos?.query?.search || [];
    const resultados = [];
    for (const art of articulos.slice(0, limite)) {
      if (signal?.aborted) break;
      try {
        const sumRes = await fetch(
          `https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(art.title)}`,
          {
            headers: { "user-agent": "GeneradorApuntesLocal/1.0 (educational use)" },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
          },
        );
        if (sumRes.ok) {
          const sumData = await sumRes.json();
          const extract = sumData.extract?.trim();
          if (extract && extract.length > 30) {
            resultados.push({
              titulo: sumData.title || art.title,
              url: sumData.content_urls?.desktop?.page || `https://es.wikipedia.org/wiki/${encodeURIComponent(art.title)}`,
              resumen: extract.slice(0, 1200),
            });
          }
        }
      } catch {}
    }
    return resultados;
  } catch {
    return [];
  }
}

export async function buscarEnBing(consulta, limite = 3, signal) {
  if (!consulta?.trim()) return [];
  const parametros = new URLSearchParams({
    format: "rss",
    q: consulta.trim().slice(0, 300),
    setlang: "es-ES",
    cc: "ES",
    adlt: "strict",
  });
  const respuesta = await fetch(`${urlBusquedaWeb}?${parametros}`, {
    headers: {
      "user-agent": "GeneradorApuntesLocal/1.0 (personal educational use)",
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  if (!respuesta.ok) return [];
  return analizarResultadosWeb(await respuesta.text(), limite);
}

export async function buscarEnInternet(consulta, limite = 3, signal) {
  if (!consulta?.trim()) return [];
  const resultados = [];
  const urlsVistas = new Set();

  // 1. Priorizar enciclopedia técnica/académica (Wikipedia en español)
  try {
    const fuentesWiki = await buscarEnWikipedia(consulta, Math.min(2, limite), signal);
    for (const f of fuentesWiki) {
      if (!urlsVistas.has(f.url)) {
        urlsVistas.add(f.url);
        resultados.push(f);
      }
    }
  } catch {}

  // 2. Complementar con buscador web si aún hay espacio
  if (resultados.length < limite) {
    try {
      const fuentesBing = await buscarEnBing(consulta, limite - resultados.length, signal);
      for (const f of fuentesBing) {
        if (!urlsVistas.has(f.url)) {
          urlsVistas.add(f.url);
          resultados.push(f);
        }
      }
    } catch {}
  }

  return resultados.slice(0, limite);
}

export function analizarResultadosWeb(xml, limite = 3) {
  const resultados = [];
  for (const coincidencia of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const campos = Object.fromEntries(
      [...coincidencia[1].matchAll(/<(title|link|description)>([\s\S]*?)<\/\1>/gi)]
        .map((resultado) => [
          resultado[1].toLowerCase(),
          limpiarTextoWeb(resultado[2]),
        ]),
    );
    const titulo = campos.title ?? "";
    const url = campos.link ?? "";
    const resumen = campos.description ?? "";
    if (!titulo || !esUrlWebSegura(url)) continue;
    resultados.push({ titulo, url, resumen: resumen.slice(0, 1200) });
    if (resultados.length >= Math.max(1, Math.min(5, limite))) break;
  }
  return resultados;
}

function limpiarTextoWeb(valor) {
  return String(valor)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi, (entidad, decimal, hexadecimal) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      }[entidad.slice(1, -1).toLowerCase()];
    })
    .replace(/\s+/g, " ")
    .trim();
}

export async function buscarFuentesOpcionales(
  consultas,
  avisos,
  buscar = buscarEnInternet,
  informarProgreso = () => {},
  signal,
) {
  const fuentes = [];
  for (const [indice, consulta] of consultas.entries()) {
    if (signal?.aborted) throw signal.reason;
    informarProgreso(indice + 1, consultas.length);
    try {
      for (const fuente of await buscar(consulta)) {
        if (!fuentes.some((existente) => existente.url === fuente.url))
          fuentes.push(fuente);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      avisos.push(
        `No se pudo buscar en Internet (${error.message}); se continúa con el material local.`,
      );
    }
  }
  if (consultas.length && !fuentes.length) {
    avisos.push(
      "La búsqueda en Internet no devolvió fuentes verificables; se continúa con el material local.",
    );
  }
  return fuentes;
}

export function esUrlWebSegura(valor) {
  try {
    const url = new URL(valor);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    for (const bloqueado of dominiosBloqueados) {
      if (host === bloqueado || host.endsWith("." + bloqueado)) return false;
    }
    // Filtrar caracteres de alfabetos irrelevantes para apuntes en español (p.ej. cirílico, kanji/hiragana)
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u0400-\u04ff]/u.test(host)) return false;
    return Boolean(host);
  } catch {
    return false;
  }
}
