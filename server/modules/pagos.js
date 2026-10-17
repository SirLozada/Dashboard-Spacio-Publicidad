// Pagos de producción: pagos por proyecto a colaboradores (no es una nómina).
// Todo el módulo es exclusivo de administradores (ver server/app.js).
const express = require('express');
const ExcelJS = require('exceljs');
const { db } = require('../db');
const config = require('../config');
const bcv = require('../lib/bcv');
const { crearCrud } = require('../lib/crud');
const { HttpError, hoy, sumarDias, convertir, likeParam } = require('../lib/util');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const TOLERANCIA = 0.004; // menos de medio centavo se considera cero
const numeroTrabajo = (n) => `${config.PREFIJO_TRABAJO}${String(n).padStart(4, '0')}`;
const METODOS = ['Pago móvil', 'Transferencia en Bs', 'Efectivo USD', 'Efectivo Bs', 'Zelle', 'Binance / USDT', 'Otro'];

function estadoPago(acordado, abonado) {
  if (abonado <= TOLERANCIA) return 'pendiente';
  if (acordado - abonado <= TOLERANCIA) return 'completado';
  return 'parcial';
}

// Lunes de la semana de una fecha (semanas de lunes a domingo).
function lunesDe(fecha) {
  const d = new Date(`${fecha}T12:00:00Z`);
  return sumarDias(fecha, -((d.getUTCDay() + 6) % 7));
}

const registrarHistorial = (tx, { entidad, entidadId, asignacionId = null, accion, detalle = null, usuarioId }) =>
  tx.run(
    'INSERT INTO pagos_historial (entidad, entidad_id, asignacion_id, accion, detalle, usuario_id) VALUES (?, ?, ?, ?, ?, ?)',
    entidad,
    entidadId,
    asignacionId,
    accion,
    detalle ? JSON.stringify(detalle) : null,
    usuarioId
  );

// ---------- Consultas de asignaciones con sus saldos ----------

const SELECT_ASIGNACION = `
  SELECT a.*, c.nombre AS colaborador, c.especialidad, c.telefono,
    t.numero, t.cliente, t.marca, t.tienda, t.descripcion AS trabajo_descripcion, t.estatus AS trabajo_estatus,
    COALESCE((SELECT SUM(b.monto_usd) FROM abonos b WHERE b.asignacion_id = a.id), 0) AS abonado_usd,
    (SELECT COUNT(*) FROM abonos b WHERE b.asignacion_id = a.id) AS total_movimientos,
    (SELECT MAX(b.fecha) FROM abonos b WHERE b.asignacion_id = a.id) AS ultimo_pago
  FROM asignaciones a
  JOIN colaboradores c ON c.id = a.colaborador_id
  JOIN trabajos t ON t.id = a.trabajo_id`;

function completar(a) {
  const acordado = r2(a.monto_acordado_usd);
  const abonado = r2(a.abonado_usd);
  return {
    ...a,
    proyecto: `${numeroTrabajo(a.numero)} · ${a.cliente}${a.trabajo_descripcion ? ` · ${a.trabajo_descripcion.split('\n')[0]}` : ''}`,
    monto_acordado_usd: acordado,
    abonado_usd: abonado,
    saldo_usd: r2(acordado - abonado),
    estado: estadoPago(acordado, abonado),
  };
}

