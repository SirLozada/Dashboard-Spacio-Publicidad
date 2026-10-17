const { crearCrud } = require('../lib/crud');

const router = crearCrud({
  tabla: 'proveedores',
  campos: {
    nombre: 'text',
    servicios: 'text',
    contacto: 'text',
    telefono: 'text',
    whatsapp: 'text',
    ubicacion: 'text',
    observaciones: 'text',
  },
  requeridos: ['nombre'],
  alias: 'p',
  selectBase: `SELECT p.*, (SELECT COUNT(*) FROM materiales m WHERE m.proveedor_id = p.id) AS total_materiales
               FROM proveedores p`,
  busqueda: ['p.nombre', 'p.servicios', 'p.contacto', 'p.ubicacion', 'p.telefono'],
  orden: 'p.nombre COLLATE NOCASE',
  soloAdminBorrar: true,
});

module.exports = { router };
