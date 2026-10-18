const express = require('express');
const { db } = require('../db');
const { hashPassword, usuarioPublico } = require('../auth');
const { HttpError } = require('../lib/util');

const router = express.Router();

const obtener = (id) => db.get('SELECT * FROM usuarios WHERE id = ?', id);
const totalAdminsActivos = () => db.value("SELECT COUNT(*) FROM usuarios WHERE rol = 'admin' AND activo = 1");

router.get('/', async (req, res) => {
  res.json((await db.all('SELECT * FROM usuarios ORDER BY nombre COLLATE NOCASE')).map(usuarioPublico));
});

router.post('/', async (req, res) => {
  const usuario = String(req.body?.usuario || '').trim().toLowerCase();
  const nombre = String(req.body?.nombre || '').trim();
  const rol = req.body?.rol === 'admin' ? 'admin' : 'usuario';
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) {
    throw new HttpError(400, 'El usuario debe tener 3 a 30 caracteres: letras, números, punto, guion');
  }
  if (!nombre) throw new HttpError(400, 'El nombre es obligatorio');
  if (await db.get('SELECT 1 FROM usuarios WHERE usuario = ?', usuario)) {
    throw new HttpError(400, 'Ese nombre de usuario ya existe');
  }
  const info = await db.run(
    'INSERT INTO usuarios (usuario, nombre, password_hash, rol, debe_cambiar_password) VALUES (?, ?, ?, ?, 1)',
    usuario,
    nombre,
    hashPassword(req.body?.password),
    rol
  );
  res.status(201).json(usuarioPublico(await obtener(info.lastInsertRowid)));
});

router.patch('/:id', async (req, res) => {
  const u = await obtener(req.params.id);
  if (!u) throw new HttpError(404, 'Usuario no encontrado');
  const b = req.body || {};
  const nombre = b.nombre !== undefined ? String(b.nombre).trim() : u.nombre;
  const rol = b.rol !== undefined ? (b.rol === 'admin' ? 'admin' : 'usuario') : u.rol;
  const activo = b.activo !== undefined ? (b.activo ? 1 : 0) : u.activo;
  if (!nombre) throw new HttpError(400, 'El nombre es obligatorio');
  if (u.id === req.usuario.id && (!activo || rol !== 'admin')) {
    throw new HttpError(400, 'No puedes desactivarte ni quitarte el rol de administrador a ti mismo');
  }
  if (u.rol === 'admin' && u.activo && (rol !== 'admin' || !activo) && (await totalAdminsActivos()) <= 1) {
    throw new HttpError(400, 'Debe existir al menos un administrador activo');
  }
  if (b.password) hashPassword(b.password); // valida antes de guardar nada
  await db.run(
    `UPDATE usuarios SET nombre = ?, rol = ?, activo = ?, actualizado_en = datetime('now') WHERE id = ?`,
    nombre,
    rol,
    activo,
    u.id
  );
  if (b.password) {
    await db.run(`UPDATE usuarios SET password_hash = ?, debe_cambiar_password = 1 WHERE id = ?`, hashPassword(b.password), u.id);
  }
  res.json(usuarioPublico(await obtener(u.id)));
});

// Eliminar un usuario. No se puede eliminar a uno mismo ni al último
// administrador. Si registró pagos de producción se conserva para el historial
// (en ese caso se puede desactivar).
router.delete('/:id', async (req, res) => {
  const u = await obtener(req.params.id);
  if (!u) throw new HttpError(404, 'Usuario no encontrado');
  if (u.id === req.usuario.id) throw new HttpError(400, 'No puedes eliminar tu propio usuario');
  if (u.rol === 'admin' && u.activo && (await totalAdminsActivos()) <= 1) {
    throw new HttpError(400, 'Debe existir al menos un administrador activo');
  }
  const conPagos = await db.value(
    `SELECT 1 FROM abonos WHERE creado_por = ? UNION SELECT 1 FROM asignaciones WHERE creado_por = ?
     UNION SELECT 1 FROM pagos_historial WHERE usuario_id = ?
     UNION SELECT 1 FROM solicitudes WHERE creado_por = ? OR aprobada_por = ?
     UNION SELECT 1 FROM solicitud_comentarios WHERE usuario_id = ? LIMIT 1`,
    u.id,
    u.id,
    u.id,
    u.id,
    u.id,
    u.id
  );
  if (!conPagos && (await db.value('SELECT 1 FROM tareas WHERE (creado_por = ? OR asignado_a = ?) LIMIT 1', u.id, u.id))) {
    throw new HttpError(400, 'Este usuario tiene tareas registradas en «Mi día» y se conserva en el historial. Puedes desactivarlo para que no ingrese.');
  }
  if (conPagos) {
    throw new HttpError(400, 'Este usuario tiene pagos o solicitudes registradas y se conserva en el historial. Puedes desactivarlo para que no ingrese.');
  }
  await db.transaction(async (tx) => {
    await tx.run('UPDATE trabajos SET creado_por = NULL WHERE creado_por = ?', u.id);
    await tx.run('UPDATE trabajos SET actualizado_por = NULL WHERE actualizado_por = ?', u.id);
    await tx.run('UPDATE adjuntos SET subido_por = NULL WHERE subido_por = ?', u.id);
    await tx.run('UPDATE tasas_bcv SET registrada_por = NULL WHERE registrada_por = ?', u.id);
    await tx.run('UPDATE cotizaciones SET creado_por = NULL WHERE creado_por = ?', u.id);
    await tx.run('UPDATE solicitud_adjuntos SET subido_por = NULL WHERE subido_por = ?', u.id);
    await tx.run('DELETE FROM solicitud_destinatarios WHERE usuario_id = ?', u.id);
    await tx.run('DELETE FROM notificaciones WHERE usuario_id = ?', u.id);
    await tx.run('UPDATE notificaciones SET actor_id = NULL WHERE actor_id = ?', u.id);
    await tx.run('UPDATE tareas SET actualizado_por = NULL WHERE actualizado_por = ?', u.id);
    await tx.run('DELETE FROM notas_personales WHERE usuario_id = ?', u.id);
    await tx.run('DELETE FROM avisos_enviados WHERE usuario_id = ?', u.id);
    await tx.run('DELETE FROM usuarios WHERE id = ?', u.id);
  });
  res.json({ ok: true });
});

module.exports = { router };
