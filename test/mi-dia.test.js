const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spacio-midia-'));
process.env.ADMIN_PASSWORD = 'clave-de-prueba';
process.env.CARPETA_IMPORTACION = path.join(process.env.DATA_DIR, 'sin-importacion');
const app = require('../server/app');
const { hoy, sumarDias } = require('../server/lib/util');

let servidor;
let base;
function cliente() {
  let cookie = '';
  return async (ruta, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${ruta}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const c = res.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    const tipo = res.headers.get('content-type') || '';
    return { status: res.status, tipo, datos: tipo.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}
const fernando = cliente();
const ana = cliente();
let idAna;
const h = hoy();

before(async () => {
  servidor = app.listen(0);
  base = `http://localhost:${servidor.address().port}/api`;
  await fernando('/auth/login', { method: 'POST', body: { usuario: 'fernando', password: 'clave-de-prueba' } });
  idAna = (await fernando('/usuarios', { method: 'POST', body: { usuario: 'ana', nombre: 'Ana Gómez', password: 'temporal123' } })).datos.id;
  await ana('/auth/login', { method: 'POST', body: { usuario: 'ana', password: 'temporal123' } });
  await ana('/auth/cambiar-password', { method: 'POST', body: { actual: 'temporal123', nueva: 'nueva-clave-1' } });
});
after(() => servidor.close());

test('agenda: compromisos calculados desde las fechas de los trabajos', async () => {
  await fernando('/trabajos', { method: 'POST', body: { cliente: 'DAKA', estatus: 'por_cotizar', fecha_cotizacion: sumarDias(h, 1) } });
  await fernando('/trabajos', { method: 'POST', body: { cliente: 'KitchenAid', estatus: 'produccion', fecha_entrega: sumarDias(h, -2), responsable: 'Ana' } });
  await fernando('/trabajos', { method: 'POST', body: { cliente: 'Cerrado', estatus: 'finalizado', fecha_entrega: sumarDias(h, 2) } });
  const r = (await fernando(`/trabajos/agenda?hasta=${sumarDias(h, 30)}`)).datos;
  const tipos = r.eventos.map((e) => `${e.trabajo.cliente}:${e.tipo}:${e.vencido}`);
  assert.deepStrictEqual(tipos.sort(), ['DAKA:cotizacion:false', 'KitchenAid:produccion:true']);
  // Filtro por cliente
  const filtrada = (await fernando(`/trabajos/agenda?cliente=DAKA&hasta=${sumarDias(h, 30)}`)).datos.eventos;
  assert.strictEqual(filtrada.length, 1);
});

let tarea;
test('tarea asignada a otro usuario: aparece en su «Mi día» y le llega a la campanita', async () => {
  const r = await fernando('/mi-dia/tareas', { method: 'POST', body: { titulo: 'Solicitar medidas al cliente', fecha: h, prioridad: 'alta', asignado_a: idAna } });
  assert.strictEqual(r.status, 201);
  tarea = r.datos;
  const n = (await ana('/notificaciones')).datos.items;
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].tarea_id, tarea.id);
  assert.match(n[0].titulo, /Fernando te asignó una tarea/);
  const dia = (await ana('/mi-dia')).datos;
  assert.ok(dia.secciones.hoy.some((i) => i.clave === `tarea:${tarea.id}`));
  // Compromiso automático: Ana es responsable del trabajo atrasado de KitchenAid.
  assert.ok(dia.secciones.atrasados.some((i) => i.origen === 'auto' && /KitchenAid/.test(i.titulo)));
  // Fernando no la ve en sus secciones, pero sí puede consultarla (la creó).
  assert.strictEqual((await fernando(`/mi-dia/tareas/${tarea.id}`)).status, 200);
});

