// Cotizaciones: costos y precio de venta por proyecto (sólo administradores).
const path = require('path');
const { pathToFileURL } = require('url');
const express = require('express');
const ExcelJS = require('exceljs');
const { db } = require('../db');
const config = require('../config');
const { HttpError, hoy, convertir } = require('../lib/util');

// Mismo cálculo que usa la pantalla (módulo ES compartido con el navegador).
let calculo;
const cargarCalculo = () =>
  (calculo ??= import(pathToFileURL(path.join(__dirname, '..', '..', 'public', 'js', 'lib', 'calculo-cotizacion.js')).href));

const numeroTrabajo = (n) => `${config.PREFIJO_TRABAJO}${String(n).padStart(4, '0')}`;
const numeroCotizacion = (n) => `COT-${String(n).padStart(4, '0')}`;
const ESTADOS = ['borrador', 'enviada', 'aprobada', 'rechazada'];
const COMISIONES_INICIALES = [
  { nombre: 'Fernando', porcentaje: 0.2 },
  { nombre: 'Darwin', porcentaje: 0.05 },
];

const n = (v, porDefecto = 0) => {
  const x = convertir(v, 'number');
  return x === undefined || x === null ? porDefecto : x;
};
const t = (v, max = 2000) => {
  const x = convertir(v, 'text');
  return x ? x.slice(0, max) : null;
};
// Datos del encabezado del documento del cliente: [campo, largo máximo]
const CAMPOS_CLIENTE = [
  ['razon_social', 200],
  ['direccion_cliente', 300],
  ['referencia', 200],
  ['forma_pago', 100],
];
// Moneda de pago del presupuesto: se elige en cada cotización (no hay valor por defecto).
const MONEDAS = { divisas: 'Divisas', bolivares: 'Bolívares' };
const monedaValida = (v) => (Object.hasOwn(MONEDAS, v) ? v : null);
const fraccion = (v, porDefecto) => {
  const x = n(v, porDefecto);
  if (x < 0 || x >= 1) throw new HttpError(400, 'Los márgenes y comisiones deben estar entre 0 % y 99 %');
  return x;
};

async function cargar(id) {
  const c = await db.get(
    `SELECT c.*, (SELECT u.numero FROM cotizaciones u WHERE u.id = c.unificada_en) AS unificada_en_numero,
       t.numero AS trabajo_numero, t.cliente, t.marca, t.tienda, t.ubicacion, t.descripcion AS trabajo_descripcion
     FROM cotizaciones c JOIN trabajos t ON t.id = c.trabajo_id WHERE c.id = ?`,
    id
  );
  if (!c) return null;
  const [piezas, lineas, viaticos] = await Promise.all([
    db.all('SELECT * FROM cotizacion_piezas WHERE cotizacion_id = ? ORDER BY orden, id', id),
    db.all(
      `SELECT l.* FROM cotizacion_lineas l JOIN cotizacion_piezas p ON p.id = l.pieza_id
       WHERE p.cotizacion_id = ? ORDER BY l.orden, l.id`,
      id
    ),
    db.all('SELECT * FROM cotizacion_viaticos WHERE cotizacion_id = ? ORDER BY orden, id', id),
  ]);
  const doc = {
    ...c,
    codigo: numeroCotizacion(c.numero),
    unificada_en_codigo: c.unificada_en_numero ? numeroCotizacion(c.unificada_en_numero) : null,
    origenes: c.origenes ? JSON.parse(c.origenes) : [],
    proyecto: `${numeroTrabajo(c.trabajo_numero)} · ${c.cliente}`,
    comisiones: JSON.parse(c.comisiones || '[]'),
    piezas: piezas.map((p) => ({ ...p, lineas: lineas.filter((l) => l.pieza_id === p.id) })),
    viaticos,
  };
  const { calcularCotizacion } = await cargarCalculo();
  doc.calculo = calcularCotizacion(doc);
  return doc;
}

const router = express.Router();

router.get('/', async (req, res) => {
  const where = req.query.trabajo_id ? 'WHERE c.trabajo_id = ?' : '';
  const filas = await db.all(
    `SELECT c.id FROM cotizaciones c ${where} ORDER BY c.numero DESC LIMIT 300`,
    ...(req.query.trabajo_id ? [req.query.trabajo_id] : [])
  );
  const docs = await Promise.all(filas.map((f) => cargar(f.id)));
  res.json(
    docs.map((d) => ({
      id: d.id,
      codigo: d.codigo,
      trabajo_id: d.trabajo_id,
      proyecto: d.proyecto,
      trabajo_descripcion: d.trabajo_descripcion,
      contacto: d.contacto,
      fecha: d.fecha,
      estado: d.estado,
      piezas: d.piezas.map((p) => p.nombre),
      costo: d.calculo.costo_fabricacion + d.calculo.costo_viaticos,
      total: d.calculo.total,
      actualizado_en: d.actualizado_en,
      unificada_en: d.unificada_en,
      unificada_en_codigo: d.unificada_en_codigo,
      origenes: d.origenes,
    }))
  );
});

router.get('/:id', async (req, res) => {
  const c = await cargar(req.params.id);
  if (!c) throw new HttpError(404, 'Cotización no encontrada');
  res.json(c);
});

