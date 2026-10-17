const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spacio-test-'));
process.env.ADMIN_PASSWORD = 'clave-de-prueba';
process.env.CARPETA_IMPORTACION = path.join(process.env.DATA_DIR, 'sin-importacion');
const app = require('../server/app');

let servidor;
let base;
let cookie = '';

async function pedir(ruta, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${ruta}`, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body && JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const tipo = res.headers.get('content-type') || '';
  return { status: res.status, datos: tipo.includes('json') ? await res.json() : null, res };
}

before(async () => {
  servidor = app.listen(0);
  base = `http://localhost:${servidor.address().port}/api`;
});
after(() => servidor.close());

test('exige sesión', async () => {
  assert.strictEqual((await pedir('/trabajos')).status, 401);
});

test('rechaza contraseña incorrecta e inicia sesión con Fernando', async () => {
  assert.strictEqual((await pedir('/auth/login', { method: 'POST', body: { usuario: 'fernando', password: 'x' } })).status, 401);
  const r = await pedir('/auth/login', { method: 'POST', body: { usuario: 'Fernando', password: 'clave-de-prueba' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.datos.rol, 'admin');
});

test('crea trabajos con número automático y filtra', async () => {
  const a = await pedir('/trabajos', { method: 'POST', body: { cliente: 'Cliente A', estatus: 'render', fecha_entrega: '2000-01-01' } });
  const b = await pedir('/trabajos', { method: 'POST', body: { cliente: 'Cliente B', marca: 'Marca Z' } });
  assert.strictEqual(a.status, 201);
  assert.strictEqual(b.datos.numero, a.datos.numero + 1);
  assert.strictEqual(b.datos.estatus, 'por_cotizar');

  assert.strictEqual((await pedir('/trabajos', { method: 'POST', body: { cliente: '' } })).status, 400);
  assert.strictEqual((await pedir('/trabajos', { method: 'POST', body: { cliente: 'X', estatus: 'otro' } })).status, 400);

  const busqueda = await pedir('/trabajos?q=marca%20z');
  assert.deepStrictEqual(busqueda.datos.map((t) => t.cliente), ['Cliente B']);
  const atrasados = await pedir('/trabajos?alerta=atrasados');
  assert.deepStrictEqual(atrasados.datos.map((t) => t.cliente), ['Cliente A']);

  const cambio = await pedir(`/trabajos/${a.datos.id}`, { method: 'PATCH', body: { estatus: 'finalizado' } });
  assert.strictEqual(cambio.datos.estatus, 'finalizado');
  assert.strictEqual((await pedir('/trabajos?alerta=atrasados')).datos.length, 0);

  const resumen = await pedir('/trabajos/resumen');
  assert.strictEqual(resumen.datos.porEstatus.finalizado, 1);
  assert.strictEqual(resumen.datos.porEstatus.por_cotizar, 1);
});

test('exporta el control de trabajos a Excel', async () => {
  const { status, res } = await pedir('/trabajos/exportar');
  assert.strictEqual(status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 2).toString(), 'PK');
});

test('materiales registran la fecha al cambiar el precio', async () => {
  const p = await pedir('/proveedores', { method: 'POST', body: { nombre: 'Proveedor 1' } });
  const m = await pedir('/materiales', { method: 'POST', body: { nombre: 'Vinil', precio: '10,5', proveedor_id: p.datos.id } });
  assert.strictEqual(m.datos.precio, 10.5);
  assert.ok(m.datos.fecha_precio);
  assert.strictEqual(m.datos.proveedor_nombre, 'Proveedor 1');
  const lista = await pedir('/materiales?q=proveedor');
  assert.strictEqual(lista.datos.length, 1);
  assert.strictEqual((await pedir(`/materiales/${m.datos.id}`, { method: 'DELETE' })).status, 200);
});

test('el administrador agrega usuarios que deben cambiar su contraseña', async () => {
  const u = await pedir('/usuarios', { method: 'POST', body: { usuario: 'maria', nombre: 'María', password: 'temporal123' } });
  assert.strictEqual(u.status, 201);
  assert.strictEqual(u.datos.debe_cambiar_password, true);
  await pedir('/auth/logout', { method: 'POST' });
  await pedir('/auth/login', { method: 'POST', body: { usuario: 'maria', password: 'temporal123' } });
  assert.strictEqual((await pedir('/trabajos')).status, 403);
  await pedir('/auth/cambiar-password', { method: 'POST', body: { actual: 'temporal123', nueva: 'nueva-clave-1' } });
  assert.strictEqual((await pedir('/trabajos')).status, 200);
  assert.strictEqual((await pedir('/usuarios')).status, 403);
});

test('pendientes de un trabajo: agregar, marcar y quitar', async () => {
  await pedir('/auth/logout', { method: 'POST' });
  await pedir('/auth/login', { method: 'POST', body: { usuario: 'fernando', password: 'clave-de-prueba' } });
  const t = await pedir('/trabajos', { method: 'POST', body: { cliente: 'Daka', pendientes: ['Artes finales', 'Forros'] } });
  assert.strictEqual(t.datos.proximo_pendiente, 'Artes finales');
  assert.strictEqual(t.datos.total_pendientes, 2);
  const ficha = await pedir(`/trabajos/${t.datos.id}`);
  const [primero] = ficha.datos.pendientes;
  await pedir(`/pendientes/${primero.id}`, { method: 'PATCH', body: { hecho: true } });
  let lista = await pedir(`/trabajos/${t.datos.id}/pendientes`, { method: 'POST', body: { texto: 'Presupuesto proveedor' } });
  assert.strictEqual(lista.datos.length, 3);
  assert.strictEqual((await pedir(`/trabajos/${t.datos.id}`)).datos.proximo_pendiente, 'Forros');
  assert.strictEqual((await pedir('/trabajos?q=presupuesto%20prov')).datos.length, 1);
  lista = await pedir(`/pendientes/${primero.id}`, { method: 'DELETE' });
  assert.strictEqual(lista.datos.length, 2);
});

test('instalado no se marca como atrasado', async () => {
  const t = await pedir('/trabajos', { method: 'POST', body: { cliente: 'Ivoo', estatus: 'instalado', fecha_entrega: '2000-01-01' } });
  assert.strictEqual(t.status, 201);
  const atrasados = await pedir('/trabajos?alerta=atrasados');
  assert.ok(!atrasados.datos.some((x) => x.id === t.datos.id));
});

test('lee el Excel de trabajos pendientes de Spacio', async () => {
  const { leerTrabajos } = require('../server/importar');
  const archivo = path.join(__dirname, '..', 'datos-iniciales', 'PENDIENTES TRABAJOS SPACIO PUBLICIDAD.xlsx');
  const trabajos = await leerTrabajos(archivo);
  assert.strictEqual(trabajos.length, 19);
  const oster = trabajos.find((t) => t.descripcion === 'MUEBLE OSTER');
  assert.strictEqual(oster.cliente, 'DAKA');
  assert.strictEqual(oster.estatus, 'produccion');
  assert.deepStrictEqual(oster.pendientes, ['PRODUCCION', 'FORROS']);
  const ivoo = trabajos.find((t) => t.cliente === 'IVOO');
  assert.strictEqual(ivoo.estatus, 'reclamo');
  assert.strictEqual(ivoo.pendientes.length, 4);
});
