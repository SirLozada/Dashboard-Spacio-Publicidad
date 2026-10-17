const { crearCrud } = require('../lib/crud');
const { db } = require('../db');

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
  // Los materiales del proveedor quedan sin proveedor asignado.
  antesDeBorrar: (id) => db.run('UPDATE materiales SET proveedor_id = NULL WHERE proveedor_id = ?', id),
  soloAdminBorrar: true,
});

module.exports = { router };
