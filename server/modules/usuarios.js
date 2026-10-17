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

module.exports = { router };