test('permisos: sólo quien la creó (o un admin) reasigna y elimina; nadie más la ve', async () => {
  const luis = cliente();
  await fernando('/usuarios', { method: 'POST', body: { usuario: 'luis', nombre: 'Luis Pérez', password: 'temporal123' } });
  await luis('/auth/login', { method: 'POST', body: { usuario: 'luis', password: 'temporal123' } });
  await luis('/auth/cambiar-password', { method: 'POST', body: { actual: 'temporal123', nueva: 'nueva-clave-1' } });
  assert.strictEqual((await luis(`/mi-dia/tareas/${tarea.id}`)).status, 404);
  assert.strictEqual((await ana(`/mi-dia/tareas/${tarea.id}`, { method: 'PATCH', body: { asignado_a: 1 } })).status, 403);
  assert.strictEqual((await ana(`/mi-dia/tareas/${tarea.id}`, { method: 'DELETE' })).status, 403);
  // Ana sí puede cambiar fecha, prioridad, observaciones y completarla.
  const c = await ana(`/mi-dia/tareas/${tarea.id}`, { method: 'PATCH', body: { observaciones: 'Llamé, envían medidas mañana', estado: 'completada' } });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(c.datos.completada_fecha, h);
  const dia = (await ana('/mi-dia')).datos;
  assert.ok(!dia.secciones.hoy.some((i) => i.clave === `tarea:${tarea.id}`));
  assert.ok(dia.secciones.completados.some((i) => i.clave === `tarea:${tarea.id}`));
  assert.ok((await ana('/mi-dia/historial')).datos.some((i) => i.id === tarea.id));
});

test('notas personales: privadas, sin notificaciones y convertibles en tarea', async () => {
  const antes = (await fernando('/notificaciones/conteo')).datos.no_leidas;
  const n = await ana('/mi-dia/notas', { method: 'POST', body: { titulo: 'KitchenAid podría pedir nuevos exhibidores', fecha: h, importancia: 'alta' } });
  assert.strictEqual(n.status, 201);
  assert.strictEqual((await fernando(`/mi-dia/notas/${n.datos.id}`)).status, 404);
  assert.strictEqual((await fernando('/notificaciones/conteo')).datos.no_leidas, antes);
  assert.ok((await ana('/mi-dia')).datos.secciones.hoy.some((i) => i.clave === `nota:${n.datos.id}`));
  await ana(`/mi-dia/notas/${n.datos.id}`, { method: 'PATCH', body: { archivada: true } });
  assert.ok(!(await ana('/mi-dia')).datos.secciones.hoy.some((i) => i.clave === `nota:${n.datos.id}`));
});

test('«Requieren mi atención»: aprobaciones, vencidos y tareas que le asignaron al administrador', async () => {
  const t = (await fernando('/trabajos', { method: 'POST', body: { cliente: 'Whirlpool', estatus: 'produccion' } })).datos;
  await ana('/solicitudes', {
    method: 'POST',
    body: { trabajo_id: t.id, tipo: 'cambio_fecha', titulo: 'Mover la entrega una semana', requiere_aprobacion: true, prioridad: 'normal', destinatarios: [] },
  });
  await ana('/mi-dia/tareas', { method: 'POST', body: { titulo: 'Revisar presupuesto Whirlpool', fecha: h, asignado_a: 1 } });
  const dia = (await fernando('/mi-dia')).datos;
  const titulos = dia.atencion.map((i) => i.titulo);
  assert.ok(titulos.some((x) => /^Aprobar: Mover la entrega/.test(x)), titulos.join(' | '));
  assert.ok(titulos.some((x) => /KitchenAid/.test(x))); // compromiso vencido
  assert.ok(titulos.includes('Revisar presupuesto Whirlpool'));
  // Sin duplicados entre «Requieren mi atención» y las demás secciones.
  const claves = [...dia.atencion, ...Object.values(dia.secciones).flat()].map((i) => i.clave);
  assert.strictEqual(new Set(claves).size, claves.length);
  // Los demás usuarios no tienen esta sección.
  assert.strictEqual((await ana('/mi-dia')).datos.atencion.length, 0);
});

test('avisos automáticos: un trabajo que acaba de vencer se notifica una sola vez', async () => {
  const fresh = cliente();
  await fresh('/auth/login', { method: 'POST', body: { usuario: 'fernando', password: 'clave-de-prueba' } });
  const antes = (await fresh('/notificaciones')).datos.items.filter((n) => n.tipo === 'vencido');
  assert.strictEqual(antes.length, 1); // KitchenAid venció hace 2 días
  assert.strictEqual(antes[0].trabajo_id !== null, true);
  await fresh('/notificaciones/conteo');
  assert.strictEqual((await fresh('/notificaciones')).datos.items.filter((n) => n.tipo === 'vencido').length, 1);
});

