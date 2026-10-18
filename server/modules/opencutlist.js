// Integración con OpenCutList (SketchUp): importación de listas y diagramas por
// proyecto, versiones con diferencias, despiece imprimible y consolidado de
// materiales a comprar. Usa los proyectos y el catálogo de materiales existentes.
const path = require('path');
const { pathToFileURL } = require('url');
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const almacen = require('../lib/almacen');
const estatus = require('../lib/estatus');
const ocl = require('../lib/opencutlist');
const { nuevoDocumento, terminar, prepararDiagramas, dibujarDespiece, fechaTxt } = require('../lib/documento-taller');
const { HttpError, convertir } = require('../lib/util');
const { requiereAdmin } = require('../auth');

// Mismo lector que usa la pantalla (módulos ES compartidos con el navegador).
let lector;
let dxf;
const raizLib = path.join(__dirname, '..', '..', 'public', 'js', 'lib');
const cargarLector = () => (lector ??= import(pathToFileURL(path.join(raizLib, 'opencutlist.js')).href));
const cargarDxf = () => (dxf ??= import(pathToFileURL(path.join(raizLib, 'dxf.js')).href));

const numeroTrabajo = (n) => `${config.PREFIJO_TRABAJO}${String(n).padStart(4, '0')}`;
const texto = (v, max = 300) => {
  const t = convertir(v, 'text');
  return t ? t.slice(0, max) : null;
};
const numero = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const sinAcentos = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const TIPOS_ARCHIVO = { pdf: 'application/pdf', svg: 'image/svg+xml', dxf: 'application/dxf', csv: 'text/csv' };
const tipoArchivo = (nombre) => path.extname(String(nombre || '')).slice(1).toLowerCase();

async function trabajoExiste(id) {
  const t = await db.get('SELECT id, numero, cliente, tienda, marca, ubicacion, responsable FROM trabajos WHERE id = ?', id);
  if (!t) throw new HttpError(404, 'Trabajo no encontrado');
  return t;
}

const router = express.Router();

// ---------- Consulta ----------

// Versión vigente e historial de un proyecto.
router.get('/trabajo/:trabajoId', async (req, res) => {
  await trabajoExiste(req.params.trabajoId);
  const [vigente, historial] = await Promise.all([
    ocl.cargarVersion(req.params.trabajoId),
    db.all(
      `SELECT i.id, i.version, i.nota, i.diferencias, i.creado_en, u.nombre AS creado_por_nombre,
         (SELECT COUNT(*) FROM ocl_piezas p WHERE p.importacion_id = i.id) AS piezas,
         (SELECT COUNT(*) FROM ocl_materiales m WHERE m.importacion_id = i.id) AS materiales
       FROM ocl_importaciones i LEFT JOIN usuarios u ON u.id = i.creado_por
       WHERE i.trabajo_id = ? ORDER BY i.version DESC`,
      req.params.trabajoId
    ),
  ]);
  const archivos = historial.length
    ? await db.all(
        `SELECT a.* FROM ocl_archivos a JOIN ocl_importaciones i ON i.id = a.importacion_id WHERE i.trabajo_id = ? ORDER BY a.id`,
        req.params.trabajoId
      )
    : [];
  const sinRuta = ({ archivo, ...a }) => a;
  res.json({
    vigente: vigente && { ...vigente, archivos: vigente.archivos.map(sinRuta) },
    historial: historial.map((h) => ({
      ...h,
      diferencias: h.diferencias ? JSON.parse(h.diferencias) : null,
      archivos: archivos.filter((a) => a.importacion_id === h.id).map(sinRuta),
    })),
  });
});

router.get('/trabajo/:trabajoId/version/:id', async (req, res) => {
  const v = await ocl.cargarVersion(req.params.trabajoId, req.params.id);
  if (!v) throw new HttpError(404, 'Versión no encontrada');
  res.json({ ...v, archivos: v.archivos.map(({ archivo, ...a }) => a) });
});

// ---------- Importación ----------

