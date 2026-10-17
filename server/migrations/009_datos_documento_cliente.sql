-- Datos del encabezado del presupuesto que recibe el cliente.
ALTER TABLE cotizaciones ADD COLUMN razon_social TEXT;
ALTER TABLE cotizaciones ADD COLUMN direccion_cliente TEXT;
ALTER TABLE cotizaciones ADD COLUMN referencia TEXT;
ALTER TABLE cotizaciones ADD COLUMN forma_pago TEXT;
