// «Mi día»: agenda personal y centro de prioridades del usuario conectado.
import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { esAdmin } from '../state.js';
import { esc, toast, hoyIso, fecha, vacio, modal } from '../ui.js';
import { montarCalendario, sumarDias, fechaLarga } from '../components/calendario.js';
import { formularioTarea, formularioNota, abrirElemento, completarTarea, abrirTarea } from '../components/mi-dia-comun.js';

const ORIGEN = { tarea: 'Tarea', nota: 'Observación personal', auto: 'Automático' };
const ICONO_AUTO = { cotizacion: 'tag', inicio: 'calendario', produccion: 'trabajos', entrega: 'trabajos', reclamo: 'alert', solicitud: 'mensaje' };
const mayuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function htmlItem(it, hoy) {
  const tarea = it.origen === 'tarea';
  const hecha = tarea && it.estado === 'completada';
  const meta = [];
  if (it.etiqueta && it.origen !== 'tarea' && !it.titulo.startsWith(it.etiqueta)) meta.push(esc(it.etiqueta));
  if (it.etiqueta && it.origen === 'tarea') meta.push(`<strong>${esc(it.etiqueta)}</strong>`);
  if (it.fecha && it.fecha !== hoy) meta.push(`${icon('calendario')}${fecha(it.fecha)}`);
  if (it.hora) meta.push(`${icon('clock')}${esc(it.hora)}`);
  if (it.proyecto) meta.push(`${icon('trabajos')}${esc(it.proyecto)}`);
  if (tarea && it.etiquetados?.length) meta.push(`${icon('arroba')}${it.etiquetados.map((e) => esc(e.nombre)).join(', ')}`);
  if (tarea && it.soy_etiquetado) meta.push(`Responsable: ${esc(it.asignado_nombre || '—')}`);
  if (it.detalle) meta.push(esc(it.detalle));
  if (tarea && it.creado_por !== it.asignado_a && !it.etiqueta) meta.push(`Asignada por ${esc(it.creado_por_nombre || '—')}`);
  if (tarea && it.estado === 'en_proceso') meta.push('<span class="md-en-proceso">En proceso</span>');
  const extracto = it.origen === 'nota' ? it.nota : it.origen === 'tarea' ? it.descripcion : '';
  const iconoOrigen = tarea ? '' : `<span class="md-icono">${icon(it.origen === 'nota' ? 'nota' : ICONO_AUTO[it.tipo] || 'alert')}</span>`;
  return `<div class="md-item origen-${it.origen} prioridad-${it.prioridad || 'normal'} ${it.vencido ? 'vencido' : ''} ${hecha ? 'hecha' : ''}" data-clave="${esc(it.clave)}" role="button" tabindex="0">
    ${tarea && it.puede_editar === false ? `<span class="md-icono md-etiquetado" title="Te etiquetaron">${icon('arroba')}</span>` : ''}
    ${tarea && it.puede_editar !== false ? `<label class="md-check" data-stop title="${hecha ? 'Marcar como pendiente' : 'Marcar como completada'}"><input type="checkbox" data-completar="${it.id}" ${hecha ? 'checked' : ''}><span></span></label>` : tarea ? '' : iconoOrigen}
    <div class="md-cuerpo">
      <div class="md-titulo">${it.vencido ? `<span class="md-vencido">${icon('alert')}Vencido</span>` : ''}${esc(it.titulo)}</div>
      ${extracto ? `<div class="md-extracto">${esc(extracto)}</div>` : ''}
      ${meta.length ? `<div class="md-meta">${meta.map((x) => `<span>${x}</span>`).join('')}</div>` : ''}
    </div>
    <div class="md-etiquetas">
      ${it.prioridad && it.prioridad !== 'normal' ? `<span class="md-prioridad ${it.prioridad}">${it.prioridad === 'urgente' ? 'Urgente' : 'Alta'}</span>` : ''}
      <span class="md-origen">${ORIGEN[it.origen]}</span>
    </div>
  </div>`;
}

function seccion(id, titulo, ico, items, hoy, vacioTexto) {
  return `<section class="panel md-seccion md-${id}">
    <div class="panel-head"><h2>${icon(ico)} ${titulo}</h2><span class="muted">${items.length || ''}</span></div>
    <div class="md-lista">${items.length ? items.map((it) => htmlItem(it, hoy)).join('') : `<p class="md-vacio">${esc(vacioTexto)}</p>`}</div>
  </section>`;
}

