import { icon } from './icons.js';
import { state, estatusPorKey, sinAlerta, listaEstatus } from './state.js';

// ---------- Utilidades de texto y formato ----------

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function hoyIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function diasHasta(fechaIso) {
  if (!fechaIso) return null;
  const a = new Date(`${hoyIso()}T12:00:00`);
  const b = new Date(`${fechaIso}T12:00:00`);
  return Math.round((b - a) / 86400000);
}

export function fecha(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export function fechaHora(sqlUtc) {
  if (!sqlUtc) return '';
  const d = new Date(`${sqlUtc.replace(' ', 'T')}Z`);
  return d.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}

export function dinero(n) {
  if (n === null || n === undefined || n === '') return '';
  try {
    return new Intl.NumberFormat('es', { style: 'currency', currency: state.config?.moneda || 'USD' }).format(n);
  } catch {
    return Number(n).toFixed(2);
  }
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function tamanoArchivo(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- Estatus y vencimientos ----------

// Una etiqueta de color por cada estatus del trabajo.
export function badgeEstatus(valor) {
  return listaEstatus(valor)
    .map((key) => {
      const e = estatusPorKey(key);
      return `<span class="badge" style="--c:${e?.color || '#64748b'}">${esc(e?.label || key)}</span>`;
    })
    .join('');
}

// Botón de la tabla que muestra los estatus y abre el selector.
export function botonEstatus(t) {
  return `<button type="button" class="status-btn" data-estatus-de="${t.id}" aria-label="Cambiar estatus">
    ${badgeEstatus(t.estatus)}${icon('chevron')}</button>`;
}

// Casillas para elegir uno o varios estatus.
export function selectorEstatus(valor) {
  const actuales = listaEstatus(valor);
  return `<div class="status-chips" role="group" aria-label="Estatus">${state.config.estatus
    .map(
      (e) => `<label class="status-chip" style="--c:${e.color}">
        <input type="checkbox" value="${e.key}" ${actuales.includes(e.key) ? 'checked' : ''}><span>${esc(e.label)}</span></label>`
    )
    .join('')}</div>`;
}

// Devuelve 'late' | 'soon' | null según la fecha de entrega del trabajo.
export function situacion(t) {
  if (!t.fecha_entrega || sinAlerta(t.estatus)) return null;
  const d = diasHasta(t.fecha_entrega);
  if (d < 0) return 'late';
  if (d <= state.config.diasAlerta) return 'soon';
  return null;
}

export function etiquetaVencimiento(t) {
  const s = situacion(t);
  if (!s) return '';
  const d = diasHasta(t.fecha_entrega);
  if (s === 'late') return `<span class="due late">${icon('alert')}${-d === 1 ? '1 día de atraso' : `${-d} días de atraso`}</span>`;
  const txt = d === 0 ? 'Vence hoy' : d === 1 ? 'Vence mañana' : `En ${d} días`;
  return `<span class="due soon">${icon('clock')}${txt}</span>`;
}

// ---------- Notificaciones ----------

export function toast(mensaje, tipo = '') {
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.textContent = mensaje;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), tipo === 'error' ? 5000 : 2600);
}

// ---------- Modales ----------

// Abre un modal. `body` es HTML; devuelve { el, close }.
// Con fijo=true no se cierra con Escape ni al hacer clic fuera.
export function modal({ titulo, body, foot = '', wide = false, fijo = false, onClose }) {
  const root = document.createElement('div');
  root.className = 'modal-root';
  root.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>${titulo}</h2>
        ${fijo ? '' : `<button class="icon-btn" data-close type="button" aria-label="Cerrar">${icon('x')}</button>`}
      </div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>`;
  let cerrado = false;
  const close = () => {
    if (cerrado) return;
    cerrado = true;
    root.remove();
    document.removeEventListener('keydown', onKey);
    if (!document.querySelector('.modal-root')) document.body.style.overflow = '';
    onClose?.();
  };
  const onKey = (e) => {
    if (!fijo && e.key === 'Escape' && root === [...document.querySelectorAll('.modal-root')].pop()) close();
  };
  root.addEventListener('mousedown', (e) => {
    if (!fijo && e.target === root) close();
  });
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  document.addEventListener('keydown', onKey);
  document.body.append(root);
  document.body.style.overflow = 'hidden';
  return { el: root, close };
}

export function confirmar(mensaje, { titulo = 'Confirmar', boton = 'Eliminar' } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const m = modal({
      titulo: esc(titulo),
      body: `<p style="margin:0">${esc(mensaje)}</p>`,
      foot: `<button class="btn" data-close type="button">Cancelar</button>
             <button class="btn btn-primary" data-ok type="button" style="background:var(--danger);border-color:var(--danger)">${esc(boton)}</button>`,
      onClose: () => resolve(ok),
    });
    m.el.querySelector('[data-ok]').addEventListener('click', () => {
      ok = true;
      m.close();
    });
  });
}

// ---------- Formularios ----------

// Genera un campo de formulario a partir de su definición.
// def: { name, label, type: text|textarea|date|number|select|tel, options, required, full, list, placeholder }
export function campo(def, valor) {
  const v = valor ?? '';
  const req = def.required ? 'required' : '';
  const ph = def.placeholder ? `placeholder="${esc(def.placeholder)}"` : '';
  let control;
  if (def.type === 'estatus') {
    return `<div class="field ${def.full ? 'full' : ''}"><span>${esc(def.label)}</span>
      ${selectorEstatus(v)}<input type="hidden" name="${def.name}" value="${esc(v)}"></div>`;
  }
  if (def.type === 'textarea') {
    control = `<textarea name="${def.name}" ${req} ${ph} rows="${def.rows || 3}">${esc(v)}</textarea>`;
  } else if (def.type === 'select') {
    control = `<select name="${def.name}" ${req}>${def.options
      .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select>`;
  } else {
    const extra = def.type === 'number' ? 'step="0.01" min="0" inputmode="decimal"' : '';
    const list = def.list ? `list="dl-${def.name}" autocomplete="off"` : '';
    control = `<input name="${def.name}" type="${def.type || 'text'}" value="${esc(v)}" ${req} ${ph} ${extra} ${list}>`;
    if (def.list) {
      control += `<datalist id="dl-${def.name}">${def.list.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>`;
    }
  }
  return `<label class="field ${def.full ? 'full' : ''}">
    <span>${esc(def.label)}${def.required ? ' <b class="req">*</b>' : ''}</span>${control}</label>`;
}

export function leerFormulario(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export function vacio(texto, ico = 'inbox') {
  return `<div class="empty">${icon(ico)}<div>${esc(texto)}</div></div>`;
}

// ---------- Papelera (eliminar desde las listas) ----------

export function botonPapelera(atributos, titulo = 'Eliminar') {
  return `<button type="button" class="icon-btn btn-papelera" ${atributos} title="${esc(titulo)}" aria-label="${esc(titulo)}">${icon('trash')}</button>`;
}

// Conecta las papeleras de un contenedor: pide confirmación, elimina y recarga.
// Se atiende en fase de captura para que el clic no abra además la ficha de la fila.
export function conectarPapeleras(contenedor, selector, { mensaje, eliminar, alEliminar, exito = 'Eliminado' }) {
  contenedor.addEventListener(
    'click',
    async (e) => {
      const boton = e.target.closest(selector);
      if (!boton || !contenedor.contains(boton)) return;
      e.stopPropagation();
      e.preventDefault();
      const texto = mensaje(boton);
      if (texto === null || !(await confirmar(texto))) return;
      try {
        await eliminar(boton);
        toast(exito);
        alEliminar?.();
      } catch (err) {
        toast(err.message, 'error');
      }
    },
    true
  );
}
