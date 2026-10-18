-- Integración con OpenCutList (SketchUp): cada importación es una versión del
-- despiece de un proyecto. La última versión es la vigente; las anteriores se
-- conservan como historial junto con sus archivos originales.

CREATE TABLE ocl_importaciones (
  id INTEGER PRIMARY KEY,
  trabajo_id INTEGER NOT NULL REFERENCES trabajos(id),
  version INTEGER NOT NULL,
  nota TEXT,
  diferencias TEXT,            -- JSON: cambios respecto a la versión anterior
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (trabajo_id, version)
);

-- Materiales comerciales a comprar según OpenCutList.
CREATE TABLE ocl_materiales (
  id INTEGER PRIMARY KEY,
  importacion_id INTEGER NOT NULL REFERENCES ocl_importaciones(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  tipo TEXT,
  espesor TEXT,
  formato TEXT,                -- formato comercial (p. ej. 2440 x 1830 mm)
  cantidad_comercial REAL,     -- tableros, barras… (NULL = no indicado en el archivo)
  origen_cantidad TEXT,        -- 'archivo' (OpenCutList) o 'manual' (diagrama de corte)
  unidad_compra TEXT,
  cantidad_piezas REAL,
  total TEXT,                  -- totales informativos (área, longitud)
  observaciones TEXT,
  material_id INTEGER REFERENCES materiales(id) ON DELETE SET NULL, -- catálogo de Spacio
  orden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ocl_materiales_importacion ON ocl_materiales (importacion_id);

-- Despiece: piezas a fabricar.
CREATE TABLE ocl_piezas (
  id INTEGER PRIMARY KEY,
  importacion_id INTEGER NOT NULL REFERENCES ocl_importaciones(id) ON DELETE CASCADE,
  numero TEXT,
  nombre TEXT NOT NULL,
  material TEXT,
  cantidad REAL NOT NULL DEFAULT 1,
  largo TEXT,
  ancho TEXT,
  espesor TEXT,
  observaciones TEXT,
  orden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ocl_piezas_importacion ON ocl_piezas (importacion_id);

-- Archivos originales (CSV, PDF, SVG, DXF).
CREATE TABLE ocl_archivos (
  id INTEGER PRIMARY KEY,
  importacion_id INTEGER NOT NULL REFERENCES ocl_importaciones(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,          -- csv, pdf, svg, dxf
  nombre_original TEXT NOT NULL,
  archivo TEXT NOT NULL,
  mime TEXT,
  tamano INTEGER,
  subido_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ocl_archivos_importacion ON ocl_archivos (importacion_id);