export default {
  id: 'mi-dia',
  titulo: 'Mi día',
  icono: 'sol',

  async render(vista, params) {
    let dia = params.get('fecha') || hoyIso();
    let modo = params.get('vista') === 'agenda' ? 'agenda' : 'dia';
    let datos = null;
    let calendario = null;
    const items = new Map();

    // Los eventos se escuchan en un contenedor propio: #view se reutiliza entre pantallas.
    vista.innerHTML = '<div class="mi-dia"></div>';
    const raiz = vista.firstElementChild;
    raiz.innerHTML = `
      <div class="md-cabecera panel">
        <div class="md-fecha">
          <div class="md-dia-nav">
            <button class="btn btn-sm" type="button" data-dia="-1" aria-label="Día anterior">‹</button>
            <input type="date" class="input" data-elegir-dia aria-label="Elegir día">
            <button class="btn btn-sm" type="button" data-dia="1" aria-label="Día siguiente">›</button>
            <button class="btn btn-sm" type="button" data-dia="0">Hoy</button>
          </div>
          <h2 data-titulo-dia></h2>
        </div>
        <div class="md-contadores" data-contadores></div>
        <div class="md-acciones">
          <button class="btn btn-primary" type="button" data-nueva-tarea>${icon('plus')}Nueva tarea</button>
          <button class="btn" type="button" data-nueva-nota>${icon('plus')}Nueva observación</button>
          <button class="btn" type="button" data-agenda>${icon('calendario')}<span>Ver toda mi agenda</span></button>
          <button class="btn btn-ghost" type="button" data-historial>${icon('historial')}Historial</button>
        </div>
      </div>
      <div data-contenido></div>`;
    const $ = (s) => raiz.querySelector(s);
    const contenido = $('[data-contenido]');

    function pintar() {
      const hoy = datos.hoy;
      const r = datos.resumen;
      $('[data-elegir-dia]').value = dia;
      $('[data-titulo-dia]').textContent = dia === hoy ? `Hoy, ${fechaLarga(dia)}` : mayuscula(fechaLarga(dia));
      $('[data-contadores]').innerHTML = `
        <div class="md-contador"><strong>${r.pendientes}</strong><span>${r.pendientes === 1 ? 'tarea pendiente' : 'tareas pendientes'}</span></div>
        <div class="md-contador ok"><strong>${r.completadas}</strong><span>${r.completadas === 1 ? 'completada' : 'completadas'}</span></div>
        <div class="md-contador ${r.atrasados ? 'alerta' : ''}"><strong>${r.atrasados}</strong><span>${r.atrasados === 1 ? 'compromiso atrasado' : 'compromisos atrasados'}</span></div>`;
      items.clear();
      [...datos.atencion, ...Object.values(datos.secciones).flat()].forEach((it) => items.set(it.clave, it));
      const s = datos.secciones;
      contenido.innerHTML = `
        ${
          esAdmin()
            ? `<section class="panel md-seccion md-atencion">
                <div class="panel-head"><h2>${icon('alert')} Requieren mi atención</h2><span class="muted">${datos.atencion.length || ''}</span></div>
                <div class="md-lista">${
                  datos.atencion.length
                    ? datos.atencion.map((it) => htmlItem(it, hoy)).join('')
                    : `<p class="md-vacio">${icon('check')} Nada pendiente de tu decisión.</p>`
                }</div></section>`
            : ''
        }
        <div class="md-columnas">
          <div>
            ${seccion('hoy', dia === hoy ? 'Hoy' : mayuscula(fechaLarga(dia)), 'sol', s.hoy, hoy, 'No hay nada programado para este día.')}
            ${s.atrasados.length ? seccion('atrasados', 'Atrasados', 'alert', s.atrasados, hoy, '') : ''}
          </div>
          <div>
            ${seccion('proximos', 'Próximos 7 días', 'calendario', s.proximos, hoy, 'Sin compromisos en los próximos días.')}
            ${seccion('completados', dia === hoy ? 'Completadas hoy' : 'Completadas ese día', 'check', s.completados, hoy, 'Aún no hay tareas completadas.')}
          </div>
        </div>`;
    }

    async function cargar() {
      datos = await api(`/mi-dia${qs({ fecha: dia })}`);
      pintar();
    }

    function mostrarAgenda() {
      modo = 'agenda';
      $('[data-agenda] span').textContent = 'Volver a mi día';
      raiz.querySelector('.md-dia-nav').hidden = true;
      $('[data-contadores]').hidden = true;
      $('[data-titulo-dia]').textContent = 'Mi agenda';
      contenido.innerHTML = `<p class="muted nota">Tus tareas, observaciones y los compromisos de proyectos que te corresponden. La agenda general de producción está en <a href="#/trabajos?vista=agenda">Control de trabajos › Agenda</a>.</p>
        <section class="panel"><div data-calendario></div></section>`;
      calendario = montarCalendario(contenido.querySelector('[data-calendario]'), {
        leyenda: [
          { tipo: 'tarea', label: 'Tarea' },
          { tipo: 'nota', label: 'Observación personal' },
          { tipo: 'entrega', label: 'Compromiso de proyecto' },
          { tipo: 'solicitud', label: 'Solicitud' },
          { tipo: 'vencido', label: 'Vencido' },
        ],
        cargarEventos: async (desde, hasta) => {
          const lista = await api(`/mi-dia/agenda${qs({ desde, hasta })}`);
          return lista.map((it) => ({
            ...it,
            tipo: it.vencido ? 'vencido' : it.origen === 'auto' ? (it.tipo === 'solicitud' ? 'solicitud' : 'entrega') : it.origen,
            etiqueta: it.origen === 'auto' ? 'Proyecto' : ORIGEN[it.origen],
            detalle: [it.hora, it.proyecto || it.detalle].filter(Boolean).join(' · '),
            abrir: () => abrirElemento(it, { alCambiar: () => calendario.recargar() }),
          }));
        },
      });
    }
    function mostrarDia() {
      modo = 'dia';
      calendario = null;
      $('[data-agenda] span').textContent = 'Ver toda mi agenda';
      raiz.querySelector('.md-dia-nav').hidden = false;
      $('[data-contadores]').hidden = false;
      cargar();
    }
    const recargar = () => (modo === 'agenda' ? calendario?.recargar() : cargar());

    // --- Eventos ---
    raiz.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-dia]');
      if (nav) {
        dia = Number(nav.dataset.dia) ? sumarDias(dia, Number(nav.dataset.dia)) : hoyIso();
        return cargar();
      }
      if (e.target.closest('[data-nueva-tarea]')) return formularioTarea(null, { inicial: { fecha: modo === 'dia' ? dia : hoyIso() }, alGuardar: recargar });
      if (e.target.closest('[data-nueva-nota]')) return formularioNota(null, { inicial: { fecha: modo === 'dia' ? dia : hoyIso() }, alGuardar: recargar });
      if (e.target.closest('[data-agenda]')) return modo === 'agenda' ? mostrarDia() : mostrarAgenda();
      if (e.target.closest('[data-historial]')) return historial(recargar);
      if (e.target.closest('[data-stop]')) return;
      const fila = e.target.closest('[data-clave]');
      if (fila) abrirElemento(items.get(fila.dataset.clave), { alCambiar: recargar });
    });
    raiz.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.matches('[data-clave]')) return;
      abrirElemento(items.get(e.target.dataset.clave), { alCambiar: recargar });
    });
    $('[data-elegir-dia]').addEventListener('change', (e) => {
      if (!e.target.value) return;
      dia = e.target.value;
      cargar();
    });
    // Casilla: completar rápidamente una tarea.
    raiz.addEventListener('change', async (e) => {
      const c = e.target.closest('[data-completar]');
      if (!c) return;
      c.closest('.md-item').classList.toggle('hecha', c.checked);
      try {
        await completarTarea(c.dataset.completar, c.checked);
        toast(c.checked ? 'Tarea completada' : 'Tarea pendiente otra vez');
        cargar();
      } catch (err) {
        toast(err.message, 'error');
        c.checked = !c.checked;
      }
    });

    if (modo === 'agenda') mostrarAgenda();
    else await cargar();
    if (params.get('tarea')) abrirTarea(Number(params.get('tarea')), { alGuardar: recargar });
  },
};

