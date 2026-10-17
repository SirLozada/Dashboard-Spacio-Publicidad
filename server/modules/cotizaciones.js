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
    .map((c) => ({ nombre: t(c.nombre, 60) || 'Comisión', porcentaje: fraccion(c.porcentaje, 0) }))
    .slice(0, 10);
  const piezas = (Array.isArray(b.piezas) ? b.piezas : []).slice(0, 100);
  const viaticos = (Array.isArray(b.viaticos) ? b.viaticos : []).slice(0, 200);

  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE cotizaciones SET contacto = ?, fecha = ?, estado = ?, margen = ?, margen_viaticos = ?, comisiones = ?,
         comision_fija_nombre = ?, reparto_viaticos = ?, validez_dias = ?, tiempo_entrega = ?, condiciones = ?, observaciones = ?,
         actualizado_en = datetime('now') WHERE id = ?`,
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
      actual.id
    );
    await tx.run('DELETE FROM cotizacion_lineas WHERE pieza_id IN (SELECT id FROM cotizacion_piezas WHERE cotizacion_id = ?)', actual.id);
    await tx.run('DELETE FROM cotizacion_piezas WHERE cotizacion_id = ?', actual.id);
    await tx.run('DELETE FROM cotizacion_viaticos WHERE cotizacion_id = ?', actual.id);
    for (const [i, p] of piezas.entries()) {
      const { lastInsertRowid: piezaId } = await tx.run(
        'INSERT INTO cotizacion_piezas (cotizacion_id, nombre, descripcion_cliente, cantidad, comision_fija, viaticos_pct, orden) VALUES (?, ?, ?, ?, ?, ?, ?)',
        actual.id,
        t(p.nombre, 200) || `Pieza ${i + 1}`,
        t(p.descripcion_cliente, 3000),
        Math.max(0, n(p.cantidad, 1)),
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
         reparto_viaticos, validez_dias, tiempo_entrega, condiciones, observaciones, origenes, creado_por)
       VALUES (?, ?, ?, ?, 'aprobada', ?, ?, ?, ?, 'proporcional', ?, ?, ?, ?, ?, ?)`,
      numero, trabajoId, base.contacto, hoy(), base.margen, base.margen_viaticos, JSON.stringify(base.comisiones), base.comision_fija_nombre,
      base.validez_dias, base.tiempo_entrega, base.condiciones,
      `Cotización consolidada con las piezas aprobadas de ${fuentes.map((c) => c.codigo).join(', ')}.`,
      JSON.stringify(fuentes.map((c) => c.codigo)),
      req.usuario.id
    );
    for (const [i, p] of piezas.entries()) {
      const { lastInsertRowid: piezaId } = await tx.run(
        'INSERT INTO cotizacion_piezas (cotizacion_id, nombre, descripcion_cliente, cantidad, comision_fija, viaticos_pct, orden) VALUES (?, ?, ?, ?, 0, NULL, ?)',
        nuevaId, p.nombre, p.descripcion_cliente, p.cantidad, i
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
         reparto_viaticos, validez_dias, tiempo_entrega, condiciones, observaciones, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      numero, c.trabajo_id, c.contacto, hoy(), c.margen, c.margen_viaticos, JSON.stringify(c.comisiones), c.comision_fija_nombre,
      c.reparto_viaticos, c.validez_dias, c.tiempo_entrega, c.condiciones, c.observaciones, req.usuario.id
    );
    for (const p of c.piezas) {
      const { lastInsertRowid: piezaId } = await tx.run(
        'INSERT INTO cotizacion_piezas (cotizacion_id, nombre, descripcion_cliente, cantidad, comision_fija, viaticos_pct, orden) VALUES (?, ?, ?, ?, ?, ?, ?)',
        lastInsertRowid, p.nombre, p.descripcion_cliente, p.cantidad, p.comision_fija, p.viaticos_pct, p.orden
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
    etiqueta('TOTAL NETO DE COSTOS (Materiales + MO):', kp.costo_unitario);
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

  titulo('RESUMEN DE LA COTIZACIÓN');
  encabezado(['PIEZA', 'CANTIDAD', 'FABRICACIÓN', '% VIÁTICOS', 'VIÁTICOS', 'TOTAL']);
  k.piezas.forEach((p) => {
    const r = h.addRow([p.nombre, p.cantidad, p.fabricacion, p.viaticos_pct, p.viaticos, p.total]);
    [3, 5, 6].forEach((col) => (r.getCell(col).numFmt = usd));
    r.getCell(4).numFmt = pct;
  });
  const tot = h.addRow(['COTIZACIÓN TOTAL', '', k.fabricacion, '', k.viaticos, k.total]);
  tot.font = { bold: true };
  [3, 5, 6].forEach((col) => (tot.getCell(col).numFmt = usd));
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

router.get('/:id/cliente', async (req, res) => {
  const c = await cargar(req.params.id);
  if (!c) throw new HttpError(404, 'Cotización no encontrada');
  const k = c.calculo;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.codigo)} · ${esc(c.cliente)}</title>
<style>
  :root { font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #0f172a; }
  body { margin: 0; background: #f4f6fa; }
  .hoja { max-width: 820px; margin: 24px auto; background: #fff; padding: 40px 44px; box-shadow: 0 10px 30px -12px rgb(15 23 42 / .3); position: relative; }
  .hoja::before { content: ""; position: absolute; inset: 0 0 auto; height: 6px; background: linear-gradient(90deg, #fcc127 0 33.3%, #e02d8b 33.3% 66.6%, #2197d4 66.6%); }
  header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; margin-bottom: 28px; }
  header img { width: 210px; }
  .num { text-align: right; } .num h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: .04em; } .num div { color: #475569; font-size: 14px; }
  .datos { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; font-size: 14px; margin-bottom: 24px; padding: 14px 16px; background: #f8fafc; border-radius: 8px; }
  .datos b { color: #475569; font-weight: 600; display: inline-block; min-width: 92px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; background: #0a0a0b; color: #fff; padding: 9px 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td { padding: 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  td .desc { margin-top: 4px; color: #475569; font-size: 13px; line-height: 1.5; white-space: pre-line; }
  .r { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 800; font-size: 16px; border-bottom: 0; border-top: 2px solid #0a0a0b; }
  .notas { margin-top: 24px; font-size: 13.5px; color: #334155; display: grid; gap: 6px; white-space: pre-line; }
  footer { margin-top: 30px; font-size: 12px; color: #64748b; text-align: center; }
  .acciones { max-width: 820px; margin: 16px auto 0; display: flex; justify-content: flex-end; gap: 8px; }
  .acciones button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 7px; border: 1px solid #1679b5; background: #1679b5; color: #fff; cursor: pointer; }
  @media print { body { background: #fff; } .hoja { box-shadow: none; margin: 0; max-width: none; } .acciones { display: none; } }
  @media (max-width: 640px) { .hoja { padding: 28px 18px; } .datos { grid-template-columns: 1fr; } header { flex-direction: column; } .num { text-align: left; } }
</style></head><body>
<div class="acciones"><button onclick="window.print()">Imprimir / Guardar como PDF</button></div>
<div class="hoja">
  <header><img src="/img/logo-oscuro.png" alt="Spacio Publicidad C.A.">
    <div class="num"><h1>COTIZACIÓN</h1><div>${esc(c.codigo)}</div><div>Fecha: ${esc(fechaTxt(c.fecha))}</div></div></header>
  <div class="datos">
    <div><b>Cliente:</b> ${esc(c.cliente)}</div>
    ${c.tienda ? `<div><b>Tienda:</b> ${esc(c.tienda)}</div>` : ''}
    ${c.contacto ? `<div><b>Contacto:</b> ${esc(c.contacto)}</div>` : ''}
    ${c.ubicacion ? `<div><b>Ubicación:</b> ${esc(c.ubicacion)}</div>` : ''}
    <div><b>Proyecto:</b> ${esc(c.trabajo_descripcion?.split('\n')[0] || c.proyecto)}</div>
  </div>
  <table>
    <thead><tr><th>Descripción</th><th class="r">Cantidad</th><th class="r">Precio unitario</th><th class="r">Total</th></tr></thead>
    <tbody>${k.piezas
      .map((p, i) => `<tr><td><strong>${esc(p.nombre)}</strong>${
        c.piezas[i].descripcion_cliente ? `<div class="desc">${esc(c.piezas[i].descripcion_cliente)}</div>` : ''
      }</td><td class="r">${esc(p.cantidad)}</td><td class="r">${dinero(p.precio_unitario_cliente)}</td><td class="r">${dinero(p.total)}</td></tr>`)
      .join('')}</tbody>
    <tfoot><tr><td colspan="3">TOTAL</td><td class="r">${dinero(k.total)}</td></tr></tfoot>
  </table>
  <div class="notas">
    <div>Montos expresados en dólares estadounidenses (USD).</div>
    ${c.tiempo_entrega ? `<div><b>Tiempo de entrega:</b> ${esc(c.tiempo_entrega)}</div>` : ''}
    ${c.validez_dias ? `<div><b>Validez de la oferta:</b> ${esc(c.validez_dias)} días</div>` : ''}
    ${c.condiciones ? `<div><b>Condiciones:</b>\n${esc(c.condiciones)}</div>` : ''}
  </div>
  <footer>Spacio Publicidad C.A.</footer>
</div></body></html>`);
});

module.exports = { router };
