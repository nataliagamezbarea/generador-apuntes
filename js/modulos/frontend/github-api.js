// ============================================================
// LLAMADAS A LA API DE GITHUB (CATÁLOGO Y CREACIÓN DE CARPETAS)
// ============================================================

export async function cargarAsignaturasDesdeGitHub(token = "", repo = "nataliagamezbarea/GRADOS_INFORMATICOS") {
  try {
    const headers = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Generador-Apuntes-App",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    // Consultar el árbol recursivo del repositorio (HEAD apunta a la rama por defecto del repo)
    let res = await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, { headers });
    if (!res.ok) {
      res = await fetch(`https://api.github.com/repos/${repo}/git/trees/master?recursive=1`, { headers });
    }
    if (!res.ok) {
      console.warn(`Respuesta GitHub API tree (${repo}): HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (!data || !Array.isArray(data.tree)) return [];

    const asignaturasMap = new Map();

    for (const item of data.tree) {
      if (!item || !item.path) continue;
      const partes = item.path.split("/");
      if (partes.length < 2) continue;
      const raiz = partes[0].toLowerCase();
      // Leer exclusivamente de las carpetas donde se guardan los apuntes en el repo
      if (raiz !== "apuntes_privados" && raiz !== "apuntes") continue;

      const nombreAsignatura = partes[1].trim();
      // Ignorar archivos sueltos en la raíz de apuntes (PDFs, zips, imágenes, etc.)
      if (!nombreAsignatura || /\.(pdf|zip|png|jpe?g|tex|txt|md|log)$/i.test(nombreAsignatura)) {
        continue;
      }

      const claveAsig = nombreAsignatura.toLowerCase();
      if (!asignaturasMap.has(claveAsig)) {
        asignaturasMap.set(claveAsig, {
          nombre: nombreAsignatura,
          temasMap: new Map(),
        });
      }

      const asigObj = asignaturasMap.get(claveAsig);

      if (partes.length >= 3) {
        const segTema = partes[2].trim();
        const mTema = segTema.match(/^(?:tema\s*|_|-)?(\d+)/i);
        if (mTema) {
          const numTema = parseInt(mTema[1], 10);
          if (!asigObj.temasMap.has(numTema)) {
            asigObj.temasMap.set(numTema, {
              numero: numTema,
              nombre: `Tema ${numTema}`,
              apartadosSet: new Set(),
            });
          }
          if (partes.length >= 4) {
            const segAp = partes[3].trim();
            const mAp = segAp.match(/(?:tema\s*\d+[._-]|^\d+[._-]|apartado\s*)(\d+)/i);
            if (mAp) {
              const numAp = parseInt(mAp[1], 10);
              asigObj.temasMap.get(numTema).apartadosSet.add(numAp);
            }
          }
        }
      }
    }

    const resultado = [];
    for (const asig of asignaturasMap.values()) {
      const temas = [];
      const sortedTemas = Array.from(asig.temasMap.values()).sort((a, b) => a.numero - b.numero);
      if (sortedTemas.length === 0) {
        temas.push({ numero: 1, nombre: "Tema 1", apartados: [] });
      } else {
        for (const t of sortedTemas) {
          const apartados = Array.from(t.apartadosSet).sort((a, b) => a - b).map((num) => ({
            numero: num,
            titulo: `${t.numero}.${num}`,
            nombre: `Apartado ${t.numero}.${num}`,
          }));
          temas.push({
            numero: t.numero,
            nombre: t.nombre,
            apartados,
          });
        }
      }
      resultado.push({
        nombre: asig.nombre,
        temas,
      });
    }

    return resultado;
  } catch (err) {
    console.warn("Fallo al obtener el catálogo de asignaturas desde GitHub:", err);
    return [];
  }
}

export async function crearCarpetaAsignaturaEnGitHub(nombre, token = "", repo = "nataliagamezbarea/GRADOS_INFORMATICOS") {
  if (!token || !nombre) return false;
  const nombreLimpio = nombre.trim();
  if (!nombreLimpio) return false;

  const rutas = [
    `apuntes_privados/${nombreLimpio}/.gitkeep`,
    `apuntes/${nombreLimpio}/.gitkeep`,
  ];

  for (const ruta of rutas) {
    try {
      const url = `https://api.github.com/repos/${repo}/contents/${ruta}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Generador-Apuntes-App",
      };

      let sha = undefined;
      try {
        const getRes = await fetch(url, { headers });
        if (getRes.ok) {
          const info = await getRes.json();
          sha = info.sha;
        }
      } catch (_) {}

      const body = {
        message: `docs(asignatura): crear carpeta ${nombreLimpio}`,
        content: btoa("\n"),
      };
      if (sha) body.sha = sha;

      await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.warn(`Aviso creando ${ruta} en GitHub:`, e.message || e);
    }
  }
  return true;
}
