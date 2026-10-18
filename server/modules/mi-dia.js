// «Mi día»: agenda personal de cada usuario.
// Combina tareas manuales y notas personales (tablas propias) con pendientes
// automáticos que se leen directamente de trabajos y solicitudes (sin copiarlos).
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const compromisos = require('../lib/compromisos');
const estatus = require('../lib/estatus');
const { notificar } = require('../lib/notificaciones');
const { HttpError, hoy, sumarDias, convertir } = require('../lib/util');

const PRIORIDADES = ['normal', 'alta', 'urgente'];
const ESTADOS_TAREA = ['pendiente', 'en_proceso', 'completada'];
const PESO = { urgente: 0, alta: 1, normal: 2 };
const DIAS_PROXIMOS = 7;
const ABIERTAS = config.SOLICITUD_ESTADOS.filter((e) => e.abierta).map((e) => e.key);
const TIPOS_SOLICITUD = Object.fromEntries(config.SOLICITUD_TIPOS.map((t) => [t.key, t.label]));
const numeroTrabajo = (n) => `${config.PREFIJO_TRABAJO}${String(n).padStart(4, '0')}`;
const esAdmin = (u) => u.rol === 'admin';
const texto = (v, max) => {
  const t = convertir(v, 'text');
  return t ? t.slice(0, max) : null;
};
const fechaValida = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const horaValida = (v) => (/^\d{2}:\d{2}$/.test(v || '') ? v : null);
const lista = (n) => config.SOLICITUD_ESTADOS.filter((e) => n.includes(e.key)).map((e) => `'${e.key}'`).join(', ');

// ---------- Lectura ----------

const SELECT_TAREA = `
  SELECT ta.*, t.numero AS trabajo_numero, t.cliente AS trabajo_cliente, t.tienda AS trabajo_tienda,
    ua.nombre AS asignado_nombre, uc.nombre AS creado_por_nombre
  FROM tareas ta
  LEFT JOIN trabajos t ON t.id = ta.trabajo_id
  LEFT JOIN usuarios ua ON ua.id = ta.asignado_a
  LEFT JOIN usuarios uc ON uc.id = ta.creado_por`;

const SELECT_NOTA = `
  SELECT n.*, t.numero AS trabajo_numero, t.cliente AS trabajo_cliente
  FROM notas_personales n LEFT JOIN trabajos t ON t.id = n.trabajo_id`;

const proyecto = (numero, cliente) => (numero ? `${numeroTrabajo(numero)} · ${cliente}` : null);

function itemTarea(ta, usuario, h) {
  return {
    clave: `tarea:${ta.id}`,
    origen: 'tarea',
    id: ta.id,
    titulo: ta.titulo,
    descripcion: ta.descripcion,
    observaciones: ta.observaciones,
    fecha: ta.fecha,
    hora: ta.hora,
    prioridad: ta.prioridad,
    estado: ta.estado,
    vencido: ta.estado !== 'completada' && !!ta.fecha && ta.fecha < h,
    trabajo_id: ta.trabajo_id,
    proyecto: proyecto(ta.trabajo_numero, ta.trabajo_cliente),
    asignado_a: ta.asignado_a,
    asignado_nombre: ta.asignado_nombre,
    creado_por: ta.creado_por,
    creado_por_nombre: ta.creado_por_nombre,
    completada_fecha: ta.completada_fecha,
    archivada: !!ta.archivada,
    actualizado_en: ta.actualizado_en,
    // Quién puede reasignar y eliminar: quien la creó o un administrador.
    puede_gestionar: ta.creado_por === usuario.id || esAdmin(usuario),
  };
}

function itemNota(n) {
  return {
    clave: `nota:${n.id}`,
    origen: 'nota',
    id: n.id,
    titulo: n.titulo,
    nota: n.nota,
    fecha: n.fecha,
    prioridad: n.importancia,
    trabajo_id: n.trabajo_id,
    proyecto: proyecto(n.trabajo_numero, n.trabajo_cliente),
    archivada: !!n.archivada,
  };
}

