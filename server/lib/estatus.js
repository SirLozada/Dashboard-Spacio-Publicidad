// Un trabajo puede tener varios estatus a la vez (p. ej. "Por cotizar" y
// "Render"). Se guardan en la columna estatus como claves separadas por coma,
// en el orden definido en config.ESTATUS: "por_cotizar,render".
const config = require('../config');
const { HttpError } = require('./util');

const lista = (valor) =>
  String(valor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Valida y ordena los estatus. Finalizado y Rechazado van solos: si vienen
// junto a otros, prevalece el estatus cerrado.
function normalizar(valor) {
  const claves = Array.isArray(valor) ? valor : lista(valor);
  for (const c of claves) {
    if (!config.ESTATUS_KEYS.includes(c)) throw new HttpError(400, 'Estatus no válido');
  }
  const cerrado = config.ESTATUS_KEYS.find((k) => config.ESTATUS_CERRADOS.includes(k) && claves.includes(k));
  if (cerrado) return cerrado;
  const ordenadas = config.ESTATUS_KEYS.filter((k) => claves.includes(k));
  return ordenadas.length ? ordenadas.join(',') : 'por_cotizar';
}

// Condición SQL: la columna contiene alguno de los estatus indicados.
// Las claves vienen de la configuración (no del usuario), por eso van en el SQL.
function sqlContiene(columna, claves) {
  if (!claves.length) return '0';
  return `(${claves.map((k) => `instr(',' || ${columna} || ',', ',${k},') > 0`).join(' OR ')})`;
}

const etiquetas = (valor) =>
  lista(valor)
    .map((k) => config.ESTATUS.find((e) => e.key === k)?.label || k)
    .join(' + ');

module.exports = { lista, normalizar, sqlContiene, etiquetas };
