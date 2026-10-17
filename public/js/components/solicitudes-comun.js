// Piezas compartidas de "Solicitudes y novedades": formulario, detalle con
// conversación y la pestaña de la ficha del proyecto.
import { api } from '../api.js';
import { icon } from '../icons.js';
import { state, esAdmin, numeroTrabajo } from '../state.js';
import { esc, fechaHora, modal, toast, confirmar, vacio, tamanoArchivo, botonPapelera, conectarPapeleras } from '../ui.js';
import { subirArchivos } from './adjuntos.js';

const cfg = () => state.config;
export const estadoInfo = (k) => cfg().solicitudEstados.find((e) => e.key === k) || { label: k, color: '#64748b' };
export const prioridadInfo = (k) => cfg().prioridades.find((p) => p.key === k) || { label: k, color: '#64748b' };
export const tipoLabel = (k) => cfg().solicitudTipos.find((t) => t.key === k)?.label || k;
export const badgeEstadoSol = (k) => `<span class="badge" style="--c:${estadoInfo(k).color}">${esc(estadoInfo(k).label)}</span>`;
export const badgePrioridad = (k) =>
  `<span class="badge prioridad-${k}" style="--c:${prioridadInfo(k).color}">${k === 'urgente' ? icon('alert') : ''}${esc(prioridadInfo(k).label)}</span>`;

let usuariosCache = null;
export async function usuariosActivos() {
  usuariosCache ??= await api('/solicitudes/usuarios');
  return usuariosCache;
}

// Hace evidentes las menciones @nombre dentro de un texto ya escapado.
const resaltarMenciones = (t) => esc(t).replace(/(^|\s)(@[\p{L}\d._-]+)/gu, '$1<span class="mencion">$2</span>');

export function tiempoRelativo(sql) {
  if (!sql) return '';
  const d = new Date(`${sql.replace(' ', 'T')}Z`);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const dias = Math.round(h / 24);
  return dias < 7 ? `hace ${dias} ${dias === 1 ? 'día' : 'días'}` : fechaHora(sql);
}

function listaArchivos(adjuntos) {
  if (!adjuntos?.length) return '';
  return `<div class="adjuntos-sol">${adjuntos
    .map((a) => {
      const img = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(a.mime || '');
      return `<a class="adj-sol" href="/api/solicitudes/adjuntos/${a.id}" target="_blank" rel="noopener" title="${esc(a.nombre_original)}">
        ${img ? `<img src="/api/solicitudes/adjuntos/${a.id}" alt="" loading="lazy">` : icon('file')}
        <span>${esc(a.nombre_original)}<small>${tamanoArchivo(a.tamano)}</small></span></a>`;
    })
    .join('')}</div>`;
}

// Selector de archivos con lista de los elegidos (para formularios y comentarios).
function selectorArchivos(contenedor) {
  const elegidos = [];
  contenedor.innerHTML = `<label class="btn btn-sm">${icon('clip')}Adjuntar<input type="file" multiple hidden></label><span class="archivos-elegidos"></span>`;
  const entrada = contenedor.querySelector('input');
  const lista = contenedor.querySelector('.archivos-elegidos');
  const pintar = () => {
    lista.innerHTML = elegidos.map((f, i) => `<span class="chip-archivo">${esc(f.name)}<button type="button" data-quitar="${i}" aria-label="Quitar">${icon('x')}</button></span>`).join('');
  };
  entrada.addEventListener('change', () => {
    const max = cfg().maxArchivoMb * 1024 * 1024;
    for (const f of entrada.files) {
      if (f.size > max) toast(`"${f.name}" supera ${cfg().maxArchivoMb} MB`, 'error');
      else elegidos.push(f);
    }
    entrada.value = '';
    pintar();
  });
  lista.addEventListener('click', (e) => {
    const b = e.target.closest('[data-quitar]');
    if (!b) return;
    elegidos.splice(Number(b.dataset.quitar), 1);
    pintar();
  });
  return {
    archivos: () => [...elegidos],
    limpiar: () => {
      elegidos.length = 0;
      pintar();
    },
  };
}

const subirAdjuntosSolicitud = (id, archivos, extra = {}) =>
  subirArchivos({ ruta: `/solicitudes/${id}/adjuntos`, carpeta: `solicitudes/${id}`, archivos, extra });

// ---------- Nueva solicitud ----------

