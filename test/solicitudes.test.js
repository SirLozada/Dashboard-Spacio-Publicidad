const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spacio-sol-'));
process.env.ADMIN_PASSWORD = 'clave-de-prueba';
process.env.CARPETA_IMPORTACION = path.join(process.env.DATA_DIR, 'sin-importacion');
const app = require('../server/app');

let servidor;
let base;
// Una "sesión" (cookie) por usuario, como si estuvieran en dispositivos distintos.
function cliente() {
  let cookie = '';
  return async (ruta, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${ruta}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const c = res.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    return { status: res.status, datos: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
  };
}
const fernando = cliente();
const ana = cliente();
const luis = cliente();
let idAna;
let idLuis;
let trabajo;

async function crearUsuario(usuario, nombre, sesion) {
  const u = await fernando('/usuarios', { method: 'POST', body: { usuario, nombre, password: 'temporal123' } });
  await sesion('/auth/login', { method: 'POST', body: { usuario, password: 'temporal123' } });
  await sesion('/auth/cambiar-password', { method: 'POST', body: { actual: 'temporal123', nueva: 'nueva-clave-1' } });
  return u.datos.id;
}

before(async () => {
  servidor = app.listen(0);
  base = `http://localhost:${servidor.address().port}/api`;
  await fernando('/auth/login', { method: 'POST', body: { usuario: 'fernando', password: 'clave-de-prueba' } });
  idAna = await crearUsuario('ana', 'Ana Gómez', ana);
  idLuis = await crearUsuario('luis', 'Luis Pérez', luis);
  trabajo = (await fernando('/trabajos', { method: 'POST', body: { cliente: 'Daka', descripcion: 'Stand Hyundai', estatus: 'produccion' } })).datos;
});
after(() => servidor.close());

let solicitud;
test('nueva solicitud notifica sólo a los destinatarios', async () => {
  const r = await ana('/solicitudes', {
    method: 'POST',
    body: { trabajo_id: trabajo.id, tipo: 'material_adicional', titulo: 'Faltan 3 láminas de acrílico', descripcion: 'Para el frente del stand', prioridad: 'alta', destinatarios: [idLuis] },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.datos.estado, 'nueva');
  solicitud = r.datos;
  assert.strictEqual((await luis('/notificaciones/conteo')).datos.no_leidas, 1);
  assert.strictEqual((await ana('/notificaciones/conteo')).datos.no_leidas, 0); // no se notifica a quien la crea
  assert.strictEqual((await fernando('/notificaciones/conteo')).datos.no_leidas, 0);
  const n = (await luis('/notificaciones')).datos.items[0];
  assert.strictEqual(n.solicitud_id, solicitud.id);
  assert.match(n.mensaje, /Daka/);
  assert.match(n.mensaje, /Solicitud de material adicional/);
  assert.strictEqual(n.actor_nombre, 'Ana Gómez');
});

test('comentarios y menciones: una sola notificación por persona', async () => {
  const c = await luis(`/solicitudes/${solicitud.id}/comentarios`, { method: 'POST', body: { mensaje: 'Las pido hoy. @Ana @fernando revisen el costo' } });
  assert.strictEqual(c.status, 201);
  const na = (await ana('/notificaciones')).datos;
  assert.strictEqual(na.no_leidas, 1); // mención y comentario en un único aviso
  assert.strictEqual(na.items[0].tipo, 'mencion');
  const nf = (await fernando('/notificaciones')).datos;
  assert.strictEqual(nf.items[0].tipo, 'mencion'); // mencionado aunque no participaba
});

test('cambio de estado notifica a los participantes y queda en el historial', async () => {
  await ana('/notificaciones/leidas', { method: 'POST' });
  const r = await luis(`/solicitudes/${solicitud.id}`, { method: 'PATCH', body: { estado: 'en_proceso' } });
  assert.strictEqual(r.datos.estado, 'en_proceso');
  assert.strictEqual((await ana('/notificaciones')).datos.items[0].tipo, 'estado');
  const det = (await ana(`/solicitudes/${solicitud.id}`)).datos;
  assert.ok(det.comentarios.some((x) => x.tipo === 'evento' && /En proceso/.test(x.mensaje)));
  // Abrir la solicitud marca sus notificaciones como leídas
  assert.strictEqual((await ana('/notificaciones/conteo')).datos.no_leidas, 0);
  // Fernando (mencionado, sin ser responsable) no puede cambiar el estado... pero es admin, así que sí
  const ajeno = await cliente();
  assert.strictEqual((await ajeno(`/solicitudes/${solicitud.id}`)).status, 401);
});

test('solicitud que modifica alcance/costo/fecha requiere aprobación del administrador', async () => {
  const r = await luis('/solicitudes', {
    method: 'POST',
    body: { trabajo_id: trabajo.id, tipo: 'cambio_fecha', titulo: 'Cliente pide mover la entrega', requiere_aprobacion: true, destinatarios: [idAna] },
  });
  assert.strictEqual(r.datos.estado, 'pendiente_aprobacion');
  assert.strictEqual((await fernando('/notificaciones')).datos.items[0].tipo, 'aprobacion');
  // Nadie puede resolverla antes de la aprobación
  assert.strictEqual((await luis(`/solicitudes/${r.datos.id}`, { method: 'PATCH', body: { estado: 'resuelta' } })).status, 400);
  assert.strictEqual((await luis(`/solicitudes/${r.datos.id}/aprobacion`, { method: 'POST', body: { decision: 'aprobada' } })).status, 403);
  const ap = await fernando(`/solicitudes/${r.datos.id}/aprobacion`, { method: 'POST', body: { decision: 'aprobada', comentario: 'OK, nueva fecha 30/10' } });
  assert.strictEqual(ap.datos.aprobacion, 'aprobada');
  assert.strictEqual(ap.datos.estado, 'en_proceso');
  assert.strictEqual(ap.datos.aprobada_por_nombre, 'Fernando');
  assert.ok(ap.datos.aprobada_en);
  assert.strictEqual((await luis('/notificaciones')).datos.items[0].tipo, 'aprobada');
  // La fecha del trabajo no cambia automáticamente
  assert.strictEqual((await fernando(`/trabajos/${trabajo.id}`)).datos.fecha_entrega, null);
});

test('bandeja: mis solicitudes, asignadas a mí, filtros y resumen del proyecto', async () => {
  assert.strictEqual((await ana('/solicitudes?vista=mias')).datos.length, 1);
  assert.strictEqual((await ana('/solicitudes?vista=asignadas')).datos.length, 1);
  assert.strictEqual((await fernando('/solicitudes?prioridad=alta')).datos.length, 1);
  assert.strictEqual((await fernando('/solicitudes?cliente=dak')).datos.length, 2);
  const p = (await fernando(`/solicitudes/proyecto/${trabajo.id}`)).datos;
  assert.strictEqual(p.solicitudes.length, 2);
  assert.strictEqual(p.abiertas, 2);
  assert.strictEqual(p.ultimas_observaciones.length, 1);
  // El trabajo con solicitudes no se puede eliminar (se conserva el historial)
  assert.strictEqual((await fernando(`/trabajos/${trabajo.id}`, { method: 'DELETE' })).status, 400);
});

test('asignar destinatarios notifica a los nuevos', async () => {
  await fernando('/notificaciones/leidas', { method: 'POST' });
  const r = await ana(`/solicitudes/${solicitud.id}/destinatarios`, { method: 'POST', body: { usuarios: [1, idLuis] } });
  assert.strictEqual(r.status, 200);
  const nf = (await fernando('/notificaciones')).datos;
  assert.strictEqual(nf.no_leidas, 1);
  assert.strictEqual(nf.items[0].tipo, 'asignada');
});
