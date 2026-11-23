// ============================================================
// EXTRACTOR DE TEXTO DE PDF PARA NAVEGADOR
// ============================================================

export async function extraerTextoPdfBrowser(file) {
  // 1. Intentar extracción rápida con el backend local (solo en localhost)
  if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
    try {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch("/api/extraer-pdf", { method: "POST", body: fd });
      if (resp.ok) {
        const data = await resp.json();
        if (data.texto && data.texto.trim()) {
          return data.texto.trim();
        }
      }
    } catch (_) {}
  }

  // 2. Extracción directa y segura con PDF.js en el navegador
  if (!window.pdfjsLib) {
    for (let w = 0; w < 10 && !window.pdfjsLib; w++) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!window.pdfjsLib) return "";
  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let paginas = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const textItems = textContent.items.map((item) => item.str).join(" ");
      if (textItems.trim()) {
        paginas.push(`--- Diapositiva / Página ${i} ---\n${textItems.trim()}`);
      }
    }
    return paginas.join("\n\n");
  } catch (err) {
    console.warn("Aviso extrayendo PDF en navegador:", err.message);
    return "";
  }
}
