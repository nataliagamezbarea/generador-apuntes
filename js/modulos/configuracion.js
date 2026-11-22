import path from "node:path";

function leerAjusteNumerico(name, fallback, min) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback;
}

function leerLimiteTokens() {
  const parsed = Number.parseInt(process.env.TOKENS_MAX_IA ?? "", 10);
  return parsed === -1 || (Number.isSafeInteger(parsed) && parsed >= 256)
    ? parsed
    : -1;
}

export const config = {
  port: leerAjusteNumerico("PORT", 8000, 1),
  notesRoot: path.resolve(
    process.env.RUTA_APUNTES_CONTENEDOR ??
      process.env.RUTA_APUNTES ??
      path.join(process.cwd(), "..", "apuntes-privados"),
  ),
  generationReportsRoot: path.resolve(
    process.env.RUTA_INFORMES_GENERACION ??
      path.join(process.cwd(), "informes-generacion"),
  ),
  latexLibrary: path.resolve(
    process.env.RUTA_BIBLIOTECA_CONTENEDOR ??
      path.join(process.cwd(), "..", "bibliotecas_latex"),
  ),
  latexLibraryGithub:
    process.env.BIBLIOTECA_LATEX_GITHUB ??
    "https://github.com/nataliagamezbarea/apuntes-latex",
  ollamaUrl: (process.env.DIRECCION_OLLAMA ?? "http://127.0.0.1:11434").replace(
    /\/+$/,
    "",
  ),
  model: process.env.MODELO_IA ?? "qwen2.5vl:7b",
  codeModel:
    process.env.MODELO_CODIGO ??
    process.env.MODELO_IA_CODIGO ??
    "qwen2.5-coder:14b",
  timeoutMs: leerAjusteNumerico("TIEMPO_IA", 900, 10) * 1000,
  maxTokens: leerLimiteTokens(),
  contextSize: leerAjusteNumerico("NUM_CTX_IA", 24576, 4096),
  parallelRequests: Math.min(50, leerAjusteNumerico("CONCURRENCIA_IA", 2, 1)),
  maxUploadBytes:
    leerAjusteNumerico("MAX_MB_SUBIDA", 0, 0) > 0
      ? leerAjusteNumerico("MAX_MB_SUBIDA", 0, 0) * 1024 * 1024
      : Infinity,
  maxUploadFiles:
    leerAjusteNumerico("MAX_ARCHIVOS_SUBIDA", 0, 0) > 0
      ? leerAjusteNumerico("MAX_ARCHIVOS_SUBIDA", 0, 0)
      : Infinity,
  maxZipBytes:
    leerAjusteNumerico("MAX_MB_ZIP", 0, 0) > 0
      ? leerAjusteNumerico("MAX_MB_ZIP", 0, 0) * 1024 * 1024
      : Infinity,
  maxPdfPages: leerAjusteNumerico("MAX_PAGINAS_PDF", 100, 1),
  maxOcrPages: leerAjusteNumerico("MAX_PAGINAS_OCR", 60, 1),
  maxVisualPages: leerAjusteNumerico("MAX_PAGINAS_VISION", 8, 0),
  urlTests: (
    process.env.URL_TESTS ??
    process.env.URL_PREPARAR_TESTS ??
    "http://localhost:3000"
  ).trim(),
  nvidiaApiKey: (process.env.NVIDIA_API_KEY ?? "").trim(),
  nvidiaModel: (process.env.NVIDIA_MODELO ?? "mistralai/mistral-large-4-1t-a52b").trim(),
  nvidiaBaseUrl: (process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1").trim().replace(/\/+$/, ""),
  proveedorIA: (process.env.PROVEEDOR_IA ?? "auto").trim().toLowerCase(),
  supabaseUrl: (process.env.SUPABASE_URL ?? "").trim(),
  supabaseAnonKey: (process.env.SUPABASE_ANON_KEY ?? "").trim(),
};

export const extensionesCodigo = new Map([
  [".js", "JavaScript"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".jsx", "JavaScript"],
  [".html", "HTML"],
  [".htm", "HTML"],
  [".css", "CSS"],
  [".scss", "SCSS"],
  [".java", "Java"],
  [".py", "Python"],
  [".php", "PHP"],
  [".sql", "SQL"],
  [".json", "JSON"],
  [".xml", "XML"],
  [".sh", "Bash"],
  [".c", "C"],
  [".h", "C"],
  [".cpp", "C++"],
  [".cs", "C#"],
  [".rb", "Ruby"],
  [".go", "Go"],
  [".rs", "Rust"],
  [".kt", "Kotlin"],
  [".kts", "Kotlin"],
  [".swift", "Swift"],
  [".dart", "Dart"],
  [".vue", "Vue"],
  [".svelte", "Svelte"],
  [".ipynb", "Jupyter Notebook"],
  [".yml", "YAML"],
  [".yaml", "YAML"],
  [".toml", "TOML"],
  [".ini", "INI"],
  [".gradle", "Gradle"],
  [".dockerfile", "Dockerfile"],
]);

export const extensionesTexto = new Set([
  ".tex",
  ".md",
  ".txt",
  ".rst",
  ".csv",
  ".log",
]);
export const extensionesImagen = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".tif",
  ".tiff",
  ".bmp",
  ".gif",
]);
export const extensionesAdmitidas = new Set([
  ".pdf",
  ".zip",
  ...extensionesCodigo.keys(),
  ...extensionesTexto,
  ...extensionesImagen,
]);

export function obtenerExtension(filename) {
  const base = path.posix
    .basename(filename.replaceAll("\\", "/"))
    .toLowerCase();
  return base === "dockerfile" ? ".dockerfile" : path.posix.extname(base);
}
