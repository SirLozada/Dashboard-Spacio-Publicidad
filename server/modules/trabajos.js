const express = require('express');
const ExcelJS = require('exceljs');
const { db } = require('../db');
const config = require('../config');
const { requiereAdmin } = require('../auth');
const { HttpError, hoy, sumarDias, leerCampos, likeParam } = require('../lib/util');
const almacen = require('../lib/almacen');
const estatus = require('../lib/estatus');

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
// Condiciones SQL según los estatus del trabajo (puede tener varios).
const ABIERTO = (col = 't.estatus') => `NOT ${estatus.sqlContiene(col, config.ESTATUS_CERRADOS)}`;
const CON_ALERTA = (col = 't.estatus') => `NOT ${estatus.sqlContiene(col, config.ESTATUS_SIN_ALERTA)}`;

const SELECT_TRABAJO = `
  SELECT t.*, (SELECT COUNT(*) FROM adjuntos a WHERE a.trabajo_id = t.id) AS total_adjuntos,
    (SELECT COUNT(*) FROM trabajo_pendientes p WHERE p.trabajo_id = t.id AND p.hecho = 0) AS total_pendientes,
    (SELECT p.texto FROM trabajo_pendientes p WHERE p.trabajo_id = t.id AND p.hecho = 0
      ORDER BY p.orden, p.id LIMIT 1) AS proximo_pendiente
  FROM trabajos t`;

const listarPendientes = (trabajoId) =>
  db.all('SELECT * FROM trabajo_pendientes WHERE trabajo_id = ? ORDER BY hecho, orden, id', trabajoId);
const listarAdjuntos = (trabajoId) => db.all('SELECT * FROM adjuntos WHERE trabajo_id = ? ORDER BY id', trabajoId);

function validarEstatus(datos) {
  if ('estatus' in datos) datos.estatus = estatus.normalizar(datos.estatus);
}

function obtener(id) {
  return db.get(`${SELECT_TRABAJO} WHERE t.id = ?`, id);
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
    where.push(ABIERTO());
  } else if (q.estatus) {
    const lista = estatus.lista(q.estatus).filter((e) => config.ESTATUS_KEYS.includes(e));
    if (lista.length) where.push(estatus.sqlContiene('t.estatus', lista));
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
    where.push(`${CON_ALERTA()} AND t.fecha_entrega < ?`);
    params.push(hoy());
  } else if (q.alerta === 'proximos') {
    where.push(`${CON_ALERTA()} AND t.fecha_entrega BETWEEN ? AND ?`);
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
  return db.all(sql, ...params);
}

// Crea un trabajo con número automático y, opcionalmente, su lista de pendientes.
// También lo usa la importación desde Excel.
function crearTrabajo(datos, pendientes = [], usuarioId = null) {
  return db.transaction(async (tx) => {
    const numero = await tx.value('SELECT COALESCE(MAX(numero), 0) + 1 FROM trabajos');
    const cols = Object.keys(datos);
    const { lastInsertRowid: id } = await tx.run(
      `INSERT INTO trabajos (numero, creado_por, actualizado_por, ${cols.join(', ')})
       VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`,
      numero,
      usuarioId,
      usuarioId,
      ...cols.map((c) => datos[c])
    );
    const textos = pendientes.map((p) => String(p ?? '').trim().slice(0, 500)).filter(Boolean);
    for (const [i, texto] of textos.entries()) {
      await tx.run('INSERT INTO trabajo_pendientes (trabajo_id, texto, orden) VALUES (?, ?, ?)', id, texto, i);
    }
    return id;
  });
}

const router = express.Router();

router.get('/', async (req, res) => res.json(await consultar(req.query)));

router.get('/resumen', async (req, res) => {
  const h = hoy();
  // Un trabajo con varios estatus cuenta en cada uno de ellos.
  const totales = await db.get(
    `SELECT
       ${config.ESTATUS_KEYS.map((k) => `SUM(${estatus.sqlContiene('estatus', [k])}) AS "${k}"`).join(',\n       ')},
       SUM(${CON_ALERTA('estatus')} AND fecha_entrega < ?) AS atrasados,
       SUM(${CON_ALERTA('estatus')} AND fecha_entrega BETWEEN ? AND ?) AS proximos,
       SUM(${ABIERTO('estatus')}) AS activos
     FROM trabajos`,
    h,
    h,
    sumarDias(h, config.DIAS_ALERTA)
  );
  const porEstatus = Object.fromEntries(config.ESTATUS_KEYS.map((k) => [k, totales[k] || 0]));
  res.json({
    porEstatus,
    atrasados: totales.atrasados || 0,
    proximos: totales.proximos || 0,
    activos: totales.activos || 0,
    hoy: h,
  });
});

