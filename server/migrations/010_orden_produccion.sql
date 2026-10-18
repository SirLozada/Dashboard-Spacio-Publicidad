-- Datos técnicos del proyecto para la orden de producción (taller).
ALTER TABLE trabajos ADD COLUMN especificaciones_tecnicas TEXT;
ALTER TABLE trabajos ADD COLUMN observaciones_fabricacion TEXT;
