// Lectura de los archivos CSV que exporta OpenCutList (extensión de SketchUp).
// Se usa en el navegador (vista previa antes de guardar) y en el servidor
// (validación y diferencias entre versiones), para que ambos coincidan.
//
// OpenCutList exporta tres tipos de lista, con encabezados en el idioma de
// SketchUp y columnas configurables:
//  - Lista de piezas (cutlist): una fila por pieza con cantidad y medidas.
//  - Resumen (summary): una fila por material con formato y totales.
//  - Lista de instancias: una fila por cada instancia (se agrupan en piezas).
// Las cantidades comerciales (tableros, barras…) sólo se toman cuando el
// archivo las trae: nunca se calculan a partir de las piezas.

const sinAcentos = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const limpio = (t) => String(t ?? '').replace(/ /g, ' ').trim();

// ---------- CSV ----------

function detectarSeparador(texto) {
  const primera = texto.split(/\r?\n/).find((l) => l.trim()) || '';
  const cuenta = (c) => primera.split(c).length - 1;
  return [';', '\t', ','].reduce((mejor, c) => (cuenta(c) > cuenta(mejor) ? c : mejor), ';');
}

export function leerCsv(texto) {
  texto = String(texto ?? '').replace(/^﻿/, '');
  const sep = detectarSeparador(texto);
  const filas = [];
  let fila = [];
  let celda = '';
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') {
        celda += '"';
        i++;
      } else if (c === '"') comillas = false;
      else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) {
      fila.push(celda);
      celda = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(celda);
      if (fila.some((x) => x.trim())) filas.push(fila.map(limpio));
      fila = [];
      celda = '';
    } else celda += c;
  }
  fila.push(celda);
  if (fila.some((x) => x.trim())) filas.push(fila.map(limpio));
  return filas;
}

