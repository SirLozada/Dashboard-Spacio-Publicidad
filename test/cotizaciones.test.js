const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spacio-cot-'));
process.env.ADMIN_PASSWORD = 'clave-de-prueba';
process.env.CARPETA_IMPORTACION = path.join(process.env.DATA_DIR, 'sin-importacion');
const app = require('../server/app');

let servidor;
let base;
let cookie = '';
async function pedir(ruta, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${ruta}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
  const c = res.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  const tipo = res.headers.get('content-type') || '';
  return { status: res.status, tipo, datos: tipo.includes('json') ? await res.json() : await res.text() };
}
before(async () => {
  servidor = app.listen(0);
  base = `http://localhost:${servidor.address().port}/api`;
  await pedir('/auth/login', { method: 'POST', body: { usuario: 'fernando', password: 'clave-de-prueba' } });
});
after(() => servidor.close());

// Datos del Excel "prueba.xlsx" de Fernando
const L = (a) => a.map(([material, cantidad, costo_unitario]) => ({ material, cantidad, costo_unitario }));
const AA = L([['MDF 15', 2, 45], ['MDF 9', 2, 30], ['Corte', 4, 10], ['Formica', 1, 35], ['Formica', 4, 35], ['Canto', 5, 0.7], ['Pega', 0.35, 100], ['Pega cola', 0.5, 25], ['Ferretería', 1, 100], ['Eléctrico', 1, 40], ['PVC', 1, 15], ['Pintura', 0.5, 25], ['Thinner', 1, 10], ['Interruptor', 1, 7], ['Cable', 0.3, 50], ['Cable STP', 5, 3], ['LED', 2, 25], ['Acrílico', 1, 20], ['CNC', 2, 15], ['CNC logo', 2, 35], ['Ángulo', 1, 14], ['Mano de obra', 1, 300], ['Envoplast', 1, 15], ['Extras', 1, 50]]);
const VIATICOS = L([['Camión', 2, 350], ['Cheyenne', 1, 200], ['Desayuno', 24, 15], ['Almuerzo', 24, 15], ['Cena', 18, 15], ['Hotel', 3, 90], ['Autobús', 4, 20], ['Gastos', 4, 50]]).map((v) => ({ ...v, concepto: v.material }));

test('reproduce los cálculos del Excel de costeo', async () => {
  const t = await pedir('/trabajos', { method: 'POST', body: { cliente: 'STAR WHITE', tienda: 'SOY TECHNO', descripcion: 'Punteras' } });
  const nueva = await pedir('/cotizaciones', { method: 'POST', body: { trabajo_id: t.datos.id } });
  assert.strictEqual(nueva.status, 201);
  assert.strictEqual(nueva.datos.codigo, 'COT-0001');
  assert.deepStrictEqual(nueva.datos.comisiones.map((c) => c.nombre), ['Fernando', 'Darwin']);
  const guardada = await pedir(`/cotizaciones/${nueva.datos.id}`, {
    method: 'PUT',
    body: {
      ...nueva.datos,
      contacto: 'Francisco Pinto',
      piezas: [{ nombre: 'Puntera aire acondicionado', cantidad: 1, lineas: AA }],
      viaticos: VIATICOS,
    },
  });
  const k = guardada.datos.calculo;
  assert.strictEqual(k.piezas[0].costo_unitario.toFixed(2), '1179.50');
  assert.strictEqual(k.piezas[0].precio_unitario.toFixed(2), '2217.11');
  assert.strictEqual(k.viaticos.toFixed(2), '2711.11');
  assert.strictEqual(k.total.toFixed(2), (2217.105263 + 2711.111111).toFixed(2));
  // Francisco como una comisión más en % (se agrega arriba, en cadena)
  const conFrancisco = await pedir(`/cotizaciones/${nueva.datos.id}`, {
    method: 'PUT',
    body: { ...guardada.datos, comisiones: [...guardada.datos.comisiones, { nombre: 'Francisco', porcentaje: 0.1 }] },
  });
  assert.strictEqual(conFrancisco.datos.calculo.piezas[0].precio_unitario.toFixed(2), (2217.105263 / 0.9).toFixed(2));
  assert.deepStrictEqual(conFrancisco.datos.calculo.pasos.map((p) => p.nombre), ['Ganancia', 'Fernando', 'Darwin', 'Francisco']);

  // La cantidad a cotizar multiplica la fabricación
  const dos = await pedir(`/cotizaciones/${nueva.datos.id}`, { method: 'PUT', body: { ...guardada.datos, piezas: [{ ...guardada.datos.piezas[0], cantidad: 2 }] } });
  assert.strictEqual(dos.datos.calculo.piezas[0].fabricacion.toFixed(2), '4434.21');

  // Margen de 100 % no es válido
  assert.strictEqual((await pedir(`/cotizaciones/${nueva.datos.id}`, { method: 'PUT', body: { ...guardada.datos, margen: 1 } })).status, 400);
});

test('exporta Excel interno y documento para el cliente sin costos', async () => {
  const xls = await pedir('/cotizaciones/1/excel');
  assert.strictEqual(xls.status, 200);
  assert.match(xls.tipo, /spreadsheetml/);
  const html = await pedir('/cotizaciones/1/cliente');
  assert.strictEqual(html.status, 200);
  assert.match(html.datos, /COT-0001/);
  assert.match(html.datos, /STAR WHITE/);
  assert.doesNotMatch(html.datos, /Fernando|Darwin|Mano de obra|1\.179,50/); // nada interno
});

test('duplicar, listar y eliminar; el trabajo no se borra con cotizaciones', async () => {
  const copia = await pedir('/cotizaciones/1/duplicar', { method: 'POST' });
  assert.strictEqual(copia.datos.codigo, 'COT-0002');
  assert.strictEqual(copia.datos.piezas[0].lineas.length, AA.length);
  const lista = await pedir(`/cotizaciones?trabajo_id=${copia.datos.trabajo_id}`);
  assert.strictEqual(lista.datos.length, 2);
  assert.strictEqual((await pedir(`/trabajos/${copia.datos.trabajo_id}`, { method: 'DELETE' })).status, 400);
  assert.strictEqual((await pedir(`/cotizaciones/${copia.datos.id}`, { method: 'DELETE' })).status, 200);
});
