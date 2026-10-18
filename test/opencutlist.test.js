const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spacio-ocl-'));
process.env.ADMIN_PASSWORD = 'clave-de-prueba';
process.env.CARPETA_IMPORTACION = path.join(process.env.DATA_DIR, 'sin-importacion');
const app = require('../server/app');

let servidor;
let base;
function cliente() {
  let cookie = '';
  return async (ruta, { method = 'GET', body, form } = {}) => {
    const res = await fetch(`${base}${ruta}`, {
      method,
      headers: { cookie, ...(form ? {} : { 'Content-Type': 'application/json' }) },
      body: form || (body && JSON.stringify(body)),
    });
    const c = res.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    const tipo = res.headers.get('content-type') || '';
    return { status: res.status, tipo, datos: tipo.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}
const fernando = cliente();
const ana = cliente();
let trabajo;
let otro;

// Exportaciones de OpenCutList (lista de piezas y resumen), en inglés y en español.
const PIEZAS = `Number,Name,Count,Cutting length,Cutting width,Cutting thickness,Bbox length,Bbox width,Bbox thickness,Material type,Material,Description,Edge ymin,Edge ymax
A,Lateral,2,1802 mm,603 mm,18 mm,1800 mm,600 mm,18 mm,Sheet good,MDF Blanco 18,,PVC 1mm,
B,Repisa,4,762 mm,582 mm,18 mm,760 mm,580 mm,18 mm,Sheet good,MDF Blanco 18,Con perforaciones,PVC 1mm,PVC 1mm
C,Fondo,1,1800 mm,800 mm,3 mm,1800 mm,800 mm,3 mm,Sheet good,Fondo HDF 3,,,`;
const RESUMEN = `Material type;Material;Std dimension;Parts count;Cutting area;Sheets
Sheet good;MDF Blanco 18;18 mm;6;3,92 m²;2
Sheet good;Fondo HDF 3;3 mm;1;1,44 m²;`;
const PIEZAS_V2 = `N.º;Nombre;Cant.;Largo;Ancho;Espesor;Tipo de material;Material
A;Lateral;2;1800 mm;600 mm;18 mm;Tablero;MDF Blanco 18
B;Repisa;5;760 mm;580 mm;18 mm;Tablero;MDF Blanco 18`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2440 1830"><rect x="0" y="0" width="2440" height="1830" fill="none" stroke="#000"/><rect x="10" y="10" width="1800" height="600" fill="#ddd" stroke="#000"/></svg>';
const DXF = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '90', '4', '70', '1', '10', '0', '20', '0', '10', '2440', '20', '0', '10', '2440', '20', '1830', '10', '0', '20', '1830', '0', 'TEXT', '10', '20', '20', '20', '40', '50', '1', 'Lateral', '0', 'ENDSEC', '0', 'EOF'].join('\n');

before(async () => {
  servidor = app.listen(0);
  base = `http://localhost:${servidor.address().port}/api`;
  await fernando('/auth/login', { method: 'POST', body: { usuario: 'fernando', password: 'clave-de-prueba' } });
  await fernando('/usuarios', { method: 'POST', body: { usuario: 'ana', nombre: 'Ana', password: 'temporal123' } });
  await ana('/auth/login', { method: 'POST', body: { usuario: 'ana', password: 'temporal123' } });
  await ana('/auth/cambiar-password', { method: 'POST', body: { actual: 'temporal123', nueva: 'nueva-clave-1' } });
  trabajo = (await fernando('/trabajos', { method: 'POST', body: { cliente: 'STAR WHITE', estatus: 'aprobado' } })).datos;
  otro = (await fernando('/trabajos', { method: 'POST', body: { cliente: 'DAKA', estatus: 'produccion' } })).datos;
  await fernando('/materiales', { method: 'POST', body: { nombre: 'MDF Blanco 18', unidad: 'Lámina', precio: 45 } });
});
after(() => servidor.close());

test('importar lista de piezas y resumen: materiales a comprar y despiece, vinculados al catálogo', async () => {
  const r = await ana(`/opencutlist/trabajo/${trabajo.id}`, {
    method: 'POST',
    body: { nota: 'Primera versión', csv: [{ nombre: 'piezas.csv', contenido: PIEZAS }, { nombre: 'resumen.csv', contenido: RESUMEN }] },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.datos));
  const v = (await ana(`/opencutlist/trabajo/${trabajo.id}`)).datos.vigente;
  assert.strictEqual(v.version, 1);
  assert.strictEqual(v.piezas.length, 3);
  assert.deepStrictEqual(
    v.piezas.map((p) => [p.nombre, p.cantidad, p.largo, p.ancho, p.espesor]),
    [['Lateral', 2, '1800 mm', '600 mm', '18 mm'], ['Repisa', 4, '760 mm', '580 mm', '18 mm'], ['Fondo', 1, '1800 mm', '800 mm', '3 mm']]
  );
  assert.match(v.piezas[1].observaciones, /Con perforaciones · Cantos: Edge ymin PVC 1mm, Edge ymax PVC 1mm/);
  const mdf = v.materiales.find((m) => m.nombre === 'MDF Blanco 18');
  // Tableros: el resultado de OpenCutList (2), no la cantidad de piezas (6).
  assert.strictEqual(mdf.cantidad_comercial, 2);
  assert.strictEqual(mdf.cantidad_piezas, 6);
  assert.strictEqual(mdf.unidad_compra, 'Tablero');
  assert.strictEqual(mdf.catalogo_nombre, 'MDF Blanco 18');
  // Sin dato en el archivo: no se inventa la cantidad.
  assert.strictEqual(v.materiales.find((m) => m.nombre === 'Fondo HDF 3').cantidad_comercial, null);
  // Los CSV originales quedan guardados.
  assert.deepStrictEqual(v.archivos.map((a) => a.tipo), ['csv', 'csv']);
});

test('diagramas de corte: SVG y DXF con vista previa, PDF para descargar', async () => {
  const { vigente } = (await ana(`/opencutlist/trabajo/${trabajo.id}`)).datos;
  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 400]);
  const form = new FormData();
  form.append('archivos', new Blob([SVG], { type: 'image/svg+xml' }), 'tablero-1.svg');
  form.append('archivos', new Blob([DXF], { type: 'application/dxf' }), 'tablero-2.dxf');
  form.append('archivos', new Blob([await pdf.save()], { type: 'application/pdf' }), 'diagramas.pdf');
  const r = await ana(`/opencutlist/importacion/${vigente.id}/archivos`, { method: 'POST', form });
  assert.strictEqual(r.status, 201, JSON.stringify(r.datos));
  const svg = r.datos.find((a) => a.tipo === 'svg');
  const dxf = r.datos.find((a) => a.tipo === 'dxf');
  const vistaDxf = await ana(`/opencutlist/archivos/${dxf.id}/vista`);
  assert.match(vistaDxf.tipo, /image\/svg\+xml/);
  assert.match(vistaDxf.datos.toString(), /<polygon points=.*<text[^>]*>Lateral<\/text>/s);
  assert.strictEqual((await ana(`/opencutlist/archivos/${svg.id}/vista`)).status, 200);
  // Otros formatos se rechazan.
  const malo = new FormData();
  malo.append('archivos', new Blob(['x'], { type: 'application/zip' }), 'modelo.skp');
  assert.strictEqual((await ana(`/opencutlist/importacion/${vigente.id}/archivos`, { method: 'POST', form: malo })).status, 400);
});

