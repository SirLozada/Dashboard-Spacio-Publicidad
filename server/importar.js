// Importa trabajos desde los Excel que Spacio Publicidad usaba antes del sistema.
//
// Reconoce los encabezados por nombre (no por posición), por lo que sirve para:
//  - "PENDIENTES TRABAJOS SPACIO PUBLICIDAD": FECHA, CLIENTE, DESCRIPCION, STATUS, PENDIENTE, ENTREGA.
//    Un trabajo ocupa varias filas: la primera trae fecha/cliente y las siguientes
//    agregan pendientes (y líneas extra de descripción).
//  - "Control de Trabajos y Producción": Fecha de inicio, Fecha de fin, Marca,
//    Nombre de tienda, Descripción, Status del trabajo, Observación.
//
// Uso desde la terminal:  npm run importar -- archivo.xlsx [otro.xlsx ...]
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const normalizar = (v) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

// Encabezado del Excel → campo del sistema.
const ENCABEZADOS = {
  FECHA: 'fecha_inicio',
  'FECHA DE INICIO': 'fecha_inicio',
  'FECHA DE FIN': 'fecha_entrega',
  ENTREGA: 'fecha_entrega',
  'FECHA DE ENTREGA': 'fecha_entrega',
  CLIENTE: 'cliente',
  MARCA: 'marca',
  TIENDA: 'tienda',
  'NOMBRE DE TIENDA': 'tienda',
  UBICACION: 'ubicacion',
  DESCRIPCION: 'descripcion',
  STATUS: 'estatus',
  ESTATUS: 'estatus',
  'STATUS DEL TRABAJO': 'estatus',
  PENDIENTE: 'pendiente',
  PENDIENTES: 'pendiente',
  OBSERVACION: 'observaciones',
  OBSERVACIONES: 'observaciones',
  RESPONSABLE: 'responsable',
};

// Estatus escritos en los Excel → estatus del sistema.
const ESTATUS = {
  'PENDIENTE POR COTIZAR': 'por_cotizar',
  'POR COTIZAR': 'por_cotizar',
  PENDIENTE: 'por_cotizar',
  RENDER: 'render',
  'PENDIENTE APROBACION': 'pendiente_aprobacion',
  'PENDIENTE POR APROBACION': 'pendiente_aprobacion',
  APROBADO: 'aprobado',
  PRODUCCION: 'produccion',
  'EN PRODUCCION': 'produccion',
  INSTALADO: 'instalado',
  RECLAMO: 'reclamo',
  'RECLAMO PENDIENTE': 'reclamo',
  'PENDIENTE REINSTALACION': 'reclamo',
  FINALIZADO: 'finalizado',
  RECHAZADO: 'rechazado',
};

function valorCelda(celda) {
  let v = celda.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if ('text' in v) v = v.text;
  }
  return v;
}

function aFechaIso(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v ?? '').trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (!m) return null;
  const anio = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${anio}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Lee un libro y devuelve la lista de trabajos encontrados (sin guardarlos).
