// Editor de cotizaciones (costeo y precio de venta) y la pestaña de la ficha del proyecto.
// Sólo administradores: muestra costos, márgenes y comisiones.
import { api, qs } from '../api.js';
import { icon } from '../icons.js';
import { numeroTrabajo } from '../state.js';
import { esc, fecha, modal, toast, confirmar, debounce, vacio, botonPapelera, conectarPapeleras } from '../ui.js';
import { calcularCotizacion } from '../lib/calculo-cotizacion.js';

const f2 = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const usd = (n) => (Number.isFinite(n) ? `$${f2.format(n)}` : '—');
const pctTxt = (n) => `${Math.round(n * 1000) / 10} %`;
// Número → texto editable con coma decimal
const aTexto = (n) => (n === null || n === undefined || n === '' ? '' : String(Math.round(Number(n) * 10000) / 10000).replace('.', ','));
// Texto → número (acepta "1.234,5", "1234,5" o "1234.5")
function aNumero(texto) {
  let t = String(texto ?? '').trim().replace(/\s|\$|%/g, '');
  if (!t) return 0;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

export const ESTADOS_COT = {
  borrador: { label: 'Borrador', color: '#64748b' },
  enviada: { label: 'Enviada al cliente', color: '#2563eb' },
  aprobada: { label: 'Aprobada', color: '#16a34a' },
  rechazada: { label: 'Rechazada', color: '#78716c' },
};
export const badgeCot = (e) => `<span class="badge" style="--c:${ESTADOS_COT[e]?.color}">${ESTADOS_COT[e]?.label || esc(e)}</span>`;

const lineaVacia = () => ({ material: '', descripcion: '', proveedor: '', cantidad: 1, costo_unitario: 0 });

let catalogo = null;
const cargarCatalogo = async () => (catalogo ??= await api('/materiales').catch(() => []));

// ---------- Editor ----------

export async function editorCotizacion(id, { alCambiar } = {}) {
  const [doc, materiales] = await Promise.all([api(`/cotizaciones/${id}`), cargarCatalogo()]);
  delete doc.calculo;
  // Cada pieza abre con al menos una fila lista para escribir (las vacías no se guardan).
  for (const p of doc.piezas) if (!p.lineas.length) p.lineas.push(lineaVacia());
  let huboCambios = false;
  let guardando = Promise.resolve();

  const m = modal({
    wide: true,
    titulo: `<span>${esc(doc.codigo)}</span> <span data-estado-badge>${badgeCot(doc.estado)}</span>`,
    body: '<div class="cot-editor"></div>',
    foot: `<button class="btn btn-danger left" type="button" data-borrar>${icon('trash')}Eliminar</button>
      <span class="save-state saved" data-guardado>${icon('check')}Guardado</span>
      <button class="btn" type="button" data-duplicar>Duplicar</button>
      <a class="btn" href="/api/cotizaciones/${id}/excel" data-excel>${icon('download')}Excel interno</a>
      <a class="btn" href="/api/cotizaciones/${id}/cliente" target="_blank" rel="noopener" data-cliente>${icon('file')}Documento para el cliente</a>
      <button class="btn btn-primary" data-close type="button">Listo</button>`,
    onClose: async () => {
      guardarDiferido.flush?.();
      await guardando;
      if (huboCambios) alCambiar?.();
    },
  });
  m.el.querySelector('.modal').classList.add('modal-editor');
  const raiz = m.el.querySelector('.cot-editor');
  const estadoGuardado = m.el.querySelector('[data-guardado]');

  // --- Guardado automático ---
  const pintarGuardado = (clase, texto) => {
    estadoGuardado.className = `save-state ${clase}`;
    estadoGuardado.innerHTML = `${clase === 'saved' ? icon('check') : ''}${esc(texto)}`;
  };
  const guardar = () => {
    pintarGuardado('saving', 'Guardando…');
    const copia = structuredClone(doc);
    guardando = guardando
      .then(() => api(`/cotizaciones/${id}`, { method: 'PUT', body: copia }))
      .then(() => {
        huboCambios = true;
        pintarGuardado('saved', 'Guardado');
      })
      .catch((err) => {
        pintarGuardado('error', `No se pudo guardar: ${err.message}`);
        toast(err.message, 'error');
      });
    return guardando;
  };
  let temporizador;
  const guardarDiferido = () => {
    clearTimeout(temporizador);
    pintarGuardado('saving', 'Cambios sin guardar…');
    temporizador = setTimeout(guardar, 900);
  };
  guardarDiferido.flush = () => {
    if (temporizador) {
      clearTimeout(temporizador);
      temporizador = null;
      guardar();
    }
  };

  // --- Cálculo en vivo ---
  const calcular = () => calcularCotizacion(doc);

  function resumenPieza(kp) {
    const pasos = kp.pasos.map((p) => `<span>+ ${esc(p.nombre)} ${pctTxt(p.porcentaje)}: <b>${usd(p.monto)}</b></span>`).join('');
    return `<span>Costo unitario: <b>${usd(kp.costo_unitario)}</b></span>${pasos}
      <span class="precio">Precio unitario: <b>${usd(kp.precio_unitario)}</b></span>
      <span class="precio">× ${aTexto(kp.cantidad)} = <b>${usd(kp.fabricacion)}</b></span>`;
  }

  function htmlResumen(k) {
    return `<div class="table-wrap"><table class="data cot-tabla">
      <thead><tr><th>Pieza</th><th class="right">Cant.</th><th class="right">Fabricación</th><th class="right">% viáticos</th><th class="right">Viáticos</th><th class="right">${esc(doc.comision_fija_nombre || 'Comisión en monto')}</th><th class="right">Total</th><th class="right">Precio unit. cliente</th></tr></thead>
      <tbody>${k.piezas
        .map(
          (p) => `<tr class="sin-clic"><td>${esc(p.nombre)}</td><td class="right">${aTexto(p.cantidad)}</td><td class="right">${usd(p.fabricacion)}</td>
            <td class="right">${pctTxt(p.viaticos_pct)}</td><td class="right">${usd(p.viaticos)}</td><td class="right">${usd(p.comision_fija)}</td>
            <td class="right num">${usd(p.total)}</td><td class="right">${usd(p.precio_unitario_cliente)}</td></tr>`
        )
        .join('')}</tbody>
      <tfoot><tr><td>TOTAL</td><td></td><td class="right">${usd(k.fabricacion)}</td><td></td><td class="right">${usd(k.viaticos)}</td><td class="right">${usd(k.comisiones_fijas)}</td><td class="right num">${usd(k.total)}</td><td></td></tr></tfoot>
    </table></div>
    <div class="cot-desglose">
      <div><small>Costo total</small><strong>${usd(k.costo_fabricacion + k.costo_viaticos)}</strong></div>
      ${k.pasos.map((p) => `<div><small>${esc(p.nombre)} (${pctTxt(p.porcentaje)})</small><strong>${usd(p.monto)}</strong></div>`).join('')}
      <div><small>Ganancia viáticos</small><strong>${usd(k.ganancia_viaticos)}</strong></div>
      <div><small>${esc(doc.comision_fija_nombre || 'Comisión en monto')}</small><strong>${usd(k.comisiones_fijas)}</strong></div>
      <div class="total"><small>Cotización total</small><strong>${usd(k.total)}</strong></div>
    </div>
    ${k.avisos.map((a) => `<p class="aviso-cot">${icon('alert')} ${esc(a)}</p>`).join('')}`;
  }

  // Actualiza sólo los valores calculados (sin redibujar los campos que se editan).
  function refrescarCalculos() {
    const k = calcular();
    doc.piezas.forEach((p, i) => {
      p.lineas.forEach((l, j) => {
        const celda = raiz.querySelector(`[data-total-linea="${i}-${j}"]`);
        if (celda) celda.textContent = usd(aNumero(l.cantidad) * aNumero(l.costo_unitario));
      });
      const r = raiz.querySelector(`[data-resumen-pieza="${i}"]`);
      if (r) r.innerHTML = resumenPieza(k.piezas[i]);
    });
    doc.viaticos.forEach((v, j) => {
      const celda = raiz.querySelector(`[data-total-viatico="${j}"]`);
      if (celda) celda.textContent = usd(aNumero(v.cantidad) * aNumero(v.costo_unitario));
    });
    const tv = raiz.querySelector('[data-total-viaticos]');
    if (tv) tv.innerHTML = `Costo: <b>${usd(k.costo_viaticos)}</b> · + ${pctTxt(aNumero(doc.margen_viaticos))}: <b>${usd(k.viaticos)}</b>`;
    raiz.querySelector('[data-resumen]').innerHTML = htmlResumen(k);
    m.el.querySelector('[data-estado-badge]').innerHTML = badgeCot(doc.estado);
  }

  const campoNum = (atributos, valor, extra = '') => `<input class="input num-input" inputmode="decimal" ${atributos} value="${esc(aTexto(valor))}" ${extra}>`;
  const campoTxt = (atributos, valor, extra = '') => `<input class="input" ${atributos} value="${esc(valor ?? '')}" ${extra}>`;

  function pintar() {
    const manual = doc.reparto_viaticos === 'manual';
    raiz.innerHTML = `
      <section class="cot-seccion">
        <h3>Datos de la cotización</h3>
        <div class="form-grid cot-grid-4">
          <div class="field"><span>Proyecto</span><div class="dato">${esc(doc.proyecto)}</div></div>
          <label class="field"><span>Contacto</span>${campoTxt('data-campo="contacto"', doc.contacto, 'placeholder="Ej. Francisco Pinto"')}</label>
          <label class="field"><span>Fecha</span><input class="input" type="date" data-campo="fecha" value="${esc(doc.fecha || '')}"></label>
          <label class="field"><span>Estado</span><select class="input" data-campo="estado">${Object.entries(ESTADOS_COT)
            .map(([k, v]) => `<option value="${k}" ${k === doc.estado ? 'selected' : ''}>${v.label}</option>`)
            .join('')}</select></label>
        </div>
      </section>

      <section class="cot-seccion">
        <h3>Margen y comisiones</h3>
        <div class="cot-parametros">
          <label class="field"><span>Margen de ganancia (%)</span>${campoNum('data-campo="margen" data-pct', doc.margen * 100)}</label>
          ${doc.comisiones
            .map(
              (c, i) => `<div class="field cot-comision"><span>Comisión (%)</span><div class="input-con-boton">
                ${campoTxt(`data-comision="${i}" data-campo="nombre"`, c.nombre, 'placeholder="Nombre" style="flex:1.4"')}
                ${campoNum(`data-comision="${i}" data-campo="porcentaje" data-pct`, c.porcentaje * 100, 'style="flex:1"')}
                ${botonPapelera(`data-accion="quitar-comision" data-comision="${i}"`, 'Quitar comisión')}</div></div>`
            )
            .join('')}
          <div class="field"><span>&nbsp;</span><button class="btn" type="button" data-accion="agregar-comision">${icon('plus')}Agregar comisión (%)</button></div>
          <label class="field"><span>Comisión en monto por pieza (nombre)</span>${campoTxt('data-campo="comision_fija_nombre"', doc.comision_fija_nombre, 'placeholder="Ej. Francisco"')}</label>
        </div>
        <p class="muted nota">Se aplica como en el Excel: costo ÷ (1 − margen) y luego ÷ (1 − cada comisión), en el orden indicado.</p>
      </section>

      <section class="cot-seccion">
        <h3>Piezas y materiales</h3>
        <datalist id="dl-materiales">${materiales.map((x) => `<option value="${esc(x.nombre)}">${esc([x.categoria, x.proveedor_nombre].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>
        ${doc.piezas
          .map(
            (p, i) => `<div class="cot-pieza">
              <div class="cot-pieza-cab">
                <label class="field" style="flex:2.2"><span>Pieza</span>${campoTxt(`data-pieza="${i}" data-campo="nombre"`, p.nombre)}</label>
                <label class="field" style="flex:.8"><span>Cantidad a cotizar</span>${campoNum(`data-pieza="${i}" data-campo="cantidad"`, p.cantidad)}</label>
                <label class="field" style="flex:1"><span>${esc(doc.comision_fija_nombre || 'Comisión en monto')} ($)</span>${campoNum(`data-pieza="${i}" data-campo="comision_fija"`, p.comision_fija)}</label>
                ${manual ? `<label class="field" style="flex:.8"><span>% de viáticos</span>${campoNum(`data-pieza="${i}" data-campo="viaticos_pct" data-pct`, (p.viaticos_pct ?? 0) * 100)}</label>` : ''}
                <div class="cot-pieza-acciones">
                  <button class="btn btn-sm" type="button" data-accion="duplicar-pieza" data-pieza="${i}" title="Duplicar pieza">Duplicar</button>
                  ${botonPapelera(`data-accion="quitar-pieza" data-pieza="${i}"`, 'Eliminar pieza')}
                </div>
              </div>
              <div class="table-wrap"><table class="data cot-tabla cot-lineas">
                <thead><tr><th>Material / servicio</th><th>Descripción</th><th>Proveedor</th><th class="right">Cantidad</th><th class="right">Costo unit. ($)</th><th class="right">Costo total</th><th></th></tr></thead>
                <tbody>${p.lineas
                  .map(
                    (l, j) => `<tr class="sin-clic">
                      <td>${campoTxt(`data-pieza="${i}" data-linea="${j}" data-campo="material"`, l.material, 'list="dl-materiales" autocomplete="off"')}</td>
                      <td>${campoTxt(`data-pieza="${i}" data-linea="${j}" data-campo="descripcion"`, l.descripcion)}</td>
                      <td>${campoTxt(`data-pieza="${i}" data-linea="${j}" data-campo="proveedor"`, l.proveedor)}</td>
                      <td>${campoNum(`data-pieza="${i}" data-linea="${j}" data-campo="cantidad"`, l.cantidad)}</td>
                      <td>${campoNum(`data-pieza="${i}" data-linea="${j}" data-campo="costo_unitario"`, l.costo_unitario)}</td>
                      <td class="right num" data-total-linea="${i}-${j}"></td>
                      <td class="col-acciones">${botonPapelera(`data-accion="quitar-linea" data-pieza="${i}" data-linea="${j}"`, 'Quitar línea')}</td>
                    </tr>`
                  )
                  .join('')}</tbody></table></div>
              <div class="cot-pieza-pie">
                <button class="btn btn-sm" type="button" data-accion="agregar-linea" data-pieza="${i}">${icon('plus')}Agregar material o servicio</button>
                <div class="cot-calculo" data-resumen-pieza="${i}"></div>
              </div>
            </div>`
          )
          .join('')}
        <button class="btn" type="button" data-accion="agregar-pieza">${icon('plus')}Agregar pieza</button>
      </section>

      <section class="cot-seccion">
        <h3>Transporte y viáticos</h3>
        <div class="cot-parametros">
          <label class="field"><span>Margen de viáticos (%)</span>${campoNum('data-campo="margen_viaticos" data-pct', doc.margen_viaticos * 100)}</label>
          <label class="field"><span>Reparto entre piezas</span><select class="input" data-campo="reparto_viaticos">
            <option value="proporcional" ${!manual ? 'selected' : ''}>Proporcional a la fabricación</option>
            <option value="manual" ${manual ? 'selected' : ''}>Porcentajes manuales</option></select></label>
          <div class="field"><span>&nbsp;</span><button class="btn" type="button" data-accion="calculadora">${icon('calendario')}Calcular comidas y hotel</button></div>
        </div>
        <div class="table-wrap"><table class="data cot-tabla cot-lineas">
          <thead><tr><th>Concepto</th><th>Descripción</th><th>Proveedor</th><th class="right">Cantidad</th><th class="right">Costo unit. ($)</th><th class="right">Costo total</th><th></th></tr></thead>
          <tbody>${doc.viaticos
            .map(
              (v, j) => `<tr class="sin-clic">
                <td>${campoTxt(`data-viatico="${j}" data-campo="concepto"`, v.concepto)}</td>
                <td>${campoTxt(`data-viatico="${j}" data-campo="descripcion"`, v.descripcion)}</td>
                <td>${campoTxt(`data-viatico="${j}" data-campo="proveedor"`, v.proveedor)}</td>
                <td>${campoNum(`data-viatico="${j}" data-campo="cantidad"`, v.cantidad)}</td>
                <td>${campoNum(`data-viatico="${j}" data-campo="costo_unitario"`, v.costo_unitario)}</td>
                <td class="right num" data-total-viatico="${j}"></td>
                <td class="col-acciones">${botonPapelera(`data-accion="quitar-viatico" data-viatico="${j}"`, 'Quitar línea')}</td>
              </tr>`
            )
            .join('')}</tbody></table></div>
        <div class="cot-pieza-pie">
          <button class="btn btn-sm" type="button" data-accion="agregar-viatico">${icon('plus')}Agregar concepto</button>
          <div class="cot-calculo" data-total-viaticos></div>
        </div>
      </section>

      <section class="cot-seccion">
        <h3>Resumen</h3>
        <div data-resumen></div>
      </section>

      <section class="cot-seccion">
        <h3>Para el documento del cliente</h3>
        <div class="form-grid">
          <label class="field"><span>Tiempo de entrega</span>${campoTxt('data-campo="tiempo_entrega"', doc.tiempo_entrega, 'placeholder="Ej. 15 días hábiles tras la aprobación"')}</label>
          <label class="field"><span>Validez de la oferta (días)</span>${campoNum('data-campo="validez_dias"', doc.validez_dias)}</label>
          <label class="field full"><span>Condiciones</span><textarea class="input" rows="3" data-campo="condiciones" placeholder="Ej. 60 % de anticipo y 40 % contra entrega. Precios no incluyen IVA.">${esc(doc.condiciones || '')}</textarea></label>
          <label class="field full"><span>Observaciones internas (no salen en el documento)</span><textarea class="input" rows="2" data-campo="observaciones">${esc(doc.observaciones || '')}</textarea></label>
        </div>
      </section>`;
    refrescarCalculos();
  }

  // --- Edición de campos ---
  raiz.addEventListener('input', (e) => {
    const el = e.target;
    const campo = el.dataset.campo;
    if (!campo) return;
    const numerico = el.classList.contains('num-input');
    let valor = numerico ? aNumero(el.value) : el.value;
    if (el.dataset.pct !== undefined) valor /= 100;
    if (el.dataset.linea !== undefined) doc.piezas[el.dataset.pieza].lineas[el.dataset.linea][campo] = valor;
    else if (el.dataset.pieza !== undefined) doc.piezas[el.dataset.pieza][campo] = valor;
    else if (el.dataset.viatico !== undefined) doc.viaticos[el.dataset.viatico][campo] = valor;
    else if (el.dataset.comision !== undefined) doc.comisiones[el.dataset.comision][campo] = valor;
    else doc[campo] = valor;

    // Al elegir un material del catálogo se completan proveedor y costo actual.
    if (campo === 'material' && el.dataset.linea !== undefined) {
      const linea = doc.piezas[el.dataset.pieza].lineas[el.dataset.linea];
      const encontrado = materiales.find((x) => x.nombre.toLowerCase() === el.value.trim().toLowerCase());
      linea.material_id = encontrado?.id ?? null;
      if (encontrado) {
        const fila = el.closest('tr');
        if (!linea.proveedor && encontrado.proveedor_nombre) {
          linea.proveedor = encontrado.proveedor_nombre;
          fila.querySelector('[data-campo=proveedor]').value = linea.proveedor;
        }
        if (!aNumero(linea.costo_unitario) && encontrado.precio) {
          linea.costo_unitario = encontrado.precio;
          fila.querySelector('[data-campo=costo_unitario]').value = aTexto(encontrado.precio);
        }
      }
    }
    if (campo === 'comision_fija_nombre' || campo === 'reparto_viaticos') pintar();
    else refrescarCalculos();
    guardarDiferido();
  });

  // --- Botones (agregar, quitar, duplicar, calculadora) ---
  raiz.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-accion]');
    if (!b) return;
    const i = Number(b.dataset.pieza);
    const j = Number(b.dataset.linea ?? b.dataset.viatico ?? b.dataset.comision);
    switch (b.dataset.accion) {
      case 'agregar-linea':
        doc.piezas[i].lineas.push(lineaVacia());
        break;
      case 'quitar-linea':
        doc.piezas[i].lineas.splice(j, 1);
        break;
      case 'agregar-pieza':
        doc.piezas.push({ nombre: `Pieza ${doc.piezas.length + 1}`, cantidad: 1, comision_fija: 0, viaticos_pct: null, lineas: [lineaVacia()] });
        break;
      case 'duplicar-pieza': {
        const copia = structuredClone(doc.piezas[i]);
        copia.nombre = `${copia.nombre} (copia)`;
        doc.piezas.splice(i + 1, 0, copia);
        toast('Pieza duplicada: ajusta lo que cambie');
        break;
      }
      case 'quitar-pieza':
        if (!(await confirmar(`¿Quitar la pieza «${doc.piezas[i].nombre}» con todos sus materiales?`, { boton: 'Quitar' }))) return;
        doc.piezas.splice(i, 1);
        break;
      case 'agregar-viatico':
        doc.viaticos.push({ concepto: '', descripcion: '', proveedor: '', cantidad: 1, costo_unitario: 0 });
        break;
      case 'quitar-viatico':
        doc.viaticos.splice(j, 1);
        break;
      case 'agregar-comision':
        doc.comisiones.push({ nombre: '', porcentaje: 0 });
        break;
      case 'quitar-comision':
        doc.comisiones.splice(j, 1);
        break;
      case 'calculadora':
        calculadoraViaticos(doc, () => {
          pintar();
          guardarDiferido();
        });
        return;
      default:
        return;
    }
    pintar();
    guardarDiferido();
  });

  // --- Pie del editor ---
  m.el.querySelector('[data-borrar]').addEventListener('click', async () => {
    if (!(await confirmar(`¿Eliminar la cotización ${doc.codigo}? Esta acción no se puede deshacer.`))) return;
    try {
      clearTimeout(temporizador);
      await guardando;
      await api(`/cotizaciones/${id}`, { method: 'DELETE' });
      toast('Cotización eliminada');
      huboCambios = true;
      m.close();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  m.el.querySelector('[data-duplicar]').addEventListener('click', async () => {
    guardarDiferido.flush();
    await guardando;
    try {
      const copia = await api(`/cotizaciones/${id}/duplicar`, { method: 'POST' });
      toast(`Se creó ${copia.codigo}`);
      huboCambios = true;
      m.close();
      editorCotizacion(copia.id, { alCambiar });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  // Antes de exportar se guardan los cambios pendientes.
  for (const sel of ['[data-excel]', '[data-cliente]']) {
    m.el.querySelector(sel).addEventListener('click', async (e) => {
      if (!temporizador) return;
      e.preventDefault();
      const enlace = e.currentTarget;
      guardarDiferido.flush();
      await guardando;
      if (enlace.target === '_blank') window.open(enlace.href, '_blank', 'noopener');
      else window.location.href = enlace.href;
    });
  }
  pintar();
}

// Calculadora de comidas y hotel: genera las líneas de viáticos.
function calculadoraViaticos(doc, alAplicar) {
  const m = modal({
    titulo: 'Calcular comidas y hotel',
    body: `<form class="form-grid" id="form-calc">
      <label class="field"><span>Personas</span><input class="input" name="personas" inputmode="numeric" value="6"></label>
      <label class="field"><span>Días de trabajo</span><input class="input" name="dias" inputmode="numeric" value="4"></label>
      <label class="field"><span>Costo por comida ($)</span><input class="input" name="comida" inputmode="decimal" value="15"></label>
      <label class="field"><span>Días con cena</span><input class="input" name="dias_cena" inputmode="numeric" value="3"></label>
      <label class="field"><span>Habitaciones de hotel</span><input class="input" name="habitaciones" inputmode="numeric" value="3"></label>
      <label class="field"><span>Noches de hotel</span><input class="input" name="noches" inputmode="numeric" value="1"></label>
      <label class="field"><span>Costo por habitación/noche ($)</span><input class="input" name="hotel" inputmode="decimal" value="90"></label>
      <p class="muted full nota">Se agregan (o actualizan) las líneas Desayuno, Almuerzo, Cena y Hotel. Luego puedes ajustarlas.</p>
    </form>`,
    foot: `<button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" type="submit" form="form-calc">Aplicar</button>`,
  });
  m.el.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (n) => aNumero(e.target.elements[n].value);
    const filas = [
      ['Desayuno', 'Personal', v('personas') * v('dias'), v('comida')],
      ['Almuerzo', 'Personal', v('personas') * v('dias'), v('comida')],
      ['Cena', 'Personal', v('personas') * v('dias_cena'), v('comida')],
      ['Hotel', `${v('habitaciones')} habitaciones × ${v('noches')} noches`, v('habitaciones') * v('noches'), v('hotel')],
    ];
    for (const [concepto, descripcion, cantidad, costo] of filas) {
      if (!cantidad) continue;
      const existente = doc.viaticos.find((x) => (x.concepto || '').toLowerCase() === concepto.toLowerCase());
      if (existente) Object.assign(existente, { descripcion, cantidad, costo_unitario: costo });
      else doc.viaticos.push({ concepto, descripcion, proveedor: 'Spacio', cantidad, costo_unitario: costo });
    }
    m.close();
    alAplicar();
  });
}

