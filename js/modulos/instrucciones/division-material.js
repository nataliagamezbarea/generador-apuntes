export function extraerTitulosDiapositiva(material = "") {
  const lineas = String(material).replace(/\r/g, "").split("\n");
  const titulos = [];
  const vistos = new Set();
  for (let i = 0; i < lineas.length; i += 1) {
    const l = lineas[i].trim();
    if (!l) continue;

    // 1. Apartado numerado (ej: 1.1 · MODELS D'EXECUCIÓ)
    const esApartado = /^\s*\d+\.\d+\s*[·\-–—:]\s*\S+/u.test(l);
    // 2. Encabezado temático o de introducción
    const esIntroduccion = /^\s*(?:INTRODUCCI[OÓ]|INTRODUCCIÓ|INTRODUCCIÓN|PRESENTACI[OÓ]|PRESENTACIÓN|OBJECTIUS|OBJETIVOS)\s*$/iu.test(l);

    if (esApartado || esIntroduccion) {
      const limpio = l.replace(/^#+\s*/, "").trim();
      const clave = limpio.toLowerCase();
      if (!vistos.has(clave)) {
        vistos.add(clave);
        titulos.push(limpio);
      }
    }
  }
  return titulos;
}

export function evaluarCoberturaMaterial(normalizado, material = "") {
  const titulosEsperados = extraerTitulosDiapositiva(material);
  if (!titulosEsperados.length) return [];

  const latexCompleto = (normalizado.archivos ?? [])
    .map((archivo) => `${archivo.titulo ?? ""}\n${archivo.latex ?? ""}`)
    .join("\n\n");
  const latexMin = latexCompleto.toLowerCase();

  const titulosFaltantes = [];
  for (const titulo of titulosEsperados) {
    const matchNum = titulo.match(/^(\d+\.\d+)/);
    const numApartado = matchNum ? matchNum[1] : null;

    const palabrasClave = titulo
      .replace(/^\d+\.\d+\s*[·\-–—:]\s*/u, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((p) => p.length >= 4);

    const encontrada =
      (numApartado && (latexMin.includes(numApartado) || latexCompleto.includes(numApartado))) ||
      palabrasClave.some((p) => latexMin.includes(p));

    if (!encontrada) {
      titulosFaltantes.push(titulo);
    }
  }

  const problemas = [];
  if (titulosFaltantes.length > 0) {
    problemas.push(
      `Faltan contenidos o secciones correspondientes a las siguientes partes del material: ${titulosFaltantes.slice(0, 5).join("; ")}. Cada diapositiva y punto clave debe tener su desarrollo y su encabezado formal en el LaTeX.`,
    );
  }
  return problemas;
}

export function dividirMaterial(
  texto,
  maxCaracteres = 8000,
  minCaracteres = 2000,
) {
  if (texto.length <= maxCaracteres) return [texto];
  const bloques = [];
  let inicio = 0;
  while (inicio < texto.length) {
    let fin = Math.min(inicio + maxCaracteres, texto.length);
    if (fin < texto.length) {
      const corteSalto = texto.lastIndexOf("\n\n", fin);
      const corteLinea = texto.lastIndexOf("\n", fin);
      const corte = corteSalto > inicio + minCaracteres ? corteSalto : corteLinea;
      if (corte > inicio + minCaracteres) fin = corte;
    }
    bloques.push(texto.slice(inicio, fin).trim());
    inicio = fin;
  }
  return bloques.filter(Boolean);
}

export function dividirMaterialConImagenes(
  material,
  imagenes,
  maxCaracteres = 8000,
  maxImagenes = 2,
) {
  const bloquesTexto = dividirMaterial(material, maxCaracteres);
  const gruposImagenes = Array.from(
    { length: Math.ceil(imagenes.length / maxImagenes) },
    (_, i) => imagenes.slice(i * maxImagenes, (i + 1) * maxImagenes),
  );
  const cantidadBloques = Math.max(bloquesTexto.length, gruposImagenes.length);
  let bloques = bloquesTexto;
  if (cantidadBloques > bloquesTexto.length) {
    bloques = dividirMaterial(
      material,
      Math.ceil(material.length / cantidadBloques),
    );
  }
  return bloques.map((texto, indice) => ({
    texto,
    imagenes: gruposImagenes[indice] ?? [],
  }));
}

export function limpiarTextoDiapositivas(str = "") {
  return str
    .replace(/Col[·.]legi\s+Sant\s+Josep\s+Obrer(?:\s*·\s*\d+)?/gi, "")
    .replace(/\b2n\s+DAW\b/gi, "")
    .replace(/\[CONTEXTO\s+GENERAL[^\]]*\]/gi, "")
    .replace(/\[CONTENIDO\s+COMPLETO[^\]]*\]/gi, "")
    .replace(/^[ \t]*[•·-]\s*·\s*\d+\s*$/gm, "")
    .trim();
}

