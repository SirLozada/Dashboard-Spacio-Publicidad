const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { db } = require('../db');
const config = require('../config');
const { requiereAdmin } = require('../auth');
const { HttpError, hoy, sumarDias, leerCampos, likeParam } = require('../lib/util');

const CAMPOS = {
  cliente: 'text',
  marca: 'text',
  tienda: 'text',
  ubicacion: 'text',
  descripcion: 'text',
  estatus: 'text',
  fecha_inicio: 'date',
  fecha_cotizacion: 'date',
  fecha_entrega: 'date',
  responsable: 'text',
  observaciones: 'text',
};
const CAMPOS_FECHA = ['fecha_inicio', 'fecha_cotizacion', 'fecha_entrega'];
const CERRADOS_SQL = config.ESTATUS_CERRADOS.map((e) => `'${e}'`).join(', ');
const SIN_ALERTA_SQL = config.ESTATUS_SIN_ALERTA.map((e) => `'${e}'`).join(', ');

const DIR_ADJUNTOS = path.join(config.DATA_DIR, 'adjuntos');
fs.mkdirSync(DIR_ADJUNTOS, { recursive: true });

const SELECT_TRABAJO = `
  SELECT t.*, (SELECT COUNT(*) FROM adjuntos a WHERE a.trabajo_id = t.id) AS total_adjuntos,
    (SELECT COUNT(*) FROM trabajo_pendientes p WHERE p.trabajo_id = t.id AND p.hecho = 0) AS total_pendientes,
    (SELECT p.texto FROM trabajo_pendientes p WHERE p.trabajo_id = t.id AND p.hecho = 0
      ORDER BY p.orden, p.id LIMIT 1) AS proximo_pendiente
  FROM trabajos t`;

const listarPendientes = (trabajoId) =>
  db.prepare('SELECT * FROM trabajo_pendientes WHERE trabajo_id = ? ORDER BY hecho, orden, id').all(trabajoId);

function validarEstatus(datos) {
  if ('estatus' in datos) {
    if (datos.estatus === null) datos.estatus = 'por_cotizar';
    if (!config.ESTATUS_KEYS.includes(datos.estatus)) throw new HttpError(400, 'Estatus no válido');
  }
}

function obtener(id) {
  return db.prepare(`${SELECT_TRABAJO} WHERE t.id = ?`).get(id);
}

// Construye la consulta filtrada; la usan el listado y la exportación a Excel.
function consultar(q) {
  const where = [];
  const params = [];
  if (q.q) {
    where.push(
      `(t.cliente LIKE ? ESCAPE '\\' OR t.marca LIKE ? ESCAPE '\\' OR t.tienda LIKE ? ESCAPE '\\'
        OR t.descripcion LIKE ? ESCAPE '\\' OR t.ubicacion LIKE ? ESCAPE '\\' OR t.responsable LIKE ? ESCAPE '\\'
        OR CAST(t.numero AS TEXT) = ?
        OR EXISTS (SELECT 1 FROM trabajo_pendientes p WHERE p.trabajo_id = t.id AND p.hecho = 0 AND p.texto LIKE ? ESCAPE '\\'))`
    );
    const like = likeParam(q.q);
    const numero = String(q.q).replace(/\D/g, '').replace(/^0+/, '');
    params.push(like, like, like, like, like, like, numero, like);
  }
  if (q.estatus === 'activos') {
    where.push(`t.estatus NOT IN (${CERRADOS_SQL})`);
  } else if (q.estatus) {
    const lista = String(q.estatus).split(',').filter((e) => config.ESTATUS_KEYS.includes(e));
    if (lista.length) {
      where.push(`t.estatus IN (${lista.map(() => '?').join(', ')})`);
      params.push(...lista);
    }
  }
  const campoFecha = CAMPOS_FECHA.includes(q.campo_fecha) ? q.campo_fecha : 'fecha_entrega';
  if (q.desde) {
    where.push(`t.${campoFecha} >= ?`);
    params.push(q.desde);
  }
  if (q.hasta) {
    where.push(`t.${campoFecha} <= ?`);
    params.push(q.hasta);
  }
  if (q.alerta === 'atrasados') {
    where.push(`t.estatus NOT IN (${SIN_ALERTA_SQL}) AND t.fecha_entrega < ?`);
    params.push(hoy());
  } else if (q.alerta === 'proximos') {
    where.push(`t.estatus NOT IN (${SIN_ALERTA_SQL}) AND t.fecha_entrega BETWEEN ? AND ?`);
    params.push(hoy(), sumarDias(hoy(), config.DIAS_ALERTA));
  }
  const ordenes = {
    recientes: 't.numero DESC',
    entrega_asc: 't.fecha_entrega IS NULL, t.fecha_entrega ASC, t.numero ASC',
    entrega_desc: 't.fecha_entrega IS NULL, t.fecha_entrega DESC, t.numero DESC',
    numero_asc: 't.numero ASC',
  };
  const orden = ordenes[q.orden] || ordenes.recientes;
  const sql = `${SELECT_TRABAJO} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orden}`;
  return db.prepare(sql).all(...params);
}

