// ============================================================
// LLAMADAS A LA API DE GITHUB (CATÁLOGO Y CREACIÓN DE CARPETAS)
// ============================================================

export async function cargarAsignaturasDesdeGitHub(token = "", repo = "nataliagamezbarea/GRADOS_INFORMATICOS") {
  const asignaturasMap = new Map();

  // 1. Intentar primero leer test/asignaturas.json o data/asignaturas.json vía raw GitHub (rápido y sin límites de API)
  const ramas = ["Segundo_grado_superior", "master", "main"];
  const rutasJson = ["test/asignaturas.json", "data/asignaturas.json"];

  for (const rama of ramas) {
    for (const ruta of rutasJson) {
      try {
        const urlRaw = `https://raw.githubusercontent.com/${repo}/${rama}/${ruta}`;
        const resRaw = await fetch(urlRaw);
        if (resRaw.ok) {
          const datos = await resRaw.json();
          if (datos && Array.isArray(datos.asignaturas) && datos.asignaturas.length > 0) {
            for (const asig of datos.asignaturas) {
              const clave = (asig.nombre || asig.id || "").trim().toLowerCase();
              if (!clave) continue;
              if (!asignaturasMap.has(clave)) {
                asignaturasMap.set(clave, {
                  nombre: asig.nombre || asig.id.toUpperCase(),
                  temas: Array.isArray(asig.temas) ? asig.temas : [{ numero: 1, nombre: "Tema 1", apartados: [] }],
                });
              }
            }
            if (asignaturasMap.size > 0) {
              // Catálogo cargado con éxito desde el repositorio
              break;
            }
          }
        }
      } catch (_) {}
    }
    if (asignaturasMap.size > 0) break;
  }

  // 2. Si raw no encontró catálogo o para enriquecer con carpetas y PDFs de apuntes, consultar árbol de GitHub
  try {
    const headers = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Generador-Apuntes-App",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let res = await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, { headers });
    if (!res.ok) {
      res = await fetch(`https://api.github.com/repos/${repo}/git/trees/Segundo_grado_superior?recursive=1`, { headers });
    }
    if (!res.ok) {
      res = await fetch(`https://api.github.com/repos/${repo}/git/trees/master?recursive=1`, { headers });
    }

    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.tree)) {
        for (const item of data.tree) {
          if (!item || !item.path) continue;
          const partes = item.path.split("/");
          if (partes.length < 2) continue;
          const raiz = partes[0].toLowerCase();
          if (raiz !== "apuntes_privados" && raiz !== "apuntes") continue;

          let nombreAsignatura = partes[1].trim();

          // Si es un archivo suelto en apuntes (p. ej. AAD_2_SQL.pdf, Presentación - SGE.pdf), clasificar por prefijo
          if (/\.(pdf|zip|png|jpe?g|tex|txt|md|log)$/i.test(nombreAsignatura)) {
            const nombreArchivo = nombreAsignatura;
            if (/^AAD|^Acceso/i.test(nombreArchivo)) {
              nombreAsignatura = "AAD";
            } else if (/PMDM|M[oó]vil/i.test(nombreArchivo)) {
              nombreAsignatura = "PMDM";
            } else if (/SGE|Odoo|ERP/i.test(nombreArchivo)) {
              nombreAsignatura = "SGE";
            } else if (/Unity/i.test(nombreArchivo)) {
              nombreAsignatura = "Unity";
            } else if (/English|DAM/i.test(nombreArchivo)) {
              nombreAsignatura = "Inglés DAM";
            } else if (/Projecte|Intermodular/i.test(nombreArchivo)) {
              nombreAsignatura = "Proyecto Intermodular";
            } else {
              continue;
            }
          }

          if (!nombreAsignatura) continue;
          const claveAsig = nombreAsignatura.toLowerCase();
          if (!asignaturasMap.has(claveAsig)) {
            asignaturasMap.set(claveAsig, {
              nombre: nombreAsignatura,
              temas: [{ numero: 1, nombre: "Tema 1", apartados: [] }],
            });
          }

          if (partes.length >= 3) {
            const asigObj = asignaturasMap.get(claveAsig);
            const segTema = partes[2].trim();
            const mTema = segTema.match(/^(?:tema\s*|_|-)?(\d+)/i);
            if (mTema) {
              const numTema = parseInt(mTema[1], 10);
              let temaExistente = asigObj.temas.find((t) => t.numero === numTema);
              if (!temaExistente) {
                temaExistente = {
                  numero: numTema,
                  nombre: `Tema ${numTema}`,
                  apartados: [],
                };
                asigObj.temas.push(temaExistente);
                asigObj.temas.sort((a, b) => a.numero - b.numero);
              }
              if (partes.length >= 4) {
                const segAp = partes[3].trim();
                const mAp = segAp.match(/(?:tema\s*\d+[._-]|^\d+[._-]|apartado\s*)(\d+)/i);
                if (mAp) {
                  const numAp = parseInt(mAp[1], 10);
                  if (!temaExistente.apartados.some((ap) => ap.numero === numAp)) {
                    temaExistente.apartados.push({
                      numero: numAp,
                      titulo: `${numTema}.${numAp}`,
                      nombre: `Apartado ${numTema}.${numAp}`,
                    });
                    temaExistente.apartados.sort((a, b) => a.numero - b.numero);
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("Fallo al obtener el catálogo de asignaturas desde GitHub tree:", err);
  }

  // 3. Si por red no se cargó nada, intentar leer ./data/asignaturas.json relativo
  if (asignaturasMap.size === 0) {
    try {
      const resLocal = await fetch("./data/asignaturas.json");
      if (resLocal.ok) {
        const datosLocal = await resLocal.json();
        if (datosLocal?.asignaturas && Array.isArray(datosLocal.asignaturas)) {
          for (const asig of datosLocal.asignaturas) {
            const clave = (asig.nombre || asig.id || "").trim().toLowerCase();
            if (clave && !asignaturasMap.has(clave)) {
              asignaturasMap.set(clave, {
                nombre: asig.nombre || asig.id.toUpperCase(),
                temas: Array.isArray(asig.temas) ? asig.temas : [{ numero: 1, nombre: "Tema 1", apartados: [] }],
              });
            }
          }
        }
      }
    } catch (_) {}
  }

  return Array.from(asignaturasMap.values());
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
