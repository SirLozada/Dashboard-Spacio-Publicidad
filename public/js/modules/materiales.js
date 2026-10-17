import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { esc, fecha, dinero, debounce, modal, toast, confirmar, campo, leerFormulario, vacio } from '../ui.js';

export async function formularioMaterial(material, { alGuardar } = {}) {
  const nuevo = !material?.id;
  const [proveedores, todos] = await Promise.all([api('/proveedores'), api('/materiales')]);
  const categorias = [...new Set(todos.map((m) => m.categoria).filter(Boolean))].sort();
  const unidades = [...new Set(['Unidad', 'm²', 'Metro lineal', 'Pliego', 'Rollo', 'Litro', 'Galón', 'Kg', ...todos.map((m) => m.unidad).filter(Boolean)])];
  const m = modal({
    titulo: nuevo ? 'Nuevo material' : esc(material.nombre),
    body: `<form class="form-grid" id="form-material">
      ${campo({ name: 'nombre', label: 'Nombre del material', required: true, full: true }, material?.nombre)}
      ${campo({ name: 'categoria', label: 'Categoría', list: categorias, placeholder: 'Ej. Vinil, Acrílico, Iluminación' }, material?.categoria)}
      ${campo({ name: 'unidad', label: 'Unidad de medida', list: unidades }, material?.unidad)}
      ${campo({ name: 'precio', label: 'Precio aproximado', type: 'number' }, material?.precio)}
      ${campo({ name: 'fecha_precio', label: 'Fecha de actualización del precio', type: 'date' }, material?.fecha_precio)}
      ${campo({
        name: 'proveedor_id',
        label: 'Proveedor',
        type: 'select',
        full: true,
        options: [{ value: '', label: '— Sin proveedor —' }, ...proveedores.map((p) => ({ value: p.id, label: p.nombre }))],
      }, material?.proveedor_id)}
      ${campo({ name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true }, material?.observaciones)}
      ${nuevo ? '' : '<p class="muted full" style="margin:0;font-size:13px">Si cambias el precio sin indicar fecha, se registra automáticamente la fecha de hoy.</p>'}
    </form>`,
    foot: `${nuevo ? '<span class="left"></span>' : `<button class="btn btn-danger left" type="button" data-borrar>${icon('trash')}Eliminar</button>`}
      <button class="btn" data-close type="button">Cancelar</button>
      <button class="btn btn-primary" type="submit" form="form-material">${nuevo ? 'Agregar material' : 'Guardar cambios'}</button>`,
  });
  const form = m.el.querySelector('form');
  form.elements.nombre.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const datos = leerFormulario(form);
    // Si se cambió el precio y no se tocó la fecha, el servidor pone la fecha de hoy.
    if (!nuevo && datos.fecha_precio === (material.fecha_precio || '') && Number(datos.precio) !== material.precio) {
      delete datos.fecha_precio;
    }
    try {
      await api(nuevo ? '/materiales' : `/materiales/${material.id}`, { method: nuevo ? 'POST' : 'PUT', body: datos });
      toast(nuevo ? 'Material agregado' : 'Material actualizado');
      m.close();
      alGuardar?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  m.el.querySelector('[data-borrar]')?.addEventListener('click', async () => {
    if (!(await confirmar(`¿Eliminar el material "${material.nombre}"?`))) return;
    try {
      await api(`/materiales/${material.id}`, { method: 'DELETE' });
      toast('Material eliminado');
      m.close();
      alGuardar?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

export default {
  id: 'materiales',
  titulo: 'Materiales y precios',
  icono: 'materiales',

  async render(vista) {
    const f = { q: '', categoria: '' };
    vista.innerHTML = `
      <div class="toolbar">
        <div class="search">${icon('search')}<input type="search" name="q" placeholder="Buscar material, categoría o proveedor…"></div>
        <select name="categoria" aria-label="Categoría"><option value="">Todas las categorías</option></select>
        <button class="btn btn-primary" type="button" id="btn-nuevo">${icon('plus')}Nuevo material</button>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Materiales</h2><span class="muted" id="contador"></span></div>
        <div id="tabla"></div>
      </section>`;
    const $ = (s) => vista.querySelector(s);
    let lista = [];

    async function cargarCategorias() {
      const todos = await api('/materiales');
      const cats = [...new Set(todos.map((m) => m.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
      $('[name=categoria]').innerHTML =
        '<option value="">Todas las categorías</option>' +
        cats.map((c) => `<option ${c === f.categoria ? 'selected' : ''}>${esc(c)}</option>`).join('');
    }

    async function cargar() {
      lista = await api(`/materiales${qs(f)}`);
      $('#contador').textContent = `${lista.length} ${lista.length === 1 ? 'material' : 'materiales'}`;
      $('#tabla').innerHTML = lista.length
        ? `<div class="table-wrap"><table class="data responsive">
            <thead><tr><th>Material</th><th>Categoría</th><th>Unidad</th><th class="right">Precio aprox.</th><th>Proveedor</th><th>Actualizado</th><th>Observaciones</th></tr></thead>
            <tbody>${lista
              .map(
                (m) => `<tr data-id="${m.id}">
                  <td data-label="Material"><strong>${esc(m.nombre)}</strong></td>
                  <td data-label="Categoría">${esc(m.categoria)}</td>
                  <td data-label="Unidad">${esc(m.unidad)}</td>
                  <td data-label="Precio" class="right num">${dinero(m.precio)}</td>
                  <td data-label="Proveedor">${esc(m.proveedor_nombre)}</td>
                  <td data-label="Actualizado" class="nowrap">${fecha(m.fecha_precio)}</td>
                  <td data-label="Observaciones" class="truncate" title="${esc(m.observaciones)}">${esc(m.observaciones)}</td>
                </tr>`
              )
              .join('')}</tbody></table></div>`
        : vacio(f.q || f.categoria ? 'No hay materiales que coincidan con la búsqueda' : 'Aún no hay materiales registrados', 'materiales');
    }

    const recargar = () => Promise.all([cargarCategorias(), cargar()]);
    const diferido = debounce(cargar, 250);
    $('[name=q]').addEventListener('input', (e) => {
      f.q = e.target.value;
      diferido();
    });
    $('[name=categoria]').addEventListener('change', (e) => {
      f.categoria = e.target.value;
      cargar();
    });
    $('#btn-nuevo').addEventListener('click', () => formularioMaterial(null, { alGuardar: recargar }));
    $('#tabla').addEventListener('click', (e) => {
      const fila = e.target.closest('tr[data-id]');
      if (fila) formularioMaterial(lista.find((m) => String(m.id) === fila.dataset.id), { alGuardar: recargar });
    });
    await recargar();
  },
};
