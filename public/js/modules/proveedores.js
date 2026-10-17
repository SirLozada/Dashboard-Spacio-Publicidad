import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { esAdmin } from '../state.js';
import { esc, dinero, debounce, modal, toast, confirmar, campo, leerFormulario, vacio } from '../ui.js';

// Número para wa.me: sólo dígitos (debe incluir el código de país).
const soloDigitos = (t) => String(t || '').replace(/\D/g, '');
const enlaceWhatsApp = (n) => `https://wa.me/${soloDigitos(n)}`;
const enlaceTelefono = (n) => `tel:${String(n || '').replace(/[^\d+]/g, '')}`;

const CAMPOS = [
  { name: 'nombre', label: 'Nombre del proveedor', required: true, full: true },
  { name: 'servicios', label: 'Materiales o servicios que ofrece', type: 'textarea', full: true, rows: 2 },
  { name: 'contacto', label: 'Persona de contacto' },
  { name: 'ubicacion', label: 'Ubicación' },
  { name: 'telefono', label: 'Número telefónico', type: 'tel' },
  { name: 'whatsapp', label: 'WhatsApp (con código de país)', type: 'tel', placeholder: 'Ej. +58 412 1234567' },
  { name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true },
];

async function fichaProveedor(proveedor, { alGuardar } = {}) {
  const nuevo = !proveedor?.id;
  const materiales = nuevo ? [] : await api(`/materiales${qs({ proveedor_id: proveedor.id })}`);
  const m = modal({
    titulo: nuevo ? 'Nuevo proveedor' : esc(proveedor.nombre),
    body: `<form class="form-grid" id="form-proveedor">${CAMPOS.map((c) => campo(c, proveedor?.[c.name])).join('')}</form>
      ${
        materiales.length
          ? `<div class="section-title">${icon('materiales')} Materiales registrados (${materiales.length})</div>
             <div class="table-wrap"><table class="data"><tbody>${materiales
               .map((x) => `<tr style="cursor:default"><td>${esc(x.nombre)}</td><td class="muted">${esc(x.unidad)}</td><td class="right num">${dinero(x.precio)}</td></tr>`)
               .join('')}</tbody></table></div>`
          : ''
      }`,
    foot: `${!nuevo && esAdmin() ? `<button class="btn btn-danger left" type="button" data-borrar>${icon('trash')}Eliminar</button>` : '<span class="left"></span>'}
      <button class="btn" data-close type="button">Cancelar</button>
      <button class="btn btn-primary" type="submit" form="form-proveedor">${nuevo ? 'Agregar proveedor' : 'Guardar cambios'}</button>`,
  });
  const form = m.el.querySelector('form');
  if (nuevo) form.elements.nombre.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(nuevo ? '/proveedores' : `/proveedores/${proveedor.id}`, { method: nuevo ? 'POST' : 'PUT', body: leerFormulario(form) });
      toast(nuevo ? 'Proveedor agregado' : 'Proveedor actualizado');
      m.close();
      alGuardar?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  m.el.querySelector('[data-borrar]')?.addEventListener('click', async () => {
    const aviso = materiales.length ? ` Sus ${materiales.length} materiales quedarán sin proveedor asignado.` : '';
    if (!(await confirmar(`¿Eliminar el proveedor "${proveedor.nombre}"?${aviso}`))) return;
    try {
      await api(`/proveedores/${proveedor.id}`, { method: 'DELETE' });
      toast('Proveedor eliminado');
      m.close();
      alGuardar?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

export default {
  id: 'proveedores',
  titulo: 'Proveedores',
  icono: 'proveedores',

  async render(vista) {
    const f = { q: '' };
    vista.innerHTML = `
      <div class="toolbar">
        <div class="search">${icon('search')}<input type="search" name="q" placeholder="Buscar proveedor, servicio, contacto o ubicación…"></div>
        <button class="btn btn-primary" type="button" id="btn-nuevo">${icon('plus')}Nuevo proveedor</button>
      </div>
      <div id="lista"></div>`;
    const $ = (s) => vista.querySelector(s);
    let lista = [];

    async function cargar() {
      lista = await api(`/proveedores${qs(f)}`);
      $('#lista').innerHTML = lista.length
        ? `<div class="grid-cards">${lista
            .map(
              (p) => `<article class="prov-card" data-id="${p.id}">
                <div>
                  <h3>${esc(p.nombre)}</h3>
                  ${p.servicios ? `<div class="services">${esc(p.servicios)}</div>` : ''}
                </div>
                <div class="meta">
                  ${p.contacto ? `<div>${icon('user')}${esc(p.contacto)}</div>` : ''}
                  ${p.telefono ? `<div>${icon('phone')}${esc(p.telefono)}</div>` : ''}
                  ${p.ubicacion ? `<div>${icon('pin')}${esc(p.ubicacion)}</div>` : ''}
                  ${p.total_materiales ? `<div>${icon('materiales')}${p.total_materiales} ${p.total_materiales === 1 ? 'material' : 'materiales'}</div>` : ''}
                </div>
                ${
                  p.telefono || p.whatsapp
                    ? `<div class="actions">
                        ${p.telefono ? `<a class="btn btn-sm" href="${enlaceTelefono(p.telefono)}" data-stop>${icon('phone')}Llamar</a>` : ''}
                        ${p.whatsapp ? `<a class="btn btn-sm btn-wa" href="${enlaceWhatsApp(p.whatsapp)}" target="_blank" rel="noopener" data-stop>${icon('whatsapp')}WhatsApp</a>` : ''}
                      </div>`
                    : ''
                }
              </article>`
            )
            .join('')}</div>`
        : `<div class="panel">${vacio(f.q ? 'No hay proveedores que coincidan con la búsqueda' : 'Aún no hay proveedores registrados', 'proveedores')}</div>`;
    }

    const diferido = debounce(cargar, 250);
    $('[name=q]').addEventListener('input', (e) => {
      f.q = e.target.value;
      diferido();
    });
    $('#btn-nuevo').addEventListener('click', () => fichaProveedor(null, { alGuardar: cargar }));
    $('#lista').addEventListener('click', (e) => {
      if (e.target.closest('[data-stop]')) return;
      const card = e.target.closest('[data-id]');
      if (card) fichaProveedor(lista.find((p) => String(p.id) === card.dataset.id), { alGuardar: cargar });
    });
    await cargar();
  },
};
