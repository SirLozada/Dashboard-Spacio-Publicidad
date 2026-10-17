import { api } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { esc, fechaHora, modal, toast, campo, leerFormulario, botonPapelera, conectarPapeleras } from '../ui.js';

const ROLES = [
  { value: 'usuario', label: 'Usuario (puede registrar y editar)' },
  { value: 'admin', label: 'Administrador (además gestiona usuarios y elimina)' },
];

function formularioUsuario(u, { alGuardar }) {
  const nuevo = !u;
  const m = modal({
    titulo: nuevo ? 'Nuevo usuario' : esc(u.nombre),
    body: `<form class="form-grid" id="form-usuario">
      ${campo({ name: 'nombre', label: 'Nombre', required: true }, u?.nombre)}
      ${nuevo ? campo({ name: 'usuario', label: 'Usuario para ingresar', required: true, placeholder: 'ej. maria' }) : `<label class="field"><span>Usuario</span><input value="${esc(u.usuario)}" disabled></label>`}
      ${campo({ name: 'rol', label: 'Rol', type: 'select', options: ROLES, full: true }, u?.rol || 'usuario')}
      ${campo({ name: 'password', label: nuevo ? 'Contraseña inicial (mín. 8 caracteres)' : 'Nueva contraseña (dejar vacío para no cambiarla)', type: 'password', required: nuevo, full: true })}
      ${nuevo ? '' : campo({ name: 'activo', label: 'Estado', type: 'select', options: [{ value: '1', label: 'Activo' }, { value: '0', label: 'Desactivado (no puede ingresar)' }], full: true }, u.activo ? '1' : '0')}
      <p class="muted full" style="margin:0;font-size:13px">El usuario deberá cambiar la contraseña en su primer ingreso.</p>
    </form>`,
    foot: `<button class="btn" data-close type="button">Cancelar</button>
      <button class="btn btn-primary" type="submit" form="form-usuario">${nuevo ? 'Crear usuario' : 'Guardar cambios'}</button>`,
  });
  const form = m.el.querySelector('form');
  form.elements.password.autocomplete = 'new-password';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = leerFormulario(form);
    if (!nuevo) d.activo = d.activo === '1';
    if (!d.password) delete d.password;
    try {
      await api(nuevo ? '/usuarios' : `/usuarios/${u.id}`, { method: nuevo ? 'POST' : 'PATCH', body: d });
      toast(nuevo ? 'Usuario creado' : 'Usuario actualizado');
      m.close();
      alGuardar();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

export default {
  id: 'usuarios',
  titulo: 'Usuarios',
  icono: 'usuarios',
  soloAdmin: true,
  seccion: 'admin',

  async render(vista) {
    vista.innerHTML = `
      <div class="toolbar"><span class="spacer"></span>
        <button class="btn btn-primary" type="button" id="btn-nuevo">${icon('plus')}Nuevo usuario</button>
      </div>
      <section class="panel"><div class="panel-head"><h2>Usuarios con acceso</h2></div><div id="tabla"></div></section>`;
    const $ = (s) => vista.querySelector(s);
    let lista = [];
    async function cargar() {
      lista = await api('/usuarios');
      $('#tabla').innerHTML = `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th>Creado</th><th></th></tr></thead>
        <tbody>${lista
          .map(
            (u) => `<tr data-id="${u.id}">
              <td data-label="Nombre"><strong>${esc(u.nombre)}</strong>${u.id === state.usuario.id ? ' <span class="muted">(tú)</span>' : ''}</td>
              <td data-label="Usuario">${esc(u.usuario)}</td>
              <td data-label="Rol">${u.rol === 'admin' ? 'Administrador' : 'Usuario'}</td>
              <td data-label="Estado">${u.activo ? '<span class="badge" style="--c:#16a34a">Activo</span>' : '<span class="badge" style="--c:#78716c">Desactivado</span>'}</td>
              <td data-label="Creado" class="nowrap">${fechaHora(u.creado_en)}</td>
              <td data-label="" class="col-acciones">${u.id === state.usuario.id ? '' : botonPapelera(`data-borrar-usuario="${u.id}"`, 'Eliminar usuario')}</td>
            </tr>`
          )
          .join('')}</tbody></table></div>`;
    }
    $('#btn-nuevo').addEventListener('click', () => formularioUsuario(null, { alGuardar: cargar }));
    conectarPapeleras($('#tabla'), '[data-borrar-usuario]', {
      mensaje: (b) => `¿Eliminar el usuario "${lista.find((u) => String(u.id) === b.dataset.borrarUsuario).nombre}"? Ya no podrá ingresar.`,
      eliminar: (b) => api(`/usuarios/${b.dataset.borrarUsuario}`, { method: 'DELETE' }),
      alEliminar: cargar,
      exito: 'Usuario eliminado',
    });
    $('#tabla').addEventListener('click', (e) => {
      const fila = e.target.closest('tr[data-id]');
      if (fila) formularioUsuario(lista.find((u) => String(u.id) === fila.dataset.id), { alGuardar: cargar });
    });
    await cargar();
  },
};
