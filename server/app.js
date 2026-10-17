const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { migrate } = require('./db');
const auth = require('./auth');
const trabajos = require('./modules/trabajos');
const materiales = require('./modules/materiales');
const proveedores = require('./modules/proveedores');
const usuarios = require('./modules/usuarios');
const almacen = require('./lib/almacen');
const { importacionInicial } = require('./importar');

// Preparación de la base de datos: migraciones, usuario inicial, clave de
// sesiones e importación de los Excel. Se ejecuta una vez por arranque
// (en Vercel, una vez por instancia) y todas las peticiones a la API la esperan.
let preparacion = null;
function preparar() {
  preparacion ??= (async () => {
    await migrate();
    await auth.crearAdminInicial();
    await auth.cargarSecreto();
    await importacionInicial().catch((err) => console.error('Importación inicial:', err.message));
  })().catch((err) => {
    preparacion = null; // se reintenta en la siguiente petición
    throw err;
  });
  return preparacion;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Peticiones que modifican datos deben venir de la propia aplicación (protección CSRF básica).
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origen = req.get('origin');
  let host = null;
  try {
    host = origen ? new URL(origen).host : null;
  } catch {
    host = 'invalido';
  }
  if (origen && host !== req.get('host')) {
    return res.status(403).json({ error: 'Origen no permitido' });
  }
  next();
});

app.use('/api', async (req, res, next) => {
  try {
    await preparar();
    next();
  } catch (err) {
    console.error('No se pudo preparar la base de datos:', err);
    const respuesta = { error: `La base de datos no está disponible. ${err.message}` };
    // Para diagnosticar la configuración: sólo nombres de variables, nunca sus valores.
    if (req.path === '/salud') {
      respuesta.diagnostico = {
        version: (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7),
        entorno: process.env.VERCEL_ENV || null,
        variables: Object.keys(process.env)
          .filter((k) => /TURSO|LIBSQL|DATABASE|BLOB|STORAGE|ADMIN/i.test(k))
          .sort(),
      };
    }
    res.status(503).json(respuesta);
  }
});

app.get('/api/salud', (req, res) => res.json({ ok: true }));
app.use('/api/auth', auth.router);

// Todo lo que sigue requiere sesión iniciada.
const privado = [auth.requiereSesion, auth.exigeCambioPassword];

app.get('/api/config', privado, (req, res) => {
  res.json({
    estatus: config.ESTATUS,
    estatusCerrados: config.ESTATUS_CERRADOS,
    estatusSinAlerta: config.ESTATUS_SIN_ALERTA,
    prefijoTrabajo: config.PREFIJO_TRABAJO,
    moneda: config.MONEDA,
    diasAlerta: config.DIAS_ALERTA,
    maxArchivoMb: config.MAX_ARCHIVO_MB,
    subidas: almacen.MODO,
    accesoBlob: almacen.ACCESO_BLOB,
  });
});

// Registro de módulos del backend. Para agregar un módulo nuevo, crear su
// archivo en server/modules y añadir aquí una línea.
const MODULOS = [
  { ruta: '/api/trabajos', router: trabajos.router },
  { ruta: '/api/adjuntos', router: trabajos.adjuntosRouter },
  { ruta: '/api/pendientes', router: trabajos.pendientesRouter },
  { ruta: '/api/materiales', router: materiales.router },
  { ruta: '/api/proveedores', router: proveedores.router },
  { ruta: '/api/usuarios', router: usuarios.router, soloAdmin: true },
];
for (const m of MODULOS) {
  app.use(m.ruta, ...privado, ...(m.soloAdmin ? [auth.requiereAdmin] : []), m.router);
}

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));
app.get('/{*ruta}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno del servidor' : err.message });
});

module.exports = app;
module.exports.preparar = preparar;
