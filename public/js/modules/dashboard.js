import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { esc } from '../ui.js';
import { tablaTrabajos, conectarTabla, abrirFicha } from '../components/trabajos-comun.js';

export default {
  id: 'dashboard',
  titulo: 'Dashboard',
  icono: 'dashboard',

  async render(vista) {
    // Filtro activo: un estatus (clic en tarjeta) o una alerta (atrasados / próximos).
    let filtro = { estatus: null, alerta: null };

    vista.innerHTML = `
      <div class="cards" id="cards"></div>
      <div class="alerts" id="alerts"></div>
      <section class="panel">
        <div class="panel-head">
          <div><h2 id="tabla-titulo">Trabajos activos</h2><span class="muted" id="tabla-sub"></span></div>
          <div class="toolbar-group">
            <button class="btn btn-sm" type="button" id="btn-limpiar" hidden>${icon('x')}Quitar filtro</button>
            <button class="btn btn-primary btn-sm" type="button" id="btn-nuevo">${icon('plus')}Nuevo trabajo</button>
          </div>
        </div>
        <div id="tabla"></div>
      </section>`;

    const $ = (s) => vista.querySelector(s);
    let trabajos = [];

    async function cargar() {
      const params = { orden: 'entrega_asc' };
      if (filtro.estatus) params.estatus = filtro.estatus;
      else params.estatus = 'activos';
      if (filtro.alerta) params.alerta = filtro.alerta;
      const [resumen, lista] = await Promise.all([api('/trabajos/resumen'), api(`/trabajos${qs(params)}`)]);
      trabajos = lista;

      const tarjetas = state.config.estatus.filter((e) => e.dashboard);
      $('#cards').style.setProperty('--n', tarjetas.length);
      $('#cards').innerHTML = tarjetas
        .map(
          (e) => `<button class="stat-card ${filtro.estatus === e.key ? 'active' : ''}" style="--c:${e.color}" data-estatus="${e.key}" type="button">
            <div class="label"><span class="dot"></span>${esc(e.tarjeta)}</div>
            <div class="value">${resumen.porEstatus[e.key] || 0}</div>
          </button>`
        )
        .join('');

      const pills = [];
      if (resumen.atrasados) {
        pills.push(`<button type="button" class="alert-pill late ${filtro.alerta === 'atrasados' ? 'active' : ''}" data-alerta="atrasados">${icon('alert')}${resumen.atrasados} ${resumen.atrasados === 1 ? 'trabajo atrasado' : 'trabajos atrasados'}</button>`);
      }
      if (resumen.proximos) {
        pills.push(`<button type="button" class="alert-pill soon ${filtro.alerta === 'proximos' ? 'active' : ''}" data-alerta="proximos">${icon('clock')}${resumen.proximos} ${resumen.proximos === 1 ? 'vence' : 'vencen'} en los próximos ${state.config.diasAlerta} días</button>`);
      }
      if (!pills.length) pills.push(`<span class="alert-pill ok">${icon('check')}Sin trabajos atrasados ni entregas próximas</span>`);
      $('#alerts').innerHTML = pills.join('');

      const est = state.config.estatus.find((e) => e.key === filtro.estatus);
      $('#tabla-titulo').textContent = filtro.alerta === 'atrasados'
        ? 'Trabajos atrasados'
        : filtro.alerta === 'proximos'
          ? 'Próximos a entregar'
          : est ? `Trabajos: ${est.tarjeta}` : 'Trabajos activos';
      $('#tabla-sub').textContent = `${lista.length} ${lista.length === 1 ? 'trabajo' : 'trabajos'} · ordenados por fecha de entrega`;
      $('#btn-limpiar').hidden = !filtro.estatus && !filtro.alerta;
      $('#tabla').innerHTML = tablaTrabajos(lista, { compacta: true });
    }

    $('#cards').addEventListener('click', (e) => {
      const c = e.target.closest('[data-estatus]');
      if (!c) return;
      filtro = { estatus: filtro.estatus === c.dataset.estatus ? null : c.dataset.estatus, alerta: null };
      cargar();
    });
    $('#alerts').addEventListener('click', (e) => {
      const p = e.target.closest('[data-alerta]');
      if (!p) return;
      filtro = { estatus: null, alerta: filtro.alerta === p.dataset.alerta ? null : p.dataset.alerta };
      cargar();
    });
    $('#btn-limpiar').addEventListener('click', () => {
      filtro = { estatus: null, alerta: null };
      cargar();
    });
    $('#btn-nuevo').addEventListener('click', () => abrirFicha(null, { alCerrar: cargar }));
    conectarTabla($('#tabla'), { alCambiar: cargar, obtenerTrabajo: (id) => trabajos.find((t) => t.id === id) });

    await cargar();
  },
};
