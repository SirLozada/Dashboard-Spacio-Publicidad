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
  assert.match(html.datos, /PRESUPUESTO NRO\. 0001-\d\d/);
  assert.match(html.datos, /RIF: J-31325103-8/);
  assert.match(html.datos, /spaciopublicidad@gmail.com/);
  assert.match(html.datos, /STAR WHITE/);
  assert.doesNotMatch(html.datos, /Fernando|Darwin|Mano de obra|1\.179,50/); // nada interno
  // Descripción del monto escrita a mano para el cliente
  const c = (await pedir('/cotizaciones/1')).datos;
  c.piezas[0].descripcion_cliente = 'Fabricación e instalación de puntera con iluminación LED.';
  await pedir('/cotizaciones/1', { method: 'PUT', body: c });
  assert.match((await pedir('/cotizaciones/1/cliente')).datos, /Fabricación e instalación de puntera con iluminación LED\./);
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

test('unir en una sola cotización las piezas aprobadas de varias cotizaciones', async () => {
  const t = await pedir('/trabajos', { method: 'POST', body: { cliente: 'KITCHENAID', descripcion: 'Varios' } });
  const crear = async (nombres) => {
    const c = await pedir('/cotizaciones', { method: 'POST', body: { trabajo_id: t.datos.id } });
    const r = await pedir(`/cotizaciones/${c.datos.id}`, {
      method: 'PUT',
      body: { ...c.datos, piezas: nombres.map((nombre) => ({ nombre, cantidad: 1, lineas: L([['Material', 1, 100]]) })), viaticos: L([['Camión', 1, 50]]).map((v) => ({ ...v, concepto: 'Camión' })) },
    });
    return r.datos;
  };
  const a = await crear(['Isla', 'Mueble carreta']);
  const b = await crear(['Stand evento']);
  const c = await crear(['Exhibidor']);
  // Aprueban: Isla (de A) y Stand (de B); C no
  const elegidas = [a.piezas[0].id, b.piezas[0].id];
  const u = await pedir('/cotizaciones/unir', { method: 'POST', body: { cotizaciones: [a.id, b.id, c.id], piezas: elegidas, incluir_viaticos: true } });
  assert.strictEqual(u.status, 201);
  assert.strictEqual(u.datos.estado, 'aprobada');
  assert.deepStrictEqual(u.datos.piezas.map((p) => p.nombre), ['Isla', 'Stand evento']);
  assert.deepStrictEqual(u.datos.origenes, [a.codigo, b.codigo, c.codigo]);
  assert.strictEqual(u.datos.viaticos.length, 3);
  assert.strictEqual(u.datos.aviso, null);
  const lista = (await pedir(`/cotizaciones?trabajo_id=${t.datos.id}`)).datos;
  const estado = (id) => lista.find((x) => x.id === id);
  assert.strictEqual(estado(a.id).estado, 'aprobada');
  assert.strictEqual(estado(a.id).unificada_en_codigo, u.datos.codigo);
  assert.strictEqual(estado(c.id).estado, 'rechazada');
  // Sin piezas elegidas no se puede
  assert.strictEqual((await pedir('/cotizaciones/unir', { method: 'POST', body: { cotizaciones: [a.id], piezas: [] } })).status, 400);
  // Al eliminar la consolidada, las originales quedan libres
  await pedir(`/cotizaciones/${u.datos.id}`, { method: 'DELETE' });
  assert.strictEqual((await pedir(`/cotizaciones/${a.id}`)).datos.unificada_en, null);
});

test('los textos del documento del cliente se corrigen sobre el mismo documento', async () => {
  const t = await pedir('/trabajos', { method: 'POST', body: { cliente: 'CLIENTE TEXTOS', descripcion: 'Prueba' } });
  const nueva = await pedir('/cotizaciones', { method: 'POST', body: { trabajo_id: t.datos.id } });
  await pedir(`/cotizaciones/${nueva.datos.id}`, {
    method: 'PUT',
    body: { ...nueva.datos, piezas: [{ nombre: 'Pieza 1', cantidad: 1, lineas: L([['MDF', 1, 10]]) }, { nombre: 'Pieza 2', cantidad: 1, lineas: [] }] },
  });
  const doc = await pedir(`/cotizaciones/${nueva.datos.id}/cliente`);
  assert.match(doc.datos, /contenteditable/);
  // El script del documento debe ser JavaScript válido
  const script = doc.datos.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
  assert.ok(script.includes("replace(/\\/cliente$/"));
  const r = await pedir(`/cotizaciones/${nueva.datos.id}/textos-cliente`, {
    method: 'PATCH',
    body: { piezas: [{ nombre: 'Puntera', descripcion_cliente: 'Fabricación en MDF' }, { nombre: '' }], condiciones: '60 % de anticipo' },
  });
  assert.strictEqual(r.status, 200);
  const c = await pedir(`/cotizaciones/${nueva.datos.id}`);
  assert.strictEqual(c.datos.piezas[0].nombre, 'Puntera');
  assert.strictEqual(c.datos.piezas[0].descripcion_cliente, 'Fabricación en MDF');
  assert.strictEqual(c.datos.piezas[1].nombre, 'Pieza 2');
  assert.strictEqual(c.datos.condiciones, '60 % de anticipo');
});

test('comisión en monto fijo: se suma al total sin aparecer como concepto para el cliente', async () => {
  const t = await pedir('/trabajos', { method: 'POST', body: { cliente: 'CLIENTE MONTO', descripcion: 'Prueba' } });
  const nueva = await pedir('/cotizaciones', { method: 'POST', body: { trabajo_id: t.datos.id } });
  const base = await pedir(`/cotizaciones/${nueva.datos.id}`, {
    method: 'PUT',
    body: { ...nueva.datos, piezas: [{ nombre: 'Pieza 1', cantidad: 1, lineas: L([['MDF', 1, 300]]) }, { nombre: 'Pieza 2', cantidad: 2, lineas: L([['MDF', 1, 100]]) }] },
  });
  const x = base.datos.calculo.total;
  const con = await pedir(`/cotizaciones/${nueva.datos.id}`, {
    method: 'PUT',
    body: { ...base.datos, comisiones: [...base.datos.comisiones, { nombre: 'Francisco', tipo: 'monto', monto: 1000 }] },
  });
  const k = con.datos.calculo;
  assert.strictEqual(k.total.toFixed(2), (x + 1000).toFixed(2));
  assert.strictEqual((k.piezas[0].comision_monto + k.piezas[1].comision_monto).toFixed(2), '1000.00');
  assert.deepStrictEqual(con.datos.comisiones.at(-1), { nombre: 'Francisco', tipo: 'monto', monto: 1000 });
  const doc = await pedir(`/cotizaciones/${nueva.datos.id}/cliente`);
  assert.doesNotMatch(doc.datos, /Francisco/);
  const excel = await pedir(`/cotizaciones/${nueva.datos.id}/excel`);
  assert.strictEqual(excel.status, 200);
});
