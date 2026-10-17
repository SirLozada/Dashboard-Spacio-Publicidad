// Piezas compartidas de "Pagos de producción": formularios de colaborador,
// asignación y abono, detalle de una asignación y la sección de la ficha del trabajo.
import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { numeroTrabajo, esAprobado, filtroAprobados } from '../state.js';
import { esc, fecha, fechaHora, hoyIso, modal, toast, confirmar, campo, leerFormulario, vacio } from '../ui.js';

export const METODOS = ['Pago móvil', 'Transferencia en Bs', 'Efectivo USD', 'Efectivo Bs', 'Zelle', 'Binance / USDT', 'Otro'];
export const ESTADOS = {
  pendiente: { label: 'Pendiente', color: '#64748b' },
  parcial: { label: 'Pago parcial', color: '#d97706' },
  completado: { label: 'Completado', color: '#16a34a' },
};

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const nf = (min, max) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: min, maximumFractionDigits: max });
const f2 = nf(2, 2);
const f4 = nf(2, 4);
export const usd = (n) => (n === null || n === undefined ? '' : `${n < 0 ? '−' : ''}$${f2.format(Math.abs(n))}`);
export const bs = (n) => (n === null || n === undefined ? '' : `${n < 0 ? '−' : ''}Bs ${f2.format(Math.abs(n))}`);
export const tasaTxt = (n) => (n ? f4.format(n) : '');

