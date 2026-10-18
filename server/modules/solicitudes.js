// Solicitudes y novedades: comunicación interna vinculada a cada proyecto,
// con conversación, aprobaciones y notificaciones por usuario.
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const almacen = require('../lib/almacen');
const { notificar } = require('../lib/notificaciones');
const { revisarAvisos } = require('../lib/avisos');
const { HttpError, convertir, likeParam } = require('../lib/util');

const TIPOS = Object.fromEntries(config.SOLICITUD_TIPOS.map((t) => [t.key, t.label]));
const ESTADOS = Object.fromEntries(config.SOLICITUD_ESTADOS.map((e) => [e.key, e]));
const PRIORIDADES = config.PRIORIDADES.map((p) => p.key);
const ABIERTAS_SQL = config.SOLICITUD_ESTADOS.filter((e) => e.abierta).map((e) => `'${e.key}'`).join(', ');
const numeroTrabajo = (n) => `${config.PREFIJO_TRABAJO}${String(n).padStart(4, '0')}`;
const esAdmin = (u) => u.rol === 'admin';
const texto = (v, max = 5000) => {
  const t = convertir(v, 'text');
  return t ? t.slice(0, max) : null;
};
const resumir = (t, n = 140) => (t && t.length > n ? `${t.slice(0, n - 1)}…` : t || '');

const SELECT_SOLICITUD = `
  SELECT s.*, t.numero, t.cliente, t.descripcion AS trabajo_descripcion, t.estatus AS trabajo_estatus,
    u.nombre AS creado_por_nombre, ap.nombre AS aprobada_por_nombre,
    (SELECT GROUP_CONCAT(du.nombre, ', ') FROM solicitud_destinatarios d JOIN usuarios du ON du.id = d.usuario_id WHERE d.solicitud_id = s.id) AS destinatarios_nombres,
    (SELECT COUNT(*) FROM solicitud_comentarios c WHERE c.solicitud_id = s.id AND c.tipo = 'comentario') AS total_comentarios,
    (SELECT MAX(c.creado_en) FROM solicitud_comentarios c WHERE c.solicitud_id = s.id) AS ultima_actividad
  FROM solicitudes s
  JOIN trabajos t ON t.id = s.trabajo_id
  LEFT JOIN usuarios u ON u.id = s.creado_por
  LEFT JOIN usuarios ap ON ap.id = s.aprobada_por`;

function completar(s) {
  return {
    ...s,
    proyecto: `${numeroTrabajo(s.numero)} · ${s.cliente}`,
    tipo_label: TIPOS[s.tipo] || s.tipo,
    abierta: ESTADOS[s.estado]?.abierta ?? true,
  };
}

async function obtener(id) {
  const s = await db.get(`${SELECT_SOLICITUD} WHERE s.id = ?`, id);
  return s ? completar(s) : null;
}

const destinatariosDe = (id) => db.column('SELECT usuario_id FROM solicitud_destinatarios WHERE solicitud_id = ?', id);

// Participantes: quien la creó, sus destinatarios y quienes comentaron.
async function participantes(s) {
  const comentaron = await db.column(
    "SELECT DISTINCT usuario_id FROM solicitud_comentarios WHERE solicitud_id = ? AND tipo = 'comentario' AND usuario_id IS NOT NULL",
    s.id
  );
  return [...new Set([s.creado_por, ...(await destinatariosDe(s.id)), ...comentaron].filter(Boolean))];
}

const administradores = () => db.column("SELECT id FROM usuarios WHERE rol = 'admin' AND activo = 1");

// Responsable: quien la creó, un destinatario o un administrador.
async function esResponsable(usuario, s) {
  if (esAdmin(usuario) || s.creado_por === usuario.id) return true;
  return (await destinatariosDe(s.id)).includes(usuario.id);
}