async function listarAsignaciones(q = {}) {
  const where = [];
  const params = [];
  if (q.colaborador_id) {
    where.push('a.colaborador_id = ?');
    params.push(q.colaborador_id);
  }
  if (q.trabajo_id) {
    where.push('a.trabajo_id = ?');
    params.push(q.trabajo_id);
  }
  if (q.q) {
    const like = likeParam(q.q);
    where.push(`(c.nombre LIKE ? ESCAPE '\\' OR t.cliente LIKE ? ESCAPE '\\' OR t.descripcion LIKE ? ESCAPE '\\' OR a.tarea LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  // Fechas: asignaciones iniciadas en el rango o con pagos en el rango.
  if (q.desde || q.hasta) {
    const desde = q.desde || '0000-01-01';
    const hasta = q.hasta || '9999-12-31';
    where.push(`(a.fecha_inicio BETWEEN ? AND ? OR EXISTS (SELECT 1 FROM abonos b WHERE b.asignacion_id = a.id AND b.fecha BETWEEN ? AND ?))`);
    params.push(desde, hasta, desde, hasta);
  }
  const filas = await db.all(
    `${SELECT_ASIGNACION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.numero DESC, c.nombre COLLATE NOCASE`,
    ...params
  );
  const lista = filas.map(completar);
  return q.estado ? lista.filter((a) => a.estado === q.estado) : lista;
}

async function obtenerAsignacion(id) {
  const a = await db.get(`${SELECT_ASIGNACION} WHERE a.id = ?`, id);
  return a ? completar(a) : null;
}

const SELECT_ABONO = `
  SELECT b.*, a.trabajo_id, a.colaborador_id, c.nombre AS colaborador, t.numero, t.cliente,
    u.nombre AS registrado_por,
    (SELECT x.id FROM abonos x WHERE x.ajusta_abono_id = b.id LIMIT 1) AS anulado_por
  FROM abonos b
  JOIN asignaciones a ON a.id = b.asignacion_id
  JOIN colaboradores c ON c.id = a.colaborador_id
  JOIN trabajos t ON t.id = a.trabajo_id
  LEFT JOIN usuarios u ON u.id = b.creado_por`;

// ---------- Rutas ----------

const router = express.Router();

// --- Tasa BCV ---

router.get('/tasa', async (req, res) => {
  res.json(await bcv.tasaParaFecha(req.query.fecha || hoy()));
});

router.get('/tasas', async (req, res) => {
  res.json(await db.all('SELECT * FROM tasas_bcv ORDER BY fecha_valor DESC LIMIT 60'));
});

router.post('/tasas/actualizar', async (req, res) => {
  try {
    res.json({ ok: true, ...(await bcv.actualizarDesdeBCV()) });
  } catch (err) {
    throw new HttpError(502, `No se pudo consultar el BCV: ${err.message}`);
  }
});

// Registro manual de una tasa oficial (p. ej. verificada en bcv.org.ve).
router.post('/tasas', async (req, res) => {
  const fecha = convertir(req.body?.fecha_valor, 'date');
  const tasa = convertir(req.body?.tasa, 'number');
  if (!fecha || !(tasa > 0)) throw new HttpError(400, 'Indica la fecha valor y una tasa válida');
  if (!req.body?.confirmada) throw new HttpError(400, 'Confirma que verificaste la tasa en la fuente oficial');
  const existente = await db.get('SELECT * FROM tasas_bcv WHERE fecha_valor = ?', fecha);
  if (existente?.fuente === 'bcv') throw new HttpError(400, 'Ya existe la tasa oficial leída del BCV para esa fecha valor');
  await bcv.guardarTasa({ fecha_valor: fecha, tasa }, 'manual', req.usuario.id);
  await registrarHistorial(db, { entidad: 'tasa', entidadId: 0, accion: 'tasa_manual', detalle: { fecha_valor: fecha, tasa, anterior: existente?.tasa ?? null }, usuarioId: req.usuario.id });
  res.status(201).json(await db.get('SELECT * FROM tasas_bcv WHERE fecha_valor = ?', fecha));
});

// --- Colaboradores ---

router.use(
  '/colaboradores',
  crearCrud({
    tabla: 'colaboradores',
    campos: { nombre: 'text', identificacion: 'text', telefono: 'text', especialidad: 'text', observaciones: 'text' },
    requeridos: ['nombre'],
    alias: 'c',
    selectBase: `SELECT c.*,
        (SELECT COUNT(*) FROM asignaciones a WHERE a.colaborador_id = c.id) AS total_asignaciones,
        (SELECT COALESCE(SUM(a.monto_acordado_usd), 0) FROM asignaciones a WHERE a.colaborador_id = c.id) AS acordado_usd,
        (SELECT COALESCE(SUM(b.monto_usd), 0) FROM abonos b JOIN asignaciones a ON a.id = b.asignacion_id WHERE a.colaborador_id = c.id) AS abonado_usd
      FROM colaboradores c`,
    busqueda: ['c.nombre', 'c.especialidad', 'c.identificacion', 'c.telefono'],
    orden: 'c.nombre COLLATE NOCASE',
    antesDeBorrar: async (id) => {
      if (await db.value('SELECT 1 FROM asignaciones WHERE colaborador_id = ? LIMIT 1', id)) {
        throw new HttpError(400, 'No se puede eliminar: el colaborador tiene proyectos asignados');
      }
    },
  })
);

// --- Asignaciones ---

router.get('/asignaciones', async (req, res) => res.json(await listarAsignaciones(req.query)));

router.get('/asignaciones/:id', async (req, res) => {
  const a = await obtenerAsignacion(req.params.id);
  if (!a) throw new HttpError(404, 'Asignación no encontrada');
  const [abonos, historial] = await Promise.all([
    db.all(`${SELECT_ABONO} WHERE b.asignacion_id = ? ORDER BY b.fecha, b.id`, a.id),
    db.all(
      `SELECT h.*, u.nombre AS usuario FROM pagos_historial h LEFT JOIN usuarios u ON u.id = h.usuario_id
       WHERE h.asignacion_id = ? ORDER BY h.id DESC`,
      a.id
    ),
  ]);
  res.json({ ...a, abonos, historial });
});

function leerAsignacion(body, parcial) {
  const datos = {};
  const campos = { tarea: 'text', fecha_inicio: 'date', monto_acordado_usd: 'number', observaciones: 'text' };
  if (!parcial) Object.assign(campos, { trabajo_id: 'int', colaborador_id: 'int' });
  for (const [k, tipo] of Object.entries(campos)) {
    if (!(k in (body || {}))) {
      if (!parcial) datos[k] = null;
      continue;
    }
    const v = convertir(body[k], tipo);
    if (v === undefined) throw new HttpError(400, `Valor inválido en "${k}"`);
    datos[k] = v ?? null;
  }
  if ('monto_acordado_usd' in datos) {
    if (datos.monto_acordado_usd === null || datos.monto_acordado_usd < 0) throw new HttpError(400, 'Indica el monto acordado en USD');
    datos.monto_acordado_usd = r2(datos.monto_acordado_usd);
  }
  return datos;
}

router.post('/asignaciones', async (req, res) => {
  const datos = leerAsignacion(req.body, false);
  if (!datos.trabajo_id || !(await db.value('SELECT 1 FROM trabajos WHERE id = ?', datos.trabajo_id))) {
    throw new HttpError(400, 'Selecciona un proyecto existente');
  }
  if (!datos.colaborador_id || !(await db.value('SELECT 1 FROM colaboradores WHERE id = ?', datos.colaborador_id))) {
    throw new HttpError(400, 'Selecciona un colaborador');
  }
  const id = await db.transaction(async (tx) => {
    const cols = Object.keys(datos);
    const { lastInsertRowid } = await tx.run(
      `INSERT INTO asignaciones (${cols.join(', ')}, creado_por) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
      ...cols.map((c) => datos[c]),
      req.usuario.id
    );
    await registrarHistorial(tx, { entidad: 'asignacion', entidadId: lastInsertRowid, asignacionId: lastInsertRowid, accion: 'creada', detalle: datos, usuarioId: req.usuario.id });
    return lastInsertRowid;
  });
  res.status(201).json(await obtenerAsignacion(id));
});