// Nueva cotización para un proyecto (con una pieza inicial).
router.post('/', async (req, res) => {
  const trabajo = await db.get('SELECT * FROM trabajos WHERE id = ?', convertir(req.body?.trabajo_id, 'int'));
  if (!trabajo) throw new HttpError(400, 'Selecciona un proyecto registrado');
  const id = await db.transaction(async (tx) => {
    const numero = await tx.value('SELECT COALESCE(MAX(numero), 0) + 1 FROM cotizaciones');
    const { lastInsertRowid } = await tx.run(
      `INSERT INTO cotizaciones (numero, trabajo_id, fecha, comisiones, creado_por) VALUES (?, ?, ?, ?, ?)`,
      numero,
      trabajo.id,
      hoy(),
      JSON.stringify(COMISIONES_INICIALES),
      req.usuario.id
    );
    await tx.run(
      'INSERT INTO cotizacion_piezas (cotizacion_id, nombre, cantidad, orden) VALUES (?, ?, 1, 0)',
      lastInsertRowid,
      (trabajo.descripcion || 'Pieza 1').split('\n')[0].slice(0, 200)
    );
    return lastInsertRowid;
  });
  res.status(201).json(await cargar(id));
});

// Guarda la cotización completa (datos, parámetros, piezas, materiales y viáticos).
router.put('/:id', async (req, res) => {
  const actual = await db.get('SELECT id FROM cotizaciones WHERE id = ?', req.params.id);
  if (!actual) throw new HttpError(404, 'Cotización no encontrada');
  const b = req.body || {};
  const estado = ESTADOS.includes(b.estado) ? b.estado : 'borrador';
  const comisiones = (Array.isArray(b.comisiones) ? b.comisiones : [])
    .map((c) => {
      const nombre = t(c.nombre, 60) || 'Comisión';
      if (c.tipo !== 'monto') return { nombre, porcentaje: fraccion(c.porcentaje, 0) };
      const monto = n(c.monto, 0);
      if (monto < 0) throw new HttpError(400, 'El monto de una comisión no puede ser negativo');
      return { nombre, tipo: 'monto', monto };
    })
    .slice(0, 10);
  const piezas = (Array.isArray(b.piezas) ? b.piezas : []).slice(0, 100);
  const viaticos = (Array.isArray(b.viaticos) ? b.viaticos : []).slice(0, 200);

  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE cotizaciones SET contacto = ?, fecha = ?, estado = ?, margen = ?, margen_viaticos = ?, comisiones = ?,
         comision_fija_nombre = ?, reparto_viaticos = ?, validez_dias = ?, tiempo_entrega = ?, condiciones = ?, observaciones = ?,
         razon_social = ?, direccion_cliente = ?, referencia = ?, forma_pago = ?, moneda = ?, actualizado_en = datetime('now') WHERE id = ?`,
      t(b.contacto, 200),
      convertir(b.fecha, 'date') || hoy(),
      estado,
      fraccion(b.margen, 0.3),
      fraccion(b.margen_viaticos, 0.1),
      JSON.stringify(comisiones),
      t(b.comision_fija_nombre, 60),
      b.reparto_viaticos === 'manual' ? 'manual' : 'proporcional',
      Math.max(0, Math.round(n(b.validez_dias, 15))),
      t(b.tiempo_entrega, 300),
      t(b.condiciones),
      t(b.observaciones),
      ...CAMPOS_CLIENTE.map(([campo, max]) => t(b[campo], max)),
      monedaValida(b.moneda),
      actual.id
    );
    await tx.run('DELETE FROM cotizacion_lineas WHERE pieza_id IN (SELECT id FROM cotizacion_piezas WHERE cotizacion_id = ?)', actual.id);
    await tx.run('DELETE FROM cotizacion_piezas WHERE cotizacion_id = ?', actual.id);
    await tx.run('DELETE FROM cotizacion_viaticos WHERE cotizacion_id = ?', actual.id);
    for (const [i, p] of piezas.entries()) {
      const { lastInsertRowid: piezaId } = await tx.run(
        'INSERT INTO cotizacion_piezas (cotizacion_id, nombre, descripcion_cliente, cantidad, costos_por, comision_fija, viaticos_pct, orden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        actual.id,
        t(p.nombre, 200) || `Pieza ${i + 1}`,
        t(p.descripcion_cliente, 3000),
        Math.max(0, n(p.cantidad, 1)),
        p.costos_por === 'lote' ? 'lote' : 'unidad',
        0, // la comisión en monto por pieza ya no se usa: las comisiones van en % arriba
        p.viaticos_pct === null || p.viaticos_pct === undefined || p.viaticos_pct === '' ? null : n(p.viaticos_pct, 0),
        i
      );
      for (const [j, l] of (Array.isArray(p.lineas) ? p.lineas : []).slice(0, 300).entries()) {
        const material = t(l.material, 200);
        if (!material && !n(l.costo_unitario)) continue; // fila vacía
        await tx.run(
          `INSERT INTO cotizacion_lineas (pieza_id, material_id, material, descripcion, proveedor, cantidad, costo_unitario, orden)
           VALUES (?, (SELECT id FROM materiales WHERE id = ?), ?, ?, ?, ?, ?, ?)`,
          piezaId,
          convertir(l.material_id, 'int') ?? null,
          material || 'Sin nombre',
          t(l.descripcion, 300),
          t(l.proveedor, 200),
          n(l.cantidad, 0),
          n(l.costo_unitario, 0),
          j
        );
      }
    }
    for (const [i, v] of viaticos.entries()) {
      const concepto = t(v.concepto, 200);
      if (!concepto && !n(v.costo_unitario)) continue;
      await tx.run(
        'INSERT INTO cotizacion_viaticos (cotizacion_id, concepto, descripcion, proveedor, cantidad, costo_unitario, orden) VALUES (?, ?, ?, ?, ?, ?, ?)',
        actual.id,
        concepto || 'Sin nombre',
        t(v.descripcion, 300),
        t(v.proveedor, 200),
        n(v.cantidad, 0),
        n(v.costo_unitario, 0),
        i
      );
    }
  });
  res.json(await cargar(actual.id));
});

// Copia una cotización (nueva versión) con un número nuevo.
// Une en una cotización nueva (aprobada) las piezas aprobadas de varias
// cotizaciones. Las originales quedan marcadas como unificadas en la nueva.
router.post('/unir', async (req, res) => {
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.cotizaciones) ? b.cotizaciones : []).map(Number).filter(Number.isInteger))];
  const piezasElegidas = new Set((Array.isArray(b.piezas) ? b.piezas : []).map(Number));
  if (!ids.length) throw new HttpError(400, 'Selecciona las cotizaciones a unir');
  const fuentes = [];
  for (const id of ids) {
    const c = await cargar(id);
    if (!c) throw new HttpError(404, 'Cotización no encontrada');
    fuentes.push(c);
  }
  const piezas = fuentes.flatMap((c) => c.piezas.filter((p) => piezasElegidas.has(p.id)).map((p) => ({ ...p, origen: c.codigo })));
  if (!piezas.length) throw new HttpError(400, 'Selecciona al menos una pieza aprobada');
  const trabajoId = convertir(b.trabajo_id, 'int') || fuentes[0].trabajo_id;
  if (!(await db.value('SELECT 1 FROM trabajos WHERE id = ?', trabajoId))) throw new HttpError(400, 'Selecciona un proyecto registrado');
  // Margen y comisiones: los de la primera cotización (se avisa si difieren).
  const base = fuentes[0];
  const firma = (c) => JSON.stringify([c.margen, c.margen_viaticos, c.comisiones]);
  const parametrosDistintos = fuentes.some((c) => firma(c) !== firma(base));
  const viaticos = b.incluir_viaticos ? fuentes.flatMap((c) => c.viaticos.map((v) => ({ ...v, origen: c.codigo }))) : [];

  const id = await db.transaction(async (tx) => {
    const numero = await tx.value('SELECT COALESCE(MAX(numero), 0) + 1 FROM cotizaciones');
    const { lastInsertRowid: nuevaId } = await tx.run(
      `INSERT INTO cotizaciones (numero, trabajo_id, contacto, fecha, estado, margen, margen_viaticos, comisiones, comision_fija_nombre,
         reparto_viaticos, validez_dias, tiempo_entrega, condiciones, razon_social, direccion_cliente, referencia, forma_pago, moneda, observaciones, origenes, creado_por)
       VALUES (?, ?, ?, ?, 'aprobada', ?, ?, ?, ?, 'proporcional', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      numero, trabajoId, base.contacto, hoy(), base.margen, base.margen_viaticos, JSON.stringify(base.comisiones), base.comision_fija_nombre,
      base.validez_dias, base.tiempo_entrega, base.condiciones, ...CAMPOS_CLIENTE.map(([campo]) => base[campo]), base.moneda,
      `Cotización consolidada con las piezas aprobadas de ${fuentes.map((c) => c.codigo).join(', ')}.`,
      JSON.stringify(fuentes.map((c) => c.codigo)),
      req.usuario.id
    );
    for (const [i, p] of piezas.entries()) {
      const { lastInsertRowid: piezaId } = await tx.run(
        'INSERT INTO cotizacion_piezas (cotizacion_id, nombre, descripcion_cliente, cantidad, costos_por, comision_fija, viaticos_pct, orden) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)',
        nuevaId, p.nombre, p.descripcion_cliente, p.cantidad, p.costos_por, i
      );
      for (const l of p.lineas) {
        await tx.run(
          'INSERT INTO cotizacion_lineas (pieza_id, material_id, material, descripcion, proveedor, cantidad, costo_unitario, orden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          piezaId, l.material_id, l.material, l.descripcion, l.proveedor, l.cantidad, l.costo_unitario, l.orden
        );
      }
    }
    for (const [i, v] of viaticos.entries()) {
      await tx.run(
        'INSERT INTO cotizacion_viaticos (cotizacion_id, concepto, descripcion, proveedor, cantidad, costo_unitario, orden) VALUES (?, ?, ?, ?, ?, ?, ?)',
        nuevaId, v.concepto, [v.descripcion, `(${v.origen})`].filter(Boolean).join(' '), v.proveedor, v.cantidad, v.costo_unitario, i
      );
    }
    // Las originales: aprobadas si aportaron piezas, rechazadas si no; todas apuntan a la consolidada.
    for (const c of fuentes) {
      const aporto = c.piezas.some((p) => piezasElegidas.has(p.id));
      await tx.run(
        "UPDATE cotizaciones SET unificada_en = ?, estado = ?, actualizado_en = datetime('now') WHERE id = ?",
        nuevaId, aporto ? 'aprobada' : 'rechazada', c.id
      );
    }
    return nuevaId;
  });
  const nueva = await cargar(id);
  res.status(201).json({
    ...nueva,
    aviso: parametrosDistintos
      ? `Las cotizaciones tenían márgenes o comisiones distintos: se usaron los de ${base.codigo}. Revisa los precios antes de enviarla.`
      : null,
  });
});

