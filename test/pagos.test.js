const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spacio-pagos-'));
process.env.ADMIN_PASSWORD = 'clave-de-prueba';
process.env.CARPETA_IMPORTACION = path.join(process.env.DATA_DIR, 'sin-importacion');

// Página falsa del BCV con el mismo formato que la oficial.
let paginaBCV = '';
const servidorBCV = http.createServer((req, res) => res.end(paginaBCV));
const { hoy, sumarDias } = require('../server/lib/util');
const HOY = hoy();
function publicarBCV(tasa, fechaValor) {
  paginaBCV = `<div id="dolar" class="col-sm-12"><div class="field-content"><div class="row recuadrotsmc">
    <div class="col-sm-6 col-xs-6"><span> USD</span></div>
    <div class="col-sm-6 col-xs-6 centrado"><strong> ${tasa} </strong></div></div></div></div>
    <div class="pull-right dinpro center">Fecha Valor: <span class="date-display-single" property="dc:date"
    datatype="xsd:dateTime" content="${fechaValor}T00:00:00-04:00">Lunes, 20 Octubre  2025</span></div>`;
}

let app;
let servidor;
let base;
let cookie = '';
async function pedir(ruta, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${ruta}`, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body && JSON.stringify(body),
  });
  const c = res.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  const tipo = res.headers.get('content-type') || '';
  return { status: res.status, datos: tipo.includes('json') ? await res.json() : null };
}

before(async () => {
  await new Promise((r) => servidorBCV.listen(0, r));
  process.env.BCV_URL = `http://localhost:${servidorBCV.address().port}/`;
  process.env.DOLARAPI_URL = `http://localhost:${servidorBCV.address().port}/no-existe`;
  app = require('../server/app');
  servidor = app.listen(0);
  base = `http://localhost:${servidor.address().port}/api`;
  await pedir('/auth/login', { method: 'POST', body: { usuario: 'fernando', password: 'clave-de-prueba' } });
});
after(() => {
  servidor.close();
  servidorBCV.close();
});

test('lee la tasa y la fecha valor de la página del BCV', () => {
  const { parsearPaginaBCV } = require('../server/lib/bcv');
  publicarBCV('36,59980000', '2025-10-20');
  assert.deepStrictEqual(parsearPaginaBCV(paginaBCV), { tasa: 36.5998, fecha_valor: '2025-10-20' });
  assert.throws(() => parsearPaginaBCV('<html>sin datos</html>'));
});

let asignacion;
test('flujo completo: colaborador, asignación, abonos en USD y Bs, estados', async () => {
  const t = await pedir('/trabajos', { method: 'POST', body: { cliente: 'Whirlpool', descripcion: 'Exhibidor Whirlpool', estatus: 'produccion' } });
  const c = await pedir('/pagos/colaboradores', { method: 'POST', body: { nombre: 'José Pérez', especialidad: 'Carpintería' } });
  assert.strictEqual(c.status, 201);
  // Sólo proyectos aprobados (o en un estatus posterior) admiten colaboradores
  const sinAprobar = await pedir('/trabajos', { method: 'POST', body: { cliente: 'Otro', estatus: 'por_cotizar,render' } });
  const rechazada = await pedir('/pagos/asignaciones', {
    method: 'POST',
    body: { trabajo_id: sinAprobar.datos.id, colaborador_id: c.datos.id, monto_acordado_usd: '100' },
  });
  assert.strictEqual(rechazada.status, 400);
  const a = await pedir('/pagos/asignaciones', {
    method: 'POST',
    body: { trabajo_id: t.datos.id, colaborador_id: c.datos.id, tarea: 'Estructura', fecha_inicio: HOY, monto_acordado_usd: '400' },
  });
  assert.strictEqual(a.status, 201, JSON.stringify(a.datos));
  assert.strictEqual(a.datos.estado, 'pendiente');
  asignacion = a.datos;

  // Tasa automática desde el "BCV" (fecha valor de hoy)
  publicarBCV('200,50000000', HOY);
  const tasa = await pedir(`/pagos/tasa?fecha=${HOY}`);
  assert.strictEqual(tasa.datos.disponible, true);
  assert.strictEqual(tasa.datos.tasa, 200.5);
  assert.strictEqual(tasa.datos.origen, 'automatica');

  const ab1 = await pedir(`/pagos/asignaciones/${a.datos.id}/abonos`, { method: 'POST', body: { fecha: HOY, moneda: 'USD', monto: '250', metodo_pago: 'Zelle' } });
  assert.strictEqual(ab1.status, 201);
  assert.strictEqual(ab1.datos.abono.monto_bs, 50125);
  assert.strictEqual(ab1.datos.abono.tasa_origen, 'automatica');
  assert.strictEqual(ab1.datos.asignacion.saldo_usd, 150);
  assert.strictEqual(ab1.datos.asignacion.estado, 'parcial');

  // Abono superior al saldo: rechazado
  const exceso = await pedir(`/pagos/asignaciones/${a.datos.id}/abonos`, { method: 'POST', body: { fecha: HOY, moneda: 'USD', monto: '200' } });
  assert.strictEqual(exceso.status, 400);

  // Pago en bolívares: 150 USD equivalentes
  const ab2 = await pedir(`/pagos/asignaciones/${a.datos.id}/abonos`, { method: 'POST', body: { fecha: HOY, moneda: 'VES', monto: '30075' } });
  assert.strictEqual(ab2.datos.abono.monto_usd, 150);
  assert.strictEqual(ab2.datos.asignacion.estado, 'completado');

  // La tasa del pago no cambia aunque cambie la tasa del BCV
  await pedir('/pagos/tasas', { method: 'POST', body: { fecha_valor: HOY, tasa: 999, confirmada: true } });
  const detalle = await pedir(`/pagos/asignaciones/${a.datos.id}`);
  assert.deepStrictEqual(detalle.datos.abonos.map((x) => x.tasa_bcv), [200.5, 200.5]);
});

