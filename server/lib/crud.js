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
  antesDeBorrar, // async (id) => void, p. ej. para desvincular registros relacionados
  soloAdminBorrar = false,
}) {
  const router = express.Router();

  const obtener = (id) => db.get(`${selectBase} WHERE ${alias}.id = ?`, id);

  router.get('/', async (req, res) => {
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
    res.json(await db.all(sql, ...params));
  });

  router.get('/:id', async (req, res) => {
    const fila = await obtener(req.params.id);
    if (!fila) throw new HttpError(404, 'Registro no encontrado');
    res.json(fila);
  });

  router.post('/', async (req, res) => {
    const datos = leerCampos(req.body, campos, { requeridos });
    if (antesDeGuardar) antesDeGuardar(datos, null);
    const cols = Object.keys(datos);
    const info = await db.run(
      `INSERT INTO ${tabla} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => datos[c])
    );
    res.status(201).json(await obtener(info.lastInsertRowid));
  });

  const actualizar = async (req, res) => {
    const existente = await db.get(`SELECT * FROM ${tabla} WHERE id = ?`, req.params.id);
    if (!existente) throw new HttpError(404, 'Registro no encontrado');
    const datos = leerCampos(req.body, campos, { parcial: true, requeridos });
    if (antesDeGuardar) antesDeGuardar(datos, existente);
    const cols = Object.keys(datos);
    if (cols.length) {
      await db.run(
        `UPDATE ${tabla} SET ${cols.map((c) => `${c} = ?`).join(', ')}, actualizado_en = datetime('now') WHERE id = ?`,
        ...cols.map((c) => datos[c]),
        req.params.id
      );
    }
    res.json(await obtener(req.params.id));
  };
  router.put('/:id', actualizar);
  router.patch('/:id', actualizar);

  router.delete('/:id', async (req, res) => {
    if (soloAdminBorrar && req.usuario.rol !== 'admin') {
      throw new HttpError(403, 'Sólo un administrador puede eliminar registros');
    }
    if (!(await db.get(`SELECT id FROM ${tabla} WHERE id = ?`, req.params.id))) {
      throw new HttpError(404, 'Registro no encontrado');
    }
    if (antesDeBorrar) await antesDeBorrar(req.params.id);
    await db.run(`DELETE FROM ${tabla} WHERE id = ?`, req.params.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { crearCrud };