test('imprimir despiece y orden de producción con despiece: PDF sin montos, con los diagramas', async () => {
  const { PDFDocument } = require('pdf-lib');
  const despiece = await ana(`/opencutlist/trabajo/${trabajo.id}/despiece.pdf`);
  assert.strictEqual(despiece.status, 200);
  assert.strictEqual(despiece.datos.subarray(0, 5).toString(), '%PDF-');
  const paginas = (await PDFDocument.load(despiece.datos)).getPageCount();
  assert.ok(paginas >= 2, `páginas: ${paginas}`); // incluye la página del PDF de diagramas
  const orden = await ana(`/trabajos/${trabajo.id}/orden-produccion.pdf?despiece=1&diagramas=1`);
  assert.strictEqual(orden.status, 200);
  assert.ok((await PDFDocument.load(orden.datos)).getPageCount() >= 2);
  const datosOrden = (await ana(`/trabajos/${trabajo.id}/orden-produccion`)).datos;
  assert.deepStrictEqual(datosOrden.despiece, { version: 1, piezas: 3, materiales: 2, diagramas: 3 });
});

test('nueva versión: muestra diferencias, no duplica y conserva el historial', async () => {
  const r = await ana(`/opencutlist/trabajo/${trabajo.id}`, { method: 'POST', body: { csv: [{ nombre: 'piezas-v2.csv', contenido: PIEZAS_V2 }] } });
  assert.strictEqual(r.status, 201);
  const d = r.datos.diferencias;
  assert.deepStrictEqual(d.piezas.modificadas, ['Repisa: cantidad 4 → 5']);
  assert.deepStrictEqual(d.piezas.eliminadas, ['Fondo (1)']);
  const { vigente, historial } = (await ana(`/opencutlist/trabajo/${trabajo.id}`)).datos;
  assert.strictEqual(vigente.version, 2);
  assert.strictEqual(vigente.piezas.length, 2);
  assert.deepStrictEqual(historial.map((h) => h.version), [2, 1]);
  assert.strictEqual(historial[1].archivos.length, 5); // archivos de la versión 1 conservados
  const v1 = (await ana(`/opencutlist/trabajo/${trabajo.id}/version/${historial[1].id}`)).datos;
  assert.strictEqual(v1.piezas.length, 3);
  // Los diagramas sólo se agregan a la versión vigente.
  const form = new FormData();
  form.append('archivos', new Blob([SVG]), 'viejo.svg');
  assert.strictEqual((await ana(`/opencutlist/importacion/${historial[1].id}/archivos`, { method: 'POST', form })).status, 400);
});