// Valores ya usados, para autocompletar en los formularios.
router.get('/sugerencias', async (req, res) => {
  const columnas = ['cliente', 'marca', 'tienda', 'ubicacion', 'responsable'];
  const valores = await Promise.all(
    columnas.map((col) =>
      db.column(`SELECT DISTINCT ${col} FROM trabajos WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col} COLLATE NOCASE`)
    )
  );
  res.json(Object.fromEntries(columnas.map((c, i) => [c, valores[i]])));
});

router.get('/exportar', async (req, res) => {
  const filas = await consultar(req.query);
  const pendientesPorTrabajo = {};
  for (const p of await db.all('SELECT trabajo_id, texto FROM trabajo_pendientes WHERE hecho = 0 ORDER BY orden, id')) {
    (pendientesPorTrabajo[p.trabajo_id] ??= []).push(`• ${p.texto}`);
  }
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
    const claves = estatus.lista(t.estatus);
    const abierto = !claves.some((k) => config.ESTATUS_SIN_ALERTA.includes(k));
    let situacion = '';
    if (abierto && t.fecha_entrega && t.fecha_entrega < h) situacion = 'Atrasado';
    else if (abierto && t.fecha_entrega && t.fecha_entrega <= limiteProximo) situacion = 'Próximo';
    const fila = hoja.addRow({
      ...t,
      numero: `${config.PREFIJO_TRABAJO}${String(t.numero).padStart(4, '0')}`,
      estatus: estatus.etiquetas(t.estatus),
      fecha_inicio: aFecha(t.fecha_inicio),
      fecha_cotizacion: aFecha(t.fecha_cotizacion),
      fecha_entrega: aFecha(t.fecha_entrega),
      pendientes: (pendientesPorTrabajo[t.id] || []).join('\n'),
      situacion,
    });
    const color = claves.length === 1 ? etiqueta[claves[0]]?.color?.replace('#', '') : null;
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

router.get('/:id', async (req, res) => {
  const t = await obtener(req.params.id);
  if (!t) throw new HttpError(404, 'Trabajo no encontrado');
  [t.adjuntos, t.pendientes] = await Promise.all([listarAdjuntos(t.id), listarPendientes(t.id)]);
  res.json(t);
});

router.post('/', async (req, res) => {
  const datos = leerCampos(req.body, CAMPOS, { requeridos: ['cliente'] });
  validarEstatus(datos);
  const pendientes = Array.isArray(req.body.pendientes) ? req.body.pendientes : [];
  const id = await crearTrabajo(datos, pendientes, req.usuario.id);
  res.status(201).json(await obtener(id));
});

router.patch('/:id', async (req, res) => {
  if (!(await obtener(req.params.id))) throw new HttpError(404, 'Trabajo no encontrado');
  const datos = leerCampos(req.body, CAMPOS, { parcial: true, requeridos: ['cliente'] });
  validarEstatus(datos);
  const cols = Object.keys(datos);
  if (cols.length) {
    await db.run(
      `UPDATE trabajos SET ${cols.map((c) => `${c} = ?`).join(', ')}, actualizado_por = ?, actualizado_en = datetime('now') WHERE id = ?`,
      ...cols.map((c) => datos[c]),
      req.usuario.id,
      req.params.id
    );
  }
  res.json(await obtener(req.params.id));
});

router.delete('/:id', requiereAdmin, async (req, res) => {
  const id = req.params.id;
  if (!(await obtener(id))) throw new HttpError(404, 'Trabajo no encontrado');
  const archivos = await db.column('SELECT archivo FROM adjuntos WHERE trabajo_id = ?', id);
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM adjuntos WHERE trabajo_id = ?', id);
    await tx.run('DELETE FROM trabajo_pendientes WHERE trabajo_id = ?', id);
    await tx.run('DELETE FROM trabajos WHERE id = ?', id);
  });
  await Promise.all(archivos.map(almacen.borrar));
  res.json({ ok: true });
});

// ---- Pendientes (próximos pasos de cada trabajo) ----

const tocarTrabajo = (trabajoId, usuarioId) =>
  db.run(`UPDATE trabajos SET actualizado_por = ?, actualizado_en = datetime('now') WHERE id = ?`, usuarioId, trabajoId);

router.post('/:id/pendientes', async (req, res) => {
  if (!(await obtener(req.params.id))) throw new HttpError(404, 'Trabajo no encontrado');
  const texto = String(req.body?.texto ?? '').trim().slice(0, 500);
  if (!texto) throw new HttpError(400, 'Escribe el pendiente');
  await db.run(
    `INSERT INTO trabajo_pendientes (trabajo_id, texto, orden)
     VALUES (?, ?, (SELECT COALESCE(MAX(orden), -1) + 1 FROM trabajo_pendientes WHERE trabajo_id = ?))`,
    req.params.id,
    texto,
    req.params.id
  );
  await tocarTrabajo(req.params.id, req.usuario.id);
  res.status(201).json(await listarPendientes(req.params.id));
});