// Historial de tareas completadas o archivadas (permanecen guardadas).
async function historial(alCambiar) {
  const lista = await api('/mi-dia/historial');
  const m = modal({
    wide: true,
    titulo: `${icon('historial')} Historial de tareas`,
    body: lista.length
      ? `<div class="md-lista">${lista
          .map(
            (t) => `<div class="md-item origen-tarea hecha" data-id="${t.id}" role="button" tabindex="0">
              <span class="md-icono">${icon(t.estado === 'completada' ? 'check' : 'inbox')}</span>
              <div class="md-cuerpo"><div class="md-titulo">${esc(t.titulo)}</div>
                <div class="md-meta"><span>${t.estado === 'completada' ? `Completada el ${fecha(t.completada_fecha)}` : 'Archivada'}</span>
                ${t.proyecto ? `<span>${icon('trabajos')}${esc(t.proyecto)}</span>` : ''}
                <span>Responsable: ${esc(t.asignado_nombre || '—')}</span></div></div>
            </div>`
          )
          .join('')}</div>`
      : vacio('Todavía no hay tareas completadas', 'check'),
    foot: '<button class="btn btn-primary" data-close type="button">Cerrar</button>',
  });
  m.el.querySelector('.modal-body').addEventListener('click', (e) => {
    const fila = e.target.closest('[data-id]');
    if (!fila) return;
    m.close();
    abrirTarea(Number(fila.dataset.id), { alGuardar: alCambiar });
  });
}