test('cantidad indicada a mano (resultado del diagrama de corte) y consolidado de compras', async () => {
  const { vigente } = (await ana(`/opencutlist/trabajo/${trabajo.id}`)).datos;
  const mdf = vigente.materiales.find((m) => m.nombre === 'MDF Blanco 18');
  assert.strictEqual(mdf.cantidad_comercial, null); // la versión 2 no trae resumen
  const r = await ana(`/opencutlist/materiales/${mdf.id}`, { method: 'PATCH', body: { cantidad_comercial: 3 } });
  assert.strictEqual(r.datos.cantidad_comercial, 3);
  assert.strictEqual(r.datos.origen_cantidad, 'manual');
  // Otro proyecto activo con el mismo material, y uno con espesor distinto.
  await ana(`/opencutlist/trabajo/${otro.id}`, {
    method: 'POST',
    body: {
      csv: [{ nombre: 'r.csv', contenido: 'Material;Std dimension;Sheets\nMDF Blanco 18;18 mm;4\nMDF Blanco 15;15 mm;1' }],
      ajustes: [{ nombre: 'MDF Blanco 18', unidad_compra: 'Tablero' }, { nombre: 'MDF Blanco 15', unidad_compra: 'Tablero' }],
    },
  });
  const consolidado = (await ana('/opencutlist/consolidado')).datos;
  const g18 = consolidado.find((g) => g.nombre === 'MDF Blanco 18');
  assert.strictEqual(g18.total, 7);
  assert.deepStrictEqual(g18.proyectos.map((p) => p.cantidad_comercial).sort(), [3, 4]);
  assert.ok(consolidado.find((g) => g.nombre === 'MDF Blanco 15')); // no se suma con el de 18 mm
  // Proyectos cerrados no cuentan.
  await fernando(`/trabajos/${otro.id}`, { method: 'PATCH', body: { estatus: 'finalizado' } });
  assert.strictEqual((await ana('/opencutlist/consolidado')).datos.find((g) => g.nombre === 'MDF Blanco 18').total, 3);
});

test('eliminar una versión: sólo administradores; la anterior vuelve a ser la vigente', async () => {
  const { historial } = (await ana(`/opencutlist/trabajo/${trabajo.id}`)).datos;
  assert.strictEqual((await ana(`/opencutlist/importacion/${historial[0].id}`, { method: 'DELETE' })).status, 403);
  assert.strictEqual((await fernando(`/opencutlist/importacion/${historial[0].id}`, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await ana(`/opencutlist/trabajo/${trabajo.id}`)).datos.vigente.version, 1);
});