router.patch('/asignaciones/:id', async (req, res) => {
  const actual = await obtenerAsignacion(req.params.id);
  if (!actual) throw new HttpError(404, 'Asignación no encontrada');
  const datos = leerAsignacion(req.body, true);
  if ('monto_acordado_usd' in datos && datos.monto_acordado_usd < actual.abonado_usd - TOLERANCIA) {
    throw new HttpError(400, `El monto acordado no puede ser menor a lo ya abonado ($${actual.abonado_usd.toFixed(2)}). Si hubo un error en un pago, registra un ajuste.`);
  }
  const cambios = {};
  for (const [k, v] of Object.entries(datos)) {
    if ((actual[k] ?? null) !== v) cambios[k] = { antes: actual[k] ?? null, despues: v };
  }
  if (Object.keys(cambios).length) {
    await db.transaction(async (tx) => {
      const cols = Object.keys(cambios);
      await tx.run(
        `UPDATE asignaciones SET ${cols.map((c) => `${c} = ?`).join(', ')}, actualizado_en = datetime('now') WHERE id = ?`,
        ...cols.map((c) => datos[c]),
        actual.id
      );
      await registrarHistorial(tx, { entidad: 'asignacion', entidadId: actual.id, asignacionId: actual.id, accion: 'modificada', detalle: cambios, usuarioId: req.usuario.id });
    });
  }
  res.json(await obtenerAsignacion(actual.id));
});

