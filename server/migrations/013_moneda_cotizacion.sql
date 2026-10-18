-- Moneda de pago del presupuesto (divisas o bolívares). Sin valor por defecto:
-- se elige en cada cotización.
ALTER TABLE cotizaciones ADD COLUMN moneda TEXT;
