// Cliente HTTP para la API. Lanza Error con el mensaje del servidor.
let alExpirarSesion = () => {};
export function onSesionExpirada(fn) {
  alExpirarSesion = fn;
}

export async function api(ruta, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${ruta}`, opts);
  let datos = null;
  try {
    datos = await res.json();
  } catch {
    /* respuesta sin cuerpo JSON */
  }
  if (res.status === 401 && !ruta.startsWith('/auth/login')) alExpirarSesion();
  if (!res.ok) {
    const err = new Error(datos?.error || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return datos;
}

export const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
};