const pendientesRouter = express.Router();

pendientesRouter.patch('/:id', async (req, res) => {
  const p = await db.get('SELECT * FROM trabajo_pendientes WHERE id = ?', req.params.id);
  if (!p) throw new HttpError(404, 'Pendiente no encontrado');
  const texto = req.body?.texto !== undefined ? String(req.body.texto).trim().slice(0, 500) : p.texto;
  if (!texto) throw new HttpError(400, 'Escribe el pendiente');
  const hecho = req.body?.hecho !== undefined ? (req.body.hecho ? 1 : 0) : p.hecho;
  await db.run(
    `UPDATE trabajo_pendientes SET texto = ?, hecho = ?,
       hecho_en = CASE WHEN ? = 1 THEN COALESCE(hecho_en, datetime('now')) ELSE NULL END WHERE id = ?`,
    texto,
    hecho,
    hecho,
    p.id
  );
  await tocarTrabajo(p.trabajo_id, req.usuario.id);
  res.json(await listarPendientes(p.trabajo_id));
});

pendientesRouter.delete('/:id', async (req, res) => {
  const p = await db.get('SELECT * FROM trabajo_pendientes WHERE id = ?', req.params.id);
  if (!p) throw new HttpError(404, 'Pendiente no encontrado');
  await db.run('DELETE FROM trabajo_pendientes WHERE id = ?', p.id);
  await tocarTrabajo(p.trabajo_id, req.usuario.id);
  res.json(await listarPendientes(p.trabajo_id));
});

// ---- Adjuntos (archivos y fotografías) ----

const registrarAdjunto = (trabajoId, nombre, archivo, mime, tamano, usuarioId) =>
  db.run(
    'INSERT INTO adjuntos (trabajo_id, nombre_original, archivo, mime, tamano, subido_por) VALUES (?, ?, ?, ?, ?, ?)',
    trabajoId,
    String(nombre || 'archivo').slice(0, 255),
    archivo,
    mime || null,
    Number(tamano) || null,
    usuarioId
  );

// Modo local: el archivo llega al servidor (multipart/form-data).
router.post('/:id/adjuntos', async (req, res) => {
  if (almacen.MODO !== 'local') throw new HttpError(400, 'Las subidas se hacen directamente al almacenamiento');
  if (!(await obtener(req.params.id))) throw new HttpError(404, 'Trabajo no encontrado');
  await new Promise((resolve, reject) =>
    almacen.subidaLocal()(req, res, (err) => {
      if (!err) return resolve();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Cada archivo debe pesar menos de ${config.MAX_ARCHIVO_MB} MB` : err.message;
      reject(new HttpError(400, msg));
    })
  );
  for (const f of req.files || []) {
    // multer entrega el nombre original en latin1; se convierte a UTF-8 para conservar acentos.
    const nombre = Buffer.from(f.originalname, 'latin1').toString('utf8');
    await registrarAdjunto(req.params.id, nombre, f.filename, f.mimetype, f.size, req.usuario.id);
  }
  res.status(201).json(await listarAdjuntos(req.params.id));
});

// Modo Vercel Blob: 1) el navegador pide permiso de subida, 2) sube el archivo
// directamente a Blob y 3) registra el adjunto.
router.post('/:id/adjuntos/permiso', async (req, res) => {
  if (almacen.MODO !== 'blob') throw new HttpError(400, 'Almacenamiento Blob no configurado');
  if (!(await obtener(req.params.id))) throw new HttpError(404, 'Trabajo no encontrado');
  res.json(await almacen.tokenSubida(req, req.params.id));
});

router.post('/:id/adjuntos/registrar', async (req, res) => {
  if (!(await obtener(req.params.id))) throw new HttpError(404, 'Trabajo no encontrado');
  const { url, nombre, mime, tamano } = req.body || {};
  if (!almacen.esUrlBlob(url)) throw new HttpError(400, 'Archivo no válido');
  await registrarAdjunto(req.params.id, nombre, url, mime, tamano, req.usuario.id);
  res.status(201).json(await listarAdjuntos(req.params.id));
});

const adjuntosRouter = express.Router();

adjuntosRouter.get('/:id', async (req, res) => {
  const a = await db.get('SELECT * FROM adjuntos WHERE id = ?', req.params.id);
  if (!a) throw new HttpError(404, 'Archivo no encontrado');
  await almacen.enviar(req, res, a);
});

adjuntosRouter.delete('/:id', async (req, res) => {
  const a = await db.get('SELECT * FROM adjuntos WHERE id = ?', req.params.id);
  if (!a) throw new HttpError(404, 'Archivo no encontrado');
  await db.run('DELETE FROM adjuntos WHERE id = ?', a.id);
  await almacen.borrar(a.archivo);
  res.json({ ok: true });
});

module.exports = { router, adjuntosRouter, pendientesRouter, crearTrabajo, validarEstatus };