async function obtenerTarea(id, usuario) {
  const ta = await db.get(`${SELECT_TAREA} WHERE ta.id = ?`, id);
  if (!ta) throw new HttpError(404, 'Tarea no encontrada');
  // Sólo la ven quien la creó y la persona asignada.
  if (ta.creado_por !== usuario.id && ta.asignado_a !== usuario.id) throw new HttpError(404, 'Tarea no encontrada');
  return ta;
}

async function obtenerNota(id, usuario) {
  const n = await db.get(`${SELECT_NOTA} WHERE n.id = ? AND n.usuario_id = ?`, id, usuario.id);
  if (!n) throw new HttpError(404, 'Nota no encontrada');
  return n;
}

// ---------- Pendientes automáticos (se leen de sus módulos) ----------

// Devuelve { items, atencion }: atencion sólo para administradores (decisiones).
async function pendientesAutomaticos(usuario, hasta) {
  const h = hoy();
  const admin = esAdmin(usuario);
  const items = [];
  const atencion = [];

  // 1. Compromisos de proyectos (fechas de los trabajos).
  //    Administrador: todos. Usuario: los proyectos donde figura como responsable.
  const primerNombre = usuario.nombre.trim().split(/\s+/)[0];
  const deProyectos = await compromisos.listar({ hasta, responsable: admin ? undefined : primerNombre });
  for (const c of deProyectos) {
    const item = {
      clave: `trabajo:${c.trabajo.id}:${c.tipo}`,
      origen: 'auto',
      tipo: c.tipo,
      etiqueta: c.etiqueta,
      titulo: `${c.etiqueta}: ${c.trabajo.codigo} · ${c.trabajo.cliente}`,
      detalle: [c.trabajo.tienda || c.trabajo.marca, c.trabajo.responsable ? `Responsable: ${c.trabajo.responsable}` : null].filter(Boolean).join(' · '),
      fecha: c.fecha,
      vencido: c.vencido,
      prioridad: c.vencido || c.tipo === 'reclamo' ? 'urgente' : c.proximo ? 'alta' : 'normal',
      enlace: { tipo: 'trabajo', id: c.trabajo.id },
    };
    // Al administrador le piden atención los compromisos vencidos y los reclamos.
    (admin && (c.vencido || c.tipo === 'reclamo') ? atencion : items).push(item);
  }

  // Trabajos en reclamo sin fecha de entrega (no aparecen como compromiso fechado).
  if (admin) {
    const reclamos = await db.all(
      `SELECT id, numero, cliente, tienda FROM trabajos WHERE fecha_entrega IS NULL AND ${estatus.sqlContiene('estatus', ['reclamo'])}`
    );
    for (const t of reclamos) {
      atencion.push({
        clave: `trabajo:${t.id}:reclamo`,
        origen: 'auto',
        tipo: 'reclamo',
        etiqueta: 'Reclamo pendiente',
        titulo: `Reclamo pendiente: ${numeroTrabajo(t.numero)} · ${t.cliente}`,
        detalle: t.tienda || '',
        fecha: null,
        vencido: false,
        prioridad: 'urgente',
        enlace: { tipo: 'trabajo', id: t.id },
      });
    }
  }

  // 2. Solicitudes y novedades abiertas.
  const solicitudes = await db.all(
    `SELECT s.id, s.titulo, s.tipo, s.prioridad, s.estado, s.creado_por, date(s.creado_en) AS fecha_creacion,
       t.numero, t.cliente, u.nombre AS creado_por_nombre,
       EXISTS (SELECT 1 FROM solicitud_destinatarios d WHERE d.solicitud_id = s.id AND d.usuario_id = ?) AS soy_destinatario
     FROM solicitudes s JOIN trabajos t ON t.id = s.trabajo_id LEFT JOIN usuarios u ON u.id = s.creado_por
     WHERE s.estado IN (${lista(ABIERTAS)})`,
    usuario.id
  );
  for (const s of solicitudes) {
    const base = {
      clave: `solicitud:${s.id}`,
      origen: 'auto',
      tipo: 'solicitud',
      detalle: [`${numeroTrabajo(s.numero)} · ${s.cliente}`, TIPOS_SOLICITUD[s.tipo], s.creado_por_nombre ? `de ${s.creado_por_nombre}` : null].filter(Boolean).join(' · '),
      fecha: null,
      vencido: false,
      prioridad: s.prioridad,
      enlace: { tipo: 'solicitud', id: s.id },
    };
    if (admin && s.estado === 'pendiente_aprobacion') {
      atencion.push({ ...base, etiqueta: 'Aprobación pendiente', titulo: `Aprobar: ${s.titulo}` });
    } else if (admin && (s.tipo === 'reclamo' || s.prioridad === 'urgente')) {
      atencion.push({ ...base, etiqueta: s.tipo === 'reclamo' ? 'Reclamo' : 'Asunto urgente', titulo: s.titulo });
    } else if (s.soy_destinatario && s.creado_por !== usuario.id && ['nueva', 'en_revision', 'en_proceso'].includes(s.estado)) {
      items.push({ ...base, etiqueta: 'Requiere tu respuesta', titulo: `Responder: ${s.titulo}` });
    } else if (admin && s.estado === 'nueva' && s.tipo === 'observacion_cliente') {
      items.push({ ...base, etiqueta: 'Observación nueva del cliente', titulo: s.titulo });
    }
  }
  return { items, atencion };
}

