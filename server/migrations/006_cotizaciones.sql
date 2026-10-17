-- Módulo "Cotizaciones": costos y precio de venta de cada proyecto
-- (reemplaza la hoja de Excel de costeo). Sólo administradores.

CREATE TABLE cotizaciones (
  id INTEGER PRIMARY KEY,
  numero INTEGER NOT NULL UNIQUE,
  trabajo_id INTEGER NOT NULL REFERENCES trabajos(id),
  contacto TEXT,
  fecha TEXT,
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'enviada', 'aprobada', 'rechazada')),
  margen REAL NOT NULL DEFAULT 0.30,
  margen_viaticos REAL NOT NULL DEFAULT 0.10,
  comisiones TEXT NOT NULL DEFAULT '[]', -- JSON: [{ "nombre": "Fernando", "porcentaje": 0.2 }, ...]
  comision_fija_nombre TEXT DEFAULT 'Francisco',
  reparto_viaticos TEXT NOT NULL DEFAULT 'proporcional' CHECK (reparto_viaticos IN ('proporcional', 'manual')),
  validez_dias INTEGER DEFAULT 15,
  tiempo_entrega TEXT,
  condiciones TEXT,
  observaciones TEXT,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cotizaciones_trabajo ON cotizaciones (trabajo_id);

-- Piezas o ítems cotizados (p. ej. "Puntera aire acondicionado").
CREATE TABLE cotizacion_piezas (
  id INTEGER PRIMARY KEY,
  cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  cantidad REAL NOT NULL DEFAULT 1,
  comision_fija REAL NOT NULL DEFAULT 0, -- comisión en monto (p. ej. Francisco)
  viaticos_pct REAL, -- sólo con reparto manual de viáticos
  orden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cot_piezas ON cotizacion_piezas (cotizacion_id);

-- Materiales y servicios de cada pieza (costos por unidad de la pieza).
CREATE TABLE cotizacion_lineas (
  id INTEGER PRIMARY KEY,
  pieza_id INTEGER NOT NULL REFERENCES cotizacion_piezas(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materiales(id) ON DELETE SET NULL,
  material TEXT NOT NULL,
  descripcion TEXT,
  proveedor TEXT,
  cantidad REAL NOT NULL DEFAULT 1,
  costo_unitario REAL NOT NULL DEFAULT 0,
  orden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cot_lineas ON cotizacion_lineas (pieza_id);

-- Transporte y viáticos del proyecto.
CREATE TABLE cotizacion_viaticos (
  id INTEGER PRIMARY KEY,
  cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  concepto TEXT NOT NULL,
  descripcion TEXT,
  proveedor TEXT,
  cantidad REAL NOT NULL DEFAULT 1,
  costo_unitario REAL NOT NULL DEFAULT 0,
  orden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cot_viaticos ON cotizacion_viaticos (cotizacion_id);