// Crea un trabajo con número automático y, opcionalmente, su lista de pendientes.
// También lo usa la importación desde Excel.
function crearTrabajo(datos, pendientes = [], usuarioId = null) {
  return db.transaction(() => {
    const numero = db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 FROM trabajos').pluck().get();
    const cols = Object.keys(datos);
    const id = db
      .prepare(
        `INSERT INTO trabajos (numero, creado_por, actualizado_por, ${cols.join(', ')})
         VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`
      )
      .run(numero, usuarioId, usuarioId, ...cols.map((c) => datos[c])).lastInsertRowid;
    const insertar = db.prepare('INSERT INTO trabajo_pendientes (trabajo_id, texto, orden) VALUES (?, ?, ?)');
    pendientes
      .map((p) => String(p ?? '').trim().slice(0, 500))
      .filter(Boolean)
      .forEach((texto, i) => insertar.run(id, texto, i));
    return id;
  })();
}

const router = express.Router();

router.get('/', (req, res) => res.json(consultar(req.query)));

router.get('/resumen', (req, res) => {
  const porEstatus = Object.fromEntries(config.ESTATUS_KEYS.map((k) => [k, 0]));
  for (const r of db.prepare('SELECT estatus, COUNT(*) AS total FROM trabajos GROUP BY estatus').all()) {
    porEstatus[r.estatus] = r.total;
  }
  const h = hoy();
  const atrasados = db
    .prepare(`SELECT COUNT(*) FROM trabajos WHERE estatus NOT IN (${SIN_ALERTA_SQL}) AND fecha_entrega < ?`)
    .pluck()
    .get(h);
  const proximos = db
    .prepare(`SELECT COUNT(*) FROM trabajos WHERE estatus NOT IN (${SIN_ALERTA_SQL}) AND fecha_entrega BETWEEN ? AND ?`)
    .pluck()
    .get(h, sumarDias(h, config.DIAS_ALERTA));
  const activos = db.prepare(`SELECT COUNT(*) FROM trabajos WHERE estatus NOT IN (${CERRADOS_SQL})`).pluck().get();
  res.json({ porEstatus, atrasados, proximos, activos, hoy: h });
});

// Valores ya usados, para autocompletar en los formularios.
router.get('/sugerencias', (req, res) => {
  const distintos = (col) =>
    db
      .prepare(`SELECT DISTINCT ${col} FROM trabajos WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col} COLLATE NOCASE`)
      .pluck()
      .all();
  res.json({
    cliente: distintos('cliente'),
    marca: distintos('marca'),
    tienda: distintos('tienda'),
    ubicacion: distintos('ubicacion'),
    responsable: distintos('responsable'),
  });
});

