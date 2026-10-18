// Notificaciones individuales de cada usuario.
//
// Reglas:
//  - Nunca se notifica a quien realizó la acción.
//  - Un mismo evento genera como máximo una notificación por usuario (si un
//    usuario califica por varios motivos, gana el primero de la lista).
//  - Sólo reciben notificaciones usuarios activos con acceso al proyecto.

// Hoy todos los usuarios activos ven todos los proyectos; si en el futuro se
// restringe el acceso por proyecto, este es el único punto a modificar.
async function usuariosConAcceso(tx, ids /* , trabajoId */) {
  if (!ids.length) return new Set();
  const activos = await tx.column(`SELECT id FROM usuarios WHERE activo = 1 AND id IN (${ids.map(() => '?').join(',')})`, ...ids);
  return new Set(activos);
}

// destinos: [{ usuarioId, tipo, titulo, mensaje }] en orden de prioridad.
// La notificación abre la solicitud, la tarea o (con enlazarTrabajo) el proyecto.
async function notificar(tx, { destinos, solicitudId = null, tareaId = null, trabajoId = null, enlazarTrabajo = false, actorId = null }) {
  const porUsuario = new Map();
  for (const d of destinos) {
    if (!d.usuarioId || d.usuarioId === actorId || porUsuario.has(d.usuarioId)) continue;
    porUsuario.set(d.usuarioId, d);
  }
  const permitidos = await usuariosConAcceso(tx, [...porUsuario.keys()], trabajoId);
  let creadas = 0;
  for (const d of porUsuario.values()) {
    if (!permitidos.has(d.usuarioId)) continue;
    await tx.run(
      'INSERT INTO notificaciones (usuario_id, solicitud_id, tarea_id, trabajo_id, tipo, titulo, mensaje, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      d.usuarioId,
      solicitudId,
      tareaId,
      enlazarTrabajo ? trabajoId : null,
      d.tipo,
      String(d.titulo).slice(0, 200),
      d.mensaje ? String(d.mensaje).slice(0, 300) : null,
      actorId
    );
    creadas++;
  }
  return creadas;
}

module.exports = { notificar, usuariosConAcceso };
