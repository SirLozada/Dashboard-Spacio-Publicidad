import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { esc, debounce } from '../ui.js';
import { tablaTrabajos, conectarTabla, abrirFicha } from '../components/trabajos-comun.js';
import { montarCalendario } from '../components/calendario.js';

const CLAVE_FILTROS = 'spacio.filtrosTrabajos';
const CLAVE_VISTA = 'spacio.vistaTrabajos';

const leerAjuste = (clave, porDefecto) => {
  try {
    return sessionStorage.getItem(clave) || porDefecto;
  } catch {
    return porDefecto;
  }
};
const guardarAjuste = (clave, valor) => {
  try {
    sessionStorage.setItem(clave, valor);
  } catch {
    /* almacenamiento no disponible */
  }
};

// Leyenda de la agenda: un color por tipo de compromiso.
const LEYENDA = [
  { tipo: 'cotizacion', label: 'Entrega de cotización' },
  { tipo: 'inicio', label: 'Inicio de trabajo' },
  { tipo: 'produccion', label: 'Entrega · en producción' },
  { tipo: 'entrega', label: 'Entrega del trabajo' },
  { tipo: 'reclamo', label: 'Reclamo pendiente' },
  { tipo: 'vencido', label: 'Atrasado' },
];

// Agenda: otra forma de ver los mismos trabajos (las fechas son las del trabajo).
function vistaAgenda(contenedor) {
  const filtros = { cliente: '', marca: '', estatus: '' };
  contenedor.innerHTML = `
    <div class="toolbar">
      <select name="cliente" aria-label="Cliente"><option value="">Todos los clientes</option></select>
      <select name="marca" aria-label="Marca"><option value="">Todas las marcas</option></select>
      <select name="estatus" aria-label="Estatus"><option value="">Todos los estatus activos</option>
        ${state.config.estatus.filter((e) => !state.config.estatusCerrados.includes(e.key)).map((e) => `<option value="${e.key}">${esc(e.label)}</option>`).join('')}</select>
      <span class="spacer"></span>
      <span class="muted nota">Haz clic en un compromiso para abrir el proyecto. Las fechas se cambian en la ficha del proyecto.</span>
    </div>
    <section class="panel"><div data-calendario></div></section>`;
  let opcionesCargadas = false;
  const llenar = (name, valores, todos) => {
    const sel = contenedor.querySelector(`[name=${name}]`);
    sel.innerHTML = `<option value="">${todos}</option>${valores.map((v) => `<option>${esc(v)}</option>`).join('')}`;
    sel.value = filtros[name];
  };
  const calendario = montarCalendario(contenedor.querySelector('[data-calendario]'), {
    vista: leerAjuste(`${CLAVE_VISTA}.cal`, undefined),
    alCambiarVista: (v) => guardarAjuste(`${CLAVE_VISTA}.cal`, v),
    leyenda: LEYENDA,
    cargarEventos: async (desde, hasta) => {
      const r = await api(`/trabajos/agenda${qs({ ...filtros, desde, hasta })}`);
      if (!opcionesCargadas) {
        opcionesCargadas = true;
        llenar('cliente', r.clientes, 'Todos los clientes');
        llenar('marca', r.marcas, 'Todas las marcas');
      }
      return r.eventos.map((e) => ({
        ...e,
        tipo: e.vencido ? 'vencido' : e.tipo,
        titulo: `${e.trabajo.codigo} · ${e.trabajo.cliente}`,
        detalle: [e.trabajo.tienda || e.trabajo.marca, e.vencido ? 'Atrasado' : null].filter(Boolean).join(' · '),
        abrir: () => abrirFicha(e.trabajo.id, { alCerrar: () => calendario.recargar() }),
      }));
    },
  });
  contenedor.querySelectorAll('select').forEach((sel) =>
    sel.addEventListener('change', () => {
      filtros[sel.name] = sel.value;
      calendario.recargar();
    })
  );
}

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
      <nav class="tabs vista-tabs" role="tablist">
        <button type="button" data-modo="lista">${icon('trabajos')}Lista de trabajos</button>
        <button type="button" data-modo="agenda">${icon('calendario')}Agenda</button>
      </nav>
      <div data-panel="agenda" hidden></div>
      <div data-panel="lista">
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
      </section>
      </div>`;

    const $ = (s) => vista.querySelector(s);
    let trabajos = [];
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
      trabajos = lista;
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
    conectarTabla($('#tabla'), { alCambiar: cargar, obtenerTrabajo: (id) => trabajos.find((t) => t.id === id) });

    // Lista o agenda (se recuerda la última vista usada).
    let agendaMontada = false;
    const mostrar = (cual) => {
      guardarAjuste(CLAVE_VISTA, cual);
      vista.querySelectorAll('[data-modo]').forEach((b) => b.classList.toggle('activo', b.dataset.modo === cual));
      vista.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== cual));
      if (cual === 'agenda' && !agendaMontada) {
        agendaMontada = true;
        vistaAgenda(vista.querySelector('[data-panel=agenda]'));
      }
      if (cual === 'lista' && agendaMontada) cargar();
    };
    vista.querySelectorAll('[data-modo]').forEach((b) => b.addEventListener('click', () => mostrar(b.dataset.modo)));
    mostrar(params.get('vista') === 'agenda' ? 'agenda' : params.get('id') ? 'lista' : leerAjuste(CLAVE_VISTA, 'lista'));

    await cargar();
    if (params.get('id')) abrirFicha(Number(params.get('id')), { alCerrar: cargar }).catch(() => {});
  },
};