export async function formularioSolicitud({ trabajoId = null, alGuardar } = {}) {
  const [usuarios, trabajos] = await Promise.all([usuariosActivos(), trabajoId ? [] : api('/trabajos?orden=recientes')]);
  const proyecto = trabajoId ? await api(`/trabajos/${trabajoId}`) : null;
  const otros = usuarios.filter((u) => u.id !== state.usuario.id);
  const m = modal({
    titulo: 'Nueva solicitud',
    body: `<form class="form-grid" id="form-solicitud" novalidate>
      ${
        proyecto
          ? `<div class="field full"><span>Proyecto</span><div class="dato">${esc(numeroTrabajo(proyecto.numero))} · ${esc(proyecto.cliente)}${proyecto.descripcion ? ` · ${esc(proyecto.descripcion.split('\n')[0])}` : ''}</div></div>`
          : `<label class="field full"><span>Proyecto <b class="req">*</b></span><select name="trabajo_id"><option value="">— Selecciona el proyecto —</option>${trabajos
              .map((t) => `<option value="${t.id}">${esc(numeroTrabajo(t.numero))} · ${esc(t.cliente)}${t.descripcion ? ` · ${esc(t.descripcion.split('\n')[0])}` : ''}</option>`)
              .join('')}</select></label>`
      }
      <label class="field"><span>Tipo de solicitud <b class="req">*</b></span><select name="tipo"><option value="">— Selecciona —</option>${cfg()
        .solicitudTipos.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`)
        .join('')}</select></label>
      <div class="field"><span>Prioridad</span><div class="segmentado" data-prioridad>${cfg()
        .prioridades.map((p, i) => `<button type="button" data-valor="${p.key}" class="${i === 0 ? 'activo' : ''}">${esc(p.label)}</button>`)
        .join('')}</div></div>
      <label class="field full"><span>Título <b class="req">*</b></span><input name="titulo" maxlength="200" placeholder="Ej. El cliente pide cambiar el color del logo"></label>
      <label class="field full"><span>Descripción</span><textarea name="descripcion" rows="4" placeholder="Detalla la solicitud o novedad…"></textarea></label>
      <div class="field full"><span>Enviar a (destinatarios)</span>
        <div class="status-chips">${otros
          .map((u) => `<label class="status-chip" style="--c:var(--primary)"><input type="checkbox" name="destinatarios" value="${u.id}"><span>${esc(u.nombre)}</span></label>`)
          .join('') || '<span class="muted">No hay otros usuarios registrados</span>'}</div></div>
      <div class="field full"><span>¿Esta solicitud modifica el alcance, costo o fecha del proyecto?</span>
        <div class="segmentado segmentado-sm" data-aprobacion>
          <button type="button" data-valor="no" class="activo">No</button><button type="button" data-valor="si">Sí, requiere aprobación</button>
        </div>
        <small class="muted nota" data-nota-aprobacion hidden>Quedará «Pendiente de aprobación» y se avisará a los administradores. No cambia automáticamente presupuesto, fechas ni condiciones del proyecto.</small></div>
      <div class="field full"><span>Archivos o fotografías (opcional)</span><div class="selector-archivos" data-archivos></div></div>
    </form>`,
    foot: `<button class="btn" data-close type="button">Cancelar</button>
      <button class="btn btn-primary" type="submit" form="form-solicitud">${icon('enviar')}Enviar solicitud</button>`,
  });
  const form = m.el.querySelector('form');
  const archivos = selectorArchivos(m.el.querySelector('[data-archivos]'));
  let prioridad = 'normal';
  let requiere = 'no';
  const segmentado = (sel, fn) =>
    m.el.querySelectorAll(`${sel} button`).forEach((b) =>
      b.addEventListener('click', () => {
        m.el.querySelectorAll(`${sel} button`).forEach((x) => x.classList.toggle('activo', x === b));
        fn(b.dataset.valor);
      })
    );
  segmentado('[data-prioridad]', (v) => (prioridad = v));
  segmentado('[data-aprobacion]', (v) => {
    requiere = v;
    m.el.querySelector('[data-nota-aprobacion]').hidden = v !== 'si';
  });
  (form.elements.trabajo_id || form.elements.tipo).focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const trabajo = trabajoId || Number(form.elements.trabajo_id.value);
    if (!trabajo) return toast('Selecciona el proyecto', 'error');
    if (!form.elements.tipo.value) return toast('Selecciona el tipo de solicitud', 'error');
    if (!form.elements.titulo.value.trim()) return toast('Escribe un título', 'error');
    const boton = m.el.querySelector('[type=submit]');
    boton.disabled = true;
    try {
      const creada = await api('/solicitudes', {
        method: 'POST',
        body: {
          trabajo_id: trabajo,
          tipo: form.elements.tipo.value,
          titulo: form.elements.titulo.value,
          descripcion: form.elements.descripcion.value,
          prioridad,
          requiere_aprobacion: requiere === 'si',
          destinatarios: [...form.querySelectorAll('[name=destinatarios]:checked')].map((c) => Number(c.value)),
        },
      });
      if (archivos.archivos().length) await subirAdjuntosSolicitud(creada.id, archivos.archivos());
      toast('Solicitud enviada');
      m.close();
      alGuardar?.(creada);
    } catch (err) {
      toast(err.message, 'error');
      boton.disabled = false;
    }
  });
}

// ---------- Detalle con conversación ----------

export async function detalleSolicitud(id, { alCambiar } = {}) {
  let huboCambios = false;
  const m = modal({
    wide: true,
    titulo: 'Solicitud',
    body: '<div class="cargando">Cargando…</div>',
    onClose: () => huboCambios && alCambiar?.(),
  });
  const cuerpo = m.el.querySelector('.modal-body');
  const titulo = m.el.querySelector('.modal-head h2');
  const usuarios = await usuariosActivos().catch(() => []);
  let s;
  let adjuntosComentario;

  async function pintar({ alFinal = false } = {}) {
    try {
      s = await api(`/solicitudes/${id}`);
    } catch (err) {
      cuerpo.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
      return;
    }
    titulo.innerHTML = `${esc(s.titulo)} ${badgeEstadoSol(s.estado)} ${badgePrioridad(s.prioridad)}`;
    const borrador = cuerpo.querySelector('[name=mensaje]')?.value || '';
    const ap = s.requiere_aprobacion
      ? `<div class="aprobacion-box ${s.aprobacion}">
          <div><strong>${icon(s.aprobacion === 'pendiente' ? 'alert' : 'check')} Modifica alcance, costo o fecha del proyecto</strong></div>
          ${
            s.aprobacion === 'pendiente'
              ? `<div>Pendiente de aprobación de un administrador. El proyecto no cambia hasta que se apruebe y se actualicen sus datos.</div>
                 ${
                   s.permisos.aprobar
                     ? `<div class="aprobacion-acciones"><input class="input" name="comentario_aprobacion" placeholder="Comentario (opcional)">
                        <button class="btn btn-primary btn-sm" type="button" data-decision="aprobada">${icon('check')}Aprobar</button>
                        <button class="btn btn-danger btn-sm" type="button" data-decision="rechazada">${icon('x')}Rechazar</button></div>`
                     : ''
                 }`
              : `<div>${s.aprobacion === 'aprobada' ? 'Aprobada' : 'Rechazada'} por <strong>${esc(s.aprobada_por_nombre || '—')}</strong> el ${fechaHora(s.aprobada_en)}.
                 ${s.aprobacion === 'aprobada' ? ' El responsable puede implementar el cambio y actualizar los datos del proyecto.' : ''}</div>`
          }</div>`
      : '';
    cuerpo.innerHTML = `
      <div class="sol-meta">
        <div><small>Proyecto</small><button type="button" class="link" data-ver-proyecto>${esc(s.proyecto)}${s.trabajo_descripcion ? ` · ${esc(s.trabajo_descripcion.split('\n')[0])}` : ''}</button></div>
        <div><small>Tipo</small>${esc(s.tipo_label)}</div>
        <div><small>Registrada por</small>${esc(s.creado_por_nombre || '—')} · ${fechaHora(s.creado_en)}</div>
        <div><small>Destinatarios</small><span class="destinatarios">${
          s.destinatarios.map((u) => `<span class="chip-usuario">${esc(u.nombre)}</span>`).join('') || '<span class="muted">Sin asignar</span>'
        }${s.permisos.agregar_destinatarios ? `<button type="button" class="btn btn-sm btn-ghost" data-asignar>${icon('plus')}Asignar</button>` : ''}</span></div>
      </div>
      ${ap}
      ${s.descripcion ? `<div class="sol-descripcion">${resaltarMenciones(s.descripcion).replace(/\n/g, '<br>')}</div>` : ''}
      ${listaArchivos(s.adjuntos)}
      ${
        s.permisos.cambiar_estado
          ? `<div class="sol-controles">
              <label class="field"><span>Estado de la solicitud</span><select name="estado">${cfg()
                .solicitudEstados.filter((e) => e.key !== 'pendiente_aprobacion' || s.estado === 'pendiente_aprobacion')
                .map((e) => `<option value="${e.key}" ${e.key === s.estado ? 'selected' : ''}>${esc(e.label)}</option>`)
                .join('')}</select></label>
              <label class="field"><span>Prioridad</span><select name="prioridad">${cfg()
                .prioridades.map((p) => `<option value="${p.key}" ${p.key === s.prioridad ? 'selected' : ''}>${esc(p.label)}</option>`)
                .join('')}</select></label>
            </div>`
          : ''
      }
      <div class="section-title">${icon('mensaje')} Conversación</div>
      <div class="hilo">${s.comentarios
        .map((c) =>
          c.tipo === 'evento'
            ? `<div class="hilo-evento">${icon('clock')}<span><strong>${esc(c.usuario_nombre || 'Sistema')}</strong> ${esc(c.mensaje)} · ${fechaHora(c.creado_en)}</span></div>`
            : `<div class="hilo-msj ${c.usuario_id === state.usuario.id ? 'propio' : ''}">
                <div class="hilo-cab"><strong>${esc(c.usuario_nombre || '—')}</strong><span>${fechaHora(c.creado_en)}</span></div>
                <div class="hilo-texto">${resaltarMenciones(c.mensaje).replace(/\n/g, '<br>')}</div>${listaArchivos(c.adjuntos)}</div>`
        )
        .join('')}</div>
      <form class="composer" novalidate>
        <textarea name="mensaje" rows="2" placeholder="Escribe un comentario… usa @nombre para mencionar a alguien"></textarea>
        <div class="composer-acciones">
          <div class="selector-archivos" data-archivos-comentario></div>
          <div class="menciones">${usuarios
            .filter((u) => u.id !== state.usuario.id)
            .slice(0, 8)
            .map((u) => `<button type="button" class="chip-mencion" data-mencionar="${esc(u.usuario)}">@${esc(u.nombre.split(' ')[0])}</button>`)
            .join('')}</div>
          <button class="btn btn-primary" type="submit">${icon('enviar')}Enviar</button>
        </div>
      </form>`;
    const caja = cuerpo.querySelector('[name=mensaje]');
    caja.value = borrador;
    adjuntosComentario = selectorArchivos(cuerpo.querySelector('[data-archivos-comentario]'));
    if (alFinal) cuerpo.querySelector('.composer').scrollIntoView({ block: 'end' });
  }

  m.el.querySelector('.modal-foot')?.remove();
  if (esAdmin()) {
    const pie = document.createElement('div');
    pie.className = 'modal-foot';
    pie.innerHTML = `<button class="btn btn-danger left" type="button" data-borrar>${icon('trash')}Eliminar solicitud</button><button class="btn" data-cerrar type="button">Cerrar</button>`;
    m.el.querySelector('.modal').append(pie);
    pie.querySelector('[data-cerrar]').addEventListener('click', m.close);
    pie.querySelector('[data-borrar]').addEventListener('click', async () => {
      if (!(await confirmar('¿Eliminar esta solicitud con toda su conversación y archivos? Esta acción no se puede deshacer.'))) return;
      try {
        await api(`/solicitudes/${id}`, { method: 'DELETE' });
        toast('Solicitud eliminada');
        huboCambios = true;
        m.close();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  const accion = async (fn, mensajeOk) => {
    try {
      await fn();
      huboCambios = true;
      if (mensajeOk) toast(mensajeOk);
      await pintar();
    } catch (err) {
      toast(err.message, 'error');
      await pintar();
    }
  };

  cuerpo.addEventListener('change', (e) => {
    const n = e.target.name;
    if (n === 'estado' || n === 'prioridad') {
      accion(() => api(`/solicitudes/${id}`, { method: 'PATCH', body: { [n]: e.target.value } }), n === 'estado' ? 'Estado actualizado' : 'Prioridad actualizada');
    }
  });
  cuerpo.addEventListener('click', async (e) => {
    const decision = e.target.closest('[data-decision]');
    if (decision) {
      const comentario = cuerpo.querySelector('[name=comentario_aprobacion]')?.value;
      accion(() => api(`/solicitudes/${id}/aprobacion`, { method: 'POST', body: { decision: decision.dataset.decision, comentario } }), decision.dataset.decision === 'aprobada' ? 'Modificación aprobada' : 'Modificación rechazada');
      return;
    }
    if (e.target.closest('[data-asignar]')) {
      elegirDestinatarios(s, usuarios, (ids) => accion(() => api(`/solicitudes/${id}/destinatarios`, { method: 'POST', body: { usuarios: ids } }), 'Solicitud asignada'));
      return;
    }
    const mencion = e.target.closest('[data-mencionar]');
    if (mencion) {
      const caja = cuerpo.querySelector('[name=mensaje]');
      caja.value = `${caja.value}${caja.value && !caja.value.endsWith(' ') ? ' ' : ''}@${mencion.dataset.mencionar} `;
      caja.focus();
      return;
    }
    if (e.target.closest('[data-ver-proyecto]')) {
      const { abrirFicha } = await import('./trabajos-comun.js');
      abrirFicha(s.trabajo_id);
    }
  });
  cuerpo.addEventListener('submit', async (e) => {
    e.preventDefault();
    const caja = cuerpo.querySelector('[name=mensaje]');
    const archivos = adjuntosComentario.archivos();
    if (!caja.value.trim()) return toast(archivos.length ? 'Escribe un mensaje para acompañar los archivos' : 'Escribe un mensaje', 'error');
    const boton = cuerpo.querySelector('.composer [type=submit]');
    boton.disabled = true;
    try {
      const c = await api(`/solicitudes/${id}/comentarios`, { method: 'POST', body: { mensaje: caja.value } });
      if (archivos.length) await subirAdjuntosSolicitud(id, archivos, { comentario_id: c.id });
      caja.value = '';
      huboCambios = true;
      await pintar({ alFinal: true });
    } catch (err) {
      toast(err.message, 'error');
      boton.disabled = false;
    }
  });
  cuerpo.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + Enter envía el comentario
    if (e.target.name === 'mensaje' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      cuerpo.querySelector('.composer').requestSubmit();
    }
  });
  await pintar();
}

function elegirDestinatarios(s, usuarios, alElegir) {
  const actuales = s.destinatarios.map((u) => u.id);
  const disponibles = usuarios.filter((u) => !actuales.includes(u.id));
  if (!disponibles.length) return toast('Todos los usuarios ya están asignados');
  const m = modal({
    titulo: 'Asignar solicitud',
    body: `<div class="status-chips">${disponibles
      .map((u) => `<label class="status-chip" style="--c:var(--primary)"><input type="checkbox" value="${u.id}"><span>${esc(u.nombre)}</span></label>`)
      .join('')}</div>`,
    foot: `<button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" type="button" data-ok>Asignar</button>`,
  });
  m.el.querySelector('[data-ok]').addEventListener('click', () => {
    const ids = [...m.el.querySelectorAll('input:checked')].map((c) => Number(c.value));
    if (!ids.length) return toast('Selecciona al menos un usuario', 'error');
    m.close();
    alElegir(ids);
  });
}

