// Avisos automáticos de «Mi día» por la campanita existente:
//  - una tarea importante (alta o urgente) llega a su fecha o queda vencida;
//  - a los administradores, un compromiso de proyecto acaba de vencer.
// Cada aviso se envía una sola vez (tabla avisos_enviados). Se revisa al
// consultar las notificaciones, como máximo cada 10 minutos por usuario.
const { db } = require('../db');
const compromisos = require('./compromisos');
const { notificar } = require('./notificaciones');
const { hoy, sumarDias } = require('./util');

const CADA_MS = 10 * 60 * 1000;
const ultimaRevision = new Map();
const fechaTxt = (iso) => iso.split('-').reverse().join('/');

async function enviarUnaVez(usuarioId, clave, aviso) {
  const { changes } = await db.run('INSERT OR IGNORE INTO avisos_enviados (usuario_id, clave) VALUES (?, ?)', usuarioId, clave);
  if (changes) await notificar(db, { destinos: [{ usuarioId, ...aviso.destino }], ...aviso.enlace });
}

async function revisarAvisos(usuario) {
  const ahora = Date.now();
  if (ahora - (ultimaRevision.get(usuario.id) || 0) < CADA_MS) return;
  ultimaRevision.set(usuario.id, ahora);
  const h = hoy();

  // Tareas importantes: el día programado y, si siguen pendientes, al vencer
  // (sólo las de la última semana, para no avisar de todo lo antiguo).
  const tareas = await db.all(
    `SELECT id, titulo, fecha, prioridad FROM tareas
     WHERE asignado_a = ? AND archivada = 0 AND estado <> 'completada' AND prioridad IN ('alta', 'urgente')
       AND fecha BETWEEN ? AND ?`,
    usuario.id,
    sumarDias(h, -7),
    h
  );
  for (const t of tareas) {
    const vencida = t.fecha < h;
    await enviarUnaVez(usuario.id, `${vencida ? 'tarea-vencida' : 'tarea-hoy'}:${t.id}:${t.fecha}`, {
      destino: {
        tipo: vencida ? 'vencido' : 'recordatorio',
        titulo: vencida ? `Tarea vencida: ${t.titulo}` : `Hoy: ${t.titulo}`,
        mensaje: vencida ? `Estaba programada para el ${fechaTxt(t.fecha)}` : `Tarea de prioridad ${t.prioridad}`,
      },
      enlace: { tareaId: t.id },
    });
  }

  // Administradores: compromisos de proyectos que vencieron en los últimos 3 días.
  if (usuario.rol === 'admin') {
    const vencidos = (await compromisos.listar({ desde: sumarDias(h, -3), hasta: sumarDias(h, -1) })).filter((c) => c.vencido);
    for (const c of vencidos) {
      await enviarUnaVez(usuario.id, `trabajo-vencido:${c.trabajo.id}:${c.tipo}:${c.fecha}`, {
        destino: {
          tipo: 'vencido',
          titulo: `Vencido: ${c.etiqueta.toLowerCase()} de ${c.trabajo.codigo}`,
          mensaje: `${c.trabajo.cliente}${c.trabajo.tienda ? ` · ${c.trabajo.tienda}` : ''} · era el ${fechaTxt(c.fecha)}`,
        },
        enlace: { trabajoId: c.trabajo.id, enlazarTrabajo: true },
      });
    }
  }
}

module.exports = { revisarAvisos };
