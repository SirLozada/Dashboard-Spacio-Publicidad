// Orden de producción para el taller (PDF). Reúne lo que ya está registrado en
// el proyecto: datos del trabajo, piezas y materiales de la cotización aprobada
// e imágenes adjuntas. Nunca incluye precios, costos, márgenes ni pagos.
const { db } = require('../db');
const config = require('../config');
const almacen = require('./almacen');
const estatus = require('./estatus');
const ocl = require('./opencutlist');
const { nuevoDocumento, terminar, prepararDiagramas, dibujarDespiece, fechaTxt, cantidadTxt, NEGRO, TEXTO2 } = require('./documento-taller');

const numeroTrabajo = (n) => `${config.PREFIJO_TRABAJO}${String(n).padStart(4, '0')}`;
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

  const despiece = await ocl.resumenVigente(trabajoId);

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
    despiece,
    faltantes,
  };
}

// Genera el PDF y lo envía en "salida" (respuesta HTTP).
// idsImagenes: adjuntos a incluir (null = todas las compatibles).
// opciones.despiece: incluir piezas y materiales de OpenCutList; opciones.diagramas: sus diagramas de corte.
async function generarPdf(datos, idsImagenes, salida, opciones = {}) {
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
  const despiece = opciones.despiece || opciones.diagramas ? await ocl.cargarVersion(t.id) : null;
  const diagramas = despiece && opciones.diagramas ? await prepararDiagramas(despiece.archivos) : { svgs: [], pdfs: [] };

  const ctx = nuevoDocumento({
    titulo: 'Orden de producción',
    codigo: t.codigo,
    datos: [
      ['Cliente', t.cliente],
      ['Marca', t.marca],
      ['Tienda', t.tienda],
      ['Ubicación', t.ubicacion],
      ['Fecha de inicio', fechaTxt(t.fecha_inicio)],
      ['Fecha de entrega', fechaTxt(t.fecha_entrega)],
      ['Responsable', t.responsable],
    ],
  });
  const { doc, izq, ancho, asegurar, tituloSeccion: titulo, parrafo, tabla } = ctx;

  if (t.descripcion) {
    titulo('Descripción del trabajo');
    parrafo(t.descripcion);
  }
  if (t.especificaciones_tecnicas) {
    titulo('Medidas y especificaciones técnicas');
    parrafo(t.especificaciones_tecnicas);
  }

  // --- Piezas, cantidades y materiales (cotización aprobada) ---
  if (piezas.length) {
    titulo('Piezas a fabricar y materiales requeridos');
    for (const p of piezas) {
      asegurar(60);
      const yNombre = doc.y;
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(NEGRO).text(p.nombre, izq, yNombre, { width: ancho - 130 });
      const yFin = doc.y;
      doc.font('Helvetica-Bold').fontSize(11).text(`Cantidad: ${cantidadTxt(p.cantidad)}`, izq + ancho - 120, yNombre, { width: 120, align: 'right' });
      doc.y = Math.max(yFin, yNombre + 16);
      if (p.descripcion) {
        doc.font('Helvetica').fontSize(9.5).fillColor(TEXTO2).text(p.descripcion, izq, doc.y, { width: ancho, lineGap: 1.5 });
        doc.moveDown(0.3);
      }
      if (p.materiales.length) {
        tabla(
          [
            { titulo: 'Material', ancho: 0.36 },
            { titulo: 'Descripción', ancho: 0.46 },
            { titulo: 'Cantidad', ancho: 0.18, derecha: true },
          ],
          p.materiales.map((m) => [m.material, m.descripcion || '', cantidadTxt(m.cantidad)])
        );
      }
      doc.moveDown(0.6);
    }
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(TEXTO2)
      .text('Las cantidades de materiales corresponden al total de unidades de cada pieza.', izq, doc.y, { width: ancho });
  }

  // --- Despiece de OpenCutList ---
  if (despiece) dibujarDespiece(ctx, despiece, diagramas, { piezas: !!opciones.despiece, materiales: !!opciones.despiece, diagramas: !!opciones.diagramas });

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

  await terminar(doc, t.codigo, salida, diagramas.pdfs);
}

module.exports = { datosOrden, generarPdf };
