// ============================================================
// UTILIDADES DE TRADUCCIÓN Y DETECCIÓN EN NAVEGADOR
// ============================================================

export function detectarCatalanTexto(texto = "") {
  if (!texto || typeof texto !== "string" || !texto.trim()) return false;
  const patron = /(?:^|[^a-zà-ÿ])(?:client-servidor|client(?:\s+servidor)?|l['’](?:origen|abast|execuci[oó]|usuari|entorn)|d['’](?:execuci[oó]|un|una|aquest|aquesta)|eines|llenguatges|execuci[oó]|entorn|entorns|desenvolupament|cercador|fitxers?|dades|sol[·.]licituds?|aquest|aquesta|aquests|aquestes|tamb[eé]|aix[oò]|dels|deles|amb|sense|per[oò]|s[oó]n|mitjan[cç]ant|interf[ií]cie|renderitzat|comunicacions|navigador)(?![a-zà-ÿ])/iu;
  return patron.test(texto);
}

export async function traducirTextoGoogleBrowser(texto = "") {
  if (!texto || typeof texto !== "string" || !texto.trim()) return texto;
  const limpio = texto.trim();
  const esCat = detectarCatalanTexto(limpio);
  const fuentes = esCat ? ["ca", "auto"] : ["auto", "ca"];
  for (const sl of fuentes) {
    try {
      const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + sl + "&tl=es&dt=t&q=" + encodeURIComponent(limpio);
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const datos = await res.json();
        const resultado = datos?.[0]?.map((s) => s[0]).join("");
        if (resultado && resultado.trim()) {
          return resultado.trim();
        }
      }
    } catch (_) {}
  }
  return limpio;
}

export async function traducirTextoLargoBrowser(texto = "") {
  if (!texto || typeof texto !== "string" || !texto.trim()) return texto;
  if (!detectarCatalanTexto(texto)) return texto;
  const lineas = texto.split("\n");
  const bloques = [];
  let actual = [];
  let len = 0;
  for (const l of lineas) {
    if (len + l.length > 1000) {
      bloques.push(actual.join("\n"));
      actual = [l];
      len = l.length;
    } else {
      actual.push(l);
      len += l.length + 1;
    }
  }
  if (actual.length) bloques.push(actual.join("\n"));
  const trads = [];
  for (const b of bloques) {
    if (detectarCatalanTexto(b)) {
      try {
        const t = await traducirTextoGoogleBrowser(b);
        trads.push(t || b);
      } catch (_) {
        trads.push(b);
      }
    } else {
      trads.push(b);
    }
  }
  return trads.join("\n");
}
