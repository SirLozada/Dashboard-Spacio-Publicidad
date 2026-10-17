import { api, onSesionExpirada } from './api.js';
import { icon } from './icons.js';
import { state, esAdmin } from './state.js';
import { esc, modal, toast, campo, leerFormulario } from './ui.js';
import dashboard from './modules/dashboard.js';
import trabajos from './modules/trabajos.js';
import materiales from './modules/materiales.js';
import proveedores from './modules/proveedores.js';
import usuarios from './modules/usuarios.js';
import pagos from './modules/pagos.js';

// Registro de módulos del frontend. Para agregar un módulo nuevo basta con
// crear su archivo en js/modules (con id, titulo, icono y render) y añadirlo aquí.
const MODULOS = [dashboard, trabajos, pagos, materiales, proveedores, usuarios];

const $ = (sel) => document.querySelector(sel);
let limpiarVista = null;

function rutaActual() {
  const [ruta, query] = location.hash.replace(/^#\/?/, '').split('?');
  return { id: ruta || 'dashboard', params: new URLSearchParams(query || '') };
}

function modulosVisibles() {
  return MODULOS.filter((m) => !m.soloAdmin || esAdmin());
}

function pintarMenu() {
  const { id } = rutaActual();
  const principales = modulosVisibles().filter((m) => !m.seccion);
  const admin = modulosVisibles().filter((m) => m.seccion === 'admin');
  const enlace = (m) =>
    `<a class="nav-link ${m.id === id ? 'active' : ''}" href="#/${m.id}">${icon(m.icono)}<span>${esc(m.titulo)}</span></a>`;
  $('#nav').innerHTML =
    principales.map(enlace).join('') +
    (admin.length ? `<div class="nav-section">Administración</div>${admin.map(enlace).join('')}` : '');
}

async function navegar() {
  const { id, params } = rutaActual();
  const mod = modulosVisibles().find((m) => m.id === id);
  if (!mod) {
    location.hash = '#/dashboard';
    return;
  }
  document.body.classList.remove('menu-open');
  limpiarVista?.();
  limpiarVista = null;
  document.querySelectorAll('.modal-root, .status-pop').forEach((m) => m.remove());
  document.body.style.overflow = '';
  pintarMenu();
  $('#page-title').textContent = mod.titulo;
  document.title = `${mod.titulo} · Spacio Publicidad`;
  const vista = $('#view');
  vista.innerHTML = '';
  window.scrollTo(0, 0);
  try {
    limpiarVista = (await mod.render(vista, params)) || null;
  } catch (err) {
    vista.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}

// ---------- Sesión ----------

function mostrarLogin() {
  state.usuario = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
  document.querySelectorAll('.modal-root').forEach((m) => m.remove());
  $('#login-form [name=usuario]').focus();
}

async function iniciarApp() {
  if (state.usuario.debe_cambiar_password) {
    $('#login').hidden = true;
    cambiarPassword({ obligatorio: true });
    return;
  }
  state.config = await api('/config');
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#user-name').textContent = state.usuario.nombre;
  $('#user-role').textContent = state.usuario.rol === 'admin' ? 'Administrador' : 'Usuario';
  $('#user-avatar').textContent = state.usuario.nombre.trim().charAt(0).toUpperCase();
  await navegar();
}

function cambiarPassword({ obligatorio = false } = {}) {
  const m = modal({
    titulo: obligatorio ? 'Crea tu nueva contraseña' : 'Cambiar contraseña',
    body: `<form id="form-pass" class="form-grid" style="grid-template-columns:1fr">
        ${obligatorio ? '<p class="muted" style="margin:0">Por seguridad, cambia la contraseña inicial antes de continuar.</p>' : ''}
        ${campo({ name: 'actual', label: 'Contraseña actual', type: 'password', required: true })}
        ${campo({ name: 'nueva', label: 'Nueva contraseña (mínimo 8 caracteres)', type: 'password', required: true })}
        ${campo({ name: 'repetir', label: 'Repetir nueva contraseña', type: 'password', required: true })}
        <p class="form-error" hidden></p>
      </form>`,
    foot: `${obligatorio ? '<button class="btn" type="button" data-salir>Salir</button>' : '<button class="btn" data-close type="button">Cancelar</button>'}
           <button class="btn btn-primary" type="submit" form="form-pass">Guardar contraseña</button>`,
    fijo: obligatorio,
  });
  if (obligatorio) {
    m.el.querySelector('[data-salir]').addEventListener('click', salir);
  }
  const form = m.el.querySelector('form');
  form.querySelectorAll('input').forEach((i) => (i.autocomplete = i.name === 'actual' ? 'current-password' : 'new-password'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = leerFormulario(form);
    const error = form.querySelector('.form-error');
    error.hidden = true;
    if (d.nueva !== d.repetir) {
      error.textContent = 'Las contraseñas nuevas no coinciden';
      error.hidden = false;
      return;
    }
    try {
      await api('/auth/cambiar-password', { method: 'POST', body: { actual: d.actual, nueva: d.nueva } });
      toast('Contraseña actualizada');
      state.usuario.debe_cambiar_password = false;
      m.close();
      if (obligatorio) iniciarApp();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });
}

async function salir() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  mostrarLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const error = $('#login-error');
  const boton = form.querySelector('button');
  error.hidden = true;
  boton.disabled = true;
  try {
    state.usuario = await api('/auth/login', { method: 'POST', body: leerFormulario(form) });
    form.reset();
    await iniciarApp();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    boton.disabled = false;
  }
});

// ---------- Arranque ----------

$('#btn-menu').innerHTML = icon('menu');
$('#btn-password').innerHTML = `${icon('key')}<span>Cambiar contraseña</span>`;
$('#btn-logout').innerHTML = `${icon('logout')}<span>Cerrar sesión</span>`;
$('#btn-menu').addEventListener('click', () => document.body.classList.toggle('menu-open'));
$('#backdrop').addEventListener('click', () => document.body.classList.remove('menu-open'));
$('#btn-password').addEventListener('click', () => cambiarPassword());
$('#btn-logout').addEventListener('click', salir);
window.addEventListener('hashchange', () => state.usuario && state.config && navegar());

onSesionExpirada(() => {
  if (state.usuario) {
    toast('Tu sesión expiró, vuelve a ingresar', 'error');
    mostrarLogin();
  }
});

(async () => {
  try {
    state.usuario = await api('/auth/me');
    await iniciarApp();
  } catch {
    mostrarLogin();
  }
})();
