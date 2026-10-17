CREATE TABLE usuarios (
  id INTEGER PRIMARY KEY,
  usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'usuario' CHECK (rol IN ('admin', 'usuario')),
  activo INTEGER NOT NULL DEFAULT 1,
  debe_cambiar_password INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE trabajos (
  id INTEGER PRIMARY KEY,
  numero INTEGER NOT NULL UNIQUE,
  cliente TEXT NOT NULL,
  marca TEXT,
  tienda TEXT,
  ubicacion TEXT,
  descripcion TEXT,
  estatus TEXT NOT NULL DEFAULT 'por_cotizar',
  fecha_inicio TEXT,
  fecha_cotizacion TEXT,
  fecha_entrega TEXT,
  responsable TEXT,
  observaciones TEXT,
  creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  actualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_trabajos_estatus ON trabajos (estatus);
CREATE INDEX idx_trabajos_fecha_entrega ON trabajos (fecha_entrega);

CREATE TABLE adjuntos (
  id INTEGER PRIMARY KEY,
  trabajo_id INTEGER NOT NULL REFERENCES trabajos(id) ON DELETE CASCADE,
  nombre_original TEXT NOT NULL,
  archivo TEXT NOT NULL,
  mime TEXT,
  tamano INTEGER,
  subido_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_adjuntos_trabajo ON adjuntos (trabajo_id);

CREATE TABLE proveedores (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  servicios TEXT,
  contacto TEXT,
  telefono TEXT,
  whatsapp TEXT,
  ubicacion TEXT,
  observaciones TEXT,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE materiales (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  categoria TEXT,
  unidad TEXT,
  precio REAL,
  proveedor_id INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  fecha_precio TEXT,
  observaciones TEXT,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_materiales_proveedor ON materiales (proveedor_id);
