const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('./config');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'spacio.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Aplica en orden los archivos .sql de server/migrations que aún no se han
// ejecutado. Para evolucionar la base de datos basta con agregar un nuevo
// archivo numerado (p. ej. 002_nueva_tabla.sql); nunca se editan los anteriores.
function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    nombre TEXT PRIMARY KEY,
    aplicada_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const dir = path.join(__dirname, 'migrations');
  const aplicadas = new Set(db.prepare('SELECT nombre FROM schema_migrations').pluck().all());
  const archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const archivo of archivos) {
    if (aplicadas.has(archivo)) continue;
    const sql = fs.readFileSync(path.join(dir, archivo), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (nombre) VALUES (?)').run(archivo);
    })();
    console.log(`Migración aplicada: ${archivo}`);
  }
}

module.exports = { db, migrate };
