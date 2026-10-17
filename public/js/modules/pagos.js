import { api, qs } from '../api.js';
import { filtroAprobados } from '../state.js';
import { icon } from '../icons.js';
import { esc, fecha, fechaHora, hoyIso, debounce, modal, toast, campo, leerFormulario, vacio, botonPapelera, conectarPapeleras } from '../ui.js';
import {
  ESTADOS, usd, bs, tasaTxt, leerMonto, proyectoTxt, formularioColaborador, formularioAsignacion, formularioAbono,
  tablaAsignaciones, tablaAbonos, conectarAsignaciones, badgeEstadoPago,
} from '../components/pagos-comun.js';

const PESTANAS = [
  { id: 'resumen', titulo: 'Resumen', icono: 'dashboard' },
  { id: 'semana', titulo: 'Pagos de la semana', icono: 'calendario' },
  { id: 'colaboradores', titulo: 'Colaboradores', icono: 'usuarios' },
  { id: 'tasas', titulo: 'Tasa BCV', icono: 'dinero' },
];

const sumarDias = (iso, n) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---------- Resumen ----------

async function vistaResumen(cont) {
  const f = { colaborador_id: '', trabajo_id: '', desde: '', hasta: '', estado: '', q: '' };
  // Proyectos para el filtro: los aprobados y los que ya tienen colaboradores asignados.
  const [colaboradores, aprobados, asignados] = await Promise.all([
    api('/pagos/colaboradores'),
    api(`/trabajos${qs({ orden: 'recientes', estatus: filtroAprobados() })}`),
    api('/pagos/asignaciones'),
  ]);
  const trabajos = [...aprobados];
  for (const a of asignados) {
    if (!trabajos.some((t) => t.id === a.trabajo_id)) {
      trabajos.push({ id: a.trabajo_id, numero: a.numero, cliente: a.cliente, descripcion: a.trabajo_descripcion });
    }
  }
  trabajos.sort((x, y) => y.numero - x.numero);
  cont.innerHTML = `
    <div class="kpis" id="kpis"></div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input type="search" name="q" placeholder="Buscar colaborador, proyecto o trabajo…"></div>
      <select name="colaborador_id" aria-label="Colaborador"><option value="">Todos los colaboradores</option>${colaboradores
        .map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`)
        .join('')}</select>
      <select name="trabajo_id" aria-label="Proyecto"><option value="">Todos los proyectos aprobados</option>${trabajos
        .map((t) => `<option value="${t.id}">${esc(proyectoTxt(t))}</option>`)
        .join('')}</select>
    </div>
    <div class="toolbar">
      <div class="toolbar-group"><span class="toolbar-label">Fechas</span>
        <input type="date" name="desde" aria-label="Desde"><input type="date" name="hasta" aria-label="Hasta"></div>
      <select name="estado" aria-label="Estado de pago"><option value="">Todos los estados</option>${Object.entries(ESTADOS)
        .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
        .join('')}</select>
      <button class="btn btn-ghost btn-sm" type="button" data-limpiar>Limpiar filtros</button>
      <span class="spacer"></span>
      <button class="btn" type="button" data-asignar>${icon('plus')}Asignar colaborador</button>
      <button class="btn btn-primary" type="button" data-abono>${icon('dinero')}Registrar abono</button>
    </div>
    <section class="panel">
      <div class="panel-head"><h2>Colaboradores por proyecto</h2><span class="muted" data-contador></span></div>
      <div data-tabla></div>
    </section>`;
  const $ = (s) => cont.querySelector(s);
  let lista = [];

  async function cargar() {
    const [resumen, asignaciones] = await Promise.all([api(`/pagos/resumen${qs(f)}`), api(`/pagos/asignaciones${qs(f)}`)]);
    lista = asignaciones;
    $('#kpis').innerHTML = `
      <div class="kpi"><small>Total acordado</small><strong>${usd(resumen.acordado_usd)}</strong></div>
      <div class="kpi"><small>Total abonado</small><strong>${usd(resumen.abonado_usd)}</strong><span>USD equivalentes</span></div>
      <div class="kpi ${resumen.saldo_usd > 0.004 ? 'kpi-alerta' : 'kpi-ok'}"><small>Saldo pendiente</small><strong>${usd(resumen.saldo_usd)}</strong></div>
      <div class="kpi"><small>Pagado esta semana</small><strong>${usd(resumen.semana.usd)}</strong><span>${resumen.semana.cantidad} ${resumen.semana.cantidad === 1 ? 'pago' : 'pagos'} · ${fecha(resumen.semana.inicio)} al ${fecha(resumen.semana.fin)}</span></div>
      <div class="kpi"><small>Colaboradores con saldo</small><strong>${resumen.colaboradores_pendientes}</strong></div>
      <div class="kpi"><small>Proyectos pagados por completo</small><strong>${resumen.proyectos_completados}</strong></div>`;
    $('[data-contador]').textContent = `${lista.length} ${lista.length === 1 ? 'asignación' : 'asignaciones'}`;
    $('[data-tabla]').innerHTML = tablaAsignaciones(lista);
  }

  const diferido = debounce(cargar, 250);
  $('[name=q]').addEventListener('input', (e) => {
    f.q = e.target.value;
    diferido();
  });
  for (const n of ['colaborador_id', 'trabajo_id', 'desde', 'hasta', 'estado']) {
    $(`[name=${n}]`).addEventListener('change', (e) => {
      f[n] = e.target.value;
      cargar();
    });
  }
  $('[data-limpiar]').addEventListener('click', () => {
    for (const k of Object.keys(f)) {
      f[k] = '';
      $(`[name=${k}]`).value = '';
    }
    cargar();
  });
  $('[data-asignar]').addEventListener('click', () => formularioAsignacion({ trabajoId: Number(f.trabajo_id) || null, alGuardar: cargar }));
  $('[data-abono]').addEventListener('click', () => formularioAbono({ alGuardar: cargar }));
  conectarAsignaciones($('[data-tabla]'), { obtener: (id) => lista.find((a) => a.id === id), alCambiar: cargar });
  await cargar();
}

// ---------- Pagos de la semana ----------

async function vistaSemana(cont) {
  let dia = hoyIso();
  cont.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-group">
        <button class="btn" type="button" data-semana="-7" aria-label="Semana anterior">‹</button>
        <input type="date" name="dia" aria-label="Semana" value="${dia}">
        <button class="btn" type="button" data-semana="7" aria-label="Semana siguiente">›</button>
        <span class="toolbar-label" data-rango></span>
      </div>
      <span class="spacer"></span>
      <button class="btn" type="button" data-exportar>${icon('download')}Exportar a Excel</button>
    </div>
    <div class="kpis kpis-3" data-totales></div>
    <section class="panel">
      <div class="panel-head"><h2>Colaboradores con saldo o pagos en la semana</h2></div>
      <div data-filas></div>
    </section>
    <section class="panel" style="margin-top:16px">
      <div class="panel-head"><h2>Pagos registrados en la semana</h2></div>
      <div data-abonos></div>
    </section>`;
  const $ = (s) => cont.querySelector(s);

  async function cargar() {
    const s = await api(`/pagos/semana${qs({ fecha: dia })}`);
    $('[data-rango]').textContent = `Semana del ${fecha(s.inicio)} al ${fecha(s.fin)}`;
    $('[data-totales]').innerHTML = `
      <div class="kpi"><small>Pagado en la semana</small><strong>${usd(s.total_semana_usd)}</strong><span>${bs(s.total_semana_bs)}</span></div>
      <div class="kpi"><small>Pagos y ajustes registrados</small><strong>${s.abonos.length}</strong></div>
      <div class="kpi ${s.saldo_usd > 0.004 ? 'kpi-alerta' : 'kpi-ok'}"><small>Saldo restante</small><strong>${usd(s.saldo_usd)}</strong></div>`;
    $('[data-filas]').innerHTML = s.filas.length
      ? `<div class="table-wrap"><table class="data responsive">
          <thead><tr><th>Colaborador</th><th>Proyecto</th><th class="right">Acordado</th><th class="right">Pagado semana</th><th class="right">Pagado total</th><th class="right">Saldo</th><th>Estado</th></tr></thead>
          <tbody>${s.filas
            .map(
              (a) => `<tr class="sin-clic"><td data-label="Colaborador"><strong>${esc(a.colaborador)}</strong></td>
                <td data-label="Proyecto" class="truncate" title="${esc(a.proyecto)}">${esc(a.proyecto)}</td>
                <td data-label="Acordado" class="right">${usd(a.monto_acordado_usd)}</td>
                <td data-label="Pagado semana" class="right num">${usd(a.pagado_semana_usd)}</td>
                <td data-label="Pagado total" class="right">${usd(a.abonado_usd)}</td>
                <td data-label="Saldo" class="right num ${a.saldo_usd > 0.004 ? 'texto-saldo' : ''}">${usd(a.saldo_usd)}</td>
                <td data-label="Estado">${badgeEstadoPago(a.estado)}</td></tr>`
            )
            .join('')}</tbody></table></div>`
      : vacio('No hay saldos pendientes ni pagos en esta semana', 'check');
    $('[data-abonos]').innerHTML = tablaAbonos(s.abonos, { conProyecto: true });
  }

  $('[name=dia]').addEventListener('change', (e) => {
    dia = e.target.value || hoyIso();
    cargar();
  });
  cont.querySelectorAll('[data-semana]').forEach((b) =>
    b.addEventListener('click', () => {
      dia = sumarDias(dia, Number(b.dataset.semana));
      $('[name=dia]').value = dia;
      cargar();
    })
  );
  $('[data-exportar]').addEventListener('click', () => {
    window.location.href = `/api/pagos/semana/exportar${qs({ fecha: dia })}`;
  });
  await cargar();
}

