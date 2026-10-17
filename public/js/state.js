// Estado global compartido: usuario en sesión y configuración del servidor.
export const state = {
  usuario: null,
  config: null,
};

export const estatusPorKey = (key) => state.config?.estatus.find((e) => e.key === key);
export const esCerrado = (key) => state.config?.estatusCerrados.includes(key);
export const numeroTrabajo = (n) => `${state.config?.prefijoTrabajo ?? ''}${String(n).padStart(4, '0')}`;
export const esAdmin = () => state.usuario?.rol === 'admin';