router.post('/:id/duplicar', async (req, res) => {
  const c = await cargar(req.params.id);
  if (!c) throw new HttpError(404, 'Cotización no encontrada');
  const id = await db.transaction(async (tx) => {
    const numero = await tx.value('SELECT COALESCE(MAX(numero), 0) + 1 FROM cotizaciones');
    const { lastInsertRowid } = await tx.run(
      `INSERT INTO cotizaciones (numero, trabajo_id, contacto, fecha, margen, margen_viaticos, comisiones, comision_fija_nombre,
         reparto_viaticos, validez_dias, tiempo_entrega, condiciones, razon_social, direccion_cliente, referencia, forma_pago, moneda, observaciones, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      numero, c.trabajo_id, c.contacto, hoy(), c.margen, c.margen_viaticos, JSON.stringify(c.comisiones), c.comision_fija_nombre,
      c.reparto_viaticos, c.validez_dias, c.tiempo_entrega, c.condiciones, ...CAMPOS_CLIENTE.map(([campo]) => c[campo]), c.moneda, c.observaciones, req.usuario.id
    );
    for (const p of c.piezas) {
      const { lastInsertRowid: piezaId } = await tx.run(
        'INSERT INTO cotizacion_piezas (cotizacion_id, nombre, descripcion_cliente, cantidad, costos_por, comision_fija, viaticos_pct, orden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        lastInsertRowid, p.nombre, p.descripcion_cliente, p.cantidad, p.costos_por, p.comision_fija, p.viaticos_pct, p.orden
      );
      for (const l of p.lineas) {
        await tx.run(
          'INSERT INTO cotizacion_lineas (pieza_id, material_id, material, descripcion, proveedor, cantidad, costo_unitario, orden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          piezaId, l.material_id, l.material, l.descripcion, l.proveedor, l.cantidad, l.costo_unitario, l.orden
        );
      }
    }
    for (const v of c.viaticos) {
      await tx.run(
        'INSERT INTO cotizacion_viaticos (cotizacion_id, concepto, descripcion, proveedor, cantidad, costo_unitario, orden) VALUES (?, ?, ?, ?, ?, ?, ?)',
        lastInsertRowid, v.concepto, v.descripcion, v.proveedor, v.cantidad, v.costo_unitario, v.orden
      );
    }
    return lastInsertRowid;
  });
  res.status(201).json(await cargar(id));
});

router.delete('/:id', async (req, res) => {
  const c = await db.get('SELECT id FROM cotizaciones WHERE id = ?', req.params.id);
  if (!c) throw new HttpError(404, 'Cotización no encontrada');
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM cotizacion_lineas WHERE pieza_id IN (SELECT id FROM cotizacion_piezas WHERE cotizacion_id = ?)', c.id);
    await tx.run('DELETE FROM cotizacion_piezas WHERE cotizacion_id = ?', c.id);
    await tx.run('DELETE FROM cotizacion_viaticos WHERE cotizacion_id = ?', c.id);
    // Si era una consolidada, las originales vuelven a quedar libres.
    await tx.run('UPDATE cotizaciones SET unificada_en = NULL WHERE unificada_en = ?', c.id);
    await tx.run('DELETE FROM cotizaciones WHERE id = ?', c.id);
  });
  res.json({ ok: true });
});

// ---------- Excel interno (costos, márgenes y comisiones) ----------

router.get('/:id/excel', async (req, res) => {
  const c = await cargar(req.params.id);
  if (!c) throw new HttpError(404, 'Cotización no encontrada');
  const k = c.calculo;
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Spacio Publicidad';
  const h = libro.addWorksheet('Cotización', { views: [{ showGridLines: false }] });
  h.columns = [{ width: 30 }, { width: 22 }, { width: 22 }, { width: 12 }, { width: 18 }, { width: 18 }, { width: 16 }];
  const usd = '"$"#,##0.00';
  const pct = '0.0%';
  const negro = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0A0B' } };
  const gris = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  const titulo = (texto) => {
    const r = h.addRow([texto]);
    h.mergeCells(r.number, 1, r.number, 6);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.getCell(1).fill = negro;
  };
  const encabezado = (cols) => {
    const r = h.addRow(cols);
    r.font = { bold: true };
    r.eachCell((cell) => (cell.fill = gris));
  };
  const etiqueta = (a, valor, fmt = usd, extra) => {
    const r = h.addRow(['', '', a, '', '', valor, extra ?? null]);
    r.getCell(3).font = { bold: true };
    r.getCell(6).numFmt = fmt;
    if (typeof extra === 'number') r.getCell(7).numFmt = usd;
    return r;
  };

  titulo('DATOS DEL PROYECTO Y CLIENTE');
  for (const [a, v1, b, v2] of [
    ['NOMBRE DE PROYECTO', c.trabajo_descripcion?.split('\n')[0] || c.proyecto, 'Fecha:', c.fecha ? new Date(`${c.fecha}T00:00:00Z`) : ''],
    ['EMPRESA / CLIENTE', c.cliente, 'Cotización Nº:', c.codigo],
    ['TIENDA', c.tienda || '', 'Proyecto:', c.proyecto],
    ['CONTACTO', c.contacto || ''],
    ['UBICACIÓN', c.ubicacion || ''],
  ]) {
    const r = h.addRow([a, v1, '', b || '', v2 ?? '']);
    r.getCell(1).font = { bold: true };
    r.getCell(4).font = { bold: true };
    if (v2 instanceof Date) r.getCell(5).numFmt = 'dd/mm/yyyy';
  }
  h.addRow([]);

  c.piezas.forEach((p, i) => {
    const kp = k.piezas[i];
    titulo(`${p.nombre.toUpperCase()} · CANTIDAD A COTIZAR: ${p.cantidad}`);
    encabezado(['MATERIALES / SERVICIO', 'DESCRIPCIÓN', 'PROVEEDOR', 'CANTIDAD', 'COSTO UNITARIO ($)', 'COSTO TOTAL']);
    for (const l of p.lineas) {
      const r = h.addRow([l.material, l.descripcion || '', l.proveedor || '', l.cantidad, l.costo_unitario, l.cantidad * l.costo_unitario]);
      r.getCell(5).numFmt = usd;
      r.getCell(6).numFmt = usd;
    }
    if (kp.costos_por === 'lote') {
      etiqueta(`TOTAL NETO DE COSTOS DE LAS ${p.cantidad} UNIDADES:`, kp.costo_lineas);
      etiqueta(`COSTO UNITARIO (÷ ${p.cantidad}):`, kp.costo_unitario);
    } else etiqueta('TOTAL NETO DE COSTOS (Materiales + MO):', kp.costo_unitario);
    let anterior = kp.costo_unitario;
    kp.pasos.forEach((paso, j) => {
      etiqueta(j === 0 ? 'MARGEN DE GANANCIA' : `COMISIÓN ${paso.nombre.toUpperCase()}`, paso.porcentaje, pct);
      anterior += paso.monto;
      etiqueta(j === 0 ? 'SUBTOTAL BRUTO + GANANCIA' : `PRECIO + ${paso.nombre.toUpperCase()}`, anterior, usd, paso.monto);
    });
    etiqueta(`PRECIO UNITARIO × ${p.cantidad}`, kp.fabricacion).font = { bold: true };
    h.addRow([]);
  });

  if (c.viaticos.length) {
    titulo('TRANSPORTE / VIÁTICOS');
    encabezado(['CONCEPTO', 'DESCRIPCIÓN', 'PROVEEDOR', 'CANTIDAD', 'COSTO UNITARIO ($)', 'COSTO TOTAL']);
    for (const v of c.viaticos) {
      const r = h.addRow([v.concepto, v.descripcion || '', v.proveedor || '', v.cantidad, v.costo_unitario, v.cantidad * v.costo_unitario]);
      r.getCell(5).numFmt = usd;
      r.getCell(6).numFmt = usd;
    }
    etiqueta('TOTAL NETO DE VIÁTICOS:', k.costo_viaticos);
    etiqueta('MARGEN DE GANANCIA', c.margen_viaticos, pct);
    etiqueta('SUBTOTAL VIÁTICOS + GANANCIA', k.viaticos, usd, k.ganancia_viaticos);
    h.addRow([]);
  }

  if (k.comisiones_monto.length) {
    titulo('COMISIONES EN MONTO (incluidas en el precio, no se muestran al cliente)');
    for (const x of k.comisiones_monto) etiqueta(`COMISIÓN ${x.nombre.toUpperCase()}`, x.monto);
    h.addRow([]);
  }

  // Con comisiones en monto se agrega su columna antes del total.
  const conMonto = k.comisiones_monto.length > 0;
  titulo('RESUMEN DE LA COTIZACIÓN');
  encabezado(['PIEZA', 'CANTIDAD', 'FABRICACIÓN', '% VIÁTICOS', 'VIÁTICOS', ...(conMonto ? ['COMISIONES EN MONTO'] : []), 'TOTAL']);
  const columnasUsd = conMonto ? [3, 5, 6, 7] : [3, 5, 6];
  k.piezas.forEach((p) => {
    const r = h.addRow([p.nombre, p.cantidad, p.fabricacion, p.viaticos_pct, p.viaticos, ...(conMonto ? [p.comision_monto] : []), p.total]);
    columnasUsd.forEach((col) => (r.getCell(col).numFmt = usd));
    r.getCell(4).numFmt = pct;
  });
  const tot = h.addRow(['COTIZACIÓN TOTAL', '', k.fabricacion, '', k.viaticos, ...(conMonto ? [k.comision_monto] : []), k.total]);
  tot.font = { bold: true };
  columnasUsd.forEach((col) => (tot.getCell(col).numFmt = usd));
  for (const a of k.avisos) h.addRow([`⚠ ${a}`]).font = { color: { argb: 'FFB45309' } };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${c.codigo}.xlsx"`);
  await libro.xlsx.write(res);
  res.end();
});

// ---------- Documento para el cliente (sin costos internos) ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const dinero = (v) => `$${new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;
const fechaTxt = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

// Guarda los textos editados directamente sobre el documento del cliente.
// Las piezas se identifican por su posición (el editor las reescribe al guardar).
router.patch('/:id/textos-cliente', async (req, res) => {
  const c = await db.get('SELECT id FROM cotizaciones WHERE id = ?', req.params.id);
  if (!c) throw new HttpError(404, 'Cotización no encontrada');
  const b = req.body || {};
  const piezas = await db.column('SELECT id FROM cotizacion_piezas WHERE cotizacion_id = ? ORDER BY orden, id', c.id);
  await db.transaction(async (tx) => {
    for (const [i, p] of (Array.isArray(b.piezas) ? b.piezas : []).entries()) {
      if (!piezas[i]) break;
      const nombre = t(p.nombre, 200);
      await tx.run(
        'UPDATE cotizacion_piezas SET nombre = COALESCE(?, nombre), descripcion_cliente = CASE WHEN ? THEN ? ELSE descripcion_cliente END WHERE id = ?',
        nombre,
        'descripcion_cliente' in p ? 1 : 0,
        t(p.descripcion_cliente, 3000),
        piezas[i]
      );
    }
    for (const [campo, max] of [['tiempo_entrega', 300], ['condiciones', 2000], ...CAMPOS_CLIENTE]) {
      if (campo in b) await tx.run(`UPDATE cotizaciones SET ${campo} = ? WHERE id = ?`, t(b[campo], max), c.id);
    }
    if ('moneda' in b) await tx.run('UPDATE cotizaciones SET moneda = ? WHERE id = ?', monedaValida(b.moneda), c.id);
    await tx.run("UPDATE cotizaciones SET actualizado_en = datetime('now') WHERE id = ?", c.id);
  });
  res.json({ ok: true });
});

router.get('/:id/cliente', async (req, res) => {
  const c = await cargar(req.params.id);
  if (!c) throw new HttpError(404, 'Cotización no encontrada');
  const k = c.calculo;
  // Los textos marcados con data-editable se pueden corregir haciendo clic sobre ellos.
  const editable = (campo, valor, placeholder, etiqueta = 'div', clase = '') =>
    `<${etiqueta} class="editable ${clase} ${valor ? '' : 'vacio'}" data-campo="${campo}" contenteditable="plaintext-only" data-placeholder="${esc(placeholder)}" spellcheck="true">${esc(valor || '')}</${etiqueta}>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"
  );
  const E = config.EMPRESA;
  const numeroPresupuesto = `${String(c.numero).padStart(4, '0')}-${(c.fecha || hoy()).slice(2, 4)}`;
  const monto = (v) => dinero(v).replace('$', '');
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Presupuesto ${esc(numeroPresupuesto)} · ${esc(c.razon_social || c.cliente)}</title>
<style>
  :root { font-family: Poppins, Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; background: #f4f6fa; }
  .hoja { max-width: 820px; margin: 16px auto 24px; background: #fff; padding: 32px; box-shadow: 0 10px 30px -12px rgb(15 23 42 / .3); }
  .marco { width: 100%; border-collapse: collapse; }
  .marco > thead > tr > td, .marco > tfoot > tr > td, .marco > tbody > tr > td { padding: 0; }
  .cabecera { background: #000; color: #fff; display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 26px 30px; }
  .cabecera img { width: 200px; display: block; }
  .cabecera .datos-doc { font-weight: 700; font-size: 13px; line-height: 1.75; min-width: 200px; }
  .cabecera .rif { margin-bottom: 22px; }
  .cliente { display: grid; grid-template-columns: 1fr 200px; gap: 2px 24px; padding: 8px 14px 6px; font-size: 13px; text-transform: uppercase; }
  .cliente .et { font-weight: 800; font-size: 12px; }
  .cliente .val { font-weight: 600; }
  .cliente .full { grid-column: 1 / -1; }
  .items { width: 100%; border-collapse: collapse; font-size: 12px; }
  .items th { background: #000; color: #fff; font-weight: 700; text-align: left; padding: 5px 6px; font-size: 11.5px; text-transform: uppercase; }
  .items td { padding: 22px 6px 22px; vertical-align: bottom; }
  .items td.n { background: #f0f0f0; text-align: center; font-weight: 700; white-space: nowrap; width: 88px; }
  .items td.n.total { width: 110px; }
  .nombre { font-weight: 700; text-decoration: underline; text-transform: uppercase; margin-bottom: 14px; }
  .desc { text-transform: uppercase; font-weight: 600; line-height: 1.75; white-space: pre-line; }
  .items .fila-total td { padding: 16px 6px; font-size: 16px; font-weight: 800; vertical-align: middle; }
  .items .fila-total td.etiqueta { text-align: center; }
  .notas { margin: 18px 0 6px; font-size: 12px; display: grid; gap: 4px; }
  .nota { display: flex; gap: 6px; flex-wrap: wrap; } .nota > b { flex: none; }
  .nota .editable { flex: 1; min-width: 200px; white-space: pre-line; }
  .terminos { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; font-size: 12px; font-weight: 800; text-transform: uppercase; margin: 18px 0 10px; align-items: center; }
  .terminos .moneda { background: #fff200; padding: 3px 4px; display: inline-flex; align-items: center; gap: 4px; }
  .moneda-campo [data-moneda-texto] { display: none; }
  .moneda-campo select { font: inherit; font-weight: 800; text-transform: uppercase; border: 1px solid #b8a800; border-radius: 4px; background: #fffbe0; padding: 1px 2px; cursor: pointer; color: #111; }
  .moneda-campo.sin-elegir .moneda { background: #fff; outline: 2px dashed #dc2626; outline-offset: 1px; }
  .moneda-campo.sin-elegir select { border-color: #dc2626; color: #dc2626; background: #fff; }
  .terminos .pago { display: flex; gap: 5px; }
  .pie { margin: 0 4% 8px; background: #000; color: #fff; display: flex; justify-content: space-between; align-items: center; padding: 8px 18px; font-size: 10.5px; line-height: 1.6; position: relative; }
  .pie::after { content: ""; position: absolute; left: 0; bottom: -5px; width: 75%; height: 5px; background: linear-gradient(90deg, #fcc127 0 33.3%, #e02d8b 33.3% 66.6%, #2197d4 66.6%); }
  .pie svg { width: 13px; height: 13px; vertical-align: -2px; margin-right: 4px; fill: currentColor; }
  .pie .redes svg { width: 20px; height: 20px; margin: 0 0 0 6px; }
  .pie .contacto span { margin-right: 14px; white-space: nowrap; }
  /* Edición sobre el documento */
  .editable { outline: none; border-radius: 4px; transition: background .15s, box-shadow .15s; cursor: text; }
  .editable:hover { background: #f0f7fc; box-shadow: 0 0 0 3px #f0f7fc; }
  .editable:focus { background: #fff; box-shadow: 0 0 0 2px #1679b5; }
  .editable.vacio:empty::before { content: attr(data-placeholder); color: #94a3b8; font-style: italic; text-transform: none; font-weight: 400; }
  .acciones { max-width: 820px; margin: 16px auto 0; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; padding: 0 4px; }
  .acciones .ayuda { font-size: 13.5px; color: #475569; }
  .acciones .estado { font-size: 13px; color: #16a34a; margin-right: 6px; } .acciones .estado.pendiente { color: #b45309; } .acciones .estado.error { color: #dc2626; }
  .acciones button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 7px; border: 1px solid #1679b5; background: #1679b5; color: #fff; cursor: pointer; }
  @page { size: letter; margin: 12mm 12mm 10mm; }
  @media print {
    body { background: #fff; } .hoja { box-shadow: none; margin: 0; max-width: none; padding: 0; } .acciones { display: none; }
    .items tbody tr { break-inside: avoid; }
    .editable { background: none !important; box-shadow: none !important; } .editable:empty, .nota.sin-texto { display: none; }
    .moneda-campo select { display: none; } .moneda-campo [data-moneda-texto] { display: inline; } .moneda-campo.sin-elegir { visibility: hidden; }
  }
  @media (max-width: 640px) {
    .hoja { padding: 10px; } .cabecera { flex-direction: column; align-items: flex-start; padding: 20px; } .cabecera .rif { margin-bottom: 8px; }
    .cliente { grid-template-columns: 1fr; gap: 6px; } .terminos { grid-template-columns: 1fr; }
    .items { font-size: 11px; } .items th, .items td { padding-left: 3px; padding-right: 3px; } .items td.n, .items td.n.total { width: auto; }
    .pie { flex-direction: column; align-items: flex-start; gap: 6px; margin: 0 0 8px; } .pie .contacto span { white-space: normal; display: inline-block; }
    .marco { table-layout: fixed; }
  }
</style></head><body>
<div class="acciones">
  <span class="ayuda">✏️ Haz clic sobre los textos (cliente, dirección, referencia, piezas, forma de pago…) para corregirlos y elige la moneda de pago. Se guardan en la cotización.</span>
  <span><span class="estado" id="estado"></span><button type="button" id="imprimir">Imprimir / Guardar como PDF</button></span>
</div>
<div class="hoja">
<table class="marco">
  <thead><tr><td>
    <div class="cabecera">
      <img src="/img/logo-claro.png" alt="${esc(E.nombre)}">
      <div class="datos-doc">
        <div class="rif">RIF: ${esc(E.rif)}</div>
        <div>PRESUPUESTO NRO. ${esc(numeroPresupuesto)}</div>
        <div>FECHA: ${esc(fechaTxt(c.fecha))}</div>
      </div>
    </div>
    <div class="cliente">
      <div><div class="et">Cliente:</div>${editable('razon_social', c.razon_social || c.cliente, 'Razón social del cliente', 'div', 'val')}</div>
      <div><div class="et">Referencia:</div>${editable('referencia', c.referencia ?? c.tienda, 'Tienda o proyecto', 'div', 'val')}</div>
      <div class="et full">Dirección</div>
      ${editable('direccion_cliente', c.direccion_cliente, 'Dirección fiscal del cliente', 'div', 'val full')}
    </div>
  </td></tr></thead>
  <tfoot><tr><td>
  <div class="terminos">
    <div class="pago">Forma de pago: ${editable('forma_pago', c.forma_pago ?? 'CONTADO', 'Contado', 'span')}</div>
    <div class="moneda-campo ${c.moneda ? '' : 'sin-elegir'}">
      <span class="moneda">Moneda: <span data-moneda-texto>${esc(MONEDAS[c.moneda] || '')}</span>
        <select data-moneda aria-label="Moneda de pago">
          <option value="">Elegir…</option>
          ${Object.entries(MONEDAS).map(([k, v]) => `<option value="${k}" ${c.moneda === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></span>
    </div>
    <div>No incluye IVA</div>
  </div>
  <div class="pie">
    <div class="contacto">
      <div><span><svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>${esc(E.direccion)}</span></div>
      <div><span><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>${esc(E.telefono)}</span>
        <span><svg viewBox="0 0 24 24"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5z"/></svg>${esc(E.correo)}</span></div>
    </div>
    <div class="redes">
      <svg viewBox="0 0 24 24" aria-label="Facebook"><path d="M12 2a10 10 0 0 0-1.6 19.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.3v7A10 10 0 0 0 12 2z"/></svg>
      <svg viewBox="0 0 24 24" aria-label="Instagram"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 13.4a2.8 2.8 0 0 1-2.8 2.8h-3.6a2.8 2.8 0 0 1-2.8-2.8V8.6a2.8 2.8 0 0 1 2.8-2.8h3.6a2.8 2.8 0 0 1 2.8 2.8zM12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zm0 4.1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm2.9-4.9a.6.6 0 1 1 0-1.2.6.6 0 0 1 0 1.2z"/></svg>
    </div>
  </div>
  </td></tr></tfoot>
  <tbody><tr><td>
  <table class="items">
    <thead><tr><th>Descripción de producción</th><th style="text-align:center">Cantidad</th><th style="text-align:center">Costo $. Und</th><th style="text-align:center">Total $</th></tr></thead>
    <tbody>${k.piezas
      .map(
        (p, i) => `<tr data-pieza="${i}"><td>${editable('nombre', p.nombre, 'Nombre de la pieza', 'div', 'nombre')}${editable(
          'descripcion_cliente',
          c.piezas[i].descripcion_cliente,
          'Agregar descripción de lo que incluye este monto…',
          'div',
          'desc'
        )}</td><td class="n">${esc(monto(p.cantidad))}</td><td class="n">${monto(p.precio_unitario_cliente)}</td><td class="n total">${monto(p.total)}</td></tr>`
      )
      .join('')}
      <tr class="fila-total"><td class="etiqueta">TOTAL GENERAL $</td><td></td><td></td><td class="n total">${monto(k.total)}</td></tr></tbody>
  </table>
  <div class="notas">
    <div class="nota ${c.tiempo_entrega ? '' : 'sin-texto'}"><b>Tiempo de entrega:</b> ${editable('tiempo_entrega', c.tiempo_entrega, 'Ej. 15 días hábiles tras la aprobación', 'span')}</div>
    ${c.validez_dias ? `<div><b>Validez de la oferta:</b> ${esc(c.validez_dias)} días</div>` : ''}
    <div class="nota ${c.condiciones ? '' : 'sin-texto'}"><b>Condiciones:</b> ${editable('condiciones', c.condiciones, 'Ej. 60 % de anticipo y 40 % contra entrega', 'span')}</div>
  </div>
  </td></tr></tbody>
</table>
</div>
<script>
(() => {
  const estado = document.getElementById('estado');
  let pendiente = false;
  let guardando = Promise.resolve();
  const texto = (el) => (el ? el.innerText.replace(/ /g, ' ').trim() : '');
  const pintar = (clase, msg) => { estado.className = 'estado ' + clase; estado.textContent = msg; };
  function guardar() {
    if (!pendiente) return guardando;
    pendiente = false;
    pintar('pendiente', 'Guardando…');
    const cuerpo = {
      piezas: [...document.querySelectorAll('[data-pieza]')].map((tr) => ({
        nombre: texto(tr.querySelector('[data-campo=nombre]')),
        descripcion_cliente: texto(tr.querySelector('[data-campo=descripcion_cliente]')),
      })),
    };
    document.querySelectorAll('[data-campo]').forEach((el) => {
      if (!el.closest('[data-pieza]')) cuerpo[el.dataset.campo] = texto(el);
    });
    guardando = guardando
      .then(() => fetch(location.pathname.replace(/\\/cliente$/, '/textos-cliente'), {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
      }))
      .then((r) => { if (!r.ok) throw new Error(); pintar('', '✓ Cambios guardados'); })
      .catch(() => { pendiente = true; pintar('error', 'No se pudo guardar. Revisa tu sesión e inténtalo de nuevo.'); });
    return guardando;
  }
  let temporizador;
  document.querySelectorAll('[data-campo]').forEach((el) => {
    el.addEventListener('input', () => {
      pendiente = true;
      el.classList.toggle('vacio', !texto(el));
      el.closest('.nota')?.classList.toggle('sin-texto', !texto(el));
      pintar('pendiente', 'Cambios sin guardar…');
      clearTimeout(temporizador);
      temporizador = setTimeout(guardar, 1200);
    });
    el.addEventListener('blur', guardar);
    // Enter en los textos de una línea no crea una línea nueva
    if (['nombre', 'razon_social', 'referencia', 'forma_pago'].includes(el.dataset.campo)) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
  });
  // Moneda de pago: se guarda al elegirla.
  const selMoneda = document.querySelector('[data-moneda]');
  selMoneda.addEventListener('change', () => {
    const campoMoneda = selMoneda.closest('.moneda-campo');
    campoMoneda.classList.toggle('sin-elegir', !selMoneda.value);
    campoMoneda.querySelector('[data-moneda-texto]').textContent = selMoneda.value ? selMoneda.selectedOptions[0].textContent : '';
    pintar('pendiente', 'Guardando…');
    guardando = guardando
      .then(() => fetch(location.pathname.replace(/\\/cliente$/, '/textos-cliente'), {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ moneda: selMoneda.value }),
      }))
      .then((r) => { if (!r.ok) throw new Error(); pintar('', '✓ Moneda guardada'); })
      .catch(() => pintar('error', 'No se pudo guardar la moneda. Revisa tu sesión e inténtalo de nuevo.'));
  });
  document.getElementById('imprimir').addEventListener('click', async () => {
    if (!selMoneda.value && !confirm('No elegiste la moneda de pago (Divisas o Bolívares). ¿Imprimir sin indicarla?')) {
      selMoneda.focus();
      return;
    }
    clearTimeout(temporizador);
    document.activeElement?.blur();
    await guardar();
    window.print();
  });
  window.addEventListener('beforeunload', (e) => { if (pendiente) { guardar(); e.preventDefault(); } });
})();
</script></body></html>`);
});

module.exports = { router };
