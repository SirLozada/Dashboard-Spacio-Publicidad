// Acceso a la base de datos (libSQL / SQLite).
// - En local usa un archivo SQLite dentro de DATA_DIR.
// - En Vercel usa Turso (variables TURSO_DATABASE_URL y TURSO_AUTH_TOKEN).
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');
const { DATA_DIR } = require('./config');

// Busca la conexión a Turso. La integración de Vercel puede crear las variables
// con otro prefijo (p. ej. STORAGE_URL / STORAGE_AUTH_TOKEN), así que se acepta
// cualquier variable cuyo valor sea una URL libsql://. Las URL de otras bases
// (p. ej. postgres:// de Neon) se ignoran.
function conexionTurso() {
  if (process.env.TURSO_DATABASE_URL) {
    return { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN };
  }
  const nombre = Object.keys(process.env)
    .sort()
    .find((k) => /^libsql:\/\//i.test(process.env[k] || ''));
  if (!nombre) return null;
  const prefijo = nombre.replace(/_(DATABASE_)?URL$/i, '');
  const token = [`${prefijo}_AUTH_TOKEN`, `${prefijo}_TOKEN`, `${prefijo}_DATABASE_AUTH_TOKEN`, 'TURSO_AUTH_TOKEN']
    .map((k) => process.env[k])
    .find(Boolean);
  return { url: process.env[nombre], authToken: token };
}

function crearCliente() {
  const turso = conexionTurso();
  if (turso) return createClient(turso);
  // En Vercel el disco no es persistente: sin Turso no hay dónde guardar los datos.
  if (process.env.VERCEL) {
    const falta = () => {
      throw new Error('Falta conectar la base de datos Turso al proyecto en Vercel (Storage).');
    };
    return { execute: falta, batch: falta, transaction: falta };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return createClient({ url: `file:${path.join(DATA_DIR, 'spacio.db')}` });
}
const cliente = crearCliente();

const aArgs = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
const aObjetos = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));

// Métodos de consulta sobre el cliente o sobre una transacción.
function consultas(ejecutor) {
  const execute = (sql, args) => ejecutor.execute({ sql, args: aArgs(args) });
  return {
    async all(sql, ...args) {
      return aObjetos(await execute(sql, args));
    },
    async get(sql, ...args) {
      return aObjetos(await execute(sql, args))[0];
    },
    // Primer valor de la primera fila (p. ej. un COUNT).
    async value(sql, ...args) {
      return (await execute(sql, args)).rows[0]?.[0];
    },
    // Primera columna de todas las filas.
    async column(sql, ...args) {
      return (await execute(sql, args)).rows.map((r) => r[0]);
    },
    async run(sql, ...args) {
      const rs = await execute(sql, args);
      return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid === undefined ? undefined : Number(rs.lastInsertRowid) };
    },
  };
}

const db = {
  ...consultas(cliente),
  // Ejecuta fn(tx) de forma atómica: si algo falla no se guarda nada.
  async transaction(fn) {
    const tx = await cliente.transaction('write');
    try {
      const resultado = await fn(consultas(tx));
      await tx.commit();
      return resultado;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      tx.close();
    }
  },
};

function sentencias(sql) {
  return sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Aplica en orden los archivos .sql de server/migrations que aún no se han
// ejecutado. Para evolucionar la base de datos basta con agregar un nuevo
// archivo numerado (p. ej. 003_nueva_tabla.sql); nunca se editan los anteriores.
async function migrate() {
  await cliente.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    nombre TEXT PRIMARY KEY,
    aplicada_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const dir = path.join(__dirname, 'migrations');
  const archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const archivo of archivos) {
    const aplicadas = new Set(await db.column('SELECT nombre FROM schema_migrations'));
    if (aplicadas.has(archivo)) continue;
    const sql = fs.readFileSync(path.join(dir, archivo), 'utf8');
    try {
      await cliente.batch(
        [...sentencias(sql), { sql: 'INSERT INTO schema_migrations (nombre) VALUES (?)', args: [archivo] }],
        'write'
      );
      console.log(`Migración aplicada: ${archivo}`);
    } catch (err) {
      // Otra instancia pudo aplicarla al mismo tiempo (arranques simultáneos en Vercel).
      const ya = await db.value('SELECT 1 FROM schema_migrations WHERE nombre = ?', archivo);
      if (!ya) throw err;
    }
  }
}

module.exports = { db, migrate };
