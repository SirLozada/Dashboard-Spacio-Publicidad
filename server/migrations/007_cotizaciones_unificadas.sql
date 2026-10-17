-- Unir cotizaciones aprobadas en una sola: la cotización original guarda en
-- qué cotización consolidada quedó, y la consolidada sus orígenes.
ALTER TABLE cotizaciones ADD COLUMN unificada_en INTEGER REFERENCES cotizaciones(id);
ALTER TABLE cotizaciones ADD COLUMN origenes TEXT; -- JSON: ["COT-0003", "COT-0005"]