// Cuerpo: { nota, csv: [{ nombre, contenido, mapeo }], ajustes: [{ nombre, cantidad_comercial, unidad_compra, formato, material_id, observaciones }] }
// Los CSV se vuelven a leer aquí con el mismo lector de la vista previa.
router.post('/trabajo/:trabajoId', async (req, res) => {
  const t = await trabajoExiste(req.params.trabajoId);
  const b = req.body || {};
  const csvs = (Array.isArray(b.csv) ? b.csv : []).filter((c) => typeof c?.contenido === 'string').slice(0, 10);
  const conDiagramas = Number(b.diagramas) > 0;
  if (!csvs.length && !conDiagramas) throw new HttpError(400, 'Agrega al menos un archivo de OpenCutList');

  const { analizarCsv, combinar, diferencias } = await cargarLector();
  const anterior = await ocl.cargarVersion(t.id);
  let datos;
  if (csvs.length) {
    const analisis = csvs.map((c) => analizarCsv(c.contenido, c.mapeo && typeof c.mapeo === 'object' ? c.mapeo : null));
    datos = combinar(analisis);
    if (!datos.piezas.length && !datos.materiales.length) throw new HttpError(400, 'No se encontraron piezas ni materiales en los archivos');
  } else {
    // Sólo diagramas nuevos: se conservan las piezas y materiales de la versión anterior.
    datos = { piezas: anterior?.piezas || [], materiales: anterior?.materiales || [] };
  }

  // Ajustes de la vista previa (por posición), y vínculo con el catálogo.
  const catalogo = await db.all('SELECT id, nombre FROM materiales');
  const ajustes = Array.isArray(b.ajustes) ? b.ajustes : [];
  datos.materiales = datos.materiales.map((m, i) => {
    const a = ajustes[i] && sinAcentos(ajustes[i].nombre) === sinAcentos(m.nombre) ? ajustes[i] : {};
    const cantidad = 'cantidad_comercial' in a ? numero(a.cantidad_comercial) : m.cantidad_comercial ?? null;
    // Si se conserva la cantidad de la versión anterior (mismas piezas), se conserva también su origen.
    const previo = anterior?.materiales.find((x) => sinAcentos(x.nombre) === sinAcentos(m.nombre));
    const heredada = previo && cantidad !== null && cantidad === previo.cantidad_comercial && Number(previo.cantidad_piezas || 0) === Number(m.cantidad_piezas || 0);
    const manual = 'cantidad_comercial' in a && cantidad !== null && cantidad !== (m.cantidad_comercial ?? null) && !heredada;
    let materialId = 'material_id' in a ? Number(a.material_id) || null : m.material_id ?? null;
    if (!('material_id' in a) && !materialId) materialId = catalogo.find((c) => sinAcentos(c.nombre) === sinAcentos(m.nombre))?.id ?? null;
    if (materialId && !catalogo.some((c) => c.id === materialId)) materialId = null;
    return {
      ...m,
      cantidad_comercial: cantidad,
      origen_cantidad: cantidad === null ? null : manual ? 'manual' : heredada && m.cantidad_comercial == null ? previo.origen_cantidad : m.origen_cantidad || 'archivo',
      unidad_compra: 'unidad_compra' in a ? texto(a.unidad_compra, 40) : m.unidad_compra,
      formato: 'formato' in a ? texto(a.formato, 80) : m.formato,
      observaciones: 'observaciones' in a ? texto(a.observaciones, 500) : m.observaciones,
      material_id: materialId,
    };
  });

  const cambios = anterior ? diferencias(anterior, datos) : null;
  const version = ((await db.value('SELECT MAX(version) FROM ocl_importaciones WHERE trabajo_id = ?', t.id)) || 0) + 1;

  // 1. Los CSV originales se guardan como historial (si falla, se avisa pero se importa igual).
  const avisos = [];
  const originales = [];
  for (const c of csvs) {
    const nombre = texto(c.nombre, 200) || 'opencutlist.csv';
    try {
      const archivo = await almacen.guardar(`opencutlist/${t.id}/v${version}`, nombre, Buffer.from(c.contenido, 'utf8'), 'text/csv');
      originales.push({ nombre, archivo, tamano: Buffer.byteLength(c.contenido) });
    } catch (err) {
      console.error('OpenCutList: no se pudo guardar el CSV original', nombre, err);
      avisos.push(`No se pudo guardar una copia del archivo original "${nombre}" (${err.message}). Los datos sí se importaron.`);
    }
  }

  // 2. Todo lo demás en un solo envío atómico: la versión, sus materiales, piezas y archivos.
  const ID = '(SELECT id FROM ocl_importaciones WHERE trabajo_id = ? AND version = ?)';
  const sentencias = [
    {
      sql: 'INSERT INTO ocl_importaciones (trabajo_id, version, nota, diferencias, creado_por) VALUES (?, ?, ?, ?, ?)',
      args: [t.id, version, texto(b.nota, 500) || (!csvs.length ? 'Actualización de diagramas de corte' : null), cambios ? JSON.stringify(cambios) : null, req.usuario.id],
    },
  ];
  // Inserta filas de a grupos (una sentencia por grupo).
  const porGrupos = (tabla, columnas, filas) => {
    for (let i = 0; i < filas.length; i += 50) {
      const grupo = filas.slice(i, i + 50);
      sentencias.push({
        sql: `INSERT INTO ${tabla} (importacion_id, ${columnas.join(', ')}) VALUES ${grupo.map(() => `(${ID}, ${columnas.map(() => '?').join(', ')})`).join(', ')}`,
        args: grupo.flatMap((fila) => [t.id, version, ...fila]),
      });
    }
  };
  porGrupos(
    'ocl_materiales',
    ['nombre', 'tipo', 'espesor', 'formato', 'cantidad_comercial', 'origen_cantidad', 'unidad_compra', 'cantidad_piezas', 'total', 'observaciones', 'material_id', 'orden'],
    datos.materiales.slice(0, 300).map((m, i) => [
      texto(m.nombre, 200) || 'Sin material', texto(m.tipo, 80), texto(m.espesor, 40), texto(m.formato, 80), m.cantidad_comercial, m.origen_cantidad,
      texto(m.unidad_compra, 40), numero(m.cantidad_piezas), texto(m.total, 120), texto(m.observaciones, 500), m.material_id, i,
    ])
  );
  porGrupos(
    'ocl_piezas',
    ['numero', 'nombre', 'material', 'cantidad', 'largo', 'ancho', 'espesor', 'observaciones', 'orden'],
    datos.piezas.slice(0, 5000).map((p, i) => [
      texto(p.numero, 40), texto(p.nombre, 200) || 'Pieza', texto(p.material, 200), numero(p.cantidad) ?? 1,
      texto(p.largo, 40), texto(p.ancho, 40), texto(p.espesor, 40), texto(p.observaciones, 500), i,
    ])
  );
  porGrupos(
    'ocl_archivos',
    ['tipo', 'nombre_original', 'archivo', 'mime', 'tamano', 'subido_por'],
    originales.map((o) => ['csv', o.nombre, o.archivo, 'text/csv', o.tamano, req.usuario.id])
  );
  try {
    await db.batch(sentencias);
  } catch (err) {
    await Promise.all(originales.map((o) => almacen.borrar(o.archivo)));
    if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'Otra persona guardó una versión al mismo tiempo. Vuelve a intentarlo.');
    throw err;
  }
  const id = await db.value('SELECT id FROM ocl_importaciones WHERE trabajo_id = ? AND version = ?', t.id, version);
  res.status(201).json({ id, version, diferencias: cambios, avisos });
});

