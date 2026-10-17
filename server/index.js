const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { migrate } = require('./db');

migrate();

const auth = require('./auth');
const trabajos = require('./modules/trabajos');
const materiales = require('./modules/materiales');
const proveedores = require('./modules/proveedores');
const usuarios = require('./modules/usuarios');

auth.crearAdminInicial();

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

if (require.main === module) {
  require('./importar')
    .importacionInicial()
    .catch((err) => console.error('Importación inicial:', err.message))
    .finally(() =>
  app.listen(config.PORT, () => {
    console.log(`Spacio Publicidad · Dashboard disponible en http://localhost:${config.PORT}`);
  }));
}

module.exports = app;
