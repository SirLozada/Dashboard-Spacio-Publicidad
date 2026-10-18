import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { esc, fecha, dinero, debounce, modal, toast, confirmar, campo, leerFormulario, vacio, botonPapelera, conectarPapeleras } from '../ui.js';
import { abrirFicha } from '../components/trabajos-comun.js';

const cantidadTxt = (n) => new Intl.NumberFormat('es', { maximumFractionDigits: 2 }).format(Number(n) || 0);

// Consolidado de compras: materiales requeridos por OpenCutList en los proyectos activos.
async function vistaRequeridos(contenedor) {
  contenedor.innerHTML = `
    <p class="muted nota">Suma de la versión vigente de OpenCutList de cada proyecto activo. Sólo se suman materiales con el mismo nombre, espesor, formato y unidad de compra. Haz clic en un material para ver cuánto corresponde a cada proyecto.</p>
    <section class="panel"><div class="panel-head"><h2>Materiales requeridos por proyectos</h2><span class="muted" data-contador></span></div><div data-tabla></div></section>`;
  const grupos = await api('/opencutlist/consolidado');
  contenedor.querySelector('[data-contador]').textContent = `${grupos.length} ${grupos.length === 1 ? 'material' : 'materiales'}`;
  const total = (g) => {
    const partes = [];
    if (g.proyectos.length > g.sin_cantidad) partes.push(`<strong>${cantidadTxt(g.total)}</strong> ${esc(g.unidad_compra || '')}`);
    if (g.sin_cantidad) partes.push(`<span class="ocl-por-definir">${g.sin_cantidad} ${g.sin_cantidad === 1 ? 'proyecto' : 'proyectos'} por definir</span>`);
    return partes.join(' + ');
  };
  contenedor.querySelector('[data-tabla]').innerHTML = grupos.length
    ? `<div class="table-wrap"><table class="data responsive ocl-consolidado">
        <thead><tr><th>Material</th><th>Tipo y espesor</th><th>Formato</th><th class="right">Total a comprar</th><th class="right">Piezas</th><th class="right">Proyectos</th></tr></thead>
        <tbody>${grupos
          .map(
            (g, i) => `<tr data-grupo="${i}">
              <td data-label="Material"><strong>${esc(g.nombre)}</strong>${g.catalogo_nombre ? `<br><span class="ocl-catalogo">${icon('materiales')}${esc(g.catalogo_nombre)}</span>` : ''}</td>
              <td data-label="Tipo y espesor">${esc([g.tipo, g.espesor].filter(Boolean).join(' · ') || '—')}</td>
              <td data-label="Formato">${esc(g.formato || '—')}</td>
              <td data-label="Total a comprar" class="right">${total(g)}</td>
              <td data-label="Piezas" class="right num">${g.cantidad_piezas ? cantidadTxt(g.cantidad_piezas) : '—'}</td>
              <td data-label="Proyectos" class="right">${g.proyectos.length} ${icon('chevron')}</td>
            </tr>
            <tr class="ocl-detalle sin-clic" data-detalle="${i}" hidden><td colspan="6"><ul>${g.proyectos
              .map(
                (p) => `<li><button type="button" class="link" data-abrir-trabajo="${p.trabajo_id}">${esc(p.codigo)} · ${esc(p.cliente)}${p.tienda ? ` · ${esc(p.tienda)}` : ''}</button>
                  <span>${p.cantidad_comercial === null ? '<span class="ocl-por-definir">Por definir</span>' : `${cantidadTxt(p.cantidad_comercial)} ${esc(g.unidad_compra || '')}`}${p.cantidad_piezas ? ` · ${cantidadTxt(p.cantidad_piezas)} ${Number(p.cantidad_piezas) === 1 ? 'pieza' : 'piezas'}` : ''} · versión ${p.version}</span></li>`
              )
              .join('')}</ul></td></tr>`
          )
          .join('')}</tbody></table></div>`
    : vacio('Ningún proyecto activo tiene datos de OpenCutList. Se importan desde la pestaña «Despieces» de cada proyecto.', 'materiales');
  contenedor.querySelector('[data-tabla]').addEventListener('click', (e) => {
    const t = e.target.closest('[data-abrir-trabajo]');
    if (t) return abrirFicha(Number(t.dataset.abrirTrabajo), { alCerrar: () => vistaRequeridos(contenedor) }).catch((err) => toast(err.message, 'error'));
    const fila = e.target.closest('[data-grupo]');
    if (fila) {
      const detalle = contenedor.querySelector(`[data-detalle="${fila.dataset.grupo}"]`);
      detalle.hidden = !detalle.hidden;
      fila.classList.toggle('abierto', !detalle.hidden);
    }
  });
}

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
      <nav class="tabs vista-tabs" role="tablist">
        <button type="button" class="activo" data-modo="catalogo">${icon('materiales')}Catálogo y precios</button>
        <button type="button" data-modo="requeridos">${icon('trabajos')}Requeridos por proyectos</button>
      </nav>
      <div data-panel="requeridos" hidden></div>
      <div data-panel="catalogo">
      <div class="toolbar">
        <div class="search">${icon('search')}<input type="search" name="q" placeholder="Buscar material, categoría o proveedor…"></div>
        <select name="categoria" aria-label="Categoría"><option value="">Todas las categorías</option></select>
        <button class="btn btn-primary" type="button" id="btn-nuevo">${icon('plus')}Nuevo material</button>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Materiales</h2><span class="muted" id="contador"></span></div>
        <div id="tabla"></div>
      </section>
      </div>`;
    const $ = (s) => vista.querySelector(s);
    vista.querySelectorAll('[data-modo]').forEach((b) =>
      b.addEventListener('click', () => {
        vista.querySelectorAll('[data-modo]').forEach((x) => x.classList.toggle('activo', x === b));
        vista.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.modo));
        if (b.dataset.modo === 'requeridos') vistaRequeridos(vista.querySelector('[data-panel=requeridos]')).catch((err) => toast(err.message, 'error'));
      })
    );
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
            <thead><tr><th>Material</th><th>Categoría</th><th>Unidad</th><th class="right">Precio aprox.</th><th>Proveedor</th><th>Actualizado</th><th>Observaciones</th><th></th></tr></thead>
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
                  <td data-label="" class="col-acciones">${botonPapelera(`data-borrar-material="${m.id}"`, 'Eliminar material')}</td>
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
    conectarPapeleras($('#tabla'), '[data-borrar-material]', {
      mensaje: (b) => `¿Eliminar el material "${lista.find((m) => String(m.id) === b.dataset.borrarMaterial).nombre}"?`,
      eliminar: (b) => api(`/materiales/${b.dataset.borrarMaterial}`, { method: 'DELETE' }),
      alEliminar: recargar,
      exito: 'Material eliminado',
    });
    $('#tabla').addEventListener('click', (e) => {
      const fila = e.target.closest('tr[data-id]');
      if (fila) formularioMaterial(lista.find((m) => String(m.id) === fila.dataset.id), { alGuardar: recargar });
    });
    await recargar();
  },
};
