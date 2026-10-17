// Tasa oficial USD/VES del Banco Central de Venezuela.
//
// Cada tasa del BCV rige desde su "fecha valor" (normalmente el siguiente día
// hábil a su publicación). Las tasas conocidas se guardan en la tabla
// tasas_bcv, por fecha valor. La tasa aplicable a una fecha es la de mayor
// fecha valor que no la supere: así los fines de semana y feriados usan
// automáticamente la última tasa vigente.
//
// Fuentes:
//  1. Sitio oficial https://www.bcv.org.ve (tasa + fecha valor). Es la única
//     fuente que se guarda como "automática" porque indica su fecha valor.
//  2. DolarApi (ve.dolarapi.com), que replica la tasa oficial pero sin fecha
//     valor: sólo se ofrece como sugerencia que el usuario debe confirmar.
//  3. Registro manual de un usuario (queda marcado como manual).
// Nunca se inventa una tasa: si no se puede verificar, se pide ingresarla.
const { db } = require('../db');
const { hoy } = require('./util');

const URL_BCV = process.env.BCV_URL || 'https://www.bcv.org.ve/';
const URL_DOLARAPI = process.env.DOLARAPI_URL || 'https://ve.dolarapi.com/v1/dolares/oficial';
// Máximo de días entre la fecha valor conocida y la fecha consultada para
// considerar la tasa vigente (cubre fines de semana largos y feriados).
const MAX_DIAS_VIGENCIA = 5;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

let ultimoIntento = 0;

// "36,59980000" o "1.234,56" → número
function parsearNumero(texto) {
  let t = String(texto ?? '').trim().replace(/\s/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const tasaValida = (n) => typeof n === 'number' && n > 0.01 && n < 1e7;

function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

async function descargar(url, ms = 9000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (SpacioDashboard)', Accept: 'text/html,application/json' },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Extrae tasa del dólar y fecha valor del HTML de la página del BCV.
function parsearPaginaBCV(html) {
  const bloque = html.match(/id=["']dolar["'][\s\S]{0,1500}?<strong>\s*([\d.,]+)\s*<\/strong>/i);
  const tasa = bloque ? parsearNumero(bloque[1]) : null;
  let fechaValor = null;
  const iso = html.match(/Fecha\s*Valor[\s\S]{0,400}?content=["'](\d{4}-\d{2}-\d{2})/i);
  if (iso) fechaValor = iso[1];
  if (!fechaValor) {
    // Texto del tipo "Fecha Valor: Lunes, 20 Octubre 2025"
    const txt = html.match(/Fecha\s*Valor:?[\s\S]{0,200}?(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)\s+(?:de\s+)?(\d{4})/i);
    const mes = txt ? MESES.indexOf(txt[2].toLowerCase()) : -1;
    if (txt && mes >= 0) fechaValor = `${txt[3]}-${String(mes + 1).padStart(2, '0')}-${txt[1].padStart(2, '0')}`;
  }
  if (!tasaValida(tasa) || !fechaValor) throw new Error('No se pudo leer la tasa o la fecha valor en la página del BCV');
  return { tasa, fecha_valor: fechaValor };
}

async function guardarTasa({ fecha_valor, tasa }, fuente, usuarioId = null) {
  await db.run(
    `INSERT INTO tasas_bcv (fecha_valor, tasa, fuente, registrada_por) VALUES (?, ?, ?, ?)
     ON CONFLICT(fecha_valor) DO UPDATE SET tasa = excluded.tasa, fuente = excluded.fuente,
       registrada_por = excluded.registrada_por, obtenida_en = datetime('now')
     WHERE tasas_bcv.fuente <> 'bcv' OR excluded.fuente = 'bcv'`,
    fecha_valor,
    tasa,
    fuente,
    usuarioId
  );
}

// Consulta el sitio del BCV y guarda la tasa publicada.
async function actualizarDesdeBCV() {
  ultimoIntento = Date.now();
  const leida = parsearPaginaBCV(await descargar(URL_BCV));
  await guardarTasa(leida, 'bcv');
  return leida;
}

// Tasa de referencia de DolarApi (sin fecha valor): sólo como sugerencia.
async function sugerenciaDolarApi() {
  try {
    const datos = JSON.parse(await descargar(URL_DOLARAPI, 7000));
    const tasa = Number(datos.promedio ?? datos.precio ?? datos.venta);
    if (!tasaValida(tasa)) return null;
    return { tasa, fuente: 'DolarApi (réplica de la tasa oficial)', actualizada: datos.fechaActualizacion || null };
  } catch {
    return null;
  }
}

async function buscarVigente(fecha) {
  const r = await db.get('SELECT * FROM tasas_bcv WHERE fecha_valor <= ? ORDER BY fecha_valor DESC LIMIT 1', fecha);
  if (r && diasEntre(r.fecha_valor, fecha) <= MAX_DIAS_VIGENCIA) return r;
  return null;
}

// Tasa aplicable a una fecha (AAAA-MM-DD).
async function tasaParaFecha(fecha, { consultar = true } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return { disponible: false, motivo: 'Fecha no válida' };
  if (fecha > hoy()) return { disponible: false, motivo: 'La fecha del pago no puede ser futura' };

  // Si no hay ninguna tasa con fecha valor posterior, puede existir una más
  // reciente que aún no conocemos: se consulta el BCV (como máximo cada 10 min).
  const posterior = await db.value('SELECT 1 FROM tasas_bcv WHERE fecha_valor > ? LIMIT 1', fecha);
  let errorBCV = null;
  if (!posterior && consultar && Date.now() - ultimoIntento > 10 * 60 * 1000) {
    try {
      await actualizarDesdeBCV();
    } catch (err) {
      errorBCV = err.message;
    }
  }

  const r = await buscarVigente(fecha);
  if (r) {
    return {
      disponible: true,
      tasa: r.tasa,
      fecha_valor: r.fecha_valor,
      fuente: r.fuente,
      origen: r.fuente === 'bcv' ? 'automatica' : 'manual',
    };
  }
  const respuesta = {
    disponible: false,
    motivo:
      fecha === hoy()
        ? 'No se pudo verificar la tasa oficial del BCV en este momento.'
        : 'No hay una tasa oficial verificada para esa fecha.',
    detalle: errorBCV,
  };
  if (fecha === hoy() && consultar) respuesta.sugerencia = await sugerenciaDolarApi();
  return respuesta;
}

async function ultimaTasa() {
  return db.get('SELECT * FROM tasas_bcv ORDER BY fecha_valor DESC LIMIT 1');
}

module.exports = { parsearNumero, parsearPaginaBCV, actualizarDesdeBCV, tasaParaFecha, guardarTasa, ultimaTasa, MAX_DIAS_VIGENCIA };
