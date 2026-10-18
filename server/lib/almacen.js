// Almacenamiento de archivos adjuntos.
// - Local: los archivos se guardan en DATA_DIR/adjuntos (servidor propio o desarrollo).
// - Vercel Blob: si existe BLOB_READ_WRITE_TOKEN. El navegador sube el archivo
//   directamente a Blob (así no aplica el límite de 4,5 MB de las funciones de
//   Vercel) y después registra el adjunto en la base de datos.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const multer = require('multer');
const config = require('../config');
const { HttpError } = require('./util');

const MODO = process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'local';
const ACCESO_BLOB = process.env.BLOB_ACCESS === 'private' ? 'private' : 'public';
const MAX_BYTES = config.MAX_ARCHIVO_MB * 1024 * 1024;
const DIR_LOCAL = path.join(config.DATA_DIR, 'adjuntos');

const esUrlBlob = (archivo) => /^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\//i.test(archivo || '');

// Middleware de subida para el modo local.
function subidaLocal() {
  fs.mkdirSync(DIR_LOCAL, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: DIR_LOCAL,
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: MAX_BYTES, files: 20 },
  }).array('archivos', 20);
}

// Responde a la librería @vercel/blob/client generando el permiso de subida.
// carpeta: prefijo obligatorio de la ruta del archivo, p. ej. "trabajos/5".
async function tokenSubida(req, carpeta) {
  const { handleUpload } = require('@vercel/blob/client');
  return handleUpload({
    body: req.body,
    request: req,
    onBeforeGenerateToken: async (pathname) => {
      if (!pathname.startsWith(`${carpeta}/`)) throw new HttpError(400, 'Ruta de archivo no válida');
      return { addRandomSuffix: true, maximumSizeInBytes: MAX_BYTES };
    },
  });
}

// Sólo imágenes (no SVG) y PDF se muestran en el navegador; el resto se descarga.
const MIME_EN_LINEA = /^(image\/(png|jpe?g|gif|webp|avif|heic|heif|bmp)|application\/pdf)$/;

async function enviar(req, res, adjunto) {
  const enLinea = MIME_EN_LINEA.test(adjunto.mime || '') && req.query.descargar === undefined;
  const disposicion = `${enLinea ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(adjunto.nombre_original)}`;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  if (esUrlBlob(adjunto.archivo)) {
    if (ACCESO_BLOB === 'public') {
      const url = new URL(adjunto.archivo);
      if (!enLinea) url.searchParams.set('download', '1');
      return res.redirect(302, url.toString());
    }
    const { get } = require('@vercel/blob');
    const r = await get(adjunto.archivo, { access: 'private' });
    if (!r || r.statusCode !== 200) throw new HttpError(404, 'Archivo no encontrado');
    res.setHeader('Content-Type', enLinea ? adjunto.mime : 'application/octet-stream');
    res.setHeader('Content-Disposition', disposicion);
    return Readable.fromWeb(r.stream).pipe(res);
  }

  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('Content-Type', enLinea ? adjunto.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', disposicion);
  res.sendFile(path.join(DIR_LOCAL, path.basename(adjunto.archivo)));
}

// Contenido de un archivo (p. ej. imágenes para la orden de producción).
async function leer(archivo) {
  if (esUrlBlob(archivo)) {
    if (ACCESO_BLOB === 'public') {
      const r = await fetch(archivo);
      if (!r.ok) throw new Error(`No se pudo leer el archivo (${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    }
    const { get } = require('@vercel/blob');
    const r = await get(archivo, { access: 'private' });
    if (!r || r.statusCode !== 200) throw new Error('Archivo no encontrado');
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  }
  return fs.promises.readFile(path.join(DIR_LOCAL, path.basename(archivo)));
}

async function borrar(archivo) {
  try {
    if (esUrlBlob(archivo)) {
      const { del } = require('@vercel/blob');
      await del(archivo);
    } else {
      await fs.promises.rm(path.join(DIR_LOCAL, path.basename(archivo)), { force: true });
    }
  } catch (err) {
    console.error('No se pudo borrar el archivo', archivo, err.message);
  }
}

module.exports = { MODO, ACCESO_BLOB, MAX_BYTES, esUrlBlob, subidaLocal, tokenSubida, enviar, leer, borrar };
