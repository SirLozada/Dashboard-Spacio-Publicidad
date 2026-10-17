-- Lista de pendientes (próximos pasos) de cada trabajo, como la columna
-- "PENDIENTE" del Excel de trabajos pendientes.
CREATE TABLE trabajo_pendientes (
  id INTEGER PRIMARY KEY,
  trabajo_id INTEGER NOT NULL REFERENCES trabajos(id) ON DELETE CASCADE,
  texto TEXT NOT NULL,
  hecho INTEGER NOT NULL DEFAULT 0,
  orden INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  hecho_en TEXT
);
CREATE INDEX idx_pendientes_trabajo ON trabajo_pendientes (trabajo_id, hecho, orden);

-- Valores internos del sistema (p. ej. si ya se hizo la importación inicial).
CREATE TABLE ajustes (
  clave TEXT PRIMARY KEY,
  valor TEXT
);