// ---------- Tabla de solicitudes ----------

export function tablaSolicitudes(lista, { conProyecto = true } = {}) {
  if (!lista.length) return vacio('No hay solicitudes que coincidan', 'mensaje');
  return `<div class="table-wrap"><table class="data responsive">
    <thead><tr><th>N°</th>${conProyecto ? '<th>Proyecto</th>' : ''}<th>Solicitud</th><th>Prioridad</th><th>Estado</th><th>Registrada por</th><th>Asignada a</th><th>Fecha</th><th></th>${esAdmin() ? '<th></th>' : ''}</tr></thead>
    <tbody>${lista
      .map(
        (s) => `<tr data-solicitud="${s.id}" class="${s.abierta ? '' : 'cerrada'}">
        <td data-label="N°" class="num">#${s.id}</td>
        ${conProyecto ? `<td data-label="Proyecto" class="nowrap">${esc(s.proyecto)}</td>` : ''}
        <td data-label="Solicitud"><strong>${esc(s.titulo)}</strong><br><small class="muted">${esc(s.tipo_label)}</small></td>
        <td data-label="Prioridad">${badgePrioridad(s.prioridad)}</td>
        <td data-label="Estado">${badgeEstadoSol(s.estado)}</td>
        <td data-label="Registrada por">${esc(s.creado_por_nombre || '—')}</td>
        <td data-label="Asignada a">${esc(s.destinatarios_nombres || '—')}</td>
        <td data-label="Fecha" class="nowrap" title="${fechaHora(s.creado_en)}">${tiempoRelativo(s.creado_en)}</td>
        <td data-label="Comentarios" class="nowrap">${s.total_comentarios ? `<span class="clip">${icon('mensaje')}${s.total_comentarios}</span>` : ''}</td>
        ${esAdmin() ? `<td data-label="" class="col-acciones">${botonPapelera(`data-borrar-solicitud="${s.id}"`, 'Eliminar solicitud')}</td>` : ''}
      </tr>`
      )
      .join('')}</tbody></table></div>`;
}