test('orden de producción: PDF sólo para proyectos aprobados y sin montos', async () => {
  const t = (await fernando('/trabajos', { method: 'POST', body: { cliente: 'STAR WHITE', estatus: 'por_cotizar' } })).datos;
  assert.strictEqual((await fernando(`/trabajos/${t.id}/orden-produccion.pdf`)).status, 400);
  await fernando(`/trabajos/${t.id}`, { method: 'PATCH', body: { estatus: 'aprobado', especificaciones_tecnicas: 'Suite 3,60 x 2,40 m' } });
  const c = (await fernando('/cotizaciones', { method: 'POST', body: { trabajo_id: t.id } })).datos;
  await fernando(`/cotizaciones/${c.id}`, {
    method: 'PUT',
    body: { ...c, estado: 'aprobada', piezas: [{ nombre: 'Suite', cantidad: 2, lineas: [{ material: 'MDF', cantidad: 3, costo_unitario: 45 }, { material: 'Mano de obra', cantidad: 1, costo_unitario: 300 }] }] },
  });
  const datos = (await ana(`/trabajos/${t.id}/orden-produccion`)).datos; // también para usuarios no administradores
  assert.deepStrictEqual(datos.piezas[0].materiales, [{ material: 'MDF', descripcion: null, cantidad: 6 }]);
  assert.ok(!JSON.stringify(datos).includes('costo'));
  const pdf = await ana(`/trabajos/${t.id}/orden-produccion.pdf`);
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.tipo, 'application/pdf');
  assert.strictEqual(pdf.datos.subarray(0, 5).toString(), '%PDF-');
});

test('etiquetar personas en una tarea: la ven, reciben un aviso y sólo agregan observaciones', async () => {
  const pedro = cliente();
  const idPedro = (await fernando('/usuarios', { method: 'POST', body: { usuario: 'pedro', nombre: 'Pedro Ruiz', password: 'temporal123' } })).datos.id;
  await pedro('/auth/login', { method: 'POST', body: { usuario: 'pedro', password: 'temporal123' } });
  await pedro('/auth/cambiar-password', { method: 'POST', body: { actual: 'temporal123', nueva: 'nueva-clave-1' } });
  const antesAna = (await ana('/notificaciones')).datos.items.length;

  // Asignada a Ana, con Pedro etiquetado; Ana no recibe dos avisos aunque también se la etiquete.
  const t = (await fernando('/mi-dia/tareas', { method: 'POST', body: { titulo: 'Confirmar transporte', fecha: h, asignado_a: idAna, etiquetados: [idPedro, idAna] } })).datos;
  assert.deepStrictEqual(t.etiquetados.map((e) => e.nombre), ['Pedro Ruiz']);
  assert.strictEqual((await ana('/notificaciones')).datos.items.length, antesAna + 1);
  const avisoPedro = (await pedro('/notificaciones')).datos.items[0];
  assert.strictEqual(avisoPedro.tipo, 'tarea_etiqueta');
  assert.strictEqual(avisoPedro.tarea_id, t.id);

  // Pedro la ve en su «Mi día», pero no cuenta como tarea suya pendiente.
  const dia = (await pedro('/mi-dia')).datos;
  const item = dia.secciones.hoy.find((i) => i.id === t.id);
  assert.ok(item && item.soy_etiquetado && item.puede_editar === false);
  assert.strictEqual(dia.resumen.pendientes, 0);

  // Sólo puede agregar observaciones.
  assert.strictEqual((await pedro(`/mi-dia/tareas/${t.id}`, { method: 'PATCH', body: { estado: 'completada' } })).status, 403);
  assert.strictEqual((await pedro(`/mi-dia/tareas/${t.id}`, { method: 'PATCH', body: { observaciones: 'El camión sale a las 7' } })).status, 200);

  // Mencionar con @ en las observaciones también etiqueta (y avisa una sola vez).
  await ana(`/mi-dia/tareas/${t.id}`, { method: 'PATCH', body: { observaciones: 'Confirmado. @fernando revisa la factura' } });
  const conFernando = (await ana(`/mi-dia/tareas/${t.id}`)).datos.etiquetados.map((e) => e.id);
  assert.ok(conFernando.includes(1) && conFernando.includes(idPedro));
  const avisos = (await fernando('/notificaciones')).datos.items.filter((n) => n.tipo === 'tarea_etiqueta' && n.tarea_id === t.id);
  assert.strictEqual(avisos.length, 1);

  // Quitar la etiqueta: deja de verla.
  await fernando(`/mi-dia/tareas/${t.id}`, { method: 'PATCH', body: { etiquetados: [] } });
  assert.strictEqual((await pedro(`/mi-dia/tareas/${t.id}`)).status, 404);
});

test('al eliminar un usuario con tareas se conserva el historial', async () => {
  assert.strictEqual((await fernando(`/usuarios/${idAna}`, { method: 'DELETE' })).status, 400);
});
