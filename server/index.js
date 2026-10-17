// Arranque como servidor propio (desarrollo local, VPS o Docker).
// En Vercel se usa api/index.js, que exporta la misma aplicación.
const app = require('./app');
const config = require('./config');

app
  .preparar()
  .then(() =>
    app.listen(config.PORT, () => {
      console.log(`Spacio Publicidad · Dashboard disponible en http://localhost:${config.PORT}`);
    })
  )
  .catch((err) => {
    console.error('No se pudo iniciar:', err);
    process.exit(1);
  });