// ---------- Armado de «Mi día» ----------

const ordenar = (a, b) =>
  (b.vencido === true) - (a.vencido === true) ||
  (PESO[a.prioridad] ?? 2) - (PESO[b.prioridad] ?? 2) ||
  String(a.fecha || '').localeCompare(String(b.fecha || '')) ||
  String(a.hora || '99').localeCompare(String(b.hora || '99'));

async function miDia(usuario, fecha) {
  const h = hoy();
  const d = fecha || h;
  const finProximos = sumarDias(d, DIAS_PROXIMOS);

  const [tareas, notas, auto, recibidas] = await Promise.all([
    db.all(
      `${SELECT_TAREA} WHERE ta.asignado_a = ? AND ta.archivada = 0 AND (ta.estado <> 'completada' OR ta.completada_fecha = ?)`,
      usuario.id,
      d
    ),
    db.all(`${SELECT_NOTA} WHERE n.usuario_id = ? AND n.archivada = 0`, usuario.id),
    pendientesAutomaticos(usuario, finProximos),
    // Tareas asignadas por otras personas que aún no están completadas.
    db.column("SELECT id FROM tareas WHERE asignado_a = ? AND creado_por <> ? AND estado <> 'completada' AND archivada = 0", usuario.id, usuario.id),
  ]);

  const hoyLista = [];
  const atrasados = [];
  const proximos = [];
  const completados = [];
  const atencion = esAdmin(usuario) ? [...auto.atencion] : [];
  const deOtros = new Set(recibidas);

  for (const ta of tareas) {
    const it = itemTarea(ta, usuario, h);
    if (ta.estado === 'completada') {
      if (ta.completada_fecha === d) completados.push(it);
      continue;
    }
    // Al administrador, las tareas que le asignaron otras personas le piden atención.
    if (esAdmin(usuario) && deOtros.has(ta.id)) {
      atencion.push({ ...it, etiqueta: `Te la asignó ${ta.creado_por_nombre || 'otro usuario'}` });
      continue;
    }
    if (it.vencido) atrasados.push(it);
    else if (!ta.fecha || ta.fecha === d) hoyLista.push(it);
    else if (ta.fecha > d && ta.fecha <= finProximos) proximos.push(it);
  }

  for (const n of notas) {
    const it = itemNota(n);
    // Los recordatorios siguen visibles hasta archivarlos.
    if (!n.fecha || n.fecha === d || (d === h && n.fecha < h)) hoyLista.push(it);
    else if (n.fecha > d && n.fecha <= finProximos) proximos.push(it);
  }

  for (const it of auto.items) {
    if (it.vencido) atrasados.push(it);
    else if (!it.fecha) {
      if (d === h) hoyLista.push(it);
    } else if (it.fecha === d) hoyLista.push(it);
    else if (it.fecha > d && it.fecha <= finProximos) proximos.push(it);
  }

  [hoyLista, atrasados, proximos, atencion].forEach((l) => l.sort(ordenar));
  completados.sort((a, b) => String(b.actualizado_en).localeCompare(String(a.actualizado_en)));

  const tareasPendientes = tareas.filter((t) => t.estado !== 'completada' && (!t.fecha || t.fecha <= d)).length;
  return {
    fecha: d,
    hoy: h,
    resumen: {
      pendientes: tareasPendientes,
      completadas: completados.length,
      atrasados: atrasados.length + atencion.filter((i) => i.vencido).length,
      atencion: atencion.length,
    },
    atencion,
    secciones: { hoy: hoyLista, atrasados, proximos, completados },
  };
}

