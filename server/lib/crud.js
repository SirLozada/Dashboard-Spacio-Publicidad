// Fábrica de rutas CRUD para módulos sencillos (materiales, proveedores...).
// Un módulo nuevo de este tipo sólo necesita su migración SQL y una llamada a
// crearCrud() con la descripción de sus campos.
const express = require('express');
const { db } = require('../db');
const { HttpError, leerCampos, likeParam } = require('./util');

function crearCrud({
  tabla,
  campos, // { columna: 'text' | 'number' | 'int' | 'date' }
  requeridos = [],
  selectBase = `SELECT * FROM ${tabla}`,
  alias = tabla,
  busqueda = [], // columnas (con alias) donde busca ?q=
  filtros = [], // columnas filtrables por igualdad (?columna=valor)
  orden = `${alias}.nombre COLLATE NOCASE`,
  antesDeGuardar, // (datos, existente) => void, permite ajustar datos
  soloAdminBorrar = false,
}) {
  const router = express.Router();

  const obtener = (id) => db.prepare(`${selectBase} WHERE ${alias}.id = ?`).get(id);

  router.get('/', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.q && busqueda.length) {
      where.push(`(${busqueda.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      busqueda.forEach(() => params.push(likeParam(req.query.q)));
    }
    for (const f of filtros) {
      if (req.query[f] !== undefined && req.query[f] !== '') {
        where.push(`${alias}.${f} = ?`);
        params.push(req.query[f]);
      }
    }
    const sql = `${selectBase} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orden}`;
    res.json(db.prepare(sql).all(...params));
  });

  router.get('/:id', (req, res) => {
    const fila = obtener(req.params.id);
    if (!fila) throw new HttpError(404, 'Registro no encontrado');
    res.json(fila);
  });

  router.post('/', (req, res) => {
    const datos = leerCampos(req.body, campos, { requeridos });
    if (antesDeGuardar) antesDeGuardar(datos, null);
    const cols = Object.keys(datos);
    const info = db
      .prepare(`INSERT INTO ${tabla} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => datos[c]));
    res.status(201).json(obtener(info.lastInsertRowid));
  });

  const actualizar = (req, res) => {
    const existente = db.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(req.params.id);
    if (!existente) throw new HttpError(404, 'Registro no encontrado');
    const datos = leerCampos(req.body, campos, { parcial: true, requeridos });
    if (antesDeGuardar) antesDeGuardar(datos, existente);
    const cols = Object.keys(datos);
    if (cols.length) {
      db.prepare(
        `UPDATE ${tabla} SET ${cols.map((c) => `${c} = ?`).join(', ')}, actualizado_en = datetime('now') WHERE id = ?`
      ).run(...cols.map((c) => datos[c]), req.params.id);
    }
    res.json(obtener(req.params.id));
  };
  router.put('/:id', actualizar);
  router.patch('/:id', actualizar);

  router.delete('/:id', (req, res) => {
    if (soloAdminBorrar && req.usuario.rol !== 'admin') {
      throw new HttpError(403, 'Sólo un administrador puede eliminar registros');
    }
    const info = db.prepare(`DELETE FROM ${tabla} WHERE id = ?`).run(req.params.id);
    if (!info.changes) throw new HttpError(404, 'Registro no encontrado');
    res.json({ ok: true });
  });

  return router;
}

module.exports = { crearCrud };