// Diagramas de corte (PDF, SVG, DXF) de una versión.
async function versionEditable(id) {
  const imp = await db.get('SELECT * FROM ocl_importaciones WHERE id = ?', id);
  if (!imp) throw new HttpError(404, 'Importación no encontrada');
  if ((await ocl.vigenteId(imp.trabajo_id)) !== imp.id) throw new HttpError(400, 'Sólo se agregan archivos a la versión vigente');
  return imp;
}
const listarArchivos = (id) => db.all('SELECT id, importacion_id, tipo, nombre_original, mime, tamano, creado_en FROM ocl_archivos WHERE importacion_id = ? ORDER BY id', id);
async function registrarArchivo(importacionId, nombre, archivo, mime, tamano, usuarioId) {
  const tipo = tipoArchivo(nombre);
  if (!['pdf', 'svg', 'dxf', 'csv'].includes(tipo)) {
    await almacen.borrar(archivo);
    throw new HttpError(400, `"${nombre}" no es un archivo de OpenCutList admitido (PDF, SVG, DXF o CSV)`);
  }
  await db.run(
    'INSERT INTO ocl_archivos (importacion_id, tipo, nombre_original, archivo, mime, tamano, subido_por) VALUES (?, ?, ?, ?, ?, ?, ?)',
    importacionId, tipo, String(nombre).slice(0, 255), archivo, TIPOS_ARCHIVO[tipo] || mime || null, Number(tamano) || null, usuarioId
  );
}