export function conectarSolicitudes(contenedor, { obtener, alCambiar }) {
  conectarPapeleras(contenedor, '[data-borrar-solicitud]', {
    mensaje: (b) => `¿Eliminar la solicitud «${obtener(Number(b.dataset.borrarSolicitud))?.titulo}» con toda su conversación y archivos?`,
    eliminar: (b) => api(`/solicitudes/${b.dataset.borrarSolicitud}`, { method: 'DELETE' }),
    alEliminar: alCambiar,
    exito: 'Solicitud eliminada',
  });
  contenedor.addEventListener('click', (e) => {
    const fila = e.target.closest('tr[data-solicitud]');
    if (fila) detalleSolicitud(Number(fila.dataset.solicitud), { alCambiar });
  });
}

// ---------- Pestaña en la ficha del proyecto ----------

export async function seccionSolicitudesTrabajo(contenedor, trabajo, { alContar } = {}) {
  let lista = [];
  const cargar = async () => {
    const r = await api(`/solicitudes/proyecto/${trabajo.id}`);
    lista = r.solicitudes;
    alContar?.(r.abiertas);
    contenedor.innerHTML = `
      <div class="toolbar">
        <div class="kpis kpis-3 kpis-compactos" style="flex:1;margin:0">
          <div class="kpi"><small>Solicitudes abiertas</small><strong>${r.abiertas}</strong></div>
          <div class="kpi ${r.pendientes_aprobacion ? 'kpi-alerta' : ''}"><small>Pendientes de aprobación</small><strong>${r.pendientes_aprobacion}</strong></div>
          <div class="kpi"><small>Total registradas</small><strong>${r.solicitudes.length}</strong></div>
        </div>
      </div>
      <div class="toolbar"><span class="spacer"></span><button class="btn btn-primary" type="button" data-nueva>${icon('plus')}Nueva solicitud</button></div>
      ${
        r.ultimas_observaciones.length
          ? `<div class="section-title">${icon('mensaje')} Últimas observaciones</div>
             <ul class="ultimas">${r.ultimas_observaciones
               .map((c) => `<li data-abrir="${c.solicitud_id}"><strong>${esc(c.usuario_nombre || '—')}</strong> en «${esc(c.titulo)}» · <span class="muted">${tiempoRelativo(c.creado_en)}</span><div>${resaltarMenciones(c.mensaje.length > 180 ? `${c.mensaje.slice(0, 179)}…` : c.mensaje)}</div></li>`)
               .join('')}</ul>`
          : ''
      }
      <div class="section-title">${icon('clock')} Historial de solicitudes y comunicaciones</div>
      <div data-lista>${tablaSolicitudes(lista, { conProyecto: false })}</div>`;
  };
  contenedor.addEventListener('click', (e) => {
    if (e.target.closest('[data-nueva]')) formularioSolicitud({ trabajoId: trabajo.id, alGuardar: cargar });
    const abrir = e.target.closest('[data-abrir]');
    if (abrir) detalleSolicitud(Number(abrir.dataset.abrir), { alCambiar: cargar });
  });
  conectarSolicitudes(contenedor, { obtener: (id) => lista.find((s) => s.id === id), alCambiar: cargar });
  await cargar();
  return cargar;
}