// ---------- Rutas ----------

const router = express.Router();

router.get('/', async (req, res) => {
  res.json(await miDia(req.usuario, fechaValida(req.query.fecha)));
});

// Resumen para el Dashboard.
router.get('/resumen', async (req, res) => {
  const r = await miDia(req.usuario, null);
  res.json({ ...r.resumen, hoy: r.secciones.hoy.length });
});

// Agenda personal: tareas, notas y compromisos del usuario en un rango de fechas.
router.get('/agenda', async (req, res) => {
  const h = hoy();
  const desde = fechaValida(req.query.desde);
  const hasta = fechaValida(req.query.hasta) || sumarDias(h, 30);
  const enRango = (f) => f && (desde ? f >= desde : f >= h) && f <= hasta;
  const [tareas, notas, auto] = await Promise.all([
    db.all(`${SELECT_TAREA} WHERE ta.asignado_a = ? AND ta.archivada = 0 AND ta.fecha IS NOT NULL`, req.usuario.id),
    db.all(`${SELECT_NOTA} WHERE n.usuario_id = ? AND n.archivada = 0 AND n.fecha IS NOT NULL`, req.usuario.id),
    pendientesAutomaticos(req.usuario, hasta),
  ]);
  const eventos = [];
  for (const ta of tareas) {
    const it = itemTarea(ta, req.usuario, h);
    if (enRango(ta.fecha) || (!desde && it.vencido)) eventos.push(it);
  }
  for (const n of notas) if (enRango(n.fecha)) eventos.push(itemNota(n));
  for (const it of [...auto.items, ...auto.atencion]) {
    if (it.fecha && (enRango(it.fecha) || (!desde && it.vencido))) eventos.push(it);
  }
  res.json(eventos);
});

// Proyectos activos para vincular tareas y notas.
router.get('/proyectos', async (req, res) => {
  const filas = await db.all(
    `SELECT id, numero, cliente, tienda FROM trabajos WHERE NOT ${estatus.sqlContiene('estatus', config.ESTATUS_CERRADOS)} ORDER BY numero DESC`
  );
  res.json(filas.map((t) => ({ id: t.id, nombre: `${numeroTrabajo(t.numero)} · ${t.cliente}${t.tienda ? ` · ${t.tienda}` : ''}` })));
});

// --- Tareas ---

async function leerTarea(b, usuario, actual = null) {
  const titulo = b.titulo !== undefined ? texto(b.titulo, 200) : actual?.titulo;
  if (!titulo) throw new HttpError(400, 'Escribe el título de la tarea');
  const datos = {
    titulo,
    descripcion: b.descripcion !== undefined ? texto(b.descripcion, 3000) : actual?.descripcion ?? null,
    observaciones: b.observaciones !== undefined ? texto(b.observaciones, 3000) : actual?.observaciones ?? null,
    fecha: b.fecha !== undefined ? fechaValida(b.fecha) : actual?.fecha ?? null,
    hora: b.hora !== undefined ? horaValida(b.hora) : actual?.hora ?? null,
    prioridad: b.prioridad !== undefined ? b.prioridad : actual?.prioridad ?? 'normal',
    estado: b.estado !== undefined ? b.estado : actual?.estado ?? 'pendiente',
    trabajo_id: b.trabajo_id !== undefined ? Number(b.trabajo_id) || null : actual?.trabajo_id ?? null,
    asignado_a: b.asignado_a !== undefined ? Number(b.asignado_a) || usuario.id : actual?.asignado_a ?? usuario.id,
    archivada: b.archivada !== undefined ? (b.archivada ? 1 : 0) : actual?.archivada ?? 0,
  };
  if (!PRIORIDADES.includes(datos.prioridad)) throw new HttpError(400, 'Prioridad no válida');
  if (!ESTADOS_TAREA.includes(datos.estado)) throw new HttpError(400, 'Estado no válido');
  if (datos.trabajo_id && !(await db.value('SELECT 1 FROM trabajos WHERE id = ?', datos.trabajo_id))) {
    throw new HttpError(400, 'El proyecto no existe');
  }
  if (!(await db.value('SELECT 1 FROM usuarios WHERE id = ? AND activo = 1', datos.asignado_a))) {
    throw new HttpError(400, 'El usuario responsable no está activo');
  }
  return datos;
}

