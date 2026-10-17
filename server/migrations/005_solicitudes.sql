-- Módulo "Solicitudes y novedades": comunicación interna por proyecto.

CREATE TABLE solicitudes (
  id INTEGER PRIMARY KEY,
  trabajo_id INTEGER NOT NULL REFERENCES trabajos(id),
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  descripcion TEXT,
  prioridad TEXT NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('normal', 'alta', 'urgente')),
  estado TEXT NOT NULL DEFAULT 'nueva',
  -- ¿Modifica alcance, costo o fecha? Entonces requiere aprobación de un administrador.
  requiere_aprobacion INTEGER NOT NULL DEFAULT 0,
  aprobacion TEXT CHECK (aprobacion IN ('pendiente', 'aprobada', 'rechazada')),
  aprobada_por INTEGER REFERENCES usuarios(id),
  aprobada_en TEXT,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_solicitudes_trabajo ON solicitudes (trabajo_id);
CREATE INDEX idx_solicitudes_estado ON solicitudes (estado);

CREATE TABLE solicitud_destinatarios (
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  agregado_en TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (solicitud_id, usuario_id)
);
CREATE INDEX idx_destinatarios_usuario ON solicitud_destinatarios (usuario_id);

-- Hilo de la solicitud: comentarios de usuarios y eventos del sistema
-- (cambios de estado, aprobaciones, destinatarios agregados).
CREATE TABLE solicitud_comentarios (
  id INTEGER PRIMARY KEY,
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id),
  tipo TEXT NOT NULL DEFAULT 'comentario' CHECK (tipo IN ('comentario', 'evento')),
  mensaje TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comentarios_solicitud ON solicitud_comentarios (solicitud_id);

CREATE TABLE solicitud_adjuntos (
  id INTEGER PRIMARY KEY,
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id) ON DELETE CASCADE,
  comentario_id INTEGER REFERENCES solicitud_comentarios(id) ON DELETE CASCADE,
  nombre_original TEXT NOT NULL,
  archivo TEXT NOT NULL,
  mime TEXT,
  tamano INTEGER,
  subido_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sol_adjuntos_solicitud ON solicitud_adjuntos (solicitud_id);

-- Notificaciones individuales de cada usuario.
CREATE TABLE notificaciones (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  solicitud_id INTEGER REFERENCES solicitudes(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  mensaje TEXT,
  actor_id INTEGER REFERENCES usuarios(id),
  leida INTEGER NOT NULL DEFAULT 0,
  creada_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notificaciones_usuario ON notificaciones (usuario_id, leida, id);
