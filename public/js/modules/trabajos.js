import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { esc, debounce } from '../ui.js';
import { tablaTrabajos, conectarTabla, abrirFicha } from '../components/trabajos-comun.js';

const CLAVE_FILTROS = 'spacio.filtrosTrabajos';

function filtrosGuardados() {
  try {
    return JSON.parse(sessionStorage.getItem(CLAVE_FILTROS)) || {};
  } catch {
    return {};
  }
}

export default {
  id: 'trabajos',
  titulo: 'Control de trabajos',
  icono: 'trabajos',

  async render(vista, params) {
    const f = { q: '', estatus: '', campo_fecha: 'fecha_entrega', desde: '', hasta: '', orden: 'recientes', alerta: '', ...filtrosGuardados() };

    vista.innerHTML = `
      <div class="toolbar">
        <div class="search">${icon('search')}<input type="search" name="q" placeholder="Buscar por cliente, marca, tienda, descripción o N°…" value="${esc(f.q)}"></div>
        <select name="estatus" aria-label="Estatus">
          <option value="">Todos los estatus</option>
          <option value="activos">Sólo activos</option>
          ${state.config.estatus.map((e) => `<option value="${e.key}">${esc(e.label)}</option>`).join('')}
        </select>
        <select name="orden" aria-label="Ordenar">
          <option value="recientes">Más recientes primero</option>
          <option value="entrega_asc">Entrega: más próxima</option>
          <option value="entrega_desc">Entrega: más lejana</option>
          <option value="numero_asc">N° de trabajo</option>
        </select>
        <button class="btn btn-primary" type="button" id="btn-nuevo">${icon('plus')}Nuevo trabajo</button>
      </div>
      <div class="toolbar">
        <div class="toolbar-group">
          <span class="toolbar-label">Fechas</span>
          <select name="campo_fecha" aria-label="Campo de fecha">
            <option value="fecha_entrega">Entrega del trabajo</option>
            <option value="fecha_cotizacion">Entrega de cotización</option>
            <option value="fecha_inicio">Inicio</option>
          </select>
        </div>
        <div class="toolbar-group">
          <input type="date" name="desde" aria-label="Desde" value="${esc(f.desde)}">
          <input type="date" name="hasta" aria-label="Hasta" value="${esc(f.hasta)}">
        </div>
        <div class="toolbar-group">
          <button type="button" class="chip" data-alerta="atrasados">${icon('alert')}Atrasados</button>
          <button type="button" class="chip warn" data-alerta="proximos">${icon('clock')}Próximos</button>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-limpiar">Limpiar filtros</button>
        </div>
        <span class="spacer"></span>
        <button class="btn" type="button" id="btn-exportar">${icon('download')}Exportar a Excel</button>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Trabajos</h2><span class="muted" id="contador"></span></div>
        <div id="tabla"></div>
      </section>`;

    const $ = (s) => vista.querySelector(s);
    const controles = ['q', 'estatus', 'orden', 'campo_fecha', 'desde', 'hasta'];
    for (const n of controles) vista.querySelector(`[name=${n}]`).value = f[n];

    const pintarChips = () =>
      vista.querySelectorAll('[data-alerta]').forEach((c) => c.classList.toggle('active', c.dataset.alerta === f.alerta));

    async function cargar() {
      try {
        sessionStorage.setItem(CLAVE_FILTROS, JSON.stringify(f));
      } catch {
        /* almacenamiento no disponible */
      }
      pintarChips();
      const lista = await api(`/trabajos${qs(f)}`);
      $('#contador').textContent = `${lista.length} ${lista.length === 1 ? 'trabajo' : 'trabajos'}`;
      $('#tabla').innerHTML = tablaTrabajos(lista);
      const th = $('th[data-sort=entrega]');
      if (th) th.innerHTML = `Entrega ${f.orden === 'entrega_asc' ? '▲' : f.orden === 'entrega_desc' ? '▼' : '↕'}`;
    }

    const cargarDiferido = debounce(cargar, 250);
    vista.querySelector('[name=q]').addEventListener('input', (e) => {
      f.q = e.target.value;
      cargarDiferido();
    });
    for (const n of controles.filter((c) => c !== 'q')) {
      vista.querySelector(`[name=${n}]`).addEventListener('change', (e) => {
        f[n] = e.target.value;
        cargar();
      });
    }
    vista.querySelectorAll('[data-alerta]').forEach((c) =>
      c.addEventListener('click', () => {
        f.alerta = f.alerta === c.dataset.alerta ? '' : c.dataset.alerta;
        cargar();
      })
    );
    $('#btn-limpiar').addEventListener('click', () => {
      Object.assign(f, { q: '', estatus: '', campo_fecha: 'fecha_entrega', desde: '', hasta: '', alerta: '' });
      for (const n of controles) vista.querySelector(`[name=${n}]`).value = f[n];
      cargar();
    });
    // Ordenar haciendo clic en la columna "Entrega".
    $('#tabla').addEventListener('click', (e) => {
      if (!e.target.closest('th[data-sort=entrega]')) return;
      f.orden = f.orden === 'entrega_asc' ? 'entrega_desc' : 'entrega_asc';
      $('[name=orden]').value = f.orden;
      cargar();
    });
    $('#btn-nuevo').addEventListener('click', () => abrirFicha(null, { alCerrar: cargar }));
    $('#btn-exportar').addEventListener('click', () => {
      window.location.href = `/api/trabajos/exportar${qs(f)}`;
    });
    conectarTabla($('#tabla'), { alCambiar: cargar });

    await cargar();
    if (params.get('id')) abrirFicha(Number(params.get('id')), { alCerrar: cargar }).catch(() => {});
  },
};