async function leerDestinatarios(lista) {
  const ids = [...new Set((Array.isArray(lista) ? lista : []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  const validos = await db.column(`SELECT id FROM usuarios WHERE activo = 1 AND id IN (${ids.map(() => '?').join(',')})`, ...ids);
  return ids.filter((id) => validos.includes(id));
}

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

const evento = (tx, solicitudId, usuarioId, mensaje) =>
  tx.run("INSERT INTO solicitud_comentarios (solicitud_id, usuario_id, tipo, mensaje) VALUES (?, ?, 'evento', ?)", solicitudId, usuarioId, mensaje);

const tocar = (tx, id) => tx.run("UPDATE solicitudes SET actualizado_en = datetime('now') WHERE id = ?", id);

const router = express.Router();

// ---------- Listado y resúmenes ----------

router.get('/', async (req, res) => {
  const q = req.query;
  const where = [];
  const params = [];
  const igual = (col, valor) => {
    if (valor) {
      where.push(`${col} = ?`);
      params.push(valor);
    }
  };
  igual('s.trabajo_id', q.trabajo_id);
  igual('s.tipo', q.tipo);
  igual('s.prioridad', q.prioridad);
  if (q.estado === 'abiertas') where.push(`s.estado IN (${ABIERTAS_SQL})`);
  else igual('s.estado', q.estado);
  if (q.cliente) {
    where.push("t.cliente LIKE ? ESCAPE '\\'");
    params.push(likeParam(q.cliente));
  }
  if (q.asignado) {
    where.push('EXISTS (SELECT 1 FROM solicitud_destinatarios d WHERE d.solicitud_id = s.id AND d.usuario_id = ?)');
    params.push(q.asignado);
  }
  if (q.vista === 'mias') {
    where.push('s.creado_por = ?');
    params.push(req.usuario.id);
  } else if (q.vista === 'asignadas') {
    where.push('EXISTS (SELECT 1 FROM solicitud_destinatarios d WHERE d.solicitud_id = s.id AND d.usuario_id = ?)');
    params.push(req.usuario.id);
  }
  if (q.desde) {
    where.push('date(s.creado_en) >= ?');
    params.push(q.desde);
  }
  if (q.hasta) {
    where.push('date(s.creado_en) <= ?');
    params.push(q.hasta);
  }
  if (q.q) {
    const like = likeParam(q.q);
    where.push("(s.titulo LIKE ? ESCAPE '\\' OR s.descripcion LIKE ? ESCAPE '\\' OR t.cliente LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const filas = await db.all(
    `${SELECT_SOLICITUD} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE WHEN s.estado IN (${ABIERTAS_SQL}) THEN 0 ELSE 1 END,
       CASE s.prioridad WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 ELSE 2 END, s.id DESC
     LIMIT 500`,
    ...params
  );
  res.json(filas.map(completar));
});

router.get('/resumen', async (req, res) => {
  const r = await db.get(
    `SELECT
       SUM(s.estado = 'nueva') AS nuevas,
       SUM(s.estado = 'pendiente_aprobacion') AS pendientes_aprobacion,
       SUM(s.estado IN (${ABIERTAS_SQL})) AS abiertas,
       SUM(s.estado IN (${ABIERTAS_SQL}) AND EXISTS (SELECT 1 FROM solicitud_destinatarios d WHERE d.solicitud_id = s.id AND d.usuario_id = ?)) AS asignadas_abiertas,
       SUM(s.estado IN (${ABIERTAS_SQL}) AND s.creado_por = ?) AS mias_abiertas
     FROM solicitudes s`,
    req.usuario.id,
    req.usuario.id
  );
  res.json(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v || 0])));
});

// Resumen para la ficha del proyecto.
router.get('/proyecto/:trabajoId', async (req, res) => {
  const id = req.params.trabajoId;
  const [solicitudes, ultimas] = await Promise.all([
    db.all(`${SELECT_SOLICITUD} WHERE s.trabajo_id = ? ORDER BY s.id DESC`, id),
    db.all(
      `SELECT c.*, u.nombre AS usuario_nombre, s.titulo, s.id AS solicitud_id FROM solicitud_comentarios c
       JOIN solicitudes s ON s.id = c.solicitud_id LEFT JOIN usuarios u ON u.id = c.usuario_id
       WHERE s.trabajo_id = ? AND c.tipo = 'comentario' ORDER BY c.id DESC LIMIT 5`,
      id
    ),
  ]);
  const lista = solicitudes.map(completar);
  res.json({
    solicitudes: lista,
    abiertas: lista.filter((s) => s.abierta).length,
    pendientes_aprobacion: lista.filter((s) => s.estado === 'pendiente_aprobacion').length,
    ultimas_observaciones: ultimas,
  });
});

// Usuarios activos que pueden recibir solicitudes (para elegir destinatarios).
router.get('/usuarios', async (req, res) => {
  res.json(await db.all('SELECT id, nombre, usuario, rol FROM usuarios WHERE activo = 1 ORDER BY nombre COLLATE NOCASE'));
});

// ---------- Adjuntos ----------

router.get('/adjuntos/:aid', async (req, res) => {
  const a = await db.get('SELECT * FROM solicitud_adjuntos WHERE id = ?', req.params.aid);
  if (!a) throw new HttpError(404, 'Archivo no encontrado');
  await almacen.enviar(req, res, a);
});

router.delete('/adjuntos/:aid', async (req, res) => {
  const a = await db.get('SELECT * FROM solicitud_adjuntos WHERE id = ?', req.params.aid);
  if (!a) throw new HttpError(404, 'Archivo no encontrado');
  if (a.subido_por !== req.usuario.id && !esAdmin(req.usuario)) throw new HttpError(403, 'Sólo quien subió el archivo puede eliminarlo');
  await db.run('DELETE FROM solicitud_adjuntos WHERE id = ?', a.id);
  await almacen.borrar(a.archivo);
  res.json({ ok: true });
});

async function comprobarComentario(solicitudId, comentarioId) {
  if (!comentarioId) return null;
  const c = await db.get('SELECT id FROM solicitud_comentarios WHERE id = ? AND solicitud_id = ?', comentarioId, solicitudId);
  if (!c) throw new HttpError(400, 'Comentario no válido');
  return c.id;
}

const listarAdjuntos = (id) => db.all('SELECT * FROM solicitud_adjuntos WHERE solicitud_id = ? ORDER BY id', id);
const registrarAdjunto = (solicitudId, comentarioId, nombre, archivo, mime, tamano, usuarioId) =>
  db.run(
    'INSERT INTO solicitud_adjuntos (solicitud_id, comentario_id, nombre_original, archivo, mime, tamano, subido_por) VALUES (?, ?, ?, ?, ?, ?, ?)',
    solicitudId,
    comentarioId,
    String(nombre || 'archivo').slice(0, 255),
    archivo,
    mime || null,
    Number(tamano) || null,
    usuarioId
  );

router.post('/:id/adjuntos', async (req, res) => {
  if (almacen.MODO !== 'local') throw new HttpError(400, 'Las subidas se hacen directamente al almacenamiento');
  if (!(await obtener(req.params.id))) throw new HttpError(404, 'Solicitud no encontrada');
  await new Promise((resolve, reject) =>
    almacen.subidaLocal()(req, res, (err) => {
      if (!err) return resolve();
      reject(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? `Cada archivo debe pesar menos de ${config.MAX_ARCHIVO_MB} MB` : err.message));
    })
  );
  const comentarioId = await comprobarComentario(req.params.id, req.body?.comentario_id);
  for (const f of req.files || []) {
    const nombre = Buffer.from(f.originalname, 'latin1').toString('utf8');
    await registrarAdjunto(req.params.id, comentarioId, nombre, f.filename, f.mimetype, f.size, req.usuario.id);
  }
  res.status(201).json(await listarAdjuntos(req.params.id));
});

