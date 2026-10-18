// «Mi día»: formularios de tareas y observaciones personales, y acceso directo
// a los registros originales (proyecto, solicitud). Lo usan el módulo Mi día,
// la agenda personal y la campanita.
import { api } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { esc, modal, toast, confirmar, hoyIso, campo, leerFormulario } from '../ui.js';
import { abrirFicha } from './trabajos-comun.js';
import { detalleSolicitud } from './solicitudes-comun.js';

export const PRIORIDADES = [
  { value: 'normal', label: 'Normal' },
  { value: 'alta', label: 'Alta' },
  { value: 'urgente', label: 'Urgente' },
];
export const ESTADOS_TAREA = [
  { value: 'pendiente', label: 'Pendiente' },
  { value: 'en_proceso', label: 'En proceso' },
  { value: 'completada', label: 'Completada' },
];

// Listas para los formularios (se piden una vez por sesión de pantalla).
let usuarios = null;
let proyectos = null;
async function opciones() {
  [usuarios, proyectos] = await Promise.all([
    usuarios ? Promise.resolve(usuarios) : api('/solicitudes/usuarios'),
    api('/mi-dia/proyectos'),
  ]);
  return { usuarios, proyectos };
}
const opcionesProyecto = (lista) => [{ value: '', label: 'Ninguno' }, ...lista.map((p) => ({ value: p.id, label: p.nombre }))];

// ---------- Tareas ----------