// "1 200,5 mm" → 1200.5 ; "1,200.5" → 1200.5 ; "3/4\"" → null
export function aNumero(valor) {
  const t = limpio(valor).replace(/\s+/g, '');
  const m = t.match(/-?[\d.,]+/);
  if (!m || /\d\/\d/.test(t)) return null;
  let n = m[0];
  const coma = n.lastIndexOf(',');
  const punto = n.lastIndexOf('.');
  if (coma > -1 && punto > -1) n = coma > punto ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
  else if (coma > -1) n = /^\d{1,3}(,\d{3})+$/.test(n) && n.split(',').length > 2 ? n.replace(/,/g, '') : n.replace(',', '.');
  else if ((n.match(/\./g) || []).length > 1) n = n.replace(/\./g, '');
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

// ---------- Reconocimiento de columnas ----------

// Cada campo: palabras exactas (puntaje alto) y fragmentos (puntaje menor).
const CAMPOS = {
  numero: { exactas: ['number', 'numero', 'num', 'no', 'n', '#', 'n°', 'nº', 'id', 'ref', 'reference', 'referencia', 'etiqueta', 'repere'], partes: [] },
  nombre: { exactas: ['name', 'nombre', 'nom', 'designation', 'designacion', 'pieza', 'part', 'definition name', 'nombre de la definicion', 'nom de la definition'], partes: ['nombre', 'name', 'designa'] },
  cantidad: { exactas: ['quantity', 'qty', 'cantidad', 'quantite', 'qte', 'cant', 'count', 'cantidad total'], partes: ['cantidad', 'quanti', 'qty'] },
  largo: { exactas: ['length', 'largo', 'longitud', 'longueur', 'long', 'l'], partes: ['length', 'longitud', 'longueur', 'largo', 'long'] },
  ancho: { exactas: ['width', 'ancho', 'anchura', 'largeur', 'larg', 'w'], partes: ['width', 'ancho', 'anchura', 'largeur', 'larg '] },
  espesor: { exactas: ['thickness', 'espesor', 'grosor', 'epaisseur', 'ep', 'esp', 't'], partes: ['thickness', 'espesor', 'grosor', 'epaiss', 'ep ', 'esp '] },
  material: { exactas: ['material', 'material name', 'nombre del material', 'matiere', 'materiau', 'nom de la matiere'], partes: ['material', 'matiere', 'materiau'] },
  tipo: { exactas: ['material type', 'tipo de material', 'type de matiere', 'tipo'], partes: ['type', 'tipo'] },
  formato: {
    exactas: ['std dimension', 'dimension estandar', 'dimension std', 'dimension standard', 'formato', 'format', 'std sheet', 'tablero estandar'],
    partes: ['std', 'estandar', 'standard', 'formato'],
  },
  comercial: {
    exactas: ['sheets', 'used sheets', 'tableros', 'tableros usados', 'paneles', 'planchas', 'panneaux', 'boards', 'bars', 'barras', 'barres', 'rolls', 'rollos'],
    partes: ['sheet', 'tablero', 'panel', 'plancha', 'panneau', 'board', 'barra', 'barre', 'rollo', 'roll'],
  },
  area: { exactas: [], partes: ['area', 'superficie', 'surface'] },
  longitud_total: { exactas: [], partes: ['total length', 'longitud total', 'longueur totale', 'cutting length', 'longitud de corte'] },
  observaciones: { exactas: ['description', 'descripcion', 'observaciones', 'notes', 'notas', 'comment', 'comentario', 'tags', 'etiquetas'], partes: ['descrip', 'observ', 'note', 'tag'] },
  ruta: { exactas: ['path', 'ruta', 'chemin', 'instance name', 'nombre de instancia'], partes: ['path', 'ruta', 'chemin', 'instanc'] },
};
export const ETIQUETAS_CAMPO = {
  numero: 'N° / referencia',
  nombre: 'Nombre de la pieza',
  cantidad: 'Cantidad',
  largo: 'Largo',
  ancho: 'Ancho',
  espesor: 'Espesor',
  material: 'Material',
  tipo: 'Tipo de material',
  formato: 'Formato comercial',
  comercial: 'Unidades comerciales',
  area: 'Área total',
  longitud_total: 'Longitud total',
  observaciones: 'Observaciones',
  ruta: 'Ruta / instancia',
};

// Columnas "de corte" o "caja" (bbox): se prefieren las medidas finales simples.
const esVariante = (h) => /(cutting|corte|coupe|debit|bbox|caja|brut|raw|final|edge|canto|chant)/.test(h);
const esCanto = (h) => /(edge|canto|chant)/.test(h);

function puntaje(campo, h) {
  const def = CAMPOS[campo];
  if (def.exactas.includes(h)) return 10;
  if (['largo', 'ancho', 'espesor', 'cantidad'].includes(campo) && esCanto(h)) return 0;
  if (campo === 'tipo' && !/(material|matiere|materiau)/.test(h) && h !== 'tipo') return 0;
  if (campo === 'nombre' && /(material|matiere|instanc)/.test(h)) return 0;
  if (campo === 'material' && /(type|tipo)/.test(h)) return 0;
  if (campo === 'longitud_total' && !/(total|corte|cutting)/.test(h)) return 0;
  if (['largo', 'ancho', 'espesor', 'cantidad'].includes(campo) && /(total|area|surface|superficie)/.test(h)) return 0;
  const parte = def.partes.find((p) => h.includes(p));
  if (!parte) return 0;
  if (!esVariante(h) || ['comercial', 'longitud_total', 'area'].includes(campo)) return 6;
  // Entre las variantes se prefiere la medida final (caja) a la de corte (con sobremedida).
  return /(bbox|caja|final)/.test(h) ? 4 : 3;
}

export function reconocerColumnas(encabezados) {
  // "Long. de débit" → "long de debit"; "N.º" → "nº"
  const hs = encabezados.map((e) => sinAcentos(e).replace(/\./g, '').replace(/[():[\]]/g, ' ').replace(/\s+/g, ' ').trim());
  const mapeo = {};
  const usadas = new Set();
  // Primero los campos más específicos, para que no "roben" columnas.
  for (const campo of ['comercial', 'formato', 'tipo', 'material', 'ruta', 'cantidad', 'largo', 'ancho', 'espesor', 'area', 'longitud_total', 'numero', 'nombre', 'observaciones']) {
    let mejor = null;
    let mejorPuntaje = 0;
    hs.forEach((h, i) => {
      if (usadas.has(i)) return;
      const p = puntaje(campo, h);
      if (p > mejorPuntaje) {
        mejor = i;
        mejorPuntaje = p;
      }
    });
    mapeo[campo] = mejor;
    if (mejor !== null) usadas.add(mejor);
  }
  // Columnas de cantos: se agregan a las observaciones de cada pieza.
  mapeo.cantos = hs.map((h, i) => (esCanto(h) && !usadas.has(i) ? i : null)).filter((i) => i !== null);
  return mapeo;
}

// ---------- Análisis de un archivo ----------

const TIPOS_LISTA = { piezas: 'Lista de piezas', resumen: 'Resumen de materiales', instancias: 'Lista de instancias', desconocido: 'No reconocido' };
export { TIPOS_LISTA };

function detectarTipo(m) {
  if (m.ruta !== null && m.nombre !== null) return 'instancias';
  if (m.nombre !== null && (m.largo !== null || m.ancho !== null)) return 'piezas';
  if (m.material !== null && (m.formato !== null || m.area !== null || m.longitud_total !== null || m.comercial !== null)) return 'resumen';
  if (m.nombre !== null && m.cantidad !== null) return 'piezas';
  return 'desconocido';
}

// Unidad de compra sugerida según el tipo de material de OpenCutList.
export function unidadSugerida(tipo, nombre = '') {
  const t = sinAcentos(`${tipo} ${nombre}`);
  if (/(sheet|tablero|panneau|panel|plancha|placa|lamina|mdf|melamin|contrachapado|triplex|playwood|plywood|acrilico)/.test(t)) return 'Tablero';
  if (/(edge|canto|chant|tapacanto)/.test(t)) return 'Metro lineal';
  if (/(dimensional|liston|barra|barre|perfil|tubo|madera maciza|solid wood|bois massif)/.test(t)) return 'Barra';
  if (/(hardware|herraje|quincaill|accesorio)/.test(t)) return 'Unidad';
  return null;
}

const clave = (...partes) => partes.map((p) => sinAcentos(p).replace(/\s+/g, ' ')).join('|');
// Medida comparable: "18 mm" y "18" son el mismo espesor.
const medida = (v) => {
  if (!v) return '';
  const n = aNumero(v);
  return n === null || /[x×]/i.test(v) ? sinAcentos(v).replace(/\s+/g, '') : String(n);
};
// Materiales iguales: mismo nombre, espesor, formato comercial y unidad de compra.
export const claveMaterial = (m) => clave(m.nombre, medida(m.espesor), medida(m.formato), m.unidad_compra || '');

// texto: contenido del CSV; mapeoManual: correcciones { campo: índice | null, lista }
export function analizarCsv(texto, mapeoManual = null) {
  const filas = leerCsv(texto);
  if (!filas.length) return { tipo: 'desconocido', encabezados: [], mapeo: {}, filas: 0, piezas: [], materiales: [], avisos: ['El archivo está vacío.'] };
  const encabezados = filas[0];
  const mapeo = { ...reconocerColumnas(encabezados), ...(mapeoManual || {}) };
  const datos = filas.slice(1);
  // mapeoManual.lista: tipo de lista elegido a mano (piezas, resumen, instancias).
  const tipo = mapeoManual?.lista || detectarTipo(mapeo);
  const val = (fila, campo) => (mapeo[campo] === null || mapeo[campo] === undefined ? '' : limpio(fila[mapeo[campo]]));
  const avisos = [];
  const piezas = [];
  const materiales = [];

  if (tipo === 'piezas' || tipo === 'instancias') {
    const porClave = new Map();
    for (const fila of datos) {
      const nombre = val(fila, 'nombre');
      if (!nombre) continue;
      const cantos = (mapeo.cantos || []).map((i) => [encabezados[i], limpio(fila[i])]).filter(([, v]) => v);
      const obs = [val(fila, 'observaciones'), cantos.length ? `Cantos: ${cantos.map(([h, v]) => `${h} ${v}`).join(', ')}` : ''].filter(Boolean).join(' · ');
      const pieza = {
        numero: val(fila, 'numero') || null,
        nombre,
        material: val(fila, 'material') || null,
        tipo_material: val(fila, 'tipo') || null,
        cantidad: tipo === 'instancias' ? 1 : aNumero(val(fila, 'cantidad')) ?? 1,
        largo: val(fila, 'largo') || null,
        ancho: val(fila, 'ancho') || null,
        espesor: val(fila, 'espesor') || null,
        observaciones: obs || null,
      };
      // La lista de instancias trae una fila por cada copia: se agrupan.
      const k = clave(pieza.nombre, pieza.material, pieza.largo, pieza.ancho, pieza.espesor);
      const previa = tipo === 'instancias' ? porClave.get(k) : null;
      if (previa) previa.cantidad += 1;
      else {
        porClave.set(k, pieza);
        piezas.push(pieza);
      }
    }
    if (!piezas.length) avisos.push('No se encontraron piezas: revisa qué columna corresponde al nombre.');
    if (mapeo.largo === null && mapeo.ancho === null) avisos.push('No se reconocieron columnas de medidas (largo, ancho).');
    if (mapeo.material === null) avisos.push('No se reconoció la columna de material.');
  } else if (tipo === 'resumen') {
    for (const fila of datos) {
      const nombre = val(fila, 'material');
      if (!nombre) continue;
      let formato = val(fila, 'formato') || null;
      let espesor = null;
      // En OpenCutList la "dimensión estándar" de un tablero es su espesor (ej. "18 mm");
      // si trae dos medidas ("2440 x 1220") es el formato del tablero o la sección.
      if (formato && !/[x×]/i.test(formato)) {
        espesor = formato;
        formato = null;
      }
      const comercialTxt = val(fila, 'comercial');
      const comercial = comercialTxt ? aNumero(comercialTxt) : null;
      const tipoMat = val(fila, 'tipo') || null;
      materiales.push({
        nombre,
        tipo: tipoMat,
        espesor,
        formato,
        cantidad_comercial: comercial,
        origen_cantidad: comercial !== null ? 'archivo' : null,
        unidad_compra: unidadSugerida(tipoMat, nombre),
        total: [val(fila, 'area'), val(fila, 'longitud_total')].filter(Boolean).join(' · ') || null,
        observaciones: null,
      });
    }
    if (!materiales.length) avisos.push('No se encontraron materiales: revisa qué columna corresponde al material.');
    if (mapeo.comercial === null) {
      avisos.push('El resumen no trae la cantidad de tableros o unidades comerciales: puedes indicarla con el resultado del diagrama de corte de OpenCutList.');
    }
  } else {
    avisos.push('No se reconoció el tipo de lista. Indica qué columna corresponde a cada dato.');
  }
  return { tipo, encabezados, mapeo, filas: datos.length, piezas, materiales, avisos };
}

// ---------- Combinar archivos de una importación ----------

// analisis: resultados de analizarCsv de cada CSV de la importación.
// Devuelve { piezas, materiales } sin duplicados.
export function combinar(analisis) {
  // Piezas: de la lista de piezas; si no hay, de la lista de instancias.
  const fuentes = analisis.filter((a) => a.tipo === 'piezas');
  const piezas = (fuentes.length ? fuentes : analisis.filter((a) => a.tipo === 'instancias')).flatMap((a) => a.piezas);

  const materiales = [];
  const porNombre = new Map();
  const agregar = (m) => {
    const k = claveMaterial(m);
    const previo = porNombre.get(k);
    if (previo) {
      // Mismo material en dos archivos: se completa sin sumar dos veces.
      for (const campo of ['tipo', 'espesor', 'formato', 'cantidad_comercial', 'origen_cantidad', 'unidad_compra', 'total']) previo[campo] ??= m[campo];
      return previo;
    }
    const nuevo = { nombre: m.nombre, tipo: null, espesor: null, formato: null, cantidad_comercial: null, origen_cantidad: null, unidad_compra: null, total: null, observaciones: null, cantidad_piezas: 0, ...m };
    porNombre.set(k, nuevo);
    materiales.push(nuevo);
    return nuevo;
  };
  for (const a of analisis.filter((x) => x.tipo === 'resumen')) a.materiales.forEach(agregar);

  // Materiales que aparecen en las piezas: cuántas piezas usan cada uno.
  const porMaterial = new Map();
  for (const p of piezas) {
    const nombre = p.material || 'Sin material';
    const lista = porMaterial.get(nombre) || [];
    lista.push(p);
    porMaterial.set(nombre, lista);
  }
  for (const [nombre, lista] of porMaterial) {
    const espesores = [...new Set(lista.map((p) => p.espesor).filter(Boolean))];
    const tipo = lista.find((p) => p.tipo_material)?.tipo_material || null;
    // Se busca primero el material del resumen con el mismo nombre.
    let m = materiales.find((x) => sinAcentos(x.nombre) === sinAcentos(nombre));
    if (!m) m = agregar({ nombre, tipo, espesor: espesores.length === 1 ? espesores[0] : null, unidad_compra: unidadSugerida(tipo, nombre) });
    m.tipo ??= tipo;
    if (!m.espesor && espesores.length === 1) m.espesor = espesores[0];
    m.cantidad_piezas = (m.cantidad_piezas || 0) + lista.reduce((s, p) => s + (Number(p.cantidad) || 0), 0);
    if (espesores.length > 1) m.observaciones = `Piezas en varios espesores: ${espesores.join(', ')}`;
  }
  return { piezas, materiales };
}

// ---------- Diferencias entre versiones ----------

const clavePieza = (p) => clave(p.material || '', p.nombre);
const medidas = (p) => [p.largo, p.ancho, p.espesor].filter(Boolean).join(' × ');
const mismasMedidas = (a, b) => ['largo', 'ancho', 'espesor'].every((k) => medida(a[k]) === medida(b[k]));

export function diferencias(anterior, nuevo) {
  const res = { piezas: { agregadas: [], eliminadas: [], modificadas: [] }, materiales: { agregados: [], eliminados: [], modificados: [] } };
  const antes = new Map((anterior.piezas || []).map((p) => [clavePieza(p), p]));
  const despues = new Map((nuevo.piezas || []).map((p) => [clavePieza(p), p]));
  for (const [k, p] of despues) {
    const a = antes.get(k);
    if (!a) res.piezas.agregadas.push(`${p.nombre} (${p.cantidad})`);
    else {
      const cambios = [];
      if (Number(a.cantidad) !== Number(p.cantidad)) cambios.push(`cantidad ${a.cantidad} → ${p.cantidad}`);
      if (!mismasMedidas(a, p)) cambios.push(`medidas ${medidas(a) || '—'} → ${medidas(p) || '—'}`);
      if (cambios.length) res.piezas.modificadas.push(`${p.nombre}: ${cambios.join(', ')}`);
    }
  }
  for (const [k, p] of antes) if (!despues.has(k)) res.piezas.eliminadas.push(`${p.nombre} (${p.cantidad})`);

  const clavePlana = (m) => clave(m.nombre, medida(m.espesor), medida(m.formato));
  const mAntes = new Map((anterior.materiales || []).map((m) => [clavePlana(m), m]));
  const mDespues = new Map((nuevo.materiales || []).map((m) => [clavePlana(m), m]));
  const txt = (m) => (m.cantidad_comercial !== null && m.cantidad_comercial !== undefined ? `${m.cantidad_comercial} ${m.unidad_compra || ''}`.trim() : 'por definir');
  for (const [k, m] of mDespues) {
    const a = mAntes.get(k);
    if (!a) res.materiales.agregados.push(`${m.nombre}${m.espesor ? ` ${m.espesor}` : ''}`);
    else if (txt(a) !== txt(m) || Number(a.cantidad_piezas || 0) !== Number(m.cantidad_piezas || 0)) {
      const cambios = [];
      if (txt(a) !== txt(m)) cambios.push(`${txt(a)} → ${txt(m)}`);
      if (Number(a.cantidad_piezas || 0) !== Number(m.cantidad_piezas || 0)) cambios.push(`piezas ${a.cantidad_piezas || 0} → ${m.cantidad_piezas || 0}`);
      res.materiales.modificados.push(`${m.nombre}: ${cambios.join(', ')}`);
    }
  }
  for (const [k, m] of mAntes) if (!mDespues.has(k)) res.materiales.eliminados.push(`${m.nombre}${m.espesor ? ` ${m.espesor}` : ''}`);
  res.total = Object.values(res.piezas).flat().length + Object.values(res.materiales).flat().length;
  return res;
}