const avisoAsignacion = (tx, ta, actor, tipo) =>
  notificar(tx, {
    destinos: [
      {
        usuarioId: ta.asignado_a,
        tipo,
        titulo: `${actor.nombre} ${tipo === 'tarea_reasignada' ? 'te reasignó' : 'te asignó'} una tarea`,
        mensaje: `${ta.titulo}${ta.fecha ? ` · para el ${ta.fecha.split('-').reverse().join('/')}` : ''}`,
      },
    ],
    tareaId: ta.id,
    trabajoId: ta.trabajo_id,
    actorId: actor.id,
  });

router.get('/tareas/:id', async (req, res) => {
  res.json(itemTarea(await obtenerTarea(req.params.id, req.usuario), req.usuario, hoy()));
});

// Historial de tareas completadas.
router.get('/historial', async (req, res) => {
  const filas = await db.all(
    `${SELECT_TAREA} WHERE (ta.asignado_a = ? OR ta.creado_por = ?) AND (ta.estado = 'completada' OR ta.archivada = 1)
     ORDER BY COALESCE(ta.completada_fecha, date(ta.actualizado_en)) DESC, ta.id DESC LIMIT 200`,
    req.usuario.id,
    req.usuario.id
  );
  res.json(filas.map((ta) => itemTarea(ta, req.usuario, hoy())));
});

router.post('/tareas', async (req, res) => {
  const datos = await leerTarea(req.body || {}, req.usuario);
  const id = await db.transaction(async (tx) => {
    const { lastInsertRowid } = await tx.run(
      `INSERT INTO tareas (titulo, descripcion, observaciones, fecha, hora, prioridad, estado, trabajo_id, asignado_a, creado_por, actualizado_por, completada_fecha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      datos.titulo, datos.descripcion, datos.observaciones, datos.fecha, datos.hora, datos.prioridad, datos.estado,
      datos.trabajo_id, datos.asignado_a, req.usuario.id, req.usuario.id, datos.estado === 'completada' ? hoy() : null
    );
    if (datos.asignado_a !== req.usuario.id) await avisoAsignacion(tx, { ...datos, id: lastInsertRowid }, req.usuario, 'tarea_asignada');
    return lastInsertRowid;
  });
  res.status(201).json(itemTarea(await obtenerTarea(id, req.usuario), req.usuario, hoy()));
});

router.patch('/tareas/:id', async (req, res) => {
  const actual = await obtenerTarea(req.params.id, req.usuario);
  const b = req.body || {};
  const gestiona = actual.creado_por === req.usuario.id || esAdmin(req.usuario);
  if (b.asignado_a !== undefined && Number(b.asignado_a) !== actual.asignado_a && !gestiona) {
    throw new HttpError(403, 'Sólo quien creó la tarea o un administrador puede reasignarla');
  }
  const datos = await leerTarea(b, req.usuario, actual);
  const completada = datos.estado === 'completada' ? actual.completada_fecha || hoy() : null;
  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE tareas SET titulo = ?, descripcion = ?, observaciones = ?, fecha = ?, hora = ?, prioridad = ?, estado = ?, trabajo_id = ?,
         asignado_a = ?, archivada = ?, completada_fecha = ?, actualizado_por = ?, actualizado_en = datetime('now') WHERE id = ?`,
      datos.titulo, datos.descripcion, datos.observaciones, datos.fecha, datos.hora, datos.prioridad, datos.estado, datos.trabajo_id,
      datos.asignado_a, datos.archivada, completada, req.usuario.id, actual.id
    );
    if (datos.asignado_a !== actual.asignado_a) {
      await avisoAsignacion(tx, { ...datos, id: actual.id }, req.usuario, 'tarea_reasignada');
      // Las notificaciones de la tarea dejan de ser de la persona anterior.
      await tx.run('DELETE FROM notificaciones WHERE tarea_id = ? AND usuario_id = ? AND leida = 0', actual.id, actual.asignado_a);
    }
  });
  // Si quien la editó ya no es responsable ni creador, deja de verla.
  const ta = await db.get(`${SELECT_TAREA} WHERE ta.id = ?`, actual.id);
  res.json(itemTarea(ta, req.usuario, hoy()));
});