async function leerTrabajos(ruta) {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.readFile(ruta);
  const trabajos = [];

  for (const hoja of libro.worksheets) {
    // 1. Ubicar la fila de encabezados: la primera con al menos 3 encabezados conocidos.
    let filaEnc = null;
    let columnas = [];
    hoja.eachRow((fila, n) => {
      if (filaEnc) return;
      const encontrados = [];
      fila.eachCell((celda, col) => {
        const campo = ENCABEZADOS[normalizar(valorCelda(celda))];
        if (campo) encontrados.push({ col, campo });
      });
      if (encontrados.length >= 3) {
        filaEnc = n;
        columnas = encontrados;
      }
    });
    if (!filaEnc) continue;

    // En el Excel de pendientes los datos están en celdas combinadas que no
    // coinciden exactamente con la columna del encabezado; cada celda se asigna
    // al encabezado más cercano.
    const campoDeColumna = (col) =>
      columnas.reduce((mejor, c) => (Math.abs(c.col - col) < Math.abs(mejor.col - col) ? c : mejor)).campo;

    let actual = null;
    for (let n = filaEnc + 1; n <= hoja.rowCount; n++) {
      const datos = {};
      hoja.getRow(n).eachCell((celda, col) => {
        // En celdas combinadas sólo cuenta la principal; las demás repiten su valor.
        if (celda.isMerged && celda.master.address !== celda.address) return;
        const v = valorCelda(celda);
        if (v === null || v === undefined || String(v).trim() === '') return;
        const campo = campoDeColumna(col);
        datos[campo] = datos[campo] ? `${datos[campo]} ${String(v).trim()}` : v;
      });
      if (!Object.keys(datos).length) continue;

      const iniciaTrabajo = datos.cliente || datos.marca || datos.tienda || datos.fecha_inicio;
      if (iniciaTrabajo) {
        const estatusTexto = normalizar(datos.estatus);
        actual = {
          cliente: String(datos.cliente ?? datos.marca ?? datos.tienda ?? '').trim(),
          marca: datos.marca ? String(datos.marca).trim() : null,
          tienda: datos.tienda ? String(datos.tienda).trim() : null,
          ubicacion: datos.ubicacion ? String(datos.ubicacion).trim() : null,
          descripcion: datos.descripcion ? String(datos.descripcion).trim() : null,
          estatus: ESTATUS[estatusTexto] || 'por_cotizar',
          estatusOriginal: datos.estatus ? String(datos.estatus).trim() : null,
          fecha_inicio: aFechaIso(datos.fecha_inicio),
          fecha_entrega: aFechaIso(datos.fecha_entrega),
          responsable: datos.responsable ? String(datos.responsable).trim() : null,
          observaciones: datos.observaciones ? String(datos.observaciones).trim() : null,
          pendientes: [],
        };
        trabajos.push(actual);
      } else if (!actual) {
        continue;
      } else if (datos.descripcion) {
        // Línea adicional de descripción (p. ej. fecha o lugar de un evento).
        actual.descripcion = actual.descripcion ? `${actual.descripcion}\n${String(datos.descripcion).trim()}` : String(datos.descripcion).trim();
      }
      if (actual && datos.pendiente) actual.pendientes.push(String(datos.pendiente).trim());
      if (actual && !iniciaTrabajo && datos.observaciones) {
        actual.observaciones = actual.observaciones ? `${actual.observaciones}\n${datos.observaciones}` : String(datos.observaciones);
      }
    }
  }

  for (const t of trabajos) {
    // "PENDIENTE" con el render como próximo paso equivale al estatus Render.
    if (normalizar(t.estatusOriginal) === 'PENDIENTE' && normalizar(t.pendientes[0]) === 'RENDER') t.estatus = 'render';
    // Si el estatus original no tiene equivalente exacto, se conserva en observaciones.
    if (t.estatusOriginal && !ESTATUS[normalizar(t.estatusOriginal)]) {
      t.observaciones = [t.observaciones, `Estatus en Excel: ${t.estatusOriginal}`].filter(Boolean).join('\n');
    }
  }
  // Filas sin información útil (p. ej. una plantilla con sólo el estatus) se descartan.
  return trabajos.filter((t) => t.cliente);
}

// Guarda los trabajos leídos. Omite los que ya existen (mismo cliente, tienda y descripción).
async function importarArchivo(ruta, { usuarioId = null } = {}) {
  const { db } = require('./db');
  const { crearTrabajo } = require('./modules/trabajos');
  const trabajos = await leerTrabajos(ruta);
  const existe = db.prepare(
    `SELECT 1 FROM trabajos WHERE cliente = ? COLLATE NOCASE
       AND COALESCE(tienda, '') = ? COLLATE NOCASE AND COALESCE(descripcion, '') = ? COLLATE NOCASE`
  );
  let creados = 0;
  let omitidos = 0;
  for (const t of trabajos) {
    if (existe.get(t.cliente, t.tienda ?? '', t.descripcion ?? '')) {
      omitidos++;
      continue;
    }
    const { pendientes, estatusOriginal, ...datos } = t;
    crearTrabajo(datos, pendientes, usuarioId);
    creados++;
  }
  return { archivo: path.basename(ruta), leidos: trabajos.length, creados, omitidos };
}

// Importación inicial: al primer arranque se cargan los Excel de la carpeta
// datos-iniciales/ (una sola vez, aunque luego se borren los trabajos).
async function importacionInicial() {
  const { db } = require('./db');
  const carpeta = process.env.CARPETA_IMPORTACION || path.join(__dirname, '..', 'datos-iniciales');
  const hecha = db.prepare("SELECT valor FROM ajustes WHERE clave = 'importacion_inicial'").pluck().get();
  if (hecha || !fs.existsSync(carpeta)) return;
  const totalTrabajos = db.prepare('SELECT COUNT(*) FROM trabajos').pluck().get();
  if (totalTrabajos === 0) {
    const archivos = fs.readdirSync(carpeta).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$')).sort();
    for (const f of archivos) {
      try {
        const r = await importarArchivo(path.join(carpeta, f));
        console.log(`Importación inicial · ${r.archivo}: ${r.creados} trabajos creados`);
      } catch (err) {
        console.error(`No se pudo importar ${f}:`, err.message);
      }
    }
  }
  db.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('importacion_inicial', datetime('now'))").run();
}

module.exports = { leerTrabajos, importarArchivo, importacionInicial };

if (require.main === module) {
  const archivos = process.argv.slice(2);
  if (!archivos.length) {
    console.log('Uso: npm run importar -- archivo.xlsx [otro.xlsx ...]');
    process.exit(1);
  }
  require('./db').migrate();
  (async () => {
    for (const a of archivos) {
      const r = await importarArchivo(path.resolve(a));
      console.log(`${r.archivo}: ${r.leidos} trabajos leídos, ${r.creados} creados, ${r.omitidos} omitidos (ya existían)`);
    }
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