// ---------- Colaboradores ----------

async function vistaColaboradores(cont) {
  const f = { q: '' };
  cont.innerHTML = `
    <div class="toolbar">
      <div class="search">${icon('search')}<input type="search" name="q" placeholder="Buscar por nombre, oficio, cédula o teléfono…"></div>
      <button class="btn btn-primary" type="button" data-nuevo>${icon('plus')}Nuevo colaborador</button>
    </div>
    <section class="panel"><div class="panel-head"><h2>Directorio de colaboradores</h2><span class="muted" data-contador></span></div><div data-tabla></div></section>`;
  const $ = (s) => cont.querySelector(s);
  let lista = [];
  async function cargar() {
    lista = await api(`/pagos/colaboradores${qs(f)}`);
    $('[data-contador]').textContent = `${lista.length} ${lista.length === 1 ? 'colaborador' : 'colaboradores'}`;
    $('[data-tabla]').innerHTML = lista.length
      ? `<div class="table-wrap"><table class="data responsive">
          <thead><tr><th>Nombre</th><th>Especialidad</th><th>Identificación</th><th>Teléfono</th><th class="right">Proyectos</th><th class="right">Acordado</th><th class="right">Saldo</th><th></th></tr></thead>
          <tbody>${lista
            .map((c) => {
              const saldo = Math.round((c.acordado_usd - c.abonado_usd) * 100) / 100;
              return `<tr data-id="${c.id}"><td data-label="Nombre"><strong>${esc(c.nombre)}</strong></td>
                <td data-label="Especialidad">${esc(c.especialidad)}</td>
                <td data-label="Identificación">${esc(c.identificacion)}</td>
                <td data-label="Teléfono" data-stop>${c.telefono ? `<a href="tel:${esc(c.telefono.replace(/[^\d+]/g, ''))}">${esc(c.telefono)}</a>` : ''}</td>
                <td data-label="Proyectos" class="right">${c.total_asignaciones}</td>
                <td data-label="Acordado" class="right">${usd(c.acordado_usd)}</td>
                <td data-label="Saldo" class="right num ${saldo > 0.004 ? 'texto-saldo' : ''}">${usd(saldo)}</td>
                <td data-label="" class="col-acciones">${botonPapelera(`data-borrar-colaborador="${c.id}"`, 'Eliminar colaborador')}</td></tr>`;
            })
            .join('')}</tbody></table></div>`
      : vacio(f.q ? 'No hay colaboradores que coincidan' : 'Aún no hay colaboradores registrados', 'usuarios');
  }
  const diferido = debounce(cargar, 250);
  $('[name=q]').addEventListener('input', (e) => {
    f.q = e.target.value;
    diferido();
  });
  $('[data-nuevo]').addEventListener('click', () => formularioColaborador(null, { alGuardar: cargar }));
  conectarPapeleras($('[data-tabla]'), '[data-borrar-colaborador]', {
    mensaje: (b) => {
      const c = lista.find((x) => String(x.id) === b.dataset.borrarColaborador);
      if (c.total_asignaciones) {
        toast(`${c.nombre} está asignado a ${c.total_asignaciones} ${c.total_asignaciones === 1 ? 'proyecto' : 'proyectos'}. Elimina primero esas asignaciones.`, 'error');
        return null;
      }
      return `¿Eliminar a ${c.nombre} del directorio?`;
    },
    eliminar: (b) => api(`/pagos/colaboradores/${b.dataset.borrarColaborador}`, { method: 'DELETE' }),
    alEliminar: cargar,
    exito: 'Colaborador eliminado',
  });
  $('[data-tabla]').addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]')) return;
    const fila = e.target.closest('tr[data-id]');
    if (fila) formularioColaborador(lista.find((c) => String(c.id) === fila.dataset.id), { alGuardar: cargar });
  });
  await cargar();
}

