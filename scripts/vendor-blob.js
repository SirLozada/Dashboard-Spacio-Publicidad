// Genera public/js/vendor/vercel-blob-client.js (subida directa a Vercel Blob
// desde el navegador). Ejecutar con: npm run vendor
const path = require('path');
require('esbuild')
  .build({
    stdin: { contents: 'export { upload } from "@vercel/blob/client";', resolveDir: path.join(__dirname, '..') },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    legalComments: 'none',
    // La librería consulta process.env (variables de Next.js); en el navegador no existe.
    banner: { js: 'const process = { env: {} };' },
    outfile: path.join(__dirname, '..', 'public', 'js', 'vendor', 'vercel-blob-client.js'),
  })
  .then(() => console.log('Listo: public/js/vendor/vercel-blob-client.js'));
