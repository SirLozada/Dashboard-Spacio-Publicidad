// Vista previa de diagramas DXF (los que exporta OpenCutList): convierte las
// entidades básicas a SVG. Lo usan el navegador (vista previa) y el servidor
// (para incluir el diagrama en los PDF del taller).
// Entidades: LINE, LWPOLYLINE, POLYLINE/VERTEX, CIRCLE, ARC, TEXT y MTEXT.

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function pares(texto) {
  const lineas = String(texto).split(/\r?\n/);
  const lista = [];
  for (let i = 0; i + 1 < lineas.length; i += 2) lista.push([Number(lineas[i].trim()), lineas[i + 1].trim()]);
  return lista;
}

// Devuelve las entidades de la sección ENTITIES como { tipo, datos: [[código, valor]...] }.
function entidades(texto) {
  const lista = pares(texto);
  const res = [];
  let enEntidades = false;
  let actual = null;
  for (let i = 0; i < lista.length; i++) {
    const [codigo, valor] = lista[i];
    if (codigo === 2 && lista[i - 1]?.[1] === 'SECTION') enEntidades = valor === 'ENTITIES';
    if (!enEntidades) continue;
    if (codigo === 0) {
      if (valor === 'ENDSEC') {
        enEntidades = false;
        actual = null;
        continue;
      }
      actual = { tipo: valor, datos: [] };
      res.push(actual);
    } else if (actual) actual.datos.push([codigo, valor]);
  }
  return res;
}

const num = (d, codigo, porDefecto = 0) => {
  const par = d.find(([c]) => c === codigo);
  return par ? Number(par[1]) : porDefecto;
};
const todos = (d, codigo) => d.filter(([c]) => c === codigo).map(([, v]) => Number(v));
const texto = (d) =>
  d
    .filter(([c]) => c === 1 || c === 3)
    .map(([, v]) => v)
    .join('')
    .replace(/\\P/g, ' ')
    .replace(/\\[A-Za-z][^;]*;/g, '')
    .replace(/[{}]/g, '');

export function dxfASvg(contenido) {
  const formas = [];
  const pts = [];
  const punto = (x, y) => pts.push([x, y]);
  const ents = entidades(contenido);
  for (let i = 0; i < ents.length; i++) {
    const { tipo, datos: d } = ents[i];
    if (tipo === 'LINE') {
      const [x1, y1, x2, y2] = [num(d, 10), num(d, 20), num(d, 11), num(d, 21)];
      punto(x1, y1);
      punto(x2, y2);
      formas.push({ t: 'linea', v: [x1, y1, x2, y2] });
    } else if (tipo === 'LWPOLYLINE') {
      const xs = todos(d, 10);
      const ys = todos(d, 20);
      const v = xs.map((x, k) => [x, ys[k] ?? 0]);
      v.forEach(([x, y]) => punto(x, y));
      formas.push({ t: 'poli', v, cerrada: (num(d, 70) & 1) === 1 });
    } else if (tipo === 'POLYLINE') {
      const v = [];
      const cerrada = (num(d, 70) & 1) === 1;
      while (ents[i + 1] && ents[i + 1].tipo === 'VERTEX') {
        i++;
        v.push([num(ents[i].datos, 10), num(ents[i].datos, 20)]);
      }
      v.forEach(([x, y]) => punto(x, y));
      formas.push({ t: 'poli', v, cerrada });
    } else if (tipo === 'CIRCLE' || tipo === 'ARC') {
      const [cx, cy, r] = [num(d, 10), num(d, 20), num(d, 40)];
      punto(cx - r, cy - r);
      punto(cx + r, cy + r);
      formas.push(tipo === 'CIRCLE' ? { t: 'circulo', v: [cx, cy, r] } : { t: 'arco', v: [cx, cy, r, num(d, 50), num(d, 51)] });
    } else if (tipo === 'TEXT' || tipo === 'MTEXT') {
      const [x, y, h] = [num(d, 10), num(d, 20), num(d, 40, 10)];
      punto(x, y);
      formas.push({ t: 'texto', v: [x, y, h, num(d, 50)], texto: texto(d) });
    }
  }
  if (!pts.length) return null;
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  const ancho = maxX - minX || 1;
  const alto = maxY - minY || 1;
  const margen = Math.max(ancho, alto) * 0.02;
  const trazo = Math.max(ancho, alto) / 800;
  // El eje Y del DXF va hacia arriba: se invierte para SVG.
  const X = (x) => +(x - minX + margen).toFixed(3);
  const Y = (y) => +(maxY - y + margen).toFixed(3);
  const partes = formas.map((f) => {
    if (f.t === 'linea') return `<line x1="${X(f.v[0])}" y1="${Y(f.v[1])}" x2="${X(f.v[2])}" y2="${Y(f.v[3])}"/>`;
    if (f.t === 'poli') return `<${f.cerrada ? 'polygon' : 'polyline'} points="${f.v.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ')}"/>`;
    if (f.t === 'circulo') return `<circle cx="${X(f.v[0])}" cy="${Y(f.v[1])}" r="${f.v[2]}"/>`;
    if (f.t === 'arco') {
      const [cx, cy, r, a1, a2] = f.v;
      const rad = (a) => (a * Math.PI) / 180;
      const x1 = cx + r * Math.cos(rad(a1));
      const y1 = cy + r * Math.sin(rad(a1));
      const x2 = cx + r * Math.cos(rad(a2));
      const y2 = cy + r * Math.sin(rad(a2));
      const barrido = (((a2 - a1) % 360) + 360) % 360;
      return `<path d="M${X(x1)} ${Y(y1)} A${r} ${r} 0 ${barrido > 180 ? 1 : 0} 0 ${X(x2)} ${Y(y2)}"/>`;
    }
    const [x, y, h, rot] = f.v;
    return `<text x="${X(x)}" y="${Y(y)}" font-size="${h}" stroke="none" fill="#111"${rot ? ` transform="rotate(${-rot} ${X(x)} ${Y(y)})"` : ''}>${esc(f.texto)}</text>`;
  });
  const w = +(ancho + margen * 2).toFixed(3);
  const hTotal = +(alto + margen * 2).toFixed(3);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${hTotal}" width="${w}" height="${hTotal}" font-family="Helvetica, Arial, sans-serif">
<rect width="100%" height="100%" fill="#fff"/>
<g fill="none" stroke="#111" stroke-width="${+trazo.toFixed(3)}">${partes.join('')}</g></svg>`;
}