// ---------- Listado y creación ----------

export function tablaCotizaciones(lista, { conProyecto = true } = {}) {
  if (!lista.length) return vacio('Todavía no hay cotizaciones', 'file');
  return `<div class="table-wrap"><table class="data responsive">
    <thead><tr><th>N°</th>${conProyecto ? '<th>Proyecto</th>' : ''}<th>Piezas</th><th>Fecha</th><th>Estado</th><th class="right">Costo</th><th class="right">Total cotizado</th><th></th></tr></thead>
    <tbody>${lista
      .map(
        (c) => `<tr data-cotizacion="${c.id}">
        <td data-label="N°" class="num">${esc(c.codigo)}</td>
        ${conProyecto ? `<td data-label="Proyecto" class="truncate" title="${esc(c.proyecto)}">${esc(c.proyecto)}${c.trabajo_descripcion ? ` · ${esc(c.trabajo_descripcion.split('\n')[0])}` : ''}</td>` : ''}
        <td data-label="Piezas" class="truncate" title="${esc(c.piezas.join(', '))}">${esc(c.piezas.join(', '))}</td>
        <td data-label="Fecha" class="nowrap">${fecha(c.fecha)}</td>
        <td data-label="Estado">${badgeCot(c.estado)}</td>
        <td data-label="Costo" class="right">${usd(c.costo)}</td>
        <td data-label="Total" class="right num">${usd(c.total)}</td>
        <td data-label="" class="col-acciones">${botonPapelera(`data-borrar-cotizacion="${c.id}"`, 'Eliminar cotización')}</td>
      </tr>`
      )
      .join('')}</tbody></table></div>`;
}

