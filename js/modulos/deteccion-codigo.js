import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";

const analizadores = [JavaScript, Python];

// Etiquetas HTML que pueden aparecer como ejemplo de código en los apuntes.
const etiquetasHtml =
  /^<\/?(?:!doctype\s+html|html|head|body|script|noscript|div|p|a|h[1-6]|span|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|form|input|button|label|link|meta|style|iframe|img|br|hr|pre|code|section|header|footer|nav|main|title|canvas|svg|template|source|video|audio)\b/i;

// Marcas que hacen que un bloque se considere código aunque tenga una sola línea.
const marcasCodigo =
  /[;{}]|=>|\b(?:const|let|var|function|class|def)\b|^\s*(?:\/\/|\/\*|\*\/|<!--|<!\[CDATA\[|<!\]\]>)|<\/?[a-z][a-z0-9-]*\b[^>]*>/i;

function esLineaHtml(linea) {
  const texto = linea.trim();
  if (!texto || !etiquetasHtml.test(texto)) return false;
  // Fragmentos de prosa como «<noscript>:» no son código.
  if (/^<\/?[a-z][^>]*>\s*:/.test(texto)) return false;
  return true;
}

function tieneFormaDeCodigo(linea) {
  const texto = linea.trim();
  return (
    texto &&
    !/^(CODI|CODE|CONSOLA|CONSOLE)$/i.test(texto) &&
    (esLineaHtml(texto) ||
      /(?:\b(?:const|let|var|function|return|class|def|if|for|while|import|from|print)\b|=>|[{};]|console\.\w+\s*\(|\bJSON\.(?:parse|stringify)\s*\()/i.test(
        texto,
      ) ||
      /^\s*(?:\/\/|\/\*|<!--|<!\[CDATA\[|<!\]\]>)/i.test(texto))
  );
}

function esCodigoValido(texto) {
  return analizadores.some((lenguaje) => {
    const parser = new Parser();
    parser.setLanguage(lenguaje);
    const arbol = parser.parse(texto);
    return !arbol.rootNode.hasError;
  });
}

function esBloqueValido(bloque) {
  // Un bloque con una línea que empieza por etiqueta HTML es código válido.
  if (bloque.split("\n").some((linea) => esLineaHtml(linea))) return true;
  return esCodigoValido(bloque);
}

function extraerCodigoEnLinea(linea) {
  if (esLineaHtml(linea)) return null;
  const inicio = linea.search(
    /\b(?:const|let|var|function|class|def|import|from)\b|console\.\w+\s*\(|(?:\w+\s*=\s*['"`])/i,
  );
  if (inicio < 0) return null;
  const candidato = linea.slice(inicio).trim();
  if (esCodigoValido(candidato)) return candidato;

  const finales = [...candidato.matchAll(/;/g)].map((match) => match.index + 1);
  for (const final of finales) {
    const fragmento = candidato.slice(0, final).trim();
    if (esCodigoValido(fragmento)) return fragmento;
  }
  return null;
}

/**
 * Una misma línea del PDF puede contener dos columnas (texto y código) o una
 * frase seguida de una etiqueta. Se divide por huecos grandes y se conservan
 * solo los trozos que parecen código; el texto se queda en el documento.
 */
function dividirSegmentosLinea(linea) {
  if (!esLineaHtml(linea)) return [linea];
  const partes = linea
    .split(/\s{6,}/)
    .map((parte) => parte.trim())
    .filter(Boolean);
  if (partes.length <= 1) return [linea];
  const codigo = partes.filter(
    (parte) => esLineaHtml(parte) || tieneFormaDeCodigo(parte),
  );
  return codigo.length ? codigo : [linea];
}

export function detectarBloquesCodigo(texto) {
  const lineas = String(texto ?? "").split(/\r?\n/);
  const candidatos = [];
  let actual = [];
  const guardar = () => {
    while (actual.at(-1)?.trim() === "") actual.pop();
    const bloque = actual.join("\n").trim();
    if (
      bloque &&
      (actual.filter((linea) => linea.trim()).length > 1 ||
        marcasCodigo.test(bloque)) &&
      esBloqueValido(bloque)
    )
      candidatos.push(bloque);
    actual = [];
  };

  for (const linea of lineas) {
    for (const segmento of dividirSegmentosLinea(linea)) {
      const codigoEnLinea = extraerCodigoEnLinea(segmento);
      const inicioCodigo = codigoEnLinea
        ? segmento.indexOf(codigoEnLinea)
        : -1;
      if (
        codigoEnLinea &&
        inicioCodigo > 0 &&
        segmento.slice(0, inicioCodigo).trim()
      ) {
        guardar();
        candidatos.push(codigoEnLinea);
        continue;
      }
      if (tieneFormaDeCodigo(segmento)) {
        actual.push(segmento);
      } else if (actual.length && !segmento.trim()) {
        actual.push(segmento);
      } else {
        guardar();
      }
    }
  }
  guardar();

  let textoSinCodigo = lineas.join("\n");
  for (const bloque of candidatos) {
    const indice = textoSinCodigo.indexOf(bloque);
    if (indice < 0) continue;
    textoSinCodigo =
      textoSinCodigo.slice(0, indice) +
      textoSinCodigo.slice(indice + bloque.length);
  }
  return {
    texto: textoSinCodigo.replace(/\n{3,}/g, "\n\n").trim(),
    bloques: candidatos,
  };
}
