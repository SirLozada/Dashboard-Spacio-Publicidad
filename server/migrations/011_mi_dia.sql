-- «Mi día»: tareas manuales y notas personales. Los pendientes automáticos no
-- se guardan: se calculan desde trabajos y solicitudes.

CREATE TABLE tareas (
  id INTEGER PRIMARY KEY,
  titulo TEXT NOT NULL,
  descripcion TEXT,
  observaciones TEXT,
  fecha TEXT,                 -- fecha programada (AAAA-MM-DD)
  hora TEXT,                  -- HH:MM (opcional)
  prioridad TEXT NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('normal', 'alta', 'urgente')),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'en_proceso', 'completada')),
  trabajo_id INTEGER REFERENCES trabajos(id),
  asignado_a INTEGER NOT NULL REFERENCES usuarios(id),
  creado_por INTEGER NOT NULL REFERENCES usuarios(id),
  actualizado_por INTEGER REFERENCES usuarios(id),
  archivada INTEGER NOT NULL DEFAULT 0,
  completada_fecha TEXT,      -- día (zona horaria de la empresa) en que se completó
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tareas_asignado ON tareas (asignado_a, archivada, estado, fecha);
CREATE INDEX idx_tareas_creador ON tareas (creado_por);

-- Notas y recordatorios personales: privados de cada usuario.
CREATE TABLE notas_personales (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  nota TEXT,
  fecha TEXT,                 -- día en que se quiere ver
  trabajo_id INTEGER REFERENCES trabajos(id),
  importancia TEXT NOT NULL DEFAULT 'normal' CHECK (importancia IN ('normal', 'alta', 'urgente')),
  archivada INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notas_usuario ON notas_personales (usuario_id, archivada, fecha);

-- Avisos automáticos ya enviados (evita repetir la misma notificación).
CREATE TABLE avisos_enviados (
  usuario_id INTEGER NOT NULL,
  clave TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (usuario_id, clave)
);

-- Las notificaciones existentes también pueden llevar a una tarea o a un proyecto.
ALTER TABLE notificaciones ADD COLUMN tarea_id INTEGER REFERENCES tareas(id) ON DELETE CASCADE;
ALTER TABLE notificaciones ADD COLUMN trabajo_id INTEGER REFERENCES trabajos(id) ON DELETE CASCADE;