export function conectarCotizaciones(contenedor, { obtener, alCambiar }) {
  conectarPapeleras(contenedor, '[data-borrar-cotizacion]', {
    mensaje: (b) => `¿Eliminar la cotización ${obtener(Number(b.dataset.borrarCotizacion))?.codigo}? Esta acción no se puede deshacer.`,
    eliminar: (b) => api(`/cotizaciones/${b.dataset.borrarCotizacion}`, { method: 'DELETE' }),
    alEliminar: alCambiar,
    exito: 'Cotización eliminada',
  });
  contenedor.addEventListener('click', (e) => {
    const fila = e.target.closest('tr[data-cotizacion]');
    if (fila) editorCotizacion(Number(fila.dataset.cotizacion), { alCambiar });
  });
}

export async function nuevaCotizacion(trabajoId, { alCambiar } = {}) {
  try {
    const c = await api('/cotizaciones', { method: 'POST', body: { trabajo_id: trabajoId } });
    toast(`Cotización ${c.codigo} creada`);
    alCambiar?.();
    editorCotizacion(c.id, { alCambiar });
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Elegir el proyecto para una cotización nueva.
export async function elegirProyectoCotizacion({ alCambiar } = {}) {
  const trabajos = await api('/trabajos?orden=recientes');
  const m = modal({
    titulo: 'Nueva cotización',
    body: `<label class="field"><span>Proyecto</span><select class="input" name="trabajo"><option value="">— Selecciona el proyecto —</option>${trabajos
      .map((t) => `<option value="${t.id}">${esc(numeroTrabajo(t.numero))} · ${esc(t.cliente)}${t.descripcion ? ` · ${esc(t.descripcion.split('\n')[0])}` : ''}</option>`)
      .join('')}</select></label>
      <p class="muted nota">¿El proyecto no existe aún? Créalo primero en Control de trabajos.</p>`,
    foot: `<button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" type="button" data-ok>Crear cotización</button>`,
  });
  m.el.querySelector('[data-ok]').addEventListener('click', () => {
    const id = Number(m.el.querySelector('[name=trabajo]').value);
    if (!id) return toast('Selecciona el proyecto', 'error');
    m.close();
    nuevaCotizacion(id, { alCambiar });
  });
}

// Pestaña "Cotización" en la ficha del proyecto.
export async function seccionCotizacionesTrabajo(contenedor, trabajo) {
  let lista = [];
  const cargar = async () => {
    lista = await api(`/cotizaciones${qs({ trabajo_id: trabajo.id })}`);
    contenedor.innerHTML = `
      <div class="toolbar"><span class="muted">Costos, márgenes y comisiones: sólo administradores.</span><span class="spacer"></span>
        <button class="btn btn-primary" type="button" data-nueva-cot>${icon('plus')}Nueva cotización</button></div>
      ${tablaCotizaciones(lista, { conProyecto: false })}`;
  };
  contenedor.addEventListener('click', (e) => {
    if (e.target.closest('[data-nueva-cot]')) nuevaCotizacion(trabajo.id, { alCambiar: cargar });
  });
  conectarCotizaciones(contenedor, { obtener: (id) => lista.find((c) => c.id === id), alCambiar: cargar });
  await cargar();
}