router.post('/:id/adjuntos/permiso', async (req, res) => {
  if (almacen.MODO !== 'blob') throw new HttpError(400, 'Almacenamiento Blob no configurado');
  if (!(await obtener(req.params.id))) throw new HttpError(404, 'Solicitud no encontrada');
  res.json(await almacen.tokenSubida(req, `solicitudes/${req.params.id}`));
});

router.post('/:id/adjuntos/registrar', async (req, res) => {
  if (!(await obtener(req.params.id))) throw new HttpError(404, 'Solicitud no encontrada');
  const { url, nombre, mime, tamano, comentario_id } = req.body || {};
  if (!almacen.esUrlBlob(url)) throw new HttpError(400, 'Archivo no válido');
  const comentarioId = await comprobarComentario(req.params.id, comentario_id);
  await registrarAdjunto(req.params.id, comentarioId, nombre, url, mime, tamano, req.usuario.id);
  res.status(201).json(await listarAdjuntos(req.params.id));
});

// ---------- Detalle ----------

router.get('/:id', async (req, res) => {
  const s = await obtener(req.params.id);
  if (!s) throw new HttpError(404, 'Solicitud no encontrada');
  const [destinatarios, comentarios, adjuntos, responsable] = await Promise.all([
    db.all(
      `SELECT u.id, u.nombre, u.usuario FROM solicitud_destinatarios d JOIN usuarios u ON u.id = d.usuario_id
       WHERE d.solicitud_id = ? ORDER BY u.nombre COLLATE NOCASE`,
      s.id
    ),
    db.all(
      `SELECT c.*, u.nombre AS usuario_nombre FROM solicitud_comentarios c LEFT JOIN usuarios u ON u.id = c.usuario_id
       WHERE c.solicitud_id = ? ORDER BY c.id`,
      s.id
    ),
    listarAdjuntos(s.id),
    esResponsable(req.usuario, s),
  ]);
  // Al abrir la solicitud se marcan como leídas sus notificaciones.
  await db.run('UPDATE notificaciones SET leida = 1 WHERE usuario_id = ? AND solicitud_id = ? AND leida = 0', req.usuario.id, s.id);
  res.json({
    ...s,
    destinatarios,
    comentarios: comentarios.map((c) => ({ ...c, adjuntos: adjuntos.filter((a) => a.comentario_id === c.id) })),
    adjuntos: adjuntos.filter((a) => !a.comentario_id),
    permisos: {
      cambiar_estado: responsable && s.aprobacion !== 'pendiente',
      aprobar: esAdmin(req.usuario) && s.aprobacion === 'pendiente',
      agregar_destinatarios: responsable,
      eliminar: esAdmin(req.usuario),
    },
  });
});

