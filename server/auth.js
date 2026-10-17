const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');
const config = require('./config');
const { HttpError } = require('./lib/util');

const COOKIE = 'spacio_sesion';
const DURACION_DIAS = 7;

// Clave para firmar las sesiones: variable de entorno o, si no existe, una
// clave aleatoria guardada en la base de datos (persiste entre reinicios).
let SECRETO = process.env.JWT_SECRET || null;
async function cargarSecreto() {
  if (SECRETO) return;
  await db.run("INSERT OR IGNORE INTO ajustes (clave, valor) VALUES ('jwt_secreto', ?)", crypto.randomBytes(48).toString('hex'));
  SECRETO = await db.value("SELECT valor FROM ajustes WHERE clave = 'jwt_secreto'");
}

function usuarioPublico(u) {
  return {
    id: u.id,
    usuario: u.usuario,
    nombre: u.nombre,
    rol: u.rol,
    activo: !!u.activo,
    debe_cambiar_password: !!u.debe_cambiar_password,
    creado_en: u.creado_en,
  };
}

function validarPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
  }
}

function hashPassword(password) {
  validarPassword(password);
  return bcrypt.hashSync(password, 10);
}

// Crea el usuario administrador inicial (Fernando) si no hay ningún usuario.
async function crearAdminInicial() {
  const total = await db.value('SELECT COUNT(*) FROM usuarios');
  if (total > 0) return;
  const info = await db.run(
    `INSERT OR IGNORE INTO usuarios (usuario, nombre, password_hash, rol, debe_cambiar_password) VALUES (?, ?, ?, 'admin', ?)`,
    config.ADMIN_USUARIO,
    config.ADMIN_NOMBRE,
    hashPassword(config.ADMIN_PASSWORD),
    process.env.ADMIN_PASSWORD ? 0 : 1
  );
  if (!info.changes) return;
  console.log(`Usuario administrador creado: "${config.ADMIN_USUARIO}"`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log('Contraseña inicial por defecto en uso; se pedirá cambiarla en el primer inicio de sesión.');
  }
}

// Límite simple de intentos de inicio de sesión por IP + usuario.
const intentos = new Map();
const MAX_INTENTOS = 8;
const VENTANA_MS = 15 * 60 * 1000;
function verificarIntentos(clave) {
  const ahora = Date.now();
  const r = intentos.get(clave);
  if (r && r.hasta > ahora && r.cuenta >= MAX_INTENTOS) {
    throw new HttpError(429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
  }
}
function registrarFallo(clave) {
  const ahora = Date.now();
  const r = intentos.get(clave);
  if (!r || r.hasta < ahora) intentos.set(clave, { cuenta: 1, hasta: ahora + VENTANA_MS });
  else r.cuenta += 1;
}

function emitirSesion(res, usuario) {
  const token = jwt.sign({ uid: usuario.id }, SECRETO, { expiresIn: `${DURACION_DIAS}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
    maxAge: DURACION_DIAS * 24 * 60 * 60 * 1000,
  });
}

// Middleware: exige una sesión válida y carga el usuario en req.usuario.
async function requiereSesion(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return next(new HttpError(401, 'Sesión no iniciada'));
  let payload;
  try {
    payload = jwt.verify(token, SECRETO);
  } catch {
    return next(new HttpError(401, 'La sesión expiró, vuelve a iniciar sesión'));
  }
  const u = await db.get('SELECT * FROM usuarios WHERE id = ? AND activo = 1', payload.uid);
  if (!u) return next(new HttpError(401, 'Usuario no válido'));
  req.usuario = usuarioPublico(u);
  next();
}

// Mientras el usuario tenga que cambiar su contraseña, sólo puede usar /api/auth.
function exigeCambioPassword(req, res, next) {
  if (req.usuario?.debe_cambiar_password) {
    return next(new HttpError(403, 'Debes cambiar tu contraseña antes de continuar'));
  }
  next();
}

function requiereAdmin(req, res, next) {
  if (req.usuario?.rol !== 'admin') return next(new HttpError(403, 'Acción reservada a administradores'));
  next();
}

const router = express.Router();

router.post('/login', async (req, res) => {
  const usuario = String(req.body?.usuario || '').trim();
  const password = String(req.body?.password || '');
  const clave = `${req.ip}|${usuario.toLowerCase()}`;
  verificarIntentos(clave);
  const u = await db.get('SELECT * FROM usuarios WHERE usuario = ?', usuario);
  if (!u || !u.activo || !bcrypt.compareSync(password, u.password_hash)) {
    registrarFallo(clave);
    throw new HttpError(401, 'Usuario o contraseña incorrectos');
  }
  intentos.delete(clave);
  emitirSesion(res, u);
  res.json(usuarioPublico(u));
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

router.get('/me', requiereSesion, (req, res) => res.json(req.usuario));

router.post('/cambiar-password', requiereSesion, async (req, res) => {
  const { actual, nueva } = req.body || {};
  const u = await db.get('SELECT * FROM usuarios WHERE id = ?', req.usuario.id);
  if (!bcrypt.compareSync(String(actual || ''), u.password_hash)) {
    throw new HttpError(400, 'La contraseña actual no es correcta');
  }
  if (actual === nueva) throw new HttpError(400, 'La nueva contraseña debe ser distinta a la actual');
  await db.run(
    `UPDATE usuarios SET password_hash = ?, debe_cambiar_password = 0, actualizado_en = datetime('now') WHERE id = ?`,
    hashPassword(nueva),
    u.id
  );
  res.json({ ok: true });
});

module.exports = {
  router,
  requiereSesion,
  requiereAdmin,
  exigeCambioPassword,
  crearAdminInicial,
  cargarSecreto,
  hashPassword,
  usuarioPublico,
};