router.delete('/asignaciones/:id', async (req, res) => {
  const a = await obtenerAsignacion(req.params.id);
  if (!a) throw new HttpError(404, 'Asignación no encontrada');
  if (a.total_movimientos > 0) throw new HttpError(400, 'No se puede eliminar: ya tiene pagos registrados');
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM asignaciones WHERE id = ?', a.id);
    await registrarHistorial(tx, { entidad: 'asignacion', entidadId: a.id, accion: 'eliminada', detalle: { colaborador: a.colaborador, proyecto: a.proyecto, monto_acordado_usd: a.monto_acordado_usd }, usuarioId: req.usuario.id });
  });
  res.json({ ok: true });
});

// --- Abonos y ajustes ---

router.post('/asignaciones/:id/abonos', async (req, res) => {
  const a = await obtenerAsignacion(req.params.id);
  if (!a) throw new HttpError(404, 'Asignación no encontrada');
  const b = req.body || {};
  const tipo = b.tipo === 'ajuste' ? 'ajuste' : 'abono';
  const texto = (v) => convertir(v, 'text') ?? null;
  let registro;

  if (tipo === 'ajuste' && b.ajusta_abono_id) {
    // Anulación de un pago registrado por error: ajuste por el mismo monto en negativo.
    const original = await db.get(`${SELECT_ABONO} WHERE b.id = ? AND b.asignacion_id = ?`, b.ajusta_abono_id, a.id);
    if (!original) throw new HttpError(404, 'Pago no encontrado');
    if (original.tipo !== 'abono') throw new HttpError(400, 'Sólo se pueden anular abonos');
    if (original.anulado_por) throw new HttpError(400, 'Ese pago ya fue anulado');
    const motivo = texto(b.motivo_ajuste);
    if (!motivo || motivo.length < 4) throw new HttpError(400, 'Indica el motivo de la anulación');
    registro = {
      tipo, fecha: hoy(), monto_usd: -original.monto_usd, monto_bs: original.monto_bs === null ? null : -original.monto_bs,
      moneda_ingreso: original.moneda_ingreso, tasa_bcv: original.tasa_bcv, tasa_fecha_valor: original.tasa_fecha_valor,
      tasa_origen: original.tasa_origen, tasa_fuente: original.tasa_fuente, metodo_pago: original.metodo_pago,
      referencia: original.referencia, observaciones: texto(b.observaciones), ajusta_abono_id: original.id, motivo_ajuste: motivo,
    };
  } else {
    const fecha = convertir(b.fecha, 'date');
    if (!fecha) throw new HttpError(400, 'Indica la fecha del pago');
    if (fecha > hoy()) throw new HttpError(400, 'La fecha del pago no puede ser futura');
    const moneda = b.moneda === 'VES' ? 'VES' : 'USD';
    const monto = convertir(b.monto, 'number');
    if (monto === undefined || monto === null || monto === 0) throw new HttpError(400, 'Indica el monto');
    if (tipo === 'abono' && monto < 0) throw new HttpError(400, 'El monto debe ser positivo');

    // Tasa: automática (verificada) o manual confirmada por el usuario.
    let tasa;
    if (b.tasa_modo === 'manual') {
      tasa = { tasa: convertir(b.tasa_manual, 'number'), origen: 'manual', fuente: 'Ingresada manualmente', fecha_valor: null };
      if (!(tasa.tasa > 0)) throw new HttpError(400, 'Indica una tasa válida');
      if (!b.confirmar_tasa) throw new HttpError(400, 'Confirma que verificaste la tasa ingresada');
    } else {
      const t = await bcv.tasaParaFecha(fecha);
      if (!t.disponible) throw new HttpError(400, `${t.motivo} Ingresa la tasa manualmente.`);
      tasa = { tasa: t.tasa, origen: t.origen, fuente: t.fuente === 'bcv' ? 'BCV (bcv.org.ve)' : 'Tasa registrada manualmente', fecha_valor: t.fecha_valor };
    }
    const montoUsd = moneda === 'USD' ? r2(monto) : r2(monto / tasa.tasa);
    const montoBs = moneda === 'VES' ? r2(monto) : r2(monto * tasa.tasa);

    let motivo = null;
    if (tipo === 'ajuste') {
      motivo = texto(b.motivo_ajuste);
      if (!motivo || motivo.length < 4) throw new HttpError(400, 'Indica el motivo del ajuste');
    } else if (montoUsd > a.saldo_usd + TOLERANCIA) {
      throw new HttpError(
        400,
        `El abono ($${montoUsd.toFixed(2)}) supera el saldo pendiente ($${Math.max(0, a.saldo_usd).toFixed(2)}). Si es correcto, regístralo como ajuste autorizado.`
      );
    }
    registro = {
      tipo, fecha, monto_usd: montoUsd, monto_bs: montoBs, moneda_ingreso: moneda, tasa_bcv: tasa.tasa,
      tasa_fecha_valor: tasa.fecha_valor, tasa_origen: tasa.origen, tasa_fuente: tasa.fuente,
      metodo_pago: texto(b.metodo_pago), referencia: texto(b.referencia), observaciones: texto(b.observaciones),
      ajusta_abono_id: null, motivo_ajuste: motivo,
    };
  }

  const id = await db.transaction(async (tx) => {
    const cols = Object.keys(registro);
    const { lastInsertRowid } = await tx.run(
      `INSERT INTO abonos (asignacion_id, ${cols.join(', ')}, creado_por) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
      a.id,
      ...cols.map((c) => registro[c]),
      req.usuario.id
    );
    await registrarHistorial(tx, {
      entidad: 'abono', entidadId: lastInsertRowid, asignacionId: a.id,
      accion: registro.ajusta_abono_id ? 'pago_anulado' : registro.tipo === 'ajuste' ? 'ajuste' : 'abono',
      detalle: { fecha: registro.fecha, monto_usd: registro.monto_usd, monto_bs: registro.monto_bs, tasa_bcv: registro.tasa_bcv, motivo: registro.motivo_ajuste, anula: registro.ajusta_abono_id },
      usuarioId: req.usuario.id,
    });
    return lastInsertRowid;
  });
  res.status(201).json({ abono: await db.get(`${SELECT_ABONO} WHERE b.id = ?`, id), asignacion: await obtenerAsignacion(a.id) });
});

router.get('/abonos', async (req, res) => {
  const where = [];
  const params = [];
  for (const [k, col] of [['trabajo_id', 'a.trabajo_id'], ['colaborador_id', 'a.colaborador_id']]) {
    if (req.query[k]) {
      where.push(`${col} = ?`);
      params.push(req.query[k]);
    }
  }
  if (req.query.desde) {
    where.push('b.fecha >= ?');
    params.push(req.query.desde);
  }
  if (req.query.hasta) {
    where.push('b.fecha <= ?');
    params.push(req.query.hasta);
  }
  res.json(await db.all(`${SELECT_ABONO} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.fecha DESC, b.id DESC`, ...params));
});

// --- Resumen (indicadores) ---

router.get('/resumen', async (req, res) => {
  const lista = await listarAsignaciones(req.query);
  const inicio = lunesDe(hoy());
  const fin = sumarDias(inicio, 6);
  const ids = lista.map((a) => a.id);
  const semana = ids.length
    ? await db.get(
        `SELECT COALESCE(SUM(monto_usd), 0) AS usd, COUNT(*) AS cantidad FROM abonos
         WHERE tipo = 'abono' AND fecha BETWEEN ? AND ? AND asignacion_id IN (${ids.map(() => '?').join(',')})`,
        inicio,
        fin,
        ...ids
      )
    : { usd: 0, cantidad: 0 };
  // Un proyecto cuenta como "completado" cuando todas sus asignaciones lo están.
  const porProyecto = new Map();
  for (const a of lista) porProyecto.set(a.trabajo_id, (porProyecto.get(a.trabajo_id) ?? true) && a.estado === 'completado');
  const suma = (k) => r2(lista.reduce((s, a) => s + a[k], 0));
  res.json({
    acordado_usd: suma('monto_acordado_usd'),
    abonado_usd: suma('abonado_usd'),
    saldo_usd: r2(lista.reduce((s, a) => s + Math.max(0, a.saldo_usd), 0)),
    semana: { inicio, fin, usd: r2(semana.usd), cantidad: semana.cantidad },
    colaboradores_pendientes: new Set(lista.filter((a) => a.saldo_usd > TOLERANCIA).map((a) => a.colaborador_id)).size,
    proyectos_completados: [...porProyecto.values()].filter(Boolean).length,
    asignaciones: lista.length,
    metodos: METODOS,
  });
});

// --- Pagos de la semana ---

async function datosSemana(fecha) {
  const inicio = lunesDe(convertir(fecha, 'date') || hoy());
  const fin = sumarDias(inicio, 6);
  const [abonos, asignaciones] = await Promise.all([
    db.all(`${SELECT_ABONO} WHERE b.fecha BETWEEN ? AND ? ORDER BY b.fecha, b.id`, inicio, fin),
    listarAsignaciones({}),
  ]);
  const pagadoSemana = new Map();
  for (const b of abonos) pagadoSemana.set(b.asignacion_id, r2((pagadoSemana.get(b.asignacion_id) || 0) + b.monto_usd));
  const filas = asignaciones
    .filter((a) => a.saldo_usd > TOLERANCIA || pagadoSemana.has(a.id))
    .map((a) => ({ ...a, pagado_semana_usd: pagadoSemana.get(a.id) || 0 }))
    .sort((x, y) => x.colaborador.localeCompare(y.colaborador, 'es') || y.numero - x.numero);
  return {
    inicio,
    fin,
    abonos,
    filas,
    total_semana_usd: r2(abonos.reduce((s, b) => s + b.monto_usd, 0)),
    total_semana_bs: r2(abonos.reduce((s, b) => s + (b.monto_bs || 0), 0)),
    saldo_usd: r2(filas.reduce((s, a) => s + Math.max(0, a.saldo_usd), 0)),
  };
}

router.get('/semana', async (req, res) => res.json(await datosSemana(req.query.fecha)));

const ESTADOS = { pendiente: 'Pendiente', parcial: 'Pago parcial', completado: 'Completado' };
const fechaExcel = (iso) => (iso ? new Date(`${iso}T00:00:00Z`) : null);

function estilarHoja(hoja) {
  const enc = hoja.getRow(1);
  enc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  enc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0A0B' } };
  enc.height = 22;
  hoja.views = [{ state: 'frozen', ySplit: 1 }];
  hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: hoja.columns.length } };
}

router.get('/semana/exportar', async (req, res) => {
  const s = await datosSemana(req.query.fecha);
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Spacio Publicidad';
  const usd = '"$"#,##0.00';
  const bs = '#,##0.00 "Bs"';

  const h1 = libro.addWorksheet('Resumen semana');
  h1.columns = [
    { header: 'Colaborador', key: 'colaborador', width: 26 },
    { header: 'Proyecto', key: 'proyecto', width: 40 },
    { header: 'Trabajo a realizar', key: 'tarea', width: 30 },
    { header: 'Acordado USD', key: 'monto_acordado_usd', width: 14, style: { numFmt: usd } },
    { header: 'Pagado en la semana USD', key: 'pagado_semana_usd', width: 16, style: { numFmt: usd } },
    { header: 'Pagado total USD', key: 'abonado_usd', width: 15, style: { numFmt: usd } },
    { header: 'Saldo pendiente USD', key: 'saldo_usd', width: 16, style: { numFmt: usd } },
    { header: 'Estado', key: 'estado', width: 14 },
  ];
  for (const f of s.filas) h1.addRow({ ...f, estado: ESTADOS[f.estado] });
  const total = h1.addRow({ colaborador: 'TOTAL', pagado_semana_usd: s.total_semana_usd, saldo_usd: s.saldo_usd });
  total.font = { bold: true };
  estilarHoja(h1);

  const h2 = libro.addWorksheet('Pagos de la semana');
  h2.columns = [
    { header: 'Fecha', key: 'fecha', width: 12, style: { numFmt: 'dd/mm/yyyy' } },
    { header: 'Colaborador', key: 'colaborador', width: 26 },
    { header: 'Proyecto', key: 'proyecto', width: 30 },
    { header: 'Tipo', key: 'tipo', width: 10 },
    { header: 'Abono USD', key: 'monto_usd', width: 13, style: { numFmt: usd } },
    { header: 'Tasa BCV', key: 'tasa_bcv', width: 13, style: { numFmt: '#,##0.0000' } },
    { header: 'Pago Bs', key: 'monto_bs', width: 16, style: { numFmt: bs } },
    { header: 'Origen tasa', key: 'tasa_origen', width: 12 },
    { header: 'Método', key: 'metodo_pago', width: 16 },
    { header: 'Referencia', key: 'referencia', width: 16 },
    { header: 'Observaciones / motivo', key: 'nota', width: 34 },
  ];
  for (const b of s.abonos) {
    h2.addRow({
      ...b,
      fecha: fechaExcel(b.fecha),
      proyecto: `${numeroTrabajo(b.numero)} · ${b.cliente}`,
      tipo: b.tipo === 'ajuste' ? 'Ajuste' : 'Abono',
      tasa_origen: b.tasa_origen === 'manual' ? 'Manual' : 'Automática',
      nota: [b.motivo_ajuste, b.observaciones].filter(Boolean).join(' · '),
    });
  }
  estilarHoja(h2);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="pagos-semana-${s.inicio}.xlsx"`);
  await libro.xlsx.write(res);
  res.end();
});

// Actualización programada de la tasa (Vercel Cron). No requiere sesión: sólo
// lee la página pública del BCV. Si existe CRON_SECRET se exige.
async function cronTasa(req, res) {
  if (process.env.CRON_SECRET && req.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    res.json({ ok: true, ...(await bcv.actualizarDesdeBCV()) });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
}

module.exports = { router, cronTasa, estadoPago, lunesDe };