// ---------- Crear ----------

router.post('/', async (req, res) => {
  const b = req.body || {};
  const trabajoId = convertir(b.trabajo_id, 'int');
  const trabajo = trabajoId && (await db.get('SELECT id, numero, cliente FROM trabajos WHERE id = ?', trabajoId));
  if (!trabajo) throw new HttpError(400, 'Selecciona un proyecto registrado');
  if (!TIPOS[b.tipo]) throw new HttpError(400, 'Selecciona el tipo de solicitud');
  const titulo = texto(b.titulo, 200);
  if (!titulo) throw new HttpError(400, 'Escribe un título');
  const prioridad = PRIORIDADES.includes(b.prioridad) ? b.prioridad : 'normal';
  const requiere = b.requiere_aprobacion === true || b.requiere_aprobacion === 'si' || b.requiere_aprobacion === '1';
  const destinatarios = await leerDestinatarios(b.destinatarios);
  const descripcion = texto(b.descripcion);

  const id = await db.transaction(async (tx) => {
    const { lastInsertRowid: nuevaId } = await tx.run(
      `INSERT INTO solicitudes (trabajo_id, tipo, titulo, descripcion, prioridad, estado, requiere_aprobacion, aprobacion, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      trabajo.id,
      b.tipo,
      titulo,
      descripcion,
      prioridad,
      requiere ? 'pendiente_aprobacion' : 'nueva',
      requiere ? 1 : 0,
      requiere ? 'pendiente' : null,
      req.usuario.id
    );
    for (const u of destinatarios) {
      await tx.run('INSERT INTO solicitud_destinatarios (solicitud_id, usuario_id) VALUES (?, ?)', nuevaId, u);
    }
    await evento(tx, nuevaId, req.usuario.id, requiere ? 'creó la solicitud (requiere aprobación: modifica alcance, costo o fecha)' : 'creó la solicitud');
    const proyecto = `${numeroTrabajo(trabajo.numero)} · ${trabajo.cliente}`;
    const mensaje = `${proyecto} · ${TIPOS[b.tipo]} · ${resumir(descripcion || titulo)}`;
    const admins = requiere ? await tx.column("SELECT id FROM usuarios WHERE rol = 'admin' AND activo = 1") : [];
    await notificar(tx, {
      solicitudId: nuevaId,
      trabajoId: trabajo.id,
      actorId: req.usuario.id,
      destinos: [
        ...admins.map((u) => ({ usuarioId: u, tipo: 'aprobacion', titulo: `Requiere tu aprobación: ${titulo}`, mensaje })),
        ...destinatarios.map((u) => ({ usuarioId: u, tipo: 'nueva', titulo: `Nueva solicitud: ${titulo}`, mensaje })),
      ],
    });
    return nuevaId;
  });
  res.status(201).json(await obtener(id));
});

// ---------- Estado, prioridad y destinatarios ----------

router.patch('/:id', async (req, res) => {
  const s = await obtener(req.params.id);
  if (!s) throw new HttpError(404, 'Solicitud no encontrada');
  if (!(await esResponsable(req.usuario, s))) throw new HttpError(403, 'Sólo los responsables de la solicitud pueden cambiarla');
  const b = req.body || {};
  const cambios = [];
  let nuevoEstado = null;
  if (b.estado !== undefined && b.estado !== s.estado) {
    if (!ESTADOS[b.estado]) throw new HttpError(400, 'Estado no válido');
    if (s.aprobacion === 'pendiente') throw new HttpError(400, 'La solicitud debe ser aprobada o rechazada por un administrador primero');
    if (b.estado === 'pendiente_aprobacion') throw new HttpError(400, 'Para pedir aprobación crea la solicitud indicando que modifica alcance, costo o fecha');
    nuevoEstado = b.estado;
    cambios.push(`cambió el estado a «${ESTADOS[b.estado].label}»`);
  }
  let nuevaPrioridad = null;
  if (b.prioridad !== undefined && b.prioridad !== s.prioridad) {
    if (!PRIORIDADES.includes(b.prioridad)) throw new HttpError(400, 'Prioridad no válida');
    nuevaPrioridad = b.prioridad;
    cambios.push(`cambió la prioridad a «${config.PRIORIDADES.find((p) => p.key === b.prioridad).label}»`);
  }
  if (cambios.length) {
    const todos = await participantes(s);
    await db.transaction(async (tx) => {
      if (nuevoEstado) await tx.run('UPDATE solicitudes SET estado = ? WHERE id = ?', nuevoEstado, s.id);
      if (nuevaPrioridad) await tx.run('UPDATE solicitudes SET prioridad = ? WHERE id = ?', nuevaPrioridad, s.id);
      await tocar(tx, s.id);
      await evento(tx, s.id, req.usuario.id, cambios.join(' y '));
      if (nuevoEstado) {
        await notificar(tx, {
          solicitudId: s.id,
          trabajoId: s.trabajo_id,
          actorId: req.usuario.id,
          destinos: todos.map((u) => ({
            usuarioId: u,
            tipo: 'estado',
            titulo: `Estado «${ESTADOS[nuevoEstado].label}»: ${s.titulo}`,
            mensaje: `${s.proyecto} · ${req.usuario.nombre} ${cambios.join(' y ')}`,
          })),
        });
      }
    });
  }
  res.json(await obtener(s.id));
});

router.post('/:id/destinatarios', async (req, res) => {
  const s = await obtener(req.params.id);
  if (!s) throw new HttpError(404, 'Solicitud no encontrada');
  if (!(await esResponsable(req.usuario, s))) throw new HttpError(403, 'Sólo los responsables de la solicitud pueden asignarla');
  const actuales = await destinatariosDe(s.id);
  const nuevos = (await leerDestinatarios(req.body?.usuarios)).filter((u) => !actuales.includes(u));
  if (nuevos.length) {
    const nombres = await db.column(`SELECT nombre FROM usuarios WHERE id IN (${nuevos.map(() => '?').join(',')})`, ...nuevos);
    await db.transaction(async (tx) => {
      for (const u of nuevos) await tx.run('INSERT INTO solicitud_destinatarios (solicitud_id, usuario_id) VALUES (?, ?)', s.id, u);
      await tocar(tx, s.id);
      await evento(tx, s.id, req.usuario.id, `asignó la solicitud a ${nombres.join(', ')}`);
      await notificar(tx, {
        solicitudId: s.id,
        trabajoId: s.trabajo_id,
        actorId: req.usuario.id,
        destinos: nuevos.map((u) => ({
          usuarioId: u,
          tipo: 'asignada',
          titulo: `Te asignaron: ${s.titulo}`,
          mensaje: `${s.proyecto} · ${s.tipo_label} · ${resumir(s.descripcion || s.titulo)}`,
        })),
      });
    });
  }
  res.json(await obtener(s.id));
});

// ---------- Aprobación de modificaciones ----------

router.post('/:id/aprobacion', async (req, res) => {
  if (!esAdmin(req.usuario)) throw new HttpError(403, 'Sólo un administrador puede aprobar o rechazar');
  const s = await obtener(req.params.id);
  if (!s) throw new HttpError(404, 'Solicitud no encontrada');
  if (s.aprobacion !== 'pendiente') throw new HttpError(400, 'Esta solicitud no está pendiente de aprobación');
  const decision = req.body?.decision === 'aprobada' ? 'aprobada' : req.body?.decision === 'rechazada' ? 'rechazada' : null;
  if (!decision) throw new HttpError(400, 'Indica si se aprueba o se rechaza');
  const comentario = texto(req.body?.comentario, 1000);
  const todos = await participantes(s);
  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE solicitudes SET aprobacion = ?, aprobada_por = ?, aprobada_en = datetime('now'), estado = ?, actualizado_en = datetime('now') WHERE id = ?`,
      decision,
      req.usuario.id,
      decision === 'aprobada' ? 'en_proceso' : 'rechazada',
      s.id
    );
    await evento(tx, s.id, req.usuario.id, `${decision === 'aprobada' ? 'aprobó' : 'rechazó'} la modificación${comentario ? `: ${comentario}` : ''}`);
    await notificar(tx, {
      solicitudId: s.id,
      trabajoId: s.trabajo_id,
      actorId: req.usuario.id,
      destinos: todos.map((u) => ({
        usuarioId: u,
        tipo: decision,
        titulo: `Modificación ${decision}: ${s.titulo}`,
        mensaje: `${s.proyecto} · ${req.usuario.nombre}${comentario ? ` · ${resumir(comentario)}` : ''}`,
      })),
    });
  });
  res.json(await obtener(s.id));
});

