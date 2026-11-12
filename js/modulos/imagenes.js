const commonsApi = "https://commons.wikimedia.org/w/api.php";
const maxImageBytes = 5 * 1024 * 1024;
const imageTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export async function buscarImagenAbierta(query) {
  const search = String(query ?? "").trim().slice(0, 200);
  if (!search) return null;

  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `filetype:bitmap ${search}`,
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "1200",
    format: "json",
    formatversion: "2",
  });
  const respuesta = await fetch(`${commonsApi}?${params}`, {
    headers: {
      "user-agent": "GeneradorApuntesLocal/1.0 (educational use)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!respuesta.ok)
    throw new Error(`Wikimedia Commons respondió ${respuesta.status}.`);
  const resultado = await respuesta.json();
  const paginas = resultado.query?.pages;
  if (!Array.isArray(paginas)) return null;

  for (const pagina of paginas) {
    const info = pagina.imageinfo?.[0];
    if (!info) continue;
    const metadatos = info.extmetadata ?? {};
    const licencia = leerMetadato(metadatos.LicenseShortName);
    const licenciaUrl = validarUrlHttps(
      leerMetadato(metadatos.LicenseUrl),
    );
    if (!esLicenciaPermitida(licencia, licenciaUrl)) continue;

    const imageUrl = validarUrlImagen(info.thumburl ?? info.url);
    if (!imageUrl) continue;
    const imageResponse = await fetch(imageUrl, {
      headers: {
        "user-agent": "GeneradorApuntesLocal/1.0 (educational use)",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!imageResponse.ok)
      throw new Error(`No se pudo descargar la imagen (${imageResponse.status}).`);
    if (!validarUrlImagen(imageResponse.url)) continue;

    const contentType = imageResponse.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    const extension = imageTypes.get(contentType);
    if (!extension) continue;
    const declaredBytes = Number(imageResponse.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxImageBytes)
      continue;
    const data = Buffer.from(await imageResponse.arrayBuffer());
    if (!data.length || data.length > maxImageBytes) continue;

    return {
      data,
      extension,
      titulo: limpiarMetadato(pagina.title),
      descripcion: leerMetadato(metadatos.ImageDescription),
      autor: leerMetadato(metadatos.Artist) || "Autor no indicado",
      licencia,
      licenciaUrl,
      fuenteUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(
        pagina.title.replaceAll(" ", "_"),
      )}`,
    };
  }
  return null;
}

function leerMetadato(metadato) {
  return limpiarMetadato(metadato?.value ?? "");
}

function limpiarMetadato(value) {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hex) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      }[entity.slice(1, -1).toLowerCase()];
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function validarUrlHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function validarUrlImagen(value) {
  const url = validarUrlHttps(value);
  return url?.hostname === "upload.wikimedia.org" ? url : null;
}

function esLicenciaPermitida(nombre, url) {
  if (/^(?:public domain(?: mark)?|pd(?:-old)?)\b/i.test(nombre)) return true;
  if (!/^(?:CC0|CC BY(?:-SA)?(?:\s+\d+(?:\.\d+)?)(?:\s+.*)?)$/i.test(nombre))
    return false;
  return (
    url?.hostname === "creativecommons.org" &&
    (/^\/licenses\/by(?:-sa)?\//i.test(url.pathname) ||
      /^\/publicdomain\/zero\//i.test(url.pathname))
  );
}

