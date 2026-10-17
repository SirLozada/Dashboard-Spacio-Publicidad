class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Fecha de hoy (AAAA-MM-DD) en la zona horaria de la empresa. Se usa una
// variable propia porque Vercel no permite definir TZ.
const formatoFecha = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.ZONA_HORARIA || 'America/Caracas',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function hoy() {
  return formatoFecha.format(new Date());
}

function sumarDias(fechaIso, dias) {
  const d = new Date(`${fechaIso}T12:00:00`);
  d.setDate(d.getDate() + dias);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

// Convierte un valor recibido del cliente al tipo de la columna.
// Devuelve undefined si el valor no es válido para que se reporte el error.
function convertir(valor, tipo) {
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  const texto = String(valor).trim();
  if (texto === '') return null;
  switch (tipo) {
    case 'number': {
      const n = Number(texto.replace(',', '.'));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'int': {
      const n = Number(texto);
      return Number.isInteger(n) ? n : undefined;
    }
    case 'date':
      return FECHA_RE.test(texto) ? texto : undefined;
    default:
      return texto.slice(0, 5000);
  }
}

// Extrae del body sólo los campos permitidos, convertidos a su tipo.
// Con parcial=true (PATCH) se ignoran los campos que no vienen en el body.
function leerCampos(body, campos, { parcial = false, requeridos = [] } = {}) {
  const datos = {};
  for (const [nombre, tipo] of Object.entries(campos)) {
    if (!(nombre in (body || {}))) {
      if (!parcial) datos[nombre] = null;
      continue;
    }
    const v = convertir(body[nombre], tipo);
    if (v === undefined) throw new HttpError(400, `Valor inválido en el campo "${nombre}"`);
    datos[nombre] = v;
  }
  for (const r of requeridos) {
    if ((parcial ? r in datos : true) && (datos[r] === null || datos[r] === undefined)) {
      throw new HttpError(400, `El campo "${r}" es obligatorio`);
    }
  }
  return datos;
}

function likeParam(q) {
  return `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

module.exports = { HttpError, hoy, sumarDias, convertir, leerCampos, likeParam };