// ---------- Conversación ----------

router.post('/:id/comentarios', async (req, res) => {
  const s = await obtener(req.params.id);
  if (!s) throw new HttpError(404, 'Solicitud no encontrada');
  const mensaje = texto(req.body?.mensaje, 4000);
  if (!mensaje) throw new HttpError(400, 'Escribe un mensaje');
  const [todos, menciones] = await Promise.all([participantes(s), mencionados(mensaje)]);
  const comentarioId = await db.transaction(async (tx) => {
    const { lastInsertRowid } = await tx.run(
      "INSERT INTO solicitud_comentarios (solicitud_id, usuario_id, tipo, mensaje) VALUES (?, ?, 'comentario', ?)",
      s.id,
      req.usuario.id,
      mensaje
    );
    await tocar(tx, s.id);
    await notificar(tx, {
      solicitudId: s.id,
      trabajoId: s.trabajo_id,
      actorId: req.usuario.id,
      destinos: [
        ...menciones.map((u) => ({ usuarioId: u, tipo: 'mencion', titulo: `${req.usuario.nombre} te mencionó en: ${s.titulo}`, mensaje: `${s.proyecto} · ${resumir(mensaje)}` })),
        ...todos.map((u) => ({ usuarioId: u, tipo: 'comentario', titulo: `Nuevo comentario en: ${s.titulo}`, mensaje: `${s.proyecto} · ${req.usuario.nombre}: ${resumir(mensaje)}` })),
      ],
    });
    return lastInsertRowid;
  });
  res.status(201).json(await db.get('SELECT c.*, u.nombre AS usuario_nombre FROM solicitud_comentarios c LEFT JOIN usuarios u ON u.id = c.usuario_id WHERE c.id = ?', comentarioId));
});