router.post('/importacion/:id/archivos', async (req, res) => {
  if (almacen.MODO !== 'local') throw new HttpError(400, 'Las subidas se hacen directamente al almacenamiento');
  const imp = await versionEditable(req.params.id);
  await new Promise((resolve, reject) =>
    almacen.subidaLocal()(req, res, (err) => {
      if (!err) return resolve();
      reject(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? `Cada archivo debe pesar menos de ${config.MAX_ARCHIVO_MB} MB` : err.message));
    })
  );
  for (const f of req.files || []) {
    const nombre = Buffer.from(f.originalname, 'latin1').toString('utf8');
    await registrarArchivo(imp.id, nombre, f.filename, f.mimetype, f.size, req.usuario.id);
  }
  res.status(201).json(await listarArchivos(imp.id));
});

router.post('/importacion/:id/archivos/permiso', async (req, res) => {
  if (almacen.MODO !== 'blob') throw new HttpError(400, 'Almacenamiento Blob no configurado');
  const imp = await versionEditable(req.params.id);
  res.json(await almacen.tokenSubida(req, `opencutlist/${imp.trabajo_id}/${imp.id}`));
});

router.post('/importacion/:id/archivos/registrar', async (req, res) => {
  const imp = await versionEditable(req.params.id);
  const { url, nombre, mime, tamano } = req.body || {};
  if (!almacen.esUrlBlob(url)) throw new HttpError(400, 'Archivo no válido');
  await registrarArchivo(imp.id, nombre, url, mime, tamano, req.usuario.id);
  res.status(201).json(await listarArchivos(imp.id));
});

// Corrección posterior de un material de la versión vigente (p. ej. indicar los
// tableros que resultaron del diagrama de corte, o vincularlo al catálogo).
router.patch('/materiales/:id', async (req, res) => {
  const m = await db.get('SELECT o.*, i.trabajo_id FROM ocl_materiales o JOIN ocl_importaciones i ON i.id = o.importacion_id WHERE o.id = ?', req.params.id);
  if (!m) throw new HttpError(404, 'Material no encontrado');
  if ((await ocl.vigenteId(m.trabajo_id)) !== m.importacion_id) throw new HttpError(400, 'Sólo se corrige la versión vigente');
  const b = req.body || {};
  const cantidad = 'cantidad_comercial' in b ? numero(b.cantidad_comercial) : m.cantidad_comercial;
  let materialId = 'material_id' in b ? Number(b.material_id) || null : m.material_id;
  if (materialId && !(await db.value('SELECT 1 FROM materiales WHERE id = ?', materialId))) materialId = null;
  await db.run(
    'UPDATE ocl_materiales SET cantidad_comercial = ?, origen_cantidad = ?, unidad_compra = ?, formato = ?, observaciones = ?, material_id = ? WHERE id = ?',
    cantidad,
    cantidad === null ? null : 'cantidad_comercial' in b && cantidad !== m.cantidad_comercial ? 'manual' : m.origen_cantidad,
    'unidad_compra' in b ? texto(b.unidad_compra, 40) : m.unidad_compra,
    'formato' in b ? texto(b.formato, 80) : m.formato,
    'observaciones' in b ? texto(b.observaciones, 500) : m.observaciones,
    materialId,
    m.id
  );
  res.json(await db.get('SELECT o.*, c.nombre AS catalogo_nombre FROM ocl_materiales o LEFT JOIN materiales c ON c.id = o.material_id WHERE o.id = ?', m.id));
});

// Eliminar una versión (sólo administradores): la anterior vuelve a ser la vigente.
router.delete('/importacion/:id', requiereAdmin, async (req, res) => {
  const imp = await db.get('SELECT * FROM ocl_importaciones WHERE id = ?', req.params.id);
  if (!imp) throw new HttpError(404, 'Importación no encontrada');
  const archivos = await db.column('SELECT archivo FROM ocl_archivos WHERE importacion_id = ?', imp.id);
  await db.transaction(async (tx) => {
    for (const tabla of ['ocl_archivos', 'ocl_piezas', 'ocl_materiales']) await tx.run(`DELETE FROM ${tabla} WHERE importacion_id = ?`, imp.id);
    await tx.run('DELETE FROM ocl_importaciones WHERE id = ?', imp.id);
  });
  await Promise.all(archivos.map(almacen.borrar));
  res.json({ ok: true });
});

// ---------- Archivos ----------

