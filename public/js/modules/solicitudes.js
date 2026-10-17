import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { state, numeroTrabajo } from '../state.js';
import { esc, debounce } from '../ui.js';
import {
  formularioSolicitud, detalleSolicitud, tablaSolicitudes, conectarSolicitudes, usuariosActivos,
} from '../components/solicitudes-comun.js';

const VISTAS = [
  { id: '', titulo: 'Todas' },
  { id: 'mias', titulo: 'Mis solicitudes' },
  { id: 'asignadas', titulo: 'Asignadas a mí' },
];

export default {
  id: 'solicitudes',
  titulo: 'Solicitudes y novedades',
  icono: 'mensaje',

  async render(vista, params) {
    const f = { vista: params.get('vista') || '', trabajo_id: '', cliente: '', tipo: '', estado: '', asignado: '', prioridad: '', desde: '', hasta: '', q: '' };
    const [trabajos, usuarios] = await Promise.all([api('/trabajos?orden=recientes'), usuariosActivos()]);
    const opciones = (lista) => lista.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    vista.innerHTML = `
      <div class="kpis" data-kpis></div>
      <div class="toolbar">
        <nav class="tabs tabs-inline" role="tablist">${VISTAS.map((v) => `<button type="button" data-vista="${v.id}">${v.titulo}</button>`).join('')}</nav>
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" data-nueva>${icon('plus')}Nueva solicitud</button>
      </div>
      <div class="toolbar">
        <div class="search">${icon('search')}<input type="search" name="q" placeholder="Buscar por título, descripción o cliente…"></div>
        <select name="trabajo_id" aria-label="Proyecto"><option value="">Todos los proyectos</option>${opciones(
          trabajos.map((t) => [t.id, `${numeroTrabajo(t.numero)} · ${t.cliente}`])
        )}</select>
        <input name="cliente" placeholder="Cliente" aria-label="Cliente" style="max-width:170px">
      </div>
      <div class="toolbar">
        <select name="tipo" aria-label="Tipo"><option value="">Todos los tipos</option>${opciones(state.config.solicitudTipos.map((t) => [t.key, t.label]))}</select>
        <select name="estado" aria-label="Estado"><option value="">Todos los estados</option><option value="abiertas">Sólo abiertas</option>${opciones(
          state.config.solicitudEstados.map((e) => [e.key, e.label])
        )}</select>
        <select name="asignado" aria-label="Usuario asignado"><option value="">Cualquier usuario asignado</option>${opciones(usuarios.map((u) => [u.id, u.nombre]))}</select>
        <select name="prioridad" aria-label="Prioridad"><option value="">Todas las prioridades</option>${opciones(state.config.prioridades.map((p) => [p.key, p.label]))}</select>
        <div class="toolbar-group"><span class="toolbar-label">Fecha</span><input type="date" name="desde" aria-label="Desde"><input type="date" name="hasta" aria-label="Hasta"></div>
        <button class="btn btn-ghost btn-sm" type="button" data-limpiar>Limpiar filtros</button>
      </div>
      <section class="panel">
        <div class="panel-head"><h2 data-titulo>Solicitudes</h2><span class="muted" data-contador></span></div>
        <div data-tabla></div>
      </section>`;
    const $ = (s) => vista.querySelector(s);
    let lista = [];

    async function cargar() {
      vista.querySelectorAll('[data-vista]').forEach((b) => b.classList.toggle('activo', b.dataset.vista === f.vista));
      const [resumen, solicitudes] = await Promise.all([api('/solicitudes/resumen'), api(`/solicitudes${qs(f)}`)]);
      lista = solicitudes;
      $('[data-kpis]').innerHTML = `
        <button type="button" class="kpi kpi-boton ${resumen.nuevas ? 'kpi-info' : ''}" data-rapido="nueva"><small>Nuevas</small><strong>${resumen.nuevas}</strong></button>
        <button type="button" class="kpi kpi-boton ${resumen.pendientes_aprobacion ? 'kpi-alerta' : ''}" data-rapido="pendiente_aprobacion"><small>Pendientes de aprobación</small><strong>${resumen.pendientes_aprobacion}</strong></button>
        <button type="button" class="kpi kpi-boton" data-rapido="abiertas"><small>Abiertas</small><strong>${resumen.abiertas}</strong></button>
        <button type="button" class="kpi kpi-boton ${resumen.asignadas_abiertas ? 'kpi-info' : ''}" data-rapido="asignadas"><small>Asignadas a mí (abiertas)</small><strong>${resumen.asignadas_abiertas}</strong></button>
        <button type="button" class="kpi kpi-boton" data-rapido="mias"><small>Mis solicitudes abiertas</small><strong>${resumen.mias_abiertas}</strong></button>`;
      $('[data-titulo]').textContent = VISTAS.find((v) => v.id === f.vista)?.titulo === 'Todas' ? 'Solicitudes' : VISTAS.find((v) => v.id === f.vista).titulo;
      $('[data-contador]').textContent = `${lista.length} ${lista.length === 1 ? 'solicitud' : 'solicitudes'}`;
      $('[data-tabla]').innerHTML = tablaSolicitudes(lista);
    }

    const diferido = debounce(cargar, 250);
    for (const n of ['q', 'cliente']) {
      $(`[name=${n}]`).addEventListener('input', (e) => {
        f[n] = e.target.value;
        diferido();
      });
    }
    for (const n of ['trabajo_id', 'tipo', 'estado', 'asignado', 'prioridad', 'desde', 'hasta']) {
      $(`[name=${n}]`).addEventListener('change', (e) => {
        f[n] = e.target.value;
        cargar();
      });
    }
    vista.querySelectorAll('[data-vista]').forEach((b) =>
      b.addEventListener('click', () => {
        f.vista = b.dataset.vista;
        cargar();
      })
    );
    $('[data-kpis]').addEventListener('click', (e) => {
      const k = e.target.closest('[data-rapido]');
      if (!k) return;
      const r = k.dataset.rapido;
      if (r === 'asignadas' || r === 'mias') {
        f.vista = r;
        f.estado = 'abiertas';
      } else {
        f.vista = '';
        f.estado = r;
      }
      $('[name=estado]').value = f.estado;
      cargar();
    });
    $('[data-limpiar]').addEventListener('click', () => {
      for (const k of Object.keys(f)) {
        if (k === 'vista') continue;
        f[k] = '';
        $(`[name=${k}]`).value = '';
      }
      cargar();
    });
    $('[data-nueva]').addEventListener('click', () => formularioSolicitud({ alGuardar: cargar }));
    conectarSolicitudes($('[data-tabla]'), { obtener: (id) => lista.find((s) => s.id === id), alCambiar: cargar });
    await cargar();
    if (params.get('id')) detalleSolicitud(Number(params.get('id')), { alCambiar: cargar });
  },
};
