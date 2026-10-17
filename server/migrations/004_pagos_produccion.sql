-- Módulo "Pagos de producción": pagos por proyecto a colaboradores externos.

-- Directorio de colaboradores (no son empleados de nómina).
CREATE TABLE colaboradores (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  identificacion TEXT,
  telefono TEXT,
  especialidad TEXT,
  observaciones TEXT,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Colaborador asignado a un trabajo/proyecto con un monto acordado en USD.
CREATE TABLE asignaciones (
  id INTEGER PRIMARY KEY,
  trabajo_id INTEGER NOT NULL REFERENCES trabajos(id),
  colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id),
  tarea TEXT,
  fecha_inicio TEXT,
  monto_acordado_usd REAL NOT NULL DEFAULT 0,
  observaciones TEXT,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_asignaciones_trabajo ON asignaciones (trabajo_id);
CREATE INDEX idx_asignaciones_colaborador ON asignaciones (colaborador_id);

-- Abonos y ajustes. Nunca se editan ni se borran: un error se corrige con un
-- ajuste (tipo = 'ajuste', monto positivo o negativo) que queda identificado.
CREATE TABLE abonos (
  id INTEGER PRIMARY KEY,
  asignacion_id INTEGER NOT NULL REFERENCES asignaciones(id),
  tipo TEXT NOT NULL DEFAULT 'abono' CHECK (tipo IN ('abono', 'ajuste')),
  fecha TEXT NOT NULL,
  monto_usd REAL NOT NULL,
  monto_bs REAL,
  moneda_ingreso TEXT NOT NULL DEFAULT 'USD' CHECK (moneda_ingreso IN ('USD', 'VES')),
  tasa_bcv REAL,
  tasa_fecha_valor TEXT,
  tasa_origen TEXT CHECK (tasa_origen IN ('automatica', 'manual')),
  tasa_fuente TEXT,
  metodo_pago TEXT,
  referencia TEXT,
  observaciones TEXT,
  ajusta_abono_id INTEGER REFERENCES abonos(id),
  motivo_ajuste TEXT,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_abonos_asignacion ON abonos (asignacion_id);
CREATE INDEX idx_abonos_fecha ON abonos (fecha);

-- Tasas oficiales USD/VES conocidas, por fecha valor (fecha desde la que rige).
-- fuente: 'bcv' (leída del sitio del BCV) o 'manual' (registrada por un usuario).
CREATE TABLE tasas_bcv (
  fecha_valor TEXT PRIMARY KEY,
  tasa REAL NOT NULL,
  fuente TEXT NOT NULL,
  registrada_por INTEGER REFERENCES usuarios(id),
  obtenida_en TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historial de cambios del módulo (altas, ediciones, ajustes).
CREATE TABLE pagos_historial (
  id INTEGER PRIMARY KEY,
  entidad TEXT NOT NULL,
  entidad_id INTEGER NOT NULL,
  asignacion_id INTEGER,
  accion TEXT NOT NULL,
  detalle TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pagos_historial_asignacion ON pagos_historial (asignacion_id);