test('anular un pago con un ajuste identificable conserva el historial', async () => {
  const det = await pedir(`/pagos/asignaciones/${asignacion.id}`);
  const primero = det.datos.abonos[0];
  const sinMotivo = await pedir(`/pagos/asignaciones/${asignacion.id}/abonos`, { method: 'POST', body: { tipo: 'ajuste', ajusta_abono_id: primero.id } });
  assert.strictEqual(sinMotivo.status, 400);
  const aj = await pedir(`/pagos/asignaciones/${asignacion.id}/abonos`, {
    method: 'POST',
    body: { tipo: 'ajuste', ajusta_abono_id: primero.id, motivo_ajuste: 'Monto registrado por error' },
  });
  assert.strictEqual(aj.status, 201);
  assert.strictEqual(aj.datos.abono.monto_usd, -250);
  assert.strictEqual(aj.datos.asignacion.saldo_usd, 250);
  assert.strictEqual(aj.datos.asignacion.estado, 'parcial');
  const despues = await pedir(`/pagos/asignaciones/${asignacion.id}`);
  assert.strictEqual(despues.datos.abonos.length, 3); // no se borra nada
  assert.ok(despues.datos.abonos.find((x) => x.id === primero.id).anulado_por);
  assert.ok(despues.datos.historial.some((h) => h.accion === 'pago_anulado'));
  const otraVez = await pedir(`/pagos/asignaciones/${asignacion.id}/abonos`, {
    method: 'POST',
    body: { tipo: 'ajuste', ajusta_abono_id: primero.id, motivo_ajuste: 'repetido' },
  });
  assert.strictEqual(otraVez.status, 400);
});

test('sin tasa verificable se exige tasa manual confirmada', async () => {
  const fecha = sumarDias(HOY, -40);
  const t = await pedir(`/pagos/tasa?fecha=${fecha}`);
  assert.strictEqual(t.datos.disponible, false);
  const auto = await pedir(`/pagos/asignaciones/${asignacion.id}/abonos`, { method: 'POST', body: { fecha, moneda: 'USD', monto: '10' } });
  assert.strictEqual(auto.status, 400);
  const sinConfirmar = await pedir(`/pagos/asignaciones/${asignacion.id}/abonos`, {
    method: 'POST',
    body: { fecha, moneda: 'USD', monto: '10', tasa_modo: 'manual', tasa_manual: '150' },
  });
  assert.strictEqual(sinConfirmar.status, 400);
  const ok = await pedir(`/pagos/asignaciones/${asignacion.id}/abonos`, {
    method: 'POST',
    body: { fecha, moneda: 'USD', monto: '10', tasa_modo: 'manual', tasa_manual: '150', confirmar_tasa: true },
  });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.datos.abono.tasa_origen, 'manual');
  assert.strictEqual(ok.datos.abono.monto_bs, 1500);
});

test('fin de semana usa la última tasa vigente', async () => {
  const { tasaParaFecha, guardarTasa } = require('../server/lib/bcv');
  await guardarTasa({ fecha_valor: '2026-01-09', tasa: 300 }, 'bcv'); // viernes
  await guardarTasa({ fecha_valor: '2026-01-12', tasa: 310 }, 'bcv'); // lunes
  assert.strictEqual((await tasaParaFecha('2026-01-10', { consultar: false })).tasa, 300); // sábado
  assert.strictEqual((await tasaParaFecha('2026-01-11', { consultar: false })).tasa, 300); // domingo
  assert.strictEqual((await tasaParaFecha('2026-01-12', { consultar: false })).tasa, 310);
});

test('resumen, semana y permisos', async () => {
  const r = await pedir('/pagos/resumen');
  assert.strictEqual(r.datos.acordado_usd, 400);
  assert.strictEqual(r.datos.colaboradores_pendientes, 1);
  const s = await pedir(`/pagos/semana?fecha=${HOY}`);
  assert.ok(s.datos.abonos.length >= 3);
  assert.strictEqual(s.datos.filas.length, 1);
  // Un usuario sin rol administrador no ve los pagos
  await pedir('/usuarios', { method: 'POST', body: { usuario: 'ana', nombre: 'Ana', password: 'temporal123' } });
  await pedir('/auth/logout', { method: 'POST' });
  await pedir('/auth/login', { method: 'POST', body: { usuario: 'ana', password: 'temporal123' } });
  await pedir('/auth/cambiar-password', { method: 'POST', body: { actual: 'temporal123', nueva: 'otra-clave-1' } });
  assert.strictEqual((await pedir('/pagos/resumen')).status, 403);
  // Un trabajo con pagos no se puede eliminar
  await pedir('/auth/logout', { method: 'POST' });
  await pedir('/auth/login', { method: 'POST', body: { usuario: 'fernando', password: 'clave-de-prueba' } });
  assert.strictEqual((await pedir(`/trabajos/${asignacion.trabajo_id}`, { method: 'DELETE' })).status, 400);
});
