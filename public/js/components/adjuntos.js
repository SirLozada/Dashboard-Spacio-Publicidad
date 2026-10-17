// Subida de archivos adjuntos, compartida por trabajos y solicitudes.
import { api } from '../api.js';
import { state } from '../state.js';

const nombreSeguro = (n) => n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '-').slice(-100);

// Reduce las fotos grandes (máx. 2000 px, JPEG) antes de subirlas: se ven igual
// en pantalla y ocupan mucho menos espacio en el almacenamiento gratuito.
export async function comprimirFoto(f) {
  if (!/^image\/(jpeg|png|webp)$/.test(f.type) || f.size < 800 * 1024) return f;
  try {
    const img = await createImageBitmap(f);
    const escala = Math.min(1, 2000 / Math.max(img.width, img.height));
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.round(img.width * escala);
    lienzo.height = Math.round(img.height * escala);
    const ctx = lienzo.getContext('2d');
    ctx.fillStyle = '#fff'; // fondo blanco para PNG con transparencia
    ctx.fillRect(0, 0, lienzo.width, lienzo.height);
    ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
    const blob = await new Promise((ok) => lienzo.toBlob(ok, 'image/jpeg', 0.82));
    if (!blob || blob.size >= f.size) return f;
    return new File([blob], f.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return f;
  }
}

// Sube archivos y devuelve la respuesta de la API (lista actualizada de adjuntos).
// ruta: endpoint de adjuntos en la API (p. ej. "/trabajos/5/adjuntos").
// carpeta: prefijo de los archivos en Vercel Blob (p. ej. "trabajos/5").
// extra: campos adicionales que se envían junto a cada archivo.
// En Vercel cada archivo va directo a Vercel Blob y luego se registra en la API.
export async function subirArchivos({ ruta, carpeta, archivos, extra = {} }) {
  archivos = await Promise.all(archivos.map(comprimirFoto));
  if (state.config.subidas === 'blob') {
    const { upload } = await import('/js/vendor/vercel-blob-client.js');
    let respuesta = [];
    for (const f of archivos) {
      const blob = await upload(`${carpeta}/${nombreSeguro(f.name)}`, f, {
        access: state.config.accesoBlob,
        handleUploadUrl: `/api${ruta}/permiso`,
      });
      respuesta = await api(`${ruta}/registrar`, {
        method: 'POST',
        body: { ...extra, url: blob.url, nombre: f.name, mime: f.type || blob.contentType, tamano: f.size },
      });
    }
    return respuesta;
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  for (const f of archivos) form.append('archivos', f);
  return api(ruta, { method: 'POST', form });
}