// Acepta "1.234,56", "1234,56" o "1234.56".
export function leerMonto(texto) {
  let t = String(texto ?? '').trim().replace(/\s|\$|bs/gi, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

export const badgeEstadoPago = (estado) =>
  `<span class="badge" style="--c:${ESTADOS[estado]?.color}">${ESTADOS[estado]?.label || esc(estado)}</span>`;

export const proyectoTxt = (t) =>
  `${numeroTrabajo(t.numero)} · ${t.cliente}${t.descripcion ? ` · ${String(t.descripcion).split('\n')[0]}` : ''}`;

// ---------- Colaboradores ----------

export function formularioColaborador(c, { alGuardar } = {}) {
  const nuevo = !c?.id;
  const m = modal({
    titulo: nuevo ? 'Nuevo colaborador' : esc(c.nombre),
    body: `<form class="form-grid" id="form-colaborador">
      ${campo({ name: 'nombre', label: 'Nombre y apellido', required: true, full: true }, c?.nombre)}
      ${campo({ name: 'identificacion', label: 'Cédula o identificación (opcional)' }, c?.identificacion)}
      ${campo({ name: 'telefono', label: 'Teléfono', type: 'tel' }, c?.telefono)}
      ${campo({ name: 'especialidad', label: 'Especialidad u oficio', full: true, placeholder: 'Ej. Carpintería, herrería, instalación' }, c?.especialidad)}
      ${campo({ name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true }, c?.observaciones)}
    </form>`,
    foot: `${nuevo ? '<span class="left"></span>' : `<button class="btn btn-danger left" type="button" data-borrar>${icon('trash')}Eliminar</button>`}
      <button class="btn" data-close type="button">Cancelar</button>
      <button class="btn btn-primary" type="submit" form="form-colaborador">${nuevo ? 'Agregar colaborador' : 'Guardar cambios'}</button>`,
  });
  const form = m.el.querySelector('form');
  form.elements.nombre.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const guardado = await api(nuevo ? '/pagos/colaboradores' : `/pagos/colaboradores/${c.id}`, {
        method: nuevo ? 'POST' : 'PUT',
        body: leerFormulario(form),
      });
      toast(nuevo ? 'Colaborador agregado' : 'Colaborador actualizado');
      m.close();
      alGuardar?.(guardado);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  m.el.querySelector('[data-borrar]')?.addEventListener('click', async () => {
    if (!(await confirmar(`¿Eliminar a ${c.nombre} del directorio?`))) return;
    try {
      await api(`/pagos/colaboradores/${c.id}`, { method: 'DELETE' });
      toast('Colaborador eliminado');
      m.close();
      alGuardar?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------- Asignaciones ----------

// Asigna un colaborador a un proyecto (o edita una asignación existente).
export async function formularioAsignacion({ asignacion = null, trabajoId = null, alGuardar } = {}) {
  const nuevo = !asignacion;
  const [trabajos, colaboradores] = await Promise.all([
    nuevo ? api(`/trabajos${qs({ orden: 'recientes', estatus: filtroAprobados() })}`) : [],
    nuevo ? api('/pagos/colaboradores') : [],
  ]);
  const opcionesColab = () =>
    `<option value="">— Selecciona —</option>${colaboradores
      .map((c) => `<option value="${c.id}">${esc(c.nombre)}${c.especialidad ? ` · ${esc(c.especialidad)}` : ''}</option>`)
      .join('')}`;
  const m = modal({
    titulo: nuevo ? 'Asignar colaborador a un proyecto' : `Editar asignación · ${esc(asignacion.colaborador)}`,
    body: `<form class="form-grid" id="form-asignacion">
      ${
        nuevo
          ? `<label class="field full"><span>Proyecto <b class="req">*</b></span>
              <select name="trabajo_id" required><option value="">— Selecciona un proyecto aprobado —</option>${trabajos
                .map((t) => `<option value="${t.id}" ${t.id === trabajoId ? 'selected' : ''}>${esc(proyectoTxt(t))}</option>`)
                .join('')}</select></label>
            <label class="field full"><span>Colaborador <b class="req">*</b></span>
              <div class="input-con-boton"><select name="colaborador_id" required>${opcionesColab()}</select>
              <button class="btn" type="button" data-nuevo-colab>${icon('plus')}Nuevo</button></div></label>`
          : `<div class="field full"><span>Proyecto</span><div class="dato">${esc(asignacion.proyecto)}</div></div>`
      }
      ${campo({ name: 'tarea', label: 'Trabajo a realizar', full: true, placeholder: 'Ej. Estructura metálica e instalación' }, asignacion?.tarea)}
      ${campo({ name: 'fecha_inicio', label: 'Fecha de inicio', type: 'date' }, asignacion?.fecha_inicio ?? hoyIso())}
      ${campo({ name: 'monto_acordado_usd', label: 'Monto total acordado (USD)', required: true, placeholder: '0,00' }, asignacion ? f2.format(asignacion.monto_acordado_usd) : '')}
      ${campo({ name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true }, asignacion?.observaciones)}
    </form>`,
    foot: `${!nuevo && asignacion.total_movimientos === 0 ? `<button class="btn btn-danger left" type="button" data-borrar>${icon('trash')}Eliminar</button>` : '<span class="left"></span>'}
      <button class="btn" data-close type="button">Cancelar</button>
      <button class="btn btn-primary" type="submit" form="form-asignacion">${nuevo ? 'Asignar' : 'Guardar cambios'}</button>`,
  });
  const form = m.el.querySelector('form');
  form.elements.monto_acordado_usd.inputMode = 'decimal';
  m.el.querySelector('[data-nuevo-colab]')?.addEventListener('click', () =>
    formularioColaborador(null, {
      alGuardar: (c) => {
        if (!c) return;
        colaboradores.push(c);
        colaboradores.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        form.elements.colaborador_id.innerHTML = opcionesColab();
        form.elements.colaborador_id.value = c.id;
      },
    })
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = leerFormulario(form);
    const monto = leerMonto(d.monto_acordado_usd);
    if (monto === null || Number.isNaN(monto) || monto < 0) return toast('Indica un monto acordado válido en USD', 'error');
    d.monto_acordado_usd = monto;
    try {
      const guardada = await api(nuevo ? '/pagos/asignaciones' : `/pagos/asignaciones/${asignacion.id}`, {
        method: nuevo ? 'POST' : 'PATCH',
        body: d,
      });
      toast(nuevo ? 'Colaborador asignado al proyecto' : 'Asignación actualizada');
      m.close();
      alGuardar?.(guardada);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  m.el.querySelector('[data-borrar]')?.addEventListener('click', async () => {
    if (!(await confirmar('¿Eliminar esta asignación? (no tiene pagos registrados)'))) return;
    try {
      await api(`/pagos/asignaciones/${asignacion.id}`, { method: 'DELETE' });
      toast('Asignación eliminada');
      m.close();
      alGuardar?.(null);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------- Abonos ----------

// Registrar un abono (o un ajuste autorizado). Si no se indica la asignación,
// se elige entre las que tienen saldo pendiente.
export async function formularioAbono({ asignacion = null, ajuste = false, alGuardar } = {}) {
  const opciones = asignacion ? [asignacion] : (await api('/pagos/asignaciones')).filter((a) => a.saldo_usd > 0.004);
  if (!opciones.length) return toast('No hay asignaciones con saldo pendiente', 'error');
  let actual = asignacion || null;
  let tasa = null; // { tasa, origen, fecha_valor, fuente } de la consulta automática
  let ultimo = 'USD'; // moneda del último monto escrito

  const m = modal({
    titulo: ajuste ? 'Registrar ajuste autorizado' : 'Registrar abono',
    body: `<form class="form-grid" id="form-abono" novalidate>
      ${
        asignacion
          ? `<div class="field full"><span>Colaborador y proyecto</span><div class="dato"><strong>${esc(asignacion.colaborador)}</strong> · ${esc(asignacion.proyecto)}</div></div>`
          : `<label class="field full"><span>Colaborador y proyecto <b class="req">*</b></span><select name="asignacion">
              <option value="">— Selecciona —</option>${opciones
                .map((a) => `<option value="${a.id}">${esc(a.colaborador)} · ${esc(a.proyecto)} · saldo ${usd(a.saldo_usd)}</option>`)
                .join('')}</select></label>`
      }
      <div class="saldo-box full" data-saldo></div>
      ${campo({ name: 'fecha', label: 'Fecha del pago', type: 'date', required: true }, hoyIso())}
      <div class="field"><span>Moneda del pago</span>
        <div class="segmentado" role="group">
          <button type="button" data-moneda="USD" class="activo">Dólares (USD)</button>
          <button type="button" data-moneda="VES">Bolívares (Bs)</button>
        </div></div>
      <div class="tasa-box full" data-tasa>Consultando tasa BCV…</div>
      <label class="field"><span>Monto en USD (equivalente)</span><input name="monto_usd" inputmode="decimal" placeholder="0,00" autocomplete="off"></label>
      <label class="field"><span>Monto en bolívares</span><input name="monto_bs" inputmode="decimal" placeholder="0,00" autocomplete="off"></label>
      <div class="full muted calculo" data-calculo></div>
      ${campo({ name: 'metodo_pago', label: 'Método de pago', type: 'select', options: METODOS.map((x) => ({ value: x, label: x })) }, 'Pago móvil')}
      ${campo({ name: 'referencia', label: 'Referencia (opcional)' })}
      ${
        ajuste
          ? campo({ name: 'motivo_ajuste', label: 'Motivo del ajuste', required: true, full: true, placeholder: 'Ej. Pago adicional autorizado por Fernando' })
          : ''
      }
      ${campo({ name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true, rows: 2 })}
      ${ajuste ? '<p class="muted full nota">Un ajuste puede superar el saldo o ser negativo (escribe el monto con signo −). Queda identificado en el historial.</p>' : ''}
    </form>`,
    foot: `<button class="btn" data-close type="button">Cancelar</button>
      <button class="btn btn-primary" type="submit" form="form-abono">${ajuste ? 'Registrar ajuste' : 'Registrar abono'}</button>`,
  });
  const form = m.el.querySelector('form');
  const cajaTasa = m.el.querySelector('[data-tasa]');
  const cajaSaldo = m.el.querySelector('[data-saldo]');
  const calculo = m.el.querySelector('[data-calculo]');
  const inUsd = form.elements.monto_usd;
  const inBs = form.elements.monto_bs;

  const tasaActual = () => {
    if (form.querySelector('[name=tasa_modo_manual]')?.checked || !tasa) {
      const v = leerMonto(form.querySelector('[name=tasa_manual]')?.value);
      return v > 0 ? v : null;
    }
    return tasa.tasa;
  };

  const pintarSaldo = () => {
    cajaSaldo.innerHTML = actual
      ? `<div><small>Acordado</small><strong>${usd(actual.monto_acordado_usd)}</strong></div>
         <div><small>Abonado</small><strong>${usd(actual.abonado_usd)}</strong></div>
         <div><small>Saldo pendiente</small><strong class="saldo">${usd(actual.saldo_usd)}</strong></div>`
      : '<div class="muted">Selecciona el colaborador y proyecto para ver el saldo.</div>';
  };

  const recalcular = () => {
    const t = tasaActual();
    if (ultimo === 'USD') {
      const v = leerMonto(inUsd.value);
      inBs.value = t && v !== null && !Number.isNaN(v) ? f2.format(r2(v * t)) : '';
    } else {
      const v = leerMonto(inBs.value);
      inUsd.value = t && v !== null && !Number.isNaN(v) ? f2.format(r2(v / t)) : '';
    }
    const montoUsd = leerMonto(inUsd.value);
    if (!actual || montoUsd === null || Number.isNaN(montoUsd)) {
      calculo.innerHTML = '';
      return;
    }
    const despues = r2(actual.saldo_usd - montoUsd);
    const excede = !ajuste && montoUsd > actual.saldo_usd + 0.004;
    calculo.innerHTML = excede
      ? `<span class="texto-error">${icon('alert')} El abono supera el saldo pendiente (${usd(actual.saldo_usd)}). Si es correcto, registra un ajuste autorizado.</span>`
      : `Saldo después de este ${ajuste ? 'ajuste' : 'abono'}: <strong>${usd(despues)}</strong>`;
  };

  const pintarTasa = (r) => {
    tasa = r?.disponible ? r : null;
    const manual = `<div class="tasa-manual" ${tasa ? 'hidden' : ''}>
        <label class="field"><span>Tasa BCV a aplicar (Bs por USD)</span><input name="tasa_manual" inputmode="decimal" placeholder="0,0000" autocomplete="off"></label>
        <label class="check"><input type="checkbox" name="confirmar_tasa"> Confirmo que verifiqué esta tasa en <a href="https://www.bcv.org.ve/" target="_blank" rel="noopener">bcv.org.ve</a> para la fecha del pago</label>
      </div>`;
    if (tasa) {
      cajaTasa.className = 'tasa-box full ok';
      cajaTasa.innerHTML = `<div>${icon('check')} Tasa BCV aplicable: <strong>Bs ${tasaTxt(tasa.tasa)}</strong> por USD</div>
        <small>Fecha valor ${fecha(tasa.fecha_valor)} · ${tasa.origen === 'automatica' ? 'obtenida automáticamente del BCV' : 'registrada manualmente'}</small>
        <label class="check"><input type="checkbox" name="tasa_modo_manual"> Usar otra tasa (ingreso manual)</label>${manual}`;
    } else {
      const sug = r?.sugerencia
        ? `<div class="sugerencia">Referencia: ${esc(r.sugerencia.fuente)} indica <strong>Bs ${tasaTxt(r.sugerencia.tasa)}</strong>, pero sin fecha valor confirmada. <button type="button" class="btn btn-sm" data-usar-sug>Usar este valor</button></div>`
        : '';
      cajaTasa.className = 'tasa-box full aviso';
      cajaTasa.innerHTML = `<div>${icon('alert')} ${esc(r?.motivo || 'No se pudo obtener la tasa.')} Ingrésala manualmente.</div>${sug}${manual}`;
      cajaTasa.querySelector('[data-usar-sug]')?.addEventListener('click', () => {
        form.elements.tasa_manual.value = f4.format(r.sugerencia.tasa);
        recalcular();
      });
    }
    cajaTasa.querySelector('[name=tasa_modo_manual]')?.addEventListener('change', (e) => {
      cajaTasa.querySelector('.tasa-manual').hidden = !e.target.checked;
      recalcular();
    });
    cajaTasa.querySelector('[name=tasa_manual]')?.addEventListener('input', recalcular);
    recalcular();
  };

  const consultarTasa = async () => {
    cajaTasa.className = 'tasa-box full';
    cajaTasa.textContent = 'Consultando tasa BCV…';
    try {
      pintarTasa(await api(`/pagos/tasa${qs({ fecha: form.elements.fecha.value })}`));
    } catch (err) {
      pintarTasa({ disponible: false, motivo: err.message });
    }
  };

  pintarSaldo();
  consultarTasa();
  form.elements.fecha.addEventListener('change', consultarTasa);
  form.elements.asignacion?.addEventListener('change', (e) => {
    actual = opciones.find((a) => String(a.id) === e.target.value) || null;
    pintarSaldo();
    recalcular();
  });
  inUsd.addEventListener('input', () => {
    ultimo = 'USD';
    recalcular();
  });
  inBs.addEventListener('input', () => {
    ultimo = 'VES';
    recalcular();
  });
  m.el.querySelectorAll('[data-moneda]').forEach((b) =>
    b.addEventListener('click', () => {
      ultimo = b.dataset.moneda;
      m.el.querySelectorAll('[data-moneda]').forEach((x) => x.classList.toggle('activo', x === b));
      (ultimo === 'USD' ? inUsd : inBs).focus();
      recalcular();
    })
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!actual) return toast('Selecciona el colaborador y proyecto', 'error');
    const manual = !tasa || form.querySelector('[name=tasa_modo_manual]')?.checked;
    const monto = leerMonto((ultimo === 'USD' ? inUsd : inBs).value);
    if (monto === null || Number.isNaN(monto) || monto === 0) return toast('Indica el monto del pago', 'error');
    if (manual && !tasaActual()) return toast('Indica la tasa BCV a aplicar', 'error');
    if (manual && !form.querySelector('[name=confirmar_tasa]')?.checked) return toast('Confirma que verificaste la tasa', 'error');
    const boton = m.el.querySelector('[type=submit]');
    boton.disabled = true;
    try {
      const r = await api(`/pagos/asignaciones/${actual.id}/abonos`, {
        method: 'POST',
        body: {
          tipo: ajuste ? 'ajuste' : 'abono',
          fecha: form.elements.fecha.value,
          moneda: ultimo,
          monto,
          tasa_modo: manual ? 'manual' : 'automatica',
          tasa_manual: manual ? tasaActual() : null,
          confirmar_tasa: manual ? true : undefined,
          metodo_pago: form.elements.metodo_pago.value,
          referencia: form.elements.referencia.value,
          observaciones: form.elements.observaciones.value,
          motivo_ajuste: form.elements.motivo_ajuste?.value,
        },
      });
      toast(`${ajuste ? 'Ajuste' : 'Abono'} registrado: ${usd(r.abono.monto_usd)} · ${bs(r.abono.monto_bs)}`);
      m.close();
      alGuardar?.(r);
    } catch (err) {
      toast(err.message, 'error');
      boton.disabled = false;
    }
  });
}

// ---------- Tablas e historial ----------

export function tablaAbonos(abonos, { conProyecto = false, conColaborador = true, acciones = false } = {}) {
  if (!abonos.length) return vacio('Todavía no hay pagos registrados', 'dinero');
  return `<div class="table-wrap"><table class="data responsive tabla-pagos">
    <thead><tr><th>Fecha</th>${conColaborador ? '<th>Colaborador</th>' : ''}${conProyecto ? '<th>Proyecto</th>' : ''}
      <th class="right">Abono USD</th><th class="right">Tasa BCV</th><th class="right">Pago Bs</th><th>Tasa</th><th>Método</th>${acciones ? '<th></th>' : ''}</tr></thead>
    <tbody>${abonos
      .map((b) => {
        const anulado = b.anulado_por ? ' anulado' : '';
        const tipo =
          b.tipo === 'ajuste'
            ? `<span class="badge" style="--c:#7c3aed" title="${esc(b.motivo_ajuste)}">${b.ajusta_abono_id ? 'Anulación' : 'Ajuste'}</span>`
            : '';
        return `<tr class="sin-clic${anulado}">
          <td data-label="Fecha" class="nowrap">${fecha(b.fecha)} ${tipo}</td>
          ${conColaborador ? `<td data-label="Colaborador">${esc(b.colaborador)}</td>` : ''}
          ${conProyecto ? `<td data-label="Proyecto" class="nowrap">${numeroTrabajo(b.numero)} · ${esc(b.cliente)}</td>` : ''}
          <td data-label="Abono USD" class="right num">${usd(b.monto_usd)}</td>
          <td data-label="Tasa BCV" class="right">${tasaTxt(b.tasa_bcv)}</td>
          <td data-label="Pago Bs" class="right nowrap">${bs(b.monto_bs)}</td>
          <td data-label="Tasa" title="${esc(b.tasa_fuente)}${b.tasa_fecha_valor ? ` · fecha valor ${fecha(b.tasa_fecha_valor)}` : ''}">${b.tasa_origen === 'manual' ? 'Manual' : 'Automática'}</td>
          <td data-label="Método">${esc(b.metodo_pago)}${b.referencia ? `<br><small class="muted">Ref. ${esc(b.referencia)}</small>` : ''}${
            b.motivo_ajuste ? `<br><small class="muted">Motivo: ${esc(b.motivo_ajuste)}</small>` : ''
          }${b.anulado_por ? '<br><small class="texto-error">Anulado</small>' : ''}</td>
          ${
            acciones
              ? `<td data-label="">${b.tipo === 'abono' && !b.anulado_por ? `<button class="btn btn-sm btn-ghost" type="button" data-anular="${b.id}">Anular</button>` : ''}</td>`
              : ''
          }
        </tr>`;
      })
      .join('')}</tbody></table></div>`;
}

const ACCIONES = {
  creada: 'Asignación creada',
  modificada: 'Asignación modificada',
  eliminada: 'Asignación eliminada',
  abono: 'Abono registrado',
  ajuste: 'Ajuste registrado',
  pago_anulado: 'Pago anulado',
};
const CAMPOS = { monto_acordado_usd: 'Monto acordado', tarea: 'Trabajo a realizar', fecha_inicio: 'Fecha de inicio', observaciones: 'Observaciones' };

function textoHistorial(h) {
  const d = h.detalle ? JSON.parse(h.detalle) : {};
  if (h.accion === 'modificada') {
    return Object.entries(d)
      .map(([k, v]) => `${CAMPOS[k] || k}: ${k === 'monto_acordado_usd' ? `${usd(v.antes)} → ${usd(v.despues)}` : `${esc(v.antes ?? '—')} → ${esc(v.despues ?? '—')}`}`)
      .join(' · ');
  }
  if (h.accion === 'creada') return `Monto acordado ${usd(d.monto_acordado_usd)}`;
  if (d.monto_usd !== undefined) return `${usd(d.monto_usd)} · ${bs(d.monto_bs)}${d.motivo ? ` · Motivo: ${esc(d.motivo)}` : ''}`;
  return '';
}

// Detalle de una asignación: saldos, pagos, ajustes e historial de cambios.
export async function detalleAsignacion(id, { alCambiar } = {}) {
  const a = await api(`/pagos/asignaciones/${id}`);
  let huboCambios = false;
  const m = modal({
    wide: true,
    titulo: `${esc(a.colaborador)} ${badgeEstadoPago(a.estado)}`,
    body: `<p class="muted" style="margin:0 0 12px">${esc(a.proyecto)}${a.tarea ? ` · <strong>${esc(a.tarea)}</strong>` : ''}${
      a.fecha_inicio ? ` · inicio ${fecha(a.fecha_inicio)}` : ''
    }</p>
      <div class="kpis kpis-3">
        <div class="kpi"><small>Monto acordado</small><strong>${usd(a.monto_acordado_usd)}</strong></div>
        <div class="kpi"><small>Total abonado</small><strong>${usd(a.abonado_usd)}</strong></div>
        <div class="kpi ${a.saldo_usd > 0.004 ? 'kpi-alerta' : 'kpi-ok'}"><small>Saldo pendiente</small><strong>${usd(a.saldo_usd)}</strong></div>
      </div>
      ${a.observaciones ? `<p class="muted">${esc(a.observaciones)}</p>` : ''}
      <div class="section-title">${icon('dinero')} Pagos registrados</div>
      ${tablaAbonos(a.abonos, { conColaborador: false, acciones: true })}
      <div class="section-title">${icon('clock')} Historial de cambios</div>
      <ul class="historial">${a.historial
        .map((h) => `<li><span class="muted">${fechaHora(h.creado_en)} · ${esc(h.usuario || '')}</span> <strong>${ACCIONES[h.accion] || esc(h.accion)}</strong> ${textoHistorial(h)}</li>`)
        .join('')}</ul>`,
    foot: `<button class="btn left" type="button" data-editar>${icon('edit')}Editar asignación</button>
      <button class="btn" type="button" data-ajuste>Registrar ajuste</button>
      ${a.saldo_usd > 0.004 ? `<button class="btn btn-primary" type="button" data-abono>${icon('plus')}Registrar abono</button>` : ''}`,
    onClose: () => huboCambios && alCambiar?.(),
  });
  const recargar = () => {
    huboCambios = true;
    m.close();
    detalleAsignacion(id, { alCambiar });
  };
  m.el.querySelector('[data-abono]')?.addEventListener('click', () => formularioAbono({ asignacion: a, alGuardar: recargar }));
  m.el.querySelector('[data-ajuste]').addEventListener('click', () => formularioAbono({ asignacion: a, ajuste: true, alGuardar: recargar }));
  m.el.querySelector('[data-editar]').addEventListener('click', () =>
    formularioAsignacion({ asignacion: a, alGuardar: (r) => (r ? recargar() : ((huboCambios = true), m.close())) })
  );
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-anular]');
    if (!b) return;
    const pago = a.abonos.find((x) => String(x.id) === b.dataset.anular);
    const motivo = prompt(`Anular el pago de ${usd(pago.monto_usd)} del ${fecha(pago.fecha)}.\nSe registrará un ajuste negativo y el pago original quedará en el historial.\n\nMotivo de la anulación:`);
    if (!motivo?.trim()) return;
    try {
      await api(`/pagos/asignaciones/${a.id}/abonos`, { method: 'POST', body: { tipo: 'ajuste', ajusta_abono_id: pago.id, motivo_ajuste: motivo } });
      toast('Pago anulado mediante ajuste');
      recargar();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// Tabla de asignaciones (colaborador + proyecto + saldos).
export function tablaAsignaciones(lista, { conProyecto = true, conColaborador = true } = {}) {
  if (!lista.length) return vacio('No hay colaboradores asignados', 'usuarios');
  return `<div class="table-wrap"><table class="data responsive">
    <thead><tr>${conColaborador ? '<th>Colaborador</th>' : ''}${conProyecto ? '<th>Proyecto</th>' : ''}<th>Trabajo a realizar</th>
      <th class="right">Acordado</th><th class="right">Abonado</th><th class="right">Saldo</th><th>Estado</th><th></th></tr></thead>
    <tbody>${lista
      .map(
        (a) => `<tr data-asignacion="${a.id}">
        ${conColaborador ? `<td data-label="Colaborador"><strong>${esc(a.colaborador)}</strong>${a.especialidad ? `<br><small class="muted">${esc(a.especialidad)}</small>` : ''}</td>` : ''}
        ${conProyecto ? `<td data-label="Proyecto" class="truncate" title="${esc(a.proyecto)}">${esc(a.proyecto)}</td>` : ''}
        <td data-label="Trabajo">${esc(a.tarea)}</td>
        <td data-label="Acordado" class="right num">${usd(a.monto_acordado_usd)}</td>
        <td data-label="Abonado" class="right">${usd(a.abonado_usd)}</td>
        <td data-label="Saldo" class="right num ${a.saldo_usd > 0.004 ? 'texto-saldo' : ''}">${usd(a.saldo_usd)}</td>
        <td data-label="Estado">${badgeEstadoPago(a.estado)}</td>
        <td data-label="" data-stop>${a.saldo_usd > 0.004 ? `<button class="btn btn-sm" type="button" data-abonar="${a.id}">${icon('plus')}Abono</button>` : ''}</td>
      </tr>`
      )
      .join('')}</tbody></table></div>`;
}

// Eventos de una tabla de asignaciones: ver detalle o registrar abono.
export function conectarAsignaciones(contenedor, { obtener, alCambiar }) {
  contenedor.addEventListener('click', (e) => {
    const abonar = e.target.closest('[data-abonar]');
    if (abonar) {
      formularioAbono({ asignacion: obtener(Number(abonar.dataset.abonar)), alGuardar: alCambiar });
      return;
    }
    if (e.target.closest('[data-stop]')) return;
    const fila = e.target.closest('tr[data-asignacion]');
    if (fila) detalleAsignacion(Number(fila.dataset.asignacion), { alCambiar });
  });
}

// ---------- Sección "Pagos de producción" en la ficha del trabajo ----------

export async function seccionPagosTrabajo(contenedor, trabajo) {
  let lista = [];
  const cargar = async () => {
    const [asignaciones, abonos] = await Promise.all([
      api(`/pagos/asignaciones${qs({ trabajo_id: trabajo.id })}`),
      api(`/pagos/abonos${qs({ trabajo_id: trabajo.id })}`),
    ]);
    lista = asignaciones;
    const suma = (k) => r2(asignaciones.reduce((s, a) => s + a[k], 0));
    contenedor.innerHTML = `
      <div class="section-title">${icon('dinero')} Pagos de producción
        ${
          esAprobado(trabajo.estatus)
            ? `<button class="btn btn-sm section-action" type="button" data-asignar>${icon('plus')}Asignar colaborador</button>`
            : '<span class="section-action muted nota">Disponible cuando el proyecto esté aprobado</span>'
        }</div>
      ${
        asignaciones.length
          ? `<div class="kpis kpis-3 kpis-compactos">
              <div class="kpi"><small>Total acordado</small><strong>${usd(suma('monto_acordado_usd'))}</strong></div>
              <div class="kpi"><small>Total abonado</small><strong>${usd(suma('abonado_usd'))}</strong></div>
              <div class="kpi ${suma('saldo_usd') > 0.004 ? 'kpi-alerta' : 'kpi-ok'}"><small>Saldo pendiente</small><strong>${usd(suma('saldo_usd'))}</strong></div>
            </div>
            ${tablaAsignaciones(asignaciones, { conProyecto: false })}
            ${abonos.length ? `<details class="historial-pagos"><summary>Historial de pagos (${abonos.length})</summary>${tablaAbonos(abonos)}</details>` : ''}`
          : '<p class="muted" style="margin:0">Sin colaboradores asignados a este proyecto.</p>'
      }`;
  };
  contenedor.addEventListener('click', (e) => {
    if (e.target.closest('[data-asignar]')) formularioAsignacion({ trabajoId: trabajo.id, alGuardar: cargar });
  });
  conectarAsignaciones(contenedor, { obtener: (id) => lista.find((a) => a.id === id), alCambiar: cargar });
  await cargar();
}