// ---------- Tasa BCV ----------

async function vistaTasas(cont) {
  cont.innerHTML = `
    <div class="tasa-box" data-vigente>Consultando tasa BCV…</div>
    <div class="toolbar" style="margin-top:12px">
      <button class="btn" type="button" data-actualizar>${icon('refrescar')}Consultar BCV ahora</button>
      <button class="btn" type="button" data-manual>${icon('plus')}Registrar tasa manualmente</button>
      <a class="btn btn-ghost" href="https://www.bcv.org.ve/" target="_blank" rel="noopener">Abrir bcv.org.ve</a>
    </div>
    <section class="panel"><div class="panel-head"><h2>Tasas oficiales registradas</h2>
      <span class="muted">Cada pago guarda su propia tasa: los cambios aquí no modifican pagos ya registrados.</span></div>
      <div data-tabla></div></section>`;
  const $ = (s) => cont.querySelector(s);
  async function cargar() {
    const [vigente, tasas] = await Promise.all([api(`/pagos/tasa${qs({ fecha: hoyIso() })}`), api('/pagos/tasas')]);
    $('[data-vigente]').className = `tasa-box ${vigente.disponible ? 'ok' : 'aviso'}`;
    $('[data-vigente]').innerHTML = vigente.disponible
      ? `<div>${icon('check')} Tasa oficial vigente hoy: <strong>Bs ${tasaTxt(vigente.tasa)}</strong> por USD</div>
         <small>Fecha valor ${fecha(vigente.fecha_valor)} · ${vigente.origen === 'automatica' ? 'leída automáticamente de bcv.org.ve' : 'registrada manualmente'}</small>`
      : `<div>${icon('alert')} ${esc(vigente.motivo)}</div>${
          vigente.sugerencia ? `<small>Referencia sin fecha valor confirmada: ${esc(vigente.sugerencia.fuente)} · Bs ${tasaTxt(vigente.sugerencia.tasa)}</small>` : ''
        }`;
    $('[data-tabla]').innerHTML = tasas.length
      ? `<div class="table-wrap"><table class="data responsive"><thead><tr><th>Fecha valor</th><th class="right">Tasa (Bs por USD)</th><th>Origen</th><th>Registrada</th><th></th></tr></thead>
          <tbody>${tasas
            .map(
              (t) => `<tr class="sin-clic"><td data-label="Fecha valor">${fecha(t.fecha_valor)}</td><td data-label="Tasa" class="right num">${tasaTxt(t.tasa)}</td>
                <td data-label="Origen">${t.fuente === 'bcv' ? 'Automática (BCV)' : 'Manual'}</td><td data-label="Registrada">${fechaHora(t.obtenida_en)}</td>
                <td data-label="" class="col-acciones">${t.fuente === 'bcv' ? '' : botonPapelera(`data-borrar-tasa="${t.fecha_valor}"`, 'Eliminar tasa manual')}</td></tr>`
            )
            .join('')}</tbody></table></div>`
      : vacio('Todavía no hay tasas registradas', 'dinero');
  }
  conectarPapeleras($('[data-tabla]'), '[data-borrar-tasa]', {
    mensaje: (b) => `¿Eliminar la tasa manual del ${fecha(b.dataset.borrarTasa)}? Los pagos ya registrados conservan su tasa.`,
    eliminar: (b) => api(`/pagos/tasas/${b.dataset.borrarTasa}`, { method: 'DELETE' }),
    alEliminar: cargar,
    exito: 'Tasa eliminada',
  });
  $('[data-actualizar]').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api('/pagos/tasas/actualizar', { method: 'POST' });
      toast(`Tasa BCV: Bs ${tasaTxt(r.tasa)} (fecha valor ${fecha(r.fecha_valor)})`);
      await cargar();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      e.currentTarget.disabled = false;
    }
  });
  $('[data-manual]').addEventListener('click', () => {
    const m = modal({
      titulo: 'Registrar tasa oficial manualmente',
      body: `<form class="form-grid" id="form-tasa">
        ${campo({ name: 'fecha_valor', label: 'Fecha valor', type: 'date', required: true }, hoyIso())}
        ${campo({ name: 'tasa', label: 'Tasa (Bs por USD)', required: true, placeholder: '0,0000' })}
        <label class="check full"><input type="checkbox" name="confirmada"> Confirmo que la verifiqué en <a href="https://www.bcv.org.ve/" target="_blank" rel="noopener">bcv.org.ve</a></label>
        <p class="muted full nota">Úsalo cuando la consulta automática no esté disponible o para cargar tasas de fechas anteriores. Queda marcada como manual.</p>
      </form>`,
      foot: `<button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" type="submit" form="form-tasa">Guardar tasa</button>`,
    });
    const form = m.el.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = leerFormulario(form);
      try {
        await api('/pagos/tasas', { method: 'POST', body: { fecha_valor: d.fecha_valor, tasa: leerMonto(d.tasa), confirmada: !!d.confirmada } });
        toast('Tasa registrada');
        m.close();
        cargar();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
  await cargar();
}

const VISTAS = { resumen: vistaResumen, semana: vistaSemana, colaboradores: vistaColaboradores, tasas: vistaTasas };

export default {
  id: 'pagos',
  titulo: 'Pagos de producción',
  icono: 'dinero',
  soloAdmin: true,

  async render(vista, params) {
    let actual = VISTAS[params.get('vista')] ? params.get('vista') : 'resumen';
    vista.innerHTML = `<nav class="tabs" role="tablist">${PESTANAS.map(
      (p) => `<button type="button" role="tab" data-tab="${p.id}">${icon(p.icono)}<span>${p.titulo}</span></button>`
    ).join('')}</nav><div data-contenido></div>`;
    const contenido = vista.querySelector('[data-contenido]');
    const mostrar = async (id) => {
      actual = id;
      vista.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('activo', b.dataset.tab === id));
      history.replaceState(null, '', id === 'resumen' ? '#/pagos' : `#/pagos?vista=${id}`);
      contenido.innerHTML = '';
      try {
        await VISTAS[id](contenido);
      } catch (err) {
        contenido.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
      }
    };
    vista.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => mostrar(b.dataset.tab)));
    await mostrar(actual);
  },
};