export function normalizarTituloApartado(titulo = "") {
  let t = titulo
    .replace(/\s*\(\d+\/\d+\)\s*$/, "")
    .replace(/\s*·\s*\d+\s*$/, "")
    .replace(/^[#\s\-·]+|[#\s\-·]+$/g, "")
    .trim();
  if (t.length > 0) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t;
}

export function detectarApartadosEnTexto(texto = "") {
  if (!texto || typeof texto !== "string") return [];
  // 1. Detectar encabezados numerados tipo 1.1, Tema 1.1, Apartado 1.1 con o sin puntuación (admite espacio simple)
  const regexNumerado = /(?:^|\n)\s*(?:[A-Za-z0-9_]+\s*:\s*)?(?:#+\s*)?(?:Apartado\s+|Tema\s+)?([0-9]+)\.([0-9]+)\s*(?:[·\-\–\—\.\:]\s*|\s+)([^\n\r]+)/gi;
  let match;
  const apartadosMap = new Map();
  while ((match = regexNumerado.exec(texto)) !== null) {
    const clave = `${match[1]}.${match[2]}`;
    if (!apartadosMap.has(clave)) {
      const rawTitulo = normalizarTituloApartado(match[3]);
      if (rawTitulo && rawTitulo.length > 2) {
        apartadosMap.set(clave, {
          tema: Number(match[1]),
          subtema: Number(match[2]),
          titulo: rawTitulo,
          inicio: match.index,
        });
      }
    }
  }

  // 2. Si se encontraron al menos 2 apartados numerados, devolverlos ordenados
  if (apartadosMap.size >= 2) {
    return Array.from(apartadosMap.values()).sort((a, b) => a.inicio - b.inicio);
  }

  // 3. Fallback inteligente: si no tienen numeración formal tipo X.Y, detectar títulos destacados por líneas en mayúsculas o bullets mayores
  const regexSecciones = /(?:^|\n)\s*(?:#+\s*|(?:\d+\s*[.)-]\s*))?([A-ZÁÉÍÓÚÀÈÒÑÇ][A-Za-z0-9ÁÉÍÓÚÀÈÒÑÇ\s\-_,]{4,70})(?=\n|$)/g;
  const secciones = [];
  while ((match = regexSecciones.exec(texto)) !== null) {
    const tit = normalizarTituloApartado(match[1]);
    if (tit && !tit.toLowerCase().startsWith("tema") && !tit.toLowerCase().startsWith("colegio") && tit.length >= 5 && tit.length <= 70) {
      if (!secciones.some((s) => s.titulo.toLowerCase() === tit.toLowerCase())) {
        secciones.push({
          titulo: tit,
          inicio: match.index,
        });
      }
    }
  }

  if (secciones.length >= 2) {
    return secciones.map((sec, idx) => ({
      tema: 1,
      subtema: idx + 1,
      titulo: sec.titulo,
      inicio: sec.inicio,
    }));
  }

  // 4. Si el texto es largo (> 4000 caracteres) y no hay títulos obvios, dividir por bloques estructurados
  if (texto.length > 4000) {
    const tamano = 3500;
    const numPartes = Math.min(8, Math.ceil(texto.length / tamano));
    const partes = [];
    const step = Math.floor(texto.length / numPartes);
    for (let i = 0; i < numPartes; i++) {
      partes.push({
        tema: 1,
        subtema: i + 1,
        titulo: `Apartado 1.${i + 1}`,
        inicio: i * step,
      });
    }
    return partes;
  }

  return Array.from(apartadosMap.values()).sort((a, b) => a.inicio - b.inicio);
}

export function dividirTextoPorApartados(
  texto = "",
  visualesOApartados = [],
  apartadosDetectados = [],
) {
  let visuales = [];
  let apartados = apartadosDetectados;

  if (Array.isArray(visualesOApartados) && visualesOApartados.length > 0 && visualesOApartados[0].subtema !== undefined) {
    apartados = visualesOApartados;
    visuales = [];
  } else if (Array.isArray(visualesOApartados)) {
    visuales = visualesOApartados;
  }

  if (!apartados || apartados.length < 2) {
    return [{ texto: limpiarTextoDiapositivas(texto), imagenes: visuales.slice(0, 2) }];
  }
  const bloques = [];

  for (let i = 0; i < apartados.length; i += 1) {
    const act = apartados[i];
    const sig = apartados[i + 1];
    const inicio = i === 0 ? 0 : act.inicio;
    const fin = sig ? sig.inicio : texto.length;
    const textoApartado = limpiarTextoDiapositivas(texto.slice(inicio, fin));

    const imagenesBloque = visuales.filter((v) => {
      const matchPagina = String(v.name || "").match(/p[áa]gina\s*(\d+)/i);
      if (matchPagina) {
        const pag = matchPagina[1];
        return (
          textoApartado.includes(`· ${pag}`) ||
          textoApartado.includes(`página ${pag}`) ||
          textoApartado.includes(`pàgina ${pag}`)
        );
      }
      return false;
    });

    const encabezado = `--- APARTADO ${act.tema}.${act.subtema}: ${act.titulo} ---\n${textoApartado}`;

    bloques.push({
      texto: encabezado,
      imagenes: imagenesBloque.length ? imagenesBloque.slice(0, 2) : [],
      temaNumero: act.tema,
      apartadoNumero: act.subtema,
      apartadoTitulo: act.titulo,
    });
  }
  return bloques;
}

export function dividirCodigoEnBloques(
  texto,
  maxCaracteres = 8000,
  esJson = false,
) {
  if (texto.length <= maxCaracteres) return [texto];
  if (esJson) {
    try {
      const obj = JSON.parse(texto);
      const claves = Object.keys(obj);
      if (claves.length > 1) {
        const mitad = Math.ceil(claves.length / 2);
        const p1 = Object.fromEntries(
          claves.slice(0, mitad).map((k) => [k, obj[k]]),
        );
        const p2 = Object.fromEntries(claves.slice(mitad).map((k) => [k, obj[k]]));
        return [
          JSON.stringify(p1, null, 2),
          JSON.stringify(p2, null, 2),
        ].flatMap((t) => dividirCodigoEnBloques(t, maxCaracteres, true));
      }
    } catch {
      // Si no parsea, continúa con la partición por líneas
    }
  }
  const lineas = texto.split("\n");
  const bloques = [];
  let actual = [];
  let len = 0;
  for (const l of lineas) {
    if (len + l.length > maxCaracteres && actual.length) {
      bloques.push(actual.join("\n"));
      actual = [];
      len = 0;
    }
    actual.push(l);
    len += l.length + 1;
  }
  if (actual.length) bloques.push(actual.join("\n"));
  return bloques;
}
