// Orden de producción para el taller (PDF). Reúne lo que ya está registrado en
// el proyecto: datos del trabajo, piezas y materiales de la cotización aprobada
// e imágenes adjuntas. Nunca incluye precios, costos, márgenes ni pagos.
const path = require('path');
const PDFDocument = require('pdfkit');
const { db } = require('../db');
const config = require('../config');
const almacen = require('./almacen');
const estatus = require('./estatus');
const { hoy } = require('./util');

const numeroTrabajo = (n) => `${config.PREFIJO_TRABAJO}${String(n).padStart(4, '0')}`;
const fechaTxt = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
const cantidadTxt = (n) => new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 }).format(Number(n) || 0);
// pdfkit sólo admite JPEG y PNG.
const IMAGEN_COMPATIBLE = /^image\/(jpeg|jpg|png)$/;
// Líneas de costo que no son materiales para el taller.
const NO_ES_MATERIAL = /^\s*mano\s+de\s+obra/i;

// Datos de la orden: se usan tanto para el formulario previo como para el PDF.
async function datosOrden(trabajoId) {
  const t = await db.get('SELECT * FROM trabajos WHERE id = ?', trabajoId);
  if (!t) return null;
  const cot = await db.get(
    `SELECT id, numero FROM cotizaciones WHERE trabajo_id = ? AND estado = 'aprobada' AND unificada_en IS NULL
     ORDER BY numero DESC LIMIT 1`,
    trabajoId
  );
  let piezas = [];
  if (cot) {
    const [filas, lineas] = await Promise.all([
      db.all('SELECT id, nombre, cantidad, descripcion_cliente FROM cotizacion_piezas WHERE cotizacion_id = ? ORDER BY orden, id', cot.id),
      db.all(
        `SELECT l.pieza_id, l.material, l.descripcion, l.cantidad FROM cotizacion_lineas l
         JOIN cotizacion_piezas p ON p.id = l.pieza_id WHERE p.cotizacion_id = ? ORDER BY l.orden, l.id`,
        cot.id
      ),
    ]);
    piezas = filas.map((p) => ({
      nombre: p.nombre,
      cantidad: p.cantidad,
      descripcion: p.descripcion_cliente,
      materiales: lineas
        .filter((l) => l.pieza_id === p.id && l.material && !NO_ES_MATERIAL.test(l.material))
        .map((l) => ({ material: l.material, descripcion: l.descripcion, cantidad: (Number(l.cantidad) || 0) * (Number(p.cantidad) || 1) })),
    }));
  }
  const adjuntos = await db.all('SELECT id, nombre_original, mime, archivo FROM adjuntos WHERE trabajo_id = ? ORDER BY id', trabajoId);
  const imagenes = adjuntos
    .filter((a) => /^image\//.test(a.mime || ''))
    .map((a) => ({ id: a.id, nombre: a.nombre_original, compatible: IMAGEN_COMPATIBLE.test(a.mime), archivo: a.archivo }));

  const faltantes = [];
  if (!t.descripcion) faltantes.push('descripcion');
  if (!t.fecha_inicio) faltantes.push('fecha_inicio');
  if (!t.fecha_entrega) faltantes.push('fecha_entrega');
  if (!t.especificaciones_tecnicas && !piezas.some((p) => p.descripcion)) faltantes.push('especificaciones_tecnicas');

  return {
    trabajo: {
      id: t.id,
      codigo: numeroTrabajo(t.numero),
      cliente: t.cliente,
      marca: t.marca,
      tienda: t.tienda,
      ubicacion: t.ubicacion,
      descripcion: t.descripcion,
      responsable: t.responsable,
      fecha_inicio: t.fecha_inicio,
      fecha_entrega: t.fecha_entrega,
      especificaciones_tecnicas: t.especificaciones_tecnicas,
      observaciones_fabricacion: t.observaciones_fabricacion,
      estatus: t.estatus,
      aprobado: estatus.lista(t.estatus).some((k) => config.ESTATUS_APROBADOS.includes(k)),
    },
    cotizacion: cot ? `COT-${String(cot.numero).padStart(4, '0')}` : null,
    piezas,
    imagenes,
    faltantes,
  };
}

// Genera el PDF y lo escribe en "salida" (respuesta HTTP).
// idsImagenes: adjuntos a incluir (null = todas las compatibles).
async function generarPdf(datos, idsImagenes, salida) {
  const { trabajo: t, piezas } = datos;
  const elegidas = datos.imagenes.filter((i) => i.compatible && (!idsImagenes || idsImagenes.includes(i.id)));
  const imagenes = [];
  for (const img of elegidas) {
    try {
      imagenes.push({ ...img, buffer: await almacen.leer(img.archivo) });
    } catch (err) {
      console.error('Orden de producción: no se pudo leer la imagen', img.id, err.message);
    }
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 40, bottom: 56, left: 40, right: 40 },
    bufferPages: true,
    info: { Title: `Orden de producción ${t.codigo}`, Author: config.EMPRESA.nombre },
  });
  doc.pipe(salida);
  const ancho = doc.page.width - 80;
  const izq = 40;
  const NEGRO = '#0a0a0b';
  const GRIS = '#f1f1f1';
  const TEXTO2 = '#475569';
  const limite = () => doc.page.height - doc.page.margins.bottom;
  const asegurar = (alto) => {
    if (doc.y + alto > limite()) doc.addPage();
  };

  // --- Encabezado ---
  doc.rect(0, 0, doc.page.width, 92).fill(NEGRO);
  doc.image(path.join(__dirname, '..', '..', 'public', 'img', 'logo-claro.png'), izq, 20, { height: 52 });
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text('ORDEN DE PRODUCCIÓN', izq, 24, { width: ancho, align: 'right' });
  doc.font('Helvetica').fontSize(10).text(`Proyecto ${t.codigo}`, izq, 46, { width: ancho, align: 'right' });
  doc.text(`Emitida: ${fechaTxt(hoy())}`, izq, 60, { width: ancho, align: 'right' });
  const franja = doc.page.width / 3;
  ['#fcc127', '#e02d8b', '#2197d4'].forEach((c, i) => doc.rect(franja * i, 92, franja, 4).fill(c));
  doc.y = 112;

  // --- Datos del proyecto ---
  const datosProyecto = [
    ['Cliente', t.cliente],
    ['Marca', t.marca],
    ['Tienda', t.tienda],
    ['Ubicación', t.ubicacion],
    ['Fecha de inicio', fechaTxt(t.fecha_inicio)],
    ['Fecha de entrega', fechaTxt(t.fecha_entrega)],
    ['Responsable', t.responsable],
  ].filter(([, v]) => v);
  const colAncho = ancho / 2;
  const yInicio = doc.y;
  datosProyecto.forEach(([etiqueta, valor], i) => {
    const x = izq + (i % 2) * colAncho;
    const y = yInicio + Math.floor(i / 2) * 30;
    doc.fillColor(TEXTO2).font('Helvetica-Bold').fontSize(8).text(etiqueta.toUpperCase(), x, y, { width: colAncho - 10 });
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(11).text(String(valor), x, y + 10, { width: colAncho - 10, height: 16, ellipsis: true });
  });
  doc.y = yInicio + Math.ceil(datosProyecto.length / 2) * 30 + 6;

  const titulo = (texto) => {
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

  if (t.descripcion) {
    titulo('Descripción del trabajo');
    parrafo(t.descripcion);
  }
  if (t.especificaciones_tecnicas) {
    titulo('Medidas y especificaciones técnicas');
    parrafo(t.especificaciones_tecnicas);
  }

  // --- Piezas, cantidades y materiales ---
  if (piezas.length) {
    titulo('Piezas a fabricar y materiales requeridos');
    const cols = [
      { titulo: 'Material', ancho: ancho * 0.36 },
      { titulo: 'Descripción', ancho: ancho * 0.46 },
      { titulo: 'Cantidad', ancho: ancho * 0.18, derecha: true },
    ];
    for (const p of piezas) {
      asegurar(60);
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(NEGRO)
        .text(`${p.nombre}`, izq, doc.y, { width: ancho - 120, continued: false });
      const yNombre = doc.y - 14;
      doc.font('Helvetica-Bold').fontSize(11).text(`Cantidad: ${cantidadTxt(p.cantidad)}`, izq + ancho - 120, yNombre, { width: 120, align: 'right' });
      doc.y = Math.max(doc.y, yNombre + 16);
      if (p.descripcion) {
        doc.font('Helvetica').fontSize(9.5).fillColor(TEXTO2).text(p.descripcion, izq, doc.y, { width: ancho, lineGap: 1.5 });
        doc.moveDown(0.3);
      }
      if (p.materiales.length) {
        asegurar(36);
        let y = doc.y + 2;
        doc.rect(izq, y, ancho, 16).fill(GRIS);
        let x = izq;
        doc.fillColor(TEXTO2).font('Helvetica-Bold').fontSize(8);
        for (const c of cols) {
          doc.text(c.titulo.toUpperCase(), x + 6, y + 5, { width: c.ancho - 12, align: c.derecha ? 'right' : 'left' });
          x += c.ancho;
        }
        y += 18;
        doc.font('Helvetica').fontSize(9.5).fillColor(NEGRO);
        for (const m of p.materiales) {
          const valores = [m.material, m.descripcion || '', cantidadTxt(m.cantidad)];
          const alto = Math.max(...valores.map((v, i) => doc.heightOfString(String(v), { width: cols[i].ancho - 12 }))) + 6;
          if (y + alto > limite()) {
            doc.addPage();
            y = doc.y;
          }
          x = izq;
          valores.forEach((v, i) => {
            doc.text(String(v), x + 6, y + 3, { width: cols[i].ancho - 12, align: cols[i].derecha ? 'right' : 'left' });
            x += cols[i].ancho;
          });
          y += alto;
          doc.moveTo(izq, y).lineTo(izq + ancho, y).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
        }
        doc.y = y + 4;
      }
      doc.moveDown(0.6);
    }
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(TEXTO2)
      .text('Las cantidades de materiales corresponden al total de unidades de cada pieza.', izq, doc.y, { width: ancho });
  }

  if (t.observaciones_fabricacion) {
    titulo('Observaciones de fabricación');
    parrafo(t.observaciones_fabricacion);
  }

  // --- Imágenes de referencia ---
  const abiertas = imagenes
    .map((img) => {
      try {
        return { ...img, abierta: doc.openImage(img.buffer) };
      } catch (err) {
        console.error('Orden de producción: imagen no válida', img.id, err.message);
        return null;
      }
    })
    .filter(Boolean);
  const medidas = (a) => {
    const escala = Math.min(ancho / a.width, 320 / a.height, 1);
    return { w: a.width * escala, h: a.height * escala };
  };
  if (abiertas.length) {
    asegurar(medidas(abiertas[0].abierta).h + 70); // el título no queda solo al final de la página
    titulo('Renders, planos y fotografías de referencia');
    for (const { abierta, nombre } of abiertas) {
      const { w, h } = medidas(abierta);
      asegurar(h + 22);
      doc.image(abierta, izq + (ancho - w) / 2, doc.y, { width: w, height: h });
      doc.y += h + 3;
      doc.font('Helvetica').fontSize(8).fillColor(TEXTO2).text(nombre, izq, doc.y, { width: ancho, align: 'center' });
      doc.moveDown(0.8);
    }
  }

  // --- Control del taller ---
  asegurar(70);
  doc.moveDown(1.2);
  const yFirma = doc.y + 30;
  const mitad = (ancho - 30) / 2;
  doc.lineWidth(0.8).strokeColor(NEGRO);
  for (const [i, etiqueta] of ['Entregado por (Spacio)', 'Recibido por (taller) · fecha'].entries()) {
    const x = izq + i * (mitad + 30);
    doc.moveTo(x, yFirma).lineTo(x + mitad, yFirma).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(TEXTO2).text(etiqueta, x, yFirma + 4, { width: mitad, align: 'center' });
  }

  // --- Pie en todas las páginas ---
  const rango = doc.bufferedPageRange();
  for (let i = 0; i < rango.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - 36;
    doc.page.margins.bottom = 0; // permite escribir en el pie sin abrir otra página
    doc.font('Helvetica').fontSize(7.5).fillColor(TEXTO2);
    doc.text(`${config.EMPRESA.nombre} · RIF ${config.EMPRESA.rif} · ${config.EMPRESA.telefono} · ${config.EMPRESA.correo}`, izq, y, {
      width: ancho - 90,
      lineBreak: false,
    });
    doc.text(`${t.codigo} · Página ${i + 1} de ${rango.count}`, izq + ancho - 150, y, { width: 150, align: 'right', lineBreak: false });
  }
  doc.end();
}

module.exports = { datosOrden, generarPdf };
