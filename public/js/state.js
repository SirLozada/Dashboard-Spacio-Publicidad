// Estado global compartido: usuario en sesión y configuración del servidor.
export const state = {
  usuario: null,
  config: null,
};

export const estatusPorKey = (key) => state.config?.estatus.find((e) => e.key === key);
export const esCerrado = (key) => state.config?.estatusCerrados.includes(key);

// Un trabajo puede tener varios estatus, guardados como "por_cotizar,render".
export const listaEstatus = (valor) => String(valor ?? '').split(',').filter(Boolean);
// Proyecto aprobado (Aprobado o un estatus posterior): habilitado para pagos de producción.
export const esAprobado = (valor) => listaEstatus(valor).some((k) => state.config?.estatusAprobados.includes(k));
export const filtroAprobados = () => state.config?.estatusAprobados.join(',');
export const sinAlerta = (valor) => listaEstatus(valor).some((k) => state.config?.estatusSinAlerta.includes(k));

// Marca o desmarca un estatus. Finalizado y Rechazado van solos: al marcar uno
// se quitan los demás, y al marcar otro estatus se quitan ellos.
export function alternarEstatus(valor, key, marcado) {
  let claves = listaEstatus(valor).filter((k) => k !== key);
  if (marcado) {
    claves = esCerrado(key) ? [key] : [...claves.filter((k) => !esCerrado(k)), key];
  }
  const orden = state.config.estatus.map((e) => e.key);
  return orden.filter((k) => claves.includes(k)).join(',') || 'por_cotizar';
}
export const numeroTrabajo = (n) => `${state.config?.prefijoTrabajo ?? ''}${String(n).padStart(4, '0')}`;
export const esAdmin = () => state.usuario?.rol === 'admin';