// tarea: existente (para editar) o null; inicial: valores sugeridos para una nueva.
export async function formularioTarea(tarea, { inicial = {}, alGuardar } = {}) {
  const { usuarios: us, proyectos: ps } = await opciones();
  const nueva = !tarea;
  const t = tarea || { fecha: hoyIso(), prioridad: 'normal', estado: 'pendiente', asignado_a: state.usuario.id, ...inicial };
  const puedeReasignar = nueva || t.puede_gestionar;
  // Quien sólo está etiquetado puede agregar observaciones, nada más.
  const soloObservaciones = !nueva && t.puede_editar === false;
  const etiquetados = new Set((t.etiquetados || []).map((e) => e.id));
  // Si el proyecto ya está cerrado no figura en la lista: se agrega para no perder el vínculo.
  const listaProyectos = t.trabajo_id && !ps.some((p) => p.id === t.trabajo_id) ? [...ps, { id: t.trabajo_id, nombre: t.proyecto || 'Proyecto vinculado' }] : ps;

  const m = modal({
    titulo: nueva ? `${icon('check')} Nueva tarea` : `${icon('check')} Tarea`,
    body: `<form class="form-grid" data-form>
      ${campo({ name: 'titulo', label: 'Título de la tarea', required: true, full: true, placeholder: 'Ej. Llamar al proveedor de acrílicos' }, t.titulo)}
      ${campo({ name: 'fecha', label: 'Fecha programada', type: 'date' }, t.fecha)}
      ${campo({ name: 'hora', label: 'Hora (opcional)', type: 'time' }, t.hora)}
      ${campo({ name: 'prioridad', label: 'Prioridad', type: 'select', options: PRIORIDADES }, t.prioridad)}
      ${campo({ name: 'estado', label: 'Estado', type: 'select', options: ESTADOS_TAREA }, t.estado)}
      ${campo(
        { name: 'asignado_a', label: 'Responsable', type: 'select', options: us.map((u) => ({ value: u.id, label: u.id === state.usuario.id ? `${u.nombre} (yo)` : u.nombre })) },
        t.asignado_a
      )}
      ${campo({ name: 'trabajo_id', label: 'Proyecto relacionado (opcional)', type: 'select', options: opcionesProyecto(listaProyectos) }, t.trabajo_id ?? '')}
      <div class="field full"><span>Etiquetar a otras personas (opcional)</span>
        <div class="chips-etiquetar">${us
          .filter((u) => u.id !== state.usuario.id || etiquetados.has(u.id))
          .map(
            (u) => `<label class="chip-etiquetar"><input type="checkbox" name="etiquetados" value="${u.id}" ${etiquetados.has(u.id) ? 'checked' : ''}><span>@${esc(u.nombre)}</span></label>`
          )
          .join('')}</div>
        <small class="muted">Verán la tarea en su «Mi día», recibirán un aviso y podrán agregar observaciones. También puedes escribir @nombre en la descripción.</small></div>
      ${campo({ name: 'descripcion', label: 'Descripción (opcional)', type: 'textarea', full: true, rows: 2 }, t.descripcion)}
      ${nueva ? '' : campo({ name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true, rows: 2, placeholder: 'Avances, respuestas, lo que quedó pendiente…' }, t.observaciones)}
      ${nueva ? '' : `<p class="muted nota full" style="margin:0">Creada por ${esc(t.creado_por_nombre || '—')}${t.asignado_a !== t.creado_por ? ` · asignada a ${esc(t.asignado_nombre || '—')}` : ''}</p>`}
      ${soloObservaciones ? `<p class="aviso-cot full" style="margin:0">${icon('arroba')} Te etiquetaron en esta tarea: puedes agregar observaciones. El responsable o quien la creó es quien la modifica o la completa.</p>` : ''}
    </form>`,
    foot: `${
      nueva
        ? '<span class="left"></span><button class="btn" data-close type="button">Cancelar</button>'
        : `${t.puede_gestionar ? `<button class="btn btn-danger left" type="button" data-eliminar>${icon('trash')}Eliminar</button>` : '<span class="left"></span>'}
           ${soloObservaciones ? '' : `<button class="btn" type="button" data-archivar>${t.archivada ? 'Desarchivar' : 'Archivar'}</button>`}`
    }
      <button class="btn btn-primary" type="submit" form="form-tarea">${nueva ? `${icon('plus')}Crear tarea` : 'Guardar'}</button>`,
  });
  const form = m.el.querySelector('[data-form]');
  form.id = 'form-tarea';
  if (!puedeReasignar) {
    form.elements.asignado_a.disabled = true;
    form.elements.asignado_a.title = 'Sólo quien creó la tarea o un administrador puede reasignarla';
  }
  if (nueva) form.elements.titulo.focus();
  if (soloObservaciones) {
    form.querySelectorAll('input, select, textarea').forEach((el) => {
      if (el.name !== 'observaciones') el.disabled = true;
    });
    form.elements.observaciones.focus();
  }

  const enviar = async (extra = {}) => {
    const d = leerFormulario(form);
    delete d.etiquetados;
    if (soloObservaciones) {
      try {
        const r = await api(`/mi-dia/tareas/${t.id}`, { method: 'PATCH', body: { observaciones: d.observaciones } });
        toast('Observación agregada');
        m.close();
        alGuardar?.(r);
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    d.etiquetados = [...form.querySelectorAll('[name=etiquetados]:checked')].map((c) => Number(c.value));
    if (!d.titulo?.trim()) {
      toast('Escribe el título de la tarea', 'error');
      form.elements.titulo.focus();
      return;
    }
    if (!puedeReasignar) delete d.asignado_a;
    try {
      const r = nueva
        ? await api('/mi-dia/tareas', { method: 'POST', body: { ...d, ...extra } })
        : await api(`/mi-dia/tareas/${t.id}`, { method: 'PATCH', body: { ...d, ...extra } });
      toast(nueva ? (Number(d.asignado_a) !== state.usuario.id ? 'Tarea creada y asignada' : 'Tarea creada') : 'Tarea guardada');
      m.close();
      alGuardar?.(r);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    enviar();
  });
  m.el.querySelector('[data-archivar]')?.addEventListener('click', () => enviar({ archivada: !t.archivada }));
  m.el.querySelector('[data-eliminar]')?.addEventListener('click', async () => {
    if (!(await confirmar(`¿Eliminar la tarea «${t.titulo}»? Si sólo quieres quitarla de la lista, puedes archivarla.`))) return;
    try {
      await api(`/mi-dia/tareas/${t.id}`, { method: 'DELETE' });
      toast('Tarea eliminada');
      m.close();
      alGuardar?.(null);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

export async function abrirTarea(id, opciones = {}) {
  try {
    await formularioTarea(await api(`/mi-dia/tareas/${id}`), opciones);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Marca o desmarca una tarea como completada (casilla de verificación).
export const completarTarea = (id, hecha) => api(`/mi-dia/tareas/${id}`, { method: 'PATCH', body: { estado: hecha ? 'completada' : 'pendiente' } });

// ---------- Observaciones personales ----------

export async function formularioNota(nota, { inicial = {}, alGuardar } = {}) {
  const { proyectos: ps } = await opciones();
  const nueva = !nota;
  const n = nota || { fecha: hoyIso(), prioridad: 'normal', ...inicial };
  const m = modal({
    titulo: nueva ? `${icon('nota')} Nueva observación` : `${icon('nota')} Observación personal`,
    body: `<form class="form-grid" data-form id="form-nota">
      ${campo({ name: 'titulo', label: 'Título', required: true, full: true, placeholder: 'Ej. Confirmar si el proveedor mantiene el precio del MDF' }, n.titulo)}
      ${campo({ name: 'nota', label: 'Nota u observación', type: 'textarea', full: true, rows: 3 }, n.nota)}
      ${campo({ name: 'fecha', label: '¿Qué día quieres verla?', type: 'date' }, n.fecha)}
      ${campo({ name: 'importancia', label: 'Importancia', type: 'select', options: PRIORIDADES }, n.prioridad)}
      ${campo({ name: 'trabajo_id', label: 'Proyecto relacionado (opcional)', type: 'select', options: opcionesProyecto(ps), full: true }, n.trabajo_id ?? '')}
      <p class="muted nota full" style="margin:0">${icon('key')} Privada: sólo tú la ves y no genera notificaciones. Las observaciones formales de un cliente se registran en <a href="#/solicitudes">Solicitudes y novedades</a>.</p>
    </form>`,
    foot: `${
      nueva
        ? '<span class="left"></span><button class="btn" data-close type="button">Cancelar</button>'
        : `<button class="btn btn-danger left" type="button" data-eliminar>${icon('trash')}Eliminar</button>
           <button class="btn" type="button" data-archivar>${n.archivada ? 'Desarchivar' : 'Archivar'}</button>
           <button class="btn" type="button" data-convertir>${icon('check')}Convertir en tarea</button>`
    }
      <button class="btn btn-primary" type="submit" form="form-nota">${nueva ? `${icon('plus')}Guardar observación` : 'Guardar'}</button>`,
  });
  const form = m.el.querySelector('[data-form]');
  if (nueva) form.elements.titulo.focus();
  const enviar = async (extra = {}) => {
    const d = leerFormulario(form);
    if (!d.titulo?.trim()) {
      toast('Escribe el título', 'error');
      form.elements.titulo.focus();
      return null;
    }
    try {
      const r = nueva
        ? await api('/mi-dia/notas', { method: 'POST', body: { ...d, ...extra } })
        : await api(`/mi-dia/notas/${n.id}`, { method: 'PATCH', body: { ...d, ...extra } });
      m.close();
      alGuardar?.(r);
      return r;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await enviar()) toast('Observación guardada');
  });
  m.el.querySelector('[data-archivar]')?.addEventListener('click', async () => {
    if (await enviar({ archivada: !n.archivada })) toast(n.archivada ? 'Observación restaurada' : 'Observación archivada');
  });
  m.el.querySelector('[data-eliminar]')?.addEventListener('click', async () => {
    if (!(await confirmar(`¿Eliminar la observación «${n.titulo}»?`))) return;
    try {
      await api(`/mi-dia/notas/${n.id}`, { method: 'DELETE' });
      toast('Observación eliminada');
      m.close();
      alGuardar?.(null);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  // Convertir en tarea: se abre el formulario de tarea con estos datos y,
  // al crearla, la observación se archiva (no se duplica).
  m.el.querySelector('[data-convertir]')?.addEventListener('click', () => {
    const d = leerFormulario(form);
    m.close();
    formularioTarea(null, {
      inicial: { titulo: d.titulo, descripcion: d.nota, fecha: d.fecha || hoyIso(), prioridad: d.importancia, trabajo_id: Number(d.trabajo_id) || null },
      alGuardar: async (tarea) => {
        if (tarea) await api(`/mi-dia/notas/${n.id}`, { method: 'PATCH', body: { archivada: true } }).catch(() => {});
        alGuardar?.(tarea);
      },
    });
  });
}

export async function abrirNota(id, opciones = {}) {
  try {
    await formularioNota(await api(`/mi-dia/notas/${id}`), opciones);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Abre el registro original de un elemento de «Mi día».
export function abrirElemento(item, { alCambiar } = {}) {
  if (item.origen === 'tarea') return abrirTarea(item.id, { alGuardar: alCambiar });
  if (item.origen === 'nota') return abrirNota(item.id, { alGuardar: alCambiar });
  if (item.enlace?.tipo === 'trabajo') return abrirFicha(item.enlace.id, { alCerrar: alCambiar }).catch((err) => toast(err.message, 'error'));
  if (item.enlace?.tipo === 'solicitud') return detalleSolicitud(item.enlace.id, { alCambiar });
  return null;
}
