export async function detectarGeneradorIniciado(
  direccion,
  modelo,
  consultar = fetch,
) {
  try {
    const respuesta = await consultar(`${direccion}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!respuesta.ok) return false;
    const estado = await respuesta.json();
    return estado.provider === "ollama local" && estado.model === modelo;
  } catch {
    return false;
  }
}