// ---------- Eliminar (sólo administradores) ----------

router.delete('/:id', async (req, res) => {
  if (!esAdmin(req.usuario)) throw new HttpError(403, 'Sólo un administrador puede eliminar solicitudes');
  const s = await obtener(req.params.id);
  if (!s) throw new HttpError(404, 'Solicitud no encontrada');
  const archivos = await db.column('SELECT archivo FROM solicitud_adjuntos WHERE solicitud_id = ?', s.id);
  await db.transaction(async (tx) => {
    for (const t of ['notificaciones', 'solicitud_adjuntos', 'solicitud_comentarios', 'solicitud_destinatarios']) {
      await tx.run(`DELETE FROM ${t} WHERE solicitud_id = ?`, s.id);
    }
    await tx.run('DELETE FROM solicitudes WHERE id = ?', s.id);
  });
  await Promise.all(archivos.map(almacen.borrar));
  res.json({ ok: true });
});

// ---------- Notificaciones del usuario ----------

const notificaciones = express.Router();

notificaciones.get('/', async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 20, 100);
  const [items, noLeidas] = await Promise.all([
    db.all(
      `SELECT n.*, a.nombre AS actor_nombre, s.tipo AS solicitud_tipo, s.prioridad, t.numero, t.cliente
       FROM notificaciones n
       LEFT JOIN usuarios a ON a.id = n.actor_id
       LEFT JOIN solicitudes s ON s.id = n.solicitud_id
       LEFT JOIN trabajos t ON t.id = COALESCE(s.trabajo_id, n.trabajo_id)
       WHERE n.usuario_id = ? ORDER BY n.id DESC LIMIT ?`,
      req.usuario.id,
      limite
    ),
    db.value('SELECT COUNT(*) FROM notificaciones WHERE usuario_id = ? AND leida = 0', req.usuario.id),
  ]);
  res.json({
    no_leidas: noLeidas,
    items: items.map((n) => ({ ...n, proyecto: n.numero ? `${numeroTrabajo(n.numero)} · ${n.cliente}` : null, tipo_solicitud: TIPOS[n.solicitud_tipo] || null })),
  });
});

notificaciones.get('/conteo', async (req, res) => {
  // Avisos automáticos de «Mi día» (tareas y compromisos vencidos), sin repetir.
  await revisarAvisos(req.usuario).catch((err) => console.error('Avisos automáticos:', err.message));
  const r = await db.get('SELECT COUNT(*) AS no_leidas, MAX(id) AS ultima FROM notificaciones WHERE usuario_id = ? AND leida = 0', req.usuario.id);
  res.json({ no_leidas: r.no_leidas || 0, ultima: r.ultima || 0 });
});

notificaciones.post('/leidas', async (req, res) => {
  await db.run('UPDATE notificaciones SET leida = 1 WHERE usuario_id = ? AND leida = 0', req.usuario.id);
  res.json({ ok: true });
});

notificaciones.post('/:id/leida', async (req, res) => {
  await db.run('UPDATE notificaciones SET leida = 1 WHERE id = ? AND usuario_id = ?', req.params.id, req.usuario.id);
  res.json({ ok: true });
});

module.exports = { router, notificaciones };
