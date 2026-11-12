function identidadArchivo(archivo) {
  return `${archivo.webkitRelativePath || archivo.name}\0${archivo.size}\0${archivo.lastModified}`;
}

export function combinarArchivos(existentes, nuevos) {
  const resultado = [...existentes];
  const identidades = new Set(resultado.map(identidadArchivo));
  for (const archivo of nuevos) {
    const identidad = identidadArchivo(archivo);
    if (identidades.has(identidad)) continue;
    identidades.add(identidad);
    resultado.push(archivo);
  }
  return resultado;
}
