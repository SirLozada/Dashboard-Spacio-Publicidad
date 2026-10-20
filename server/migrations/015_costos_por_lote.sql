-- Las líneas de una pieza pueden ser el costo de una unidad (como en el Excel)
-- o el costo de todas las unidades a cotizar (se divide entre la cantidad).
ALTER TABLE cotizacion_piezas ADD COLUMN costos_por TEXT NOT NULL DEFAULT 'unidad' CHECK (costos_por IN ('unidad', 'lote'));
