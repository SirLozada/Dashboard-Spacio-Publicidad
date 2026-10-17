const express = require('express');
const { db } = require('../db');
const { hashPassword, usuarioPublico } = require('../auth');
const { HttpError } = require('../lib/util');

const router = express.Router();

const obtener = (id) => db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
const totalAdminsActivos = () =>
  db.prepare("SELECT COUNT(*) FROM usuarios WHERE rol = 'admin' AND activo = 1").pluck().get();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM usuarios ORDER BY nombre COLLATE NOCASE').all().map(usuarioPublico));
});

router.post('/', (req, res) => {
  const usuario = String(req.body?.usuario || '').trim().toLowerCase();
  const nombre = String(req.body?.nombre || '').trim();
  const rol = req.body?.rol === 'admin' ? 'admin' : 'usuario';
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) {
    throw new HttpError(400, 'El usuario debe tener 3 a 30 caracteres: letras, números, punto, guion');
  }
  if (!nombre) throw new HttpError(400, 'El nombre es obligatorio');
  if (db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(usuario)) {
    throw new HttpError(400, 'Ese nombre de usuario ya existe');
  }
  const info = db
    .prepare('INSERT INTO usuarios (usuario, nombre, password_hash, rol, debe_cambiar_password) VALUES (?, ?, ?, ?, 1)')
    .run(usuario, nombre, hashPassword(req.body?.password), rol);
  res.status(201).json(usuarioPublico(obtener(info.lastInsertRowid)));
});

router.patch('/:id', (req, res) => {
  const u = obtener(req.params.id);
  if (!u) throw new HttpError(404, 'Usuario no encontrado');
  const b = req.body || {};
  const nombre = b.nombre !== undefined ? String(b.nombre).trim() : u.nombre;
  const rol = b.rol !== undefined ? (b.rol === 'admin' ? 'admin' : 'usuario') : u.rol;
  const activo = b.activo !== undefined ? (b.activo ? 1 : 0) : u.activo;
  if (!nombre) throw new HttpError(400, 'El nombre es obligatorio');
  if (u.id === req.usuario.id && (!activo || rol !== 'admin')) {
    throw new HttpError(400, 'No puedes desactivarte ni quitarte el rol de administrador a ti mismo');
  }
  if (u.rol === 'admin' && u.activo && (rol !== 'admin' || !activo) && totalAdminsActivos() <= 1) {
    throw new HttpError(400, 'Debe existir al menos un administrador activo');
  }
  db.prepare(`UPDATE usuarios SET nombre = ?, rol = ?, activo = ?, actualizado_en = datetime('now') WHERE id = ?`).run(
    nombre,
    rol,
    activo,
    u.id
  );
  if (b.password) {
    db.prepare(`UPDATE usuarios SET password_hash = ?, debe_cambiar_password = 1 WHERE id = ?`).run(
      hashPassword(b.password),
      u.id
    );
  }
  res.json(usuarioPublico(obtener(u.id)));
});

module.exports = { router };
