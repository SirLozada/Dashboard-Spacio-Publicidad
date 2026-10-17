import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { esc, debounce } from '../ui.js';
import { ESTADOS_COT, tablaCotizaciones, conectarCotizaciones, elegirProyectoCotizacion, editorCotizacion, usd } from '../components/cotizaciones-comun.js';

export default {
  id: 'cotizaciones',
  titulo: 'Cotizaciones',
  icono: 'tag',
  soloAdmin: true,

  async render(vista, params) {
    const f = { estado: '', q: '' };
    vista.innerHTML = `
      <div class="kpis" data-kpis></div>
      <div class="toolbar">
        <div class="search">${icon('search')}<input type="search" name="q" placeholder="Buscar por N°, cliente, proyecto o pieza…"></div>
        <select name="estado" aria-label="Estado"><option value="">Todos los estados</option>${Object.entries(ESTADOS_COT)
          .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
          .join('')}</select>
        <button class="btn btn-primary" type="button" data-nueva>${icon('plus')}Nueva cotización</button>
      </div>
      <section class="panel"><div class="panel-head"><h2>Cotizaciones</h2><span class="muted" data-contador></span></div><div data-tabla></div></section>`;
    const $ = (s) => vista.querySelector(s);
    let todas = [];
    let lista = [];
    const filtrar = () => {
      const q = f.q.trim().toLowerCase();
      lista = todas.filter(
        (c) => (!f.estado || c.estado === f.estado) && (!q || [c.codigo, c.proyecto, c.trabajo_descripcion, ...c.piezas].join(' ').toLowerCase().includes(q))
      );
      $('[data-contador]').textContent = `${lista.length} ${lista.length === 1 ? 'cotización' : 'cotizaciones'}`;
      $('[data-tabla]').innerHTML = tablaCotizaciones(lista);
    };
    async function cargar() {
      todas = await api('/cotizaciones');
      const por = (e) => todas.filter((c) => c.estado === e);
      const suma = (l) => l.reduce((s, c) => s + c.total, 0);
      $('[data-kpis]').innerHTML = `
        <div class="kpi"><small>Borradores</small><strong>${por('borrador').length}</strong></div>
        <div class="kpi kpi-info"><small>Enviadas al cliente</small><strong>${por('enviada').length}</strong><span>${usd(suma(por('enviada')))}</span></div>
        <div class="kpi kpi-ok"><small>Aprobadas</small><strong>${por('aprobada').length}</strong><span>${usd(suma(por('aprobada')))}</span></div>
        <div class="kpi"><small>Rechazadas</small><strong>${por('rechazada').length}</strong></div>`;
      filtrar();
    }
    $('[name=q]').addEventListener('input', debounce((e) => {
      f.q = e.target.value;
      filtrar();
    }, 200));
    $('[name=estado]').addEventListener('change', (e) => {
      f.estado = e.target.value;
      filtrar();
    });
    $('[data-nueva]').addEventListener('click', () => elegirProyectoCotizacion({ alCambiar: cargar }));
    conectarCotizaciones($('[data-tabla]'), { obtener: (id) => lista.find((c) => c.id === id), alCambiar: cargar });
    await cargar();
    if (params.get('id')) editorCotizacion(Number(params.get('id')), { alCambiar: cargar });
  },
};