router.delete('/tareas/:id', async (req, res) => {
  const actual = await obtenerTarea(req.params.id, req.usuario);
  if (actual.creado_por !== req.usuario.id && !esAdmin(req.usuario)) {
    throw new HttpError(403, 'Sólo quien creó la tarea o un administrador puede eliminarla. Puedes archivarla.');
  }
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM notificaciones WHERE tarea_id = ?', actual.id);
    await tx.run('DELETE FROM tareas WHERE id = ?', actual.id);
  });
  res.json({ ok: true });
});

// --- Notas personales (privadas: nunca generan notificaciones) ---

async function leerNota(b, actual = null) {
  const titulo = b.titulo !== undefined ? texto(b.titulo, 200) : actual?.titulo;
  if (!titulo) throw new HttpError(400, 'Escribe el título de la observación');
  const datos = {
    titulo,
    nota: b.nota !== undefined ? texto(b.nota, 5000) : actual?.nota ?? null,
    fecha: b.fecha !== undefined ? fechaValida(b.fecha) : actual?.fecha ?? null,
    trabajo_id: b.trabajo_id !== undefined ? Number(b.trabajo_id) || null : actual?.trabajo_id ?? null,
    importancia: b.importancia !== undefined ? b.importancia : actual?.importancia ?? 'normal',
    archivada: b.archivada !== undefined ? (b.archivada ? 1 : 0) : actual?.archivada ?? 0,
  };
  if (!PRIORIDADES.includes(datos.importancia)) throw new HttpError(400, 'Importancia no válida');
  if (datos.trabajo_id && !(await db.value('SELECT 1 FROM trabajos WHERE id = ?', datos.trabajo_id))) {
    throw new HttpError(400, 'El proyecto no existe');
  }
  return datos;
}

router.get('/notas', async (req, res) => {
  const archivadas = req.query.archivadas ? 1 : 0;
  const filas = await db.all(`${SELECT_NOTA} WHERE n.usuario_id = ? AND n.archivada = ? ORDER BY n.fecha DESC, n.id DESC LIMIT 200`, req.usuario.id, archivadas);
  res.json(filas.map(itemNota));
});

router.get('/notas/:id', async (req, res) => {
  res.json(itemNota(await obtenerNota(req.params.id, req.usuario)));
});

router.post('/notas', async (req, res) => {
  const d = await leerNota(req.body || {});
  const { lastInsertRowid } = await db.run(
    'INSERT INTO notas_personales (usuario_id, titulo, nota, fecha, trabajo_id, importancia) VALUES (?, ?, ?, ?, ?, ?)',
    req.usuario.id, d.titulo, d.nota, d.fecha, d.trabajo_id, d.importancia
  );
  res.status(201).json(itemNota(await obtenerNota(lastInsertRowid, req.usuario)));
});

router.patch('/notas/:id', async (req, res) => {
  const actual = await obtenerNota(req.params.id, req.usuario);
  const d = await leerNota(req.body || {}, actual);
  await db.run(
    `UPDATE notas_personales SET titulo = ?, nota = ?, fecha = ?, trabajo_id = ?, importancia = ?, archivada = ?, actualizado_en = datetime('now')
     WHERE id = ?`,
    d.titulo, d.nota, d.fecha, d.trabajo_id, d.importancia, d.archivada, actual.id
  );
  res.json(itemNota(await obtenerNota(actual.id, req.usuario)));
});

router.delete('/notas/:id', async (req, res) => {
  const actual = await obtenerNota(req.params.id, req.usuario);
  await db.run('DELETE FROM notas_personales WHERE id = ?', actual.id);
  res.json({ ok: true });
});

module.exports = { router, pendientesAutomaticos };