async function archivo(id) {
  const a = await db.get('SELECT * FROM ocl_archivos WHERE id = ?', id);
  if (!a) throw new HttpError(404, 'Archivo no encontrado');
  return a;
}

router.get('/archivos/:id', async (req, res) => {
  await almacen.enviar(req, res, await archivo(req.params.id));
});

// Vista previa de diagramas SVG y DXF como imagen (se muestra con <img>, sin scripts).
router.get('/archivos/:id/vista', async (req, res) => {
  const a = await archivo(req.params.id);
  if (!['svg', 'dxf'].includes(a.tipo)) throw new HttpError(400, 'Este archivo no tiene vista previa');
  const contenido = (await almacen.leer(a.archivo)).toString('utf8');
  const svg = a.tipo === 'dxf' ? (await cargarDxf()).dxfASvg(contenido) : contenido;
  if (!svg) throw new HttpError(422, 'El diagrama no tiene elementos que se puedan mostrar');
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(svg);
});

// ---------- Despiece imprimible ----------

router.get('/trabajo/:trabajoId/despiece.pdf', async (req, res) => {
  const t = await trabajoExiste(req.params.trabajoId);
  const v = await ocl.cargarVersion(t.id, Number(req.query.version) || null);
  if (!v) throw new HttpError(404, 'Este proyecto todavía no tiene datos de OpenCutList');
  const diagramas = req.query.diagramas === '0' ? { svgs: [], pdfs: [] } : await prepararDiagramas(v.archivos);
  const codigo = numeroTrabajo(t.numero);
  const ctx = nuevoDocumento({
    titulo: 'Despiece',
    codigo,
    datos: [
      ['Cliente', t.cliente],
      ['Tienda', t.tienda],
      ['Versión de OpenCutList', `${v.version} · ${fechaTxt(v.creado_en)}`],
      ['Responsable', t.responsable],
    ],
  });
  dibujarDespiece(ctx, v, diagramas);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.descargar ? 'attachment' : 'inline'}; filename="despiece-${codigo}-v${v.version}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  await terminar(ctx.doc, codigo, res, diagramas.pdfs);
});

// ---------- Consolidado de compras (proyectos activos) ----------

router.get('/consolidado', async (req, res) => {
  const { claveMaterial } = await cargarLector();
  const filas = await db.all(
    `SELECT o.*, c.nombre AS catalogo_nombre, t.id AS trabajo_id, t.numero, t.cliente, t.tienda, i.version
     FROM ocl_materiales o
     JOIN ocl_importaciones i ON i.id = o.importacion_id
     JOIN trabajos t ON t.id = i.trabajo_id
     LEFT JOIN materiales c ON c.id = o.material_id
     WHERE i.version = (SELECT MAX(x.version) FROM ocl_importaciones x WHERE x.trabajo_id = i.trabajo_id)
       AND NOT ${estatus.sqlContiene('t.estatus', config.ESTATUS_CERRADOS)}
     ORDER BY o.nombre COLLATE NOCASE, t.numero`
  );
  // Sólo se suman materiales con las mismas características (nombre, espesor, formato y unidad).
  const grupos = new Map();
  for (const f of filas) {
    const k = claveMaterial(f);
    if (!grupos.has(k)) {
      grupos.set(k, {
        clave: k, nombre: f.nombre, tipo: f.tipo, espesor: f.espesor, formato: f.formato, unidad_compra: f.unidad_compra,
        material_id: f.material_id, catalogo_nombre: f.catalogo_nombre, total: 0, sin_cantidad: 0, cantidad_piezas: 0, proyectos: [],
      });
    }
    const g = grupos.get(k);
    g.material_id ??= f.material_id;
    g.catalogo_nombre ??= f.catalogo_nombre;
    if (f.cantidad_comercial === null) g.sin_cantidad++;
    else g.total += f.cantidad_comercial;
    g.cantidad_piezas += f.cantidad_piezas || 0;
    g.proyectos.push({
      trabajo_id: f.trabajo_id, codigo: numeroTrabajo(f.numero), cliente: f.cliente, tienda: f.tienda, version: f.version,
      cantidad_comercial: f.cantidad_comercial, origen_cantidad: f.origen_cantidad, cantidad_piezas: f.cantidad_piezas, ocl_material_id: f.id,
    });
  }
  res.json([...grupos.values()]);
});

module.exports = { router };
