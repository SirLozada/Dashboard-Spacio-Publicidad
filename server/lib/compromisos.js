// Compromisos de los proyectos calculados a partir de las fechas que ya tiene
// cada trabajo (no se guardan aparte). Los usan la agenda de trabajos y «Mi día».
const { db } = require('../db');
const config = require('../config');
const estatus = require('./estatus');
const { hoy, sumarDias, likeParam } = require('./util');

const numeroTrabajo = (n) => `${config.PREFIJO_TRABAJO}${String(n).padStart(4, '0')}`;
const tiene = (t, ...claves) => estatus.lista(t.estatus).some((k) => claves.includes(k));

// Tipos de compromiso (la etiqueta es la que se ve en la agenda).
const TIPOS = {
  cotizacion: 'Entrega de cotización',
  inicio: 'Inicio de trabajo',
  produccion: 'Entrega · en producción',
  entrega: 'Entrega del trabajo',
  reclamo: 'Reclamo pendiente',
};

// Compromisos de un trabajo (puede tener varios: cotización, inicio y entrega).
function deTrabajo(t, h = hoy()) {
  if (tiene(t, ...config.ESTATUS_CERRADOS)) return [];
  const limiteProximo = sumarDias(h, config.DIAS_ALERTA);
  const lista = [];
  const agregar = (tipo, fecha, vencido) =>
    lista.push({
      tipo,
      etiqueta: TIPOS[tipo],
      fecha,
      vencido,
      proximo: !vencido && fecha >= h && fecha <= limiteProximo,
      trabajo: { id: t.id, codigo: numeroTrabajo(t.numero), cliente: t.cliente, marca: t.marca, tienda: t.tienda, estatus: t.estatus, responsable: t.responsable },
    });
  // La cotización está pendiente mientras el trabajo siga "Por cotizar" o en "Render".
  if (t.fecha_cotizacion && tiene(t, 'por_cotizar', 'render')) agregar('cotizacion', t.fecha_cotizacion, t.fecha_cotizacion < h);
  // Por iniciar: aprobado (o aún sin aprobar) y todavía no está en producción.
  if (t.fecha_inicio && !tiene(t, 'produccion', 'instalado', 'reclamo')) {
    agregar('inicio', t.fecha_inicio, t.fecha_inicio < h && tiene(t, 'aprobado'));
  }
  if (t.fecha_entrega) {
    const sinAlerta = tiene(t, ...config.ESTATUS_SIN_ALERTA);
    if (!sinAlerta) {
      const tipo = tiene(t, 'reclamo') ? 'reclamo' : tiene(t, 'produccion') ? 'produccion' : 'entrega';
      agregar(tipo, t.fecha_entrega, t.fecha_entrega < h);
    }
  }
  return lista;
}

// filtros: { desde, hasta, cliente, marca, estatus, responsable }
// Sin "desde" se incluyen todos los atrasados hasta "hasta".
async function listar({ desde = null, hasta, cliente, marca, estatus: est, responsable } = {}) {
  const where = [`NOT ${estatus.sqlContiene('t.estatus', config.ESTATUS_CERRADOS)}`];
  const params = [];
  if (cliente) {
    where.push('t.cliente = ?');
    params.push(cliente);
  }
  if (marca) {
    where.push('t.marca = ?');
    params.push(marca);
  }
  if (est) {
    const lista = estatus.lista(est).filter((e) => config.ESTATUS_KEYS.includes(e));
    if (lista.length) where.push(estatus.sqlContiene('t.estatus', lista));
  }
  if (responsable) {
    where.push("t.responsable LIKE ? ESCAPE '\\'");
    params.push(likeParam(responsable));
  }
  const trabajos = await db.all(
    `SELECT t.id, t.numero, t.cliente, t.marca, t.tienda, t.estatus, t.responsable, t.fecha_inicio, t.fecha_cotizacion, t.fecha_entrega
     FROM trabajos t WHERE ${where.join(' AND ')}`,
    ...params
  );
  const h = hoy();
  return trabajos
    .flatMap((t) => deTrabajo(t, h))
    .filter((c) => (desde ? c.fecha >= desde : c.vencido || c.fecha >= h) && (!hasta || c.fecha <= hasta))
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.trabajo.codigo.localeCompare(b.trabajo.codigo));
}

module.exports = { TIPOS, deTrabajo, listar };
