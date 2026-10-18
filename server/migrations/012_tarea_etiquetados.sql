-- Personas etiquetadas en una tarea de «Mi día» (además del responsable):
-- la ven en su agenda, reciben el aviso y pueden agregar observaciones.
CREATE TABLE tarea_etiquetados (
  tarea_id INTEGER NOT NULL REFERENCES tareas(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  agregado_por INTEGER REFERENCES usuarios(id),
  agregado_en TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tarea_id, usuario_id)
);
CREATE INDEX idx_tarea_etiquetados_usuario ON tarea_etiquetados (usuario_id);
