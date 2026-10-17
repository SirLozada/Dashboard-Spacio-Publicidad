const { crearCrud } = require('../lib/crud');
const { hoy } = require('../lib/util');

const router = crearCrud({
  tabla: 'materiales',
  campos: {
    nombre: 'text',
    categoria: 'text',
    unidad: 'text',
    precio: 'number',
    proveedor_id: 'int',
    fecha_precio: 'date',
    observaciones: 'text',
  },
  requeridos: ['nombre'],
  alias: 'm',
  selectBase: `SELECT m.*, p.nombre AS proveedor_nombre FROM materiales m
               LEFT JOIN proveedores p ON p.id = m.proveedor_id`,
  busqueda: ['m.nombre', 'm.categoria', 'm.observaciones', 'p.nombre'],
  filtros: ['categoria', 'proveedor_id'],
  orden: 'm.categoria IS NULL, m.categoria COLLATE NOCASE, m.nombre COLLATE NOCASE',
  // Si cambia el precio y no se indicó fecha, se registra la fecha de hoy.
  antesDeGuardar(datos, existente) {
    const cambioPrecio = 'precio' in datos && (!existente || existente.precio !== datos.precio);
    const fechaManual = 'fecha_precio' in datos && datos.fecha_precio && datos.fecha_precio !== existente?.fecha_precio;
    if (cambioPrecio && datos.precio !== null && !fechaManual) datos.fecha_precio = hoy();
  },
});

module.exports = { router };