router.get('/exportar', async (req, res) => {
  const filas = consultar(req.query);
  const etiqueta = Object.fromEntries(config.ESTATUS.map((e) => [e.key, e]));
  const h = hoy();
  const limiteProximo = sumarDias(h, config.DIAS_ALERTA);

  const libro = new ExcelJS.Workbook();
  libro.creator = 'Spacio Publicidad';
  libro.created = new Date();
  const hoja = libro.addWorksheet('Control de trabajos', { views: [{ state: 'frozen', ySplit: 1 }] });
  hoja.columns = [
    { header: 'N° trabajo', key: 'numero', width: 12 },
    { header: 'Cliente', key: 'cliente', width: 24 },
    { header: 'Marca', key: 'marca', width: 18 },
    { header: 'Tienda', key: 'tienda', width: 22 },
    { header: 'Ubicación', key: 'ubicacion', width: 22 },
    { header: 'Descripción del trabajo', key: 'descripcion', width: 40 },
    { header: 'Estatus', key: 'estatus', width: 24 },
    { header: 'Fecha de inicio', key: 'fecha_inicio', width: 14 },
    { header: 'Entrega cotización', key: 'fecha_cotizacion', width: 16 },
    { header: 'Entrega trabajo', key: 'fecha_entrega', width: 15 },
    { header: 'Responsable', key: 'responsable', width: 18 },
    { header: 'Pendientes', key: 'pendientes', width: 34 },
    { header: 'Observaciones', key: 'observaciones', width: 40 },
    { header: 'Situación', key: 'situacion', width: 12 },
  ];
  const aFecha = (iso) => (iso ? new Date(`${iso}T00:00:00Z`) : null);
  for (const t of filas) {
    const abierto = !config.ESTATUS_SIN_ALERTA.includes(t.estatus);
    let situacion = '';
    if (abierto && t.fecha_entrega && t.fecha_entrega < h) situacion = 'Atrasado';
    else if (abierto && t.fecha_entrega && t.fecha_entrega <= limiteProximo) situacion = 'Próximo';
    const fila = hoja.addRow({
      ...t,
      numero: `${config.PREFIJO_TRABAJO}${String(t.numero).padStart(4, '0')}`,
      estatus: etiqueta[t.estatus]?.label || t.estatus,
      fecha_inicio: aFecha(t.fecha_inicio),
      fecha_cotizacion: aFecha(t.fecha_cotizacion),
      fecha_entrega: aFecha(t.fecha_entrega),
      pendientes: listarPendientes(t.id)
        .filter((p) => !p.hecho)
        .map((p) => `• ${p.texto}`)
        .join('\n'),
      situacion,
    });
    const color = etiqueta[t.estatus]?.color?.replace('#', '');
    if (color) fila.getCell('estatus').font = { color: { argb: `FF${color}` }, bold: true };
    if (situacion === 'Atrasado') {
      fila.getCell('situacion').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE2E4' } };
      fila.getCell('situacion').font = { color: { argb: 'FFB91C1C' }, bold: true };
    } else if (situacion === 'Próximo') {
      fila.getCell('situacion').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    }
  }
  for (const key of ['fecha_inicio', 'fecha_cotizacion', 'fecha_entrega']) hoja.getColumn(key).numFmt = 'dd/mm/yyyy';
  for (const key of ['descripcion', 'pendientes', 'observaciones']) hoja.getColumn(key).alignment = { wrapText: true, vertical: 'top' };
  const encabezado = hoja.getRow(1);
  encabezado.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  encabezado.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  encabezado.alignment = { vertical: 'middle' };
  encabezado.height = 22;
  hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: hoja.columns.length } };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="control-trabajos-${h}.xlsx"`);
  await libro.xlsx.write(res);
  res.end();
});

router.get('/:id', (req, res) => {
  const t = obtener(req.params.id);
  if (!t) throw new HttpError(404, 'Trabajo no encontrado');
  t.adjuntos = db.prepare('SELECT * FROM adjuntos WHERE trabajo_id = ? ORDER BY id').all(t.id);
  t.pendientes = listarPendientes(t.id);
  res.json(t);
});

router.post('/', (req, res) => {
  const datos = leerCampos(req.body, CAMPOS, { requeridos: ['cliente'] });
  if (datos.estatus === null) datos.estatus = 'por_cotizar';
  validarEstatus(datos);
  const pendientes = Array.isArray(req.body.pendientes) ? req.body.pendientes : [];
  const id = crearTrabajo(datos, pendientes, req.usuario.id);
  res.status(201).json(obtener(id));
});

router.patch('/:id', (req, res) => {
  if (!obtener(req.params.id)) throw new HttpError(404, 'Trabajo no encontrado');
  const datos = leerCampos(req.body, CAMPOS, { parcial: true, requeridos: ['cliente'] });
  validarEstatus(datos);
  const cols = Object.keys(datos);
  if (cols.length) {
    db.prepare(
      `UPDATE trabajos SET ${cols.map((c) => `${c} = ?`).join(', ')}, actualizado_por = ?, actualizado_en = datetime('now') WHERE id = ?`
    ).run(...cols.map((c) => datos[c]), req.usuario.id, req.params.id);
  }
  res.json(obtener(req.params.id));
});

router.delete('/:id', requiereAdmin, (req, res) => {
  const archivos = db.prepare('SELECT archivo FROM adjuntos WHERE trabajo_id = ?').pluck().all(req.params.id);
  const info = db.prepare('DELETE FROM trabajos WHERE id = ?').run(req.params.id);
  if (!info.changes) throw new HttpError(404, 'Trabajo no encontrado');
  for (const a of archivos) fs.rm(path.join(DIR_ADJUNTOS, a), { force: true }, () => {});
  res.json({ ok: true });
});

// ---- Pendientes (próximos pasos de cada trabajo) ----

const tocarTrabajo = (trabajoId, usuarioId) =>
  db.prepare(`UPDATE trabajos SET actualizado_por = ?, actualizado_en = datetime('now') WHERE id = ?`).run(usuarioId, trabajoId);

router.post('/:id/pendientes', (req, res) => {
  if (!obtener(req.params.id)) throw new HttpError(404, 'Trabajo no encontrado');
  const texto = String(req.body?.texto ?? '').trim().slice(0, 500);
  if (!texto) throw new HttpError(400, 'Escribe el pendiente');
  const orden = db
    .prepare('SELECT COALESCE(MAX(orden), -1) + 1 FROM trabajo_pendientes WHERE trabajo_id = ?')
    .pluck()
    .get(req.params.id);
  db.prepare('INSERT INTO trabajo_pendientes (trabajo_id, texto, orden) VALUES (?, ?, ?)').run(req.params.id, texto, orden);
  tocarTrabajo(req.params.id, req.usuario.id);
  res.status(201).json(listarPendientes(req.params.id));
});

const pendientesRouter = express.Router();

pendientesRouter.patch('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM trabajo_pendientes WHERE id = ?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Pendiente no encontrado');
  const texto = req.body?.texto !== undefined ? String(req.body.texto).trim().slice(0, 500) : p.texto;
  if (!texto) throw new HttpError(400, 'Escribe el pendiente');
  const hecho = req.body?.hecho !== undefined ? (req.body.hecho ? 1 : 0) : p.hecho;
  db.prepare(
    `UPDATE trabajo_pendientes SET texto = ?, hecho = ?,
       hecho_en = CASE WHEN ? = 1 THEN COALESCE(hecho_en, datetime('now')) ELSE NULL END WHERE id = ?`
  ).run(texto, hecho, hecho, p.id);
  tocarTrabajo(p.trabajo_id, req.usuario.id);
  res.json(listarPendientes(p.trabajo_id));
});

pendientesRouter.delete('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM trabajo_pendientes WHERE id = ?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Pendiente no encontrado');
  db.prepare('DELETE FROM trabajo_pendientes WHERE id = ?').run(p.id);
  tocarTrabajo(p.trabajo_id, req.usuario.id);
  res.json(listarPendientes(p.trabajo_id));
});

// ---- Adjuntos (archivos y fotografías) ----

const subida = multer({
  storage: multer.diskStorage({
    destination: DIR_ADJUNTOS,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: config.MAX_ARCHIVO_MB * 1024 * 1024, files: 20 },
});

router.post('/:id/adjuntos', (req, res, next) => {
  if (!obtener(req.params.id)) throw new HttpError(404, 'Trabajo no encontrado');
  subida.array('archivos', 20)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Cada archivo debe pesar menos de ${config.MAX_ARCHIVO_MB} MB` : err.message;
      return next(new HttpError(400, msg));
    }
    const insertar = db.prepare(
      'INSERT INTO adjuntos (trabajo_id, nombre_original, archivo, mime, tamano, subido_por) VALUES (?, ?, ?, ?, ?, ?)'
    );
    db.transaction(() => {
      for (const f of req.files || []) {
        // multer entrega el nombre original en latin1; se convierte a UTF-8 para conservar acentos.
        const nombre = Buffer.from(f.originalname, 'latin1').toString('utf8');
        insertar.run(req.params.id, nombre, f.filename, f.mimetype, f.size, req.usuario.id);
      }
    })();
    res.status(201).json(db.prepare('SELECT * FROM adjuntos WHERE trabajo_id = ? ORDER BY id').all(req.params.id));
  });
});

const adjuntosRouter = express.Router();

// Sólo imágenes (no SVG) y PDF se muestran en el navegador; el resto se descarga.
const MIME_EN_LINEA = /^(image\/(png|jpe?g|gif|webp|avif|heic|heif|bmp)|application\/pdf)$/;

adjuntosRouter.get('/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM adjuntos WHERE id = ?').get(req.params.id);
  if (!a) throw new HttpError(404, 'Archivo no encontrado');
  const enLinea = MIME_EN_LINEA.test(a.mime || '') && req.query.descargar === undefined;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Type', enLinea ? a.mime : 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${enLinea ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.nombre_original)}`
  );
  res.sendFile(path.join(DIR_ADJUNTOS, a.archivo));
});

adjuntosRouter.delete('/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM adjuntos WHERE id = ?').get(req.params.id);
  if (!a) throw new HttpError(404, 'Archivo no encontrado');
  db.prepare('DELETE FROM adjuntos WHERE id = ?').run(a.id);
  fs.rm(path.join(DIR_ADJUNTOS, a.archivo), { force: true }, () => {});
  res.json({ ok: true });
});

module.exports = { router, adjuntosRouter, pendientesRouter, crearTrabajo, validarEstatus };
