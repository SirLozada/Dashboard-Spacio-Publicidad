// Menciones con @usuario o @Nombre (solicitudes y tareas de «Mi día»).
const { db } = require('../db');

// Usuarios mencionados con @usuario o @Nombre en un texto.
async function mencionados(mensaje) {
  const quitarAcentos = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const marcas = [...String(mensaje).matchAll(/@([\p{L}\d._-]+)/gu)].map((m) => quitarAcentos(m[1]).replace(/[._-]+$/, ''));
  if (!marcas.length) return [];
  const usuarios = await db.all('SELECT id, usuario, nombre FROM usuarios WHERE activo = 1');
  return usuarios
    .filter((u) => marcas.some((m) => m === quitarAcentos(u.usuario) || m === quitarAcentos(u.nombre.split(/\s+/)[0]) || m === quitarAcentos(u.nombre.replace(/\s+/g, ''))))
    .map((u) => u.id);
}

module.exports = { mencionados };
