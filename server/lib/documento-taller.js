// Documentos PDF para el taller (orden de producción y despiece de OpenCutList):
// encabezado y pie comunes, tablas del despiece y diagramas de corte.
// Nunca incluyen precios, costos ni pagos.
const path = require('path');
const { pathToFileURL } = require('url');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');
const config = require('../config');
const almacen = require('./almacen');
const { hoy } = require('./util');

const NEGRO = '#0a0a0b';
const GRIS = '#f1f1f1';
const TEXTO2 = '#475569';
const fechaTxt = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
const cantidadTxt = (n) => new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 }).format(Number(n) || 0);
const piezasTxt = (n) => `${cantidadTxt(n)} ${Number(n) === 1 ? 'pieza' : 'piezas'}`;

let libDxf;
const cargarDxf = () => (libDxf ??= import(pathToFileURL(path.join(__dirname, '..', '..', 'public', 'js', 'lib', 'dxf.js')).href));

// Crea el documento con el encabezado de Spacio y devuelve ayudas de maquetación.
function nuevoDocumento({ titulo, codigo, datos = [] }) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 40, bottom: 56, left: 40, right: 40 },
    bufferPages: true,
    info: { Title: `${titulo} ${codigo}`, Author: config.EMPRESA.nombre },
  });
  const izq = 40;
  const ancho = doc.page.width - 80;
  const limite = () => doc.page.height - doc.page.margins.bottom;
  const asegurar = (alto) => {
    if (doc.y + alto > limite()) doc.addPage();
  };

  doc.rect(0, 0, doc.page.width, 92).fill(NEGRO);
  doc.image(path.join(__dirname, '..', '..', 'public', 'img', 'logo-claro.png'), izq, 20, { height: 52 });
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text(titulo.toUpperCase(), izq, 24, { width: ancho, align: 'right' });
  doc.font('Helvetica').fontSize(10).text(`Proyecto ${codigo}`, izq, 46, { width: ancho, align: 'right' });
  doc.text(`Emitida: ${fechaTxt(hoy())}`, izq, 60, { width: ancho, align: 'right' });
  const franja = doc.page.width / 3;
  ['#fcc127', '#e02d8b', '#2197d4'].forEach((c, i) => doc.rect(franja * i, 92, franja, 4).fill(c));
  doc.y = 112;

  // Datos del proyecto en dos columnas.
  const visibles = datos.filter(([, v]) => v);
  const colAncho = ancho / 2;
  const yInicio = doc.y;
  visibles.forEach(([etiqueta, valor], i) => {
    const x = izq + (i % 2) * colAncho;
    const y = yInicio + Math.floor(i / 2) * 30;
    doc.fillColor(TEXTO2).font('Helvetica-Bold').fontSize(8).text(etiqueta.toUpperCase(), x, y, { width: colAncho - 10 });
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(11).text(String(valor), x, y + 10, { width: colAncho - 10, height: 16, ellipsis: true });
  });
  doc.y = yInicio + Math.ceil(visibles.length / 2) * 30 + 6;

  const tituloSeccion = (texto) => {
    asegurar(40);
    doc.moveDown(0.6);
    const y = doc.y;
    doc.rect(izq, y, ancho, 18).fill(NEGRO);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5).text(texto.toUpperCase(), izq + 8, y + 5, { width: ancho - 16 });
    doc.y = y + 24;
    doc.fillColor(NEGRO);
  };
  const parrafo = (texto) => {
    doc.font('Helvetica').fontSize(10.5).fillColor(NEGRO);
    for (const linea of String(texto).split('\n')) {
      asegurar(16);
      doc.text(linea || ' ', izq, doc.y, { width: ancho, lineGap: 2 });
    }
  };
  // Tabla simple con encabezado gris; columnas: [{ titulo, ancho (fracción), derecha }]
  const tabla = (columnas, filas, { tamano = 9.5 } = {}) => {
    const cols = columnas.map((c) => ({ ...c, w: ancho * c.ancho }));
    const encabezado = () => {
      const y = doc.y + 2;
      doc.rect(izq, y, ancho, 16).fill(GRIS);
      let x = izq;
      doc.fillColor(TEXTO2).font('Helvetica-Bold').fontSize(7.5);
      for (const c of cols) {
        doc.text(c.titulo.toUpperCase(), x + 5, y + 5, { width: c.w - 10, align: c.derecha ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += c.w;
      }
      doc.y = y + 18;
    };
    asegurar(40);
    encabezado();
    doc.font('Helvetica').fontSize(tamano).fillColor(NEGRO);
    for (const fila of filas) {
      const valores = fila.map((v) => String(v ?? ''));
      const alto = Math.max(...valores.map((v, i) => doc.heightOfString(v || ' ', { width: cols[i].w - 10 }))) + 6;
      if (doc.y + alto > limite()) {
        doc.addPage();
        encabezado();
        doc.font('Helvetica').fontSize(tamano).fillColor(NEGRO);
      }
      const y = doc.y;
      let x = izq;
      valores.forEach((v, i) => {
        doc.text(v, x + 5, y + 3, { width: cols[i].w - 10, align: cols[i].derecha ? 'right' : 'left' });
        x += cols[i].w;
      });
      doc.y = y + alto;
      doc.moveTo(izq, doc.y).lineTo(izq + ancho, doc.y).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
    }
    doc.y += 4;
  };

  return { doc, izq, ancho, limite, asegurar, tituloSeccion, parrafo, tabla };
}

// Pie en todas las páginas, une los PDF anexos (diagramas) y envía el resultado.
async function terminar(doc, codigo, salida, anexos = []) {
  const rango = doc.bufferedPageRange();
  for (let i = 0; i < rango.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - 36;
    doc.page.margins.bottom = 0; // permite escribir en el pie sin abrir otra página
    doc.font('Helvetica').fontSize(7.5).fillColor(TEXTO2);
    doc.text(`${config.EMPRESA.nombre} · RIF ${config.EMPRESA.rif} · ${config.EMPRESA.telefono} · ${config.EMPRESA.correo}`, 40, y, {
      width: doc.page.width - 80 - 90,
      lineBreak: false,
    });
    doc.text(`${codigo} · Página ${i + 1} de ${rango.count}`, doc.page.width - 40 - 150, y, { width: 150, align: 'right', lineBreak: false });
  }
  const partes = [];
  doc.on('data', (c) => partes.push(c));
  const fin = new Promise((ok) => doc.on('end', ok));
  doc.end();
  await fin;
  let buffer = Buffer.concat(partes);
  if (anexos.length) {
    // Diagramas de corte en PDF: se agregan sus páginas al final.
    const { PDFDocument: PdfLib } = require('pdf-lib');
    const final = await PdfLib.load(buffer);
    for (const a of anexos) {
      try {
        const origen = await PdfLib.load(a.buffer, { ignoreEncryption: true });
        const paginas = await final.copyPages(origen, origen.getPageIndices());
        paginas.forEach((p) => final.addPage(p));
      } catch (err) {
        console.error('No se pudo anexar el PDF', a.nombre, err.message);
      }
    }
    buffer = Buffer.from(await final.save());
  }
  salida.setHeader('Content-Length', buffer.length);
  salida.end(buffer);
}

// ---------- Despiece de OpenCutList ----------

// Lee los diagramas de corte: SVG y DXF se dibujan en el documento; los PDF se anexan.
async function prepararDiagramas(archivos) {
  const svgs = [];
  const pdfs = [];
  for (const a of archivos.filter((x) => ['svg', 'dxf', 'pdf'].includes(x.tipo))) {
    try {
      const buffer = await almacen.leer(a.archivo);
      if (a.tipo === 'pdf') pdfs.push({ nombre: a.nombre_original, buffer });
      else {
        const svg = a.tipo === 'dxf' ? (await cargarDxf()).dxfASvg(buffer.toString('utf8')) : buffer.toString('utf8');
        if (svg) svgs.push({ nombre: a.nombre_original, svg });
      }
    } catch (err) {
      console.error('Diagrama no disponible', a.id, err.message);
    }
  }
  return { svgs, pdfs };
}

// Proporción de un SVG (viewBox o ancho/alto).
function proporcion(svg) {
  const vb = svg.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (vb) return Number(vb[2]) / Number(vb[1]) || 0.6;
  const w = Number(svg.match(/\bwidth\s*=\s*["']([\d.]+)/i)?.[1]);
  const h = Number(svg.match(/\bheight\s*=\s*["']([\d.]+)/i)?.[1]);
  return w && h ? h / w : 0.6;
}

// Dibuja materiales requeridos, despiece y diagramas SVG/DXF.
// d: { materiales, piezas, version, creado_en }  ·  opciones: { piezas, materiales, diagramas }
function dibujarDespiece(ctx, d, diagramas, opciones = {}) {
  const { doc, izq, ancho, limite, asegurar, tituloSeccion, tabla } = ctx;
  const { piezas: conPiezas = true, materiales: conMateriales = true, diagramas: conDiagramas = true } = opciones;
  if (conMateriales && d.materiales.length) {
    tituloSeccion(`Materiales requeridos (OpenCutList · versión ${d.version})`);
    tabla(
      [
        { titulo: 'Material', ancho: 0.3 },
        { titulo: 'Tipo / espesor', ancho: 0.2 },
        { titulo: 'Formato', ancho: 0.17 },
        { titulo: 'A comprar', ancho: 0.15, derecha: true },
        { titulo: 'Observaciones', ancho: 0.18 },
      ],
      d.materiales.map((m) => [
        m.nombre,
        [m.tipo, m.espesor].filter(Boolean).join(' · '),
        m.formato || '—',
        m.cantidad_comercial !== null && m.cantidad_comercial !== undefined ? `${cantidadTxt(m.cantidad_comercial)} ${m.unidad_compra || ''}`.trim() : 'Por definir',
        [m.cantidad_piezas ? piezasTxt(m.cantidad_piezas) : '', m.total, m.observaciones].filter(Boolean).join(' · '),
      ])
    );
  }
  if (conPiezas && d.piezas.length) {
    tituloSeccion('Despiece');
    // Agrupado por material, como se corta en el taller.
    const grupos = new Map();
    for (const p of d.piezas) {
      const k = p.material || 'Sin material';
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(p);
    }
    for (const [material, lista] of grupos) {
      asegurar(50);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NEGRO).text(`${material} · ${piezasTxt(lista.reduce((s, p) => s + Number(p.cantidad || 0), 0))}`, izq, doc.y + 2, { width: ancho });
      tabla(
        [
          { titulo: 'N°', ancho: 0.07 },
          { titulo: 'Pieza', ancho: 0.27 },
          { titulo: 'Cant.', ancho: 0.08, derecha: true },
          { titulo: 'Largo', ancho: 0.12, derecha: true },
          { titulo: 'Ancho', ancho: 0.12, derecha: true },
          { titulo: 'Espesor', ancho: 0.1, derecha: true },
          { titulo: 'Observaciones', ancho: 0.24 },
        ],
        lista.map((p) => [p.numero || '', p.nombre, cantidadTxt(p.cantidad), p.largo || '', p.ancho || '', p.espesor || '', p.observaciones || '']),
        { tamano: 9 }
      );
    }
  }
  if (conDiagramas && diagramas.svgs.length) {
    // El título no queda solo al final de la página: va junto al primer diagrama.
    asegurar(Math.min(ancho * proporcion(diagramas.svgs[0].svg), limite() - 120) + 60);
    tituloSeccion('Diagramas de corte');
    for (const { nombre, svg } of diagramas.svgs) {
      const alto = Math.min(ancho * proporcion(svg), limite() - 120);
      asegurar(alto + 24);
      try {
        SVGtoPDF(doc, svg, izq, doc.y, { width: ancho, height: alto, preserveAspectRatio: 'xMidYMid meet', assumePt: true });
      } catch (err) {
        console.error('Diagrama SVG no válido', nombre, err.message);
      }
      doc.y += alto + 3;
      doc.font('Helvetica').fontSize(8).fillColor(TEXTO2).text(nombre, izq, doc.y, { width: ancho, align: 'center' });
      doc.moveDown(0.8);
    }
  }
  if (conDiagramas && diagramas.pdfs.length) {
    asegurar(30);
    doc.moveDown(0.5);
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(TEXTO2)
      .text(`Diagramas de corte en PDF al final del documento: ${diagramas.pdfs.map((p) => p.nombre).join(', ')}.`, izq, doc.y, { width: ancho });
  }
}

module.exports = { nuevoDocumento, terminar, prepararDiagramas, dibujarDespiece, fechaTxt, cantidadTxt, NEGRO, TEXTO2 };
