// Datos de OpenCutList guardados por proyecto (lectura). La versión vigente de
// un proyecto es su última importación; las anteriores son historial.
const { db } = require('../db');

const vigenteId = (trabajoId) => db.value('SELECT id FROM ocl_importaciones WHERE trabajo_id = ? ORDER BY version DESC LIMIT 1', trabajoId);

// Una versión completa (la vigente si no se indica otra).
async function cargarVersion(trabajoId, importacionId = null) {
  const id = importacionId || (await vigenteId(trabajoId));
  if (!id) return null;
  const imp = await db.get(
    `SELECT i.*, u.nombre AS creado_por_nombre FROM ocl_importaciones i LEFT JOIN usuarios u ON u.id = i.creado_por
     WHERE i.id = ? AND i.trabajo_id = ?`,
    id,
    trabajoId
  );
  if (!imp) return null;
  const [materiales, piezas, archivos] = await Promise.all([
    db.all(
      `SELECT o.*, m.nombre AS catalogo_nombre, m.unidad AS catalogo_unidad FROM ocl_materiales o
       LEFT JOIN materiales m ON m.id = o.material_id WHERE o.importacion_id = ? ORDER BY o.orden, o.id`,
      id
    ),
    db.all('SELECT * FROM ocl_piezas WHERE importacion_id = ? ORDER BY orden, id', id),
    db.all('SELECT * FROM ocl_archivos WHERE importacion_id = ? ORDER BY id', id),
  ]);
  return { ...imp, diferencias: imp.diferencias ? JSON.parse(imp.diferencias) : null, materiales, piezas, archivos };
}

// Resumen de la versión vigente (para la orden de producción).
async function resumenVigente(trabajoId) {
  const id = await vigenteId(trabajoId);
  if (!id) return null;
  const r = await db.get(
    `SELECT i.version,
       (SELECT COUNT(*) FROM ocl_piezas p WHERE p.importacion_id = i.id) AS piezas,
       (SELECT COUNT(*) FROM ocl_materiales m WHERE m.importacion_id = i.id) AS materiales,
       (SELECT COUNT(*) FROM ocl_archivos a WHERE a.importacion_id = i.id AND a.tipo IN ('pdf', 'svg', 'dxf')) AS diagramas
     FROM ocl_importaciones i WHERE i.id = ?`,
    id
  );
  return r;
}

module.exports = { vigenteId, cargarVersion, resumenVigente };
