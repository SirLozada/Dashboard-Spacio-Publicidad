// Piezas compartidas entre el Dashboard y Control de trabajos:
// la tabla de trabajos y la ficha (detalle editable con autoguardado).
import { api } from '../api.js';
import { seccionPagosTrabajo } from './pagos-comun.js';
import { subirArchivos } from './adjuntos.js';
import { seccionSolicitudesTrabajo } from './solicitudes-comun.js';
import { seccionCotizacionesTrabajo } from './cotizaciones-comun.js';
import { icon } from '../icons.js';
import { state, numeroTrabajo, esAdmin, alternarEstatus, listaEstatus } from '../state.js';
import {
  esc, fecha, fechaHora, campo, modal, toast, confirmar, botonPapelera, conectarPapeleras, botonEstatus, selectorEstatus, badgeEstatus,
  situacion, etiquetaVencimiento, tamanoArchivo, debounce, vacio,
} from '../ui.js';

// ---------- Tabla ----------

export function tablaTrabajos(lista, { compacta = false } = {}) {
  if (!lista.length) return vacio('No hay trabajos que coincidan con los filtros', 'trabajos');
  const filas = lista
    .map((t) => {
      const sit = situacion(t);
      return `<tr data-id="${t.id}" class="${sit || ''}">
        <td data-label="N°" class="num">${numeroTrabajo(t.numero)}</td>
        <td data-label="Cliente"><strong>${esc(t.cliente)}</strong></td>
        <td data-label="Marca">${esc(t.marca)}</td>
        <td data-label="Tienda">${esc(t.tienda)}</td>
        ${compacta ? '' : `<td data-label="Ubicación" class="hide-sm">${esc(t.ubicacion)}</td>`}
        <td data-label="Descripción" class="truncate" title="${esc(t.descripcion)}">${esc(t.descripcion)}</td>
        <td data-label="Estatus" data-stop>${botonEstatus(t)}</td>
        <td data-label="Pendiente" class="truncate" title="${esc(t.proximo_pendiente)}">${t.proximo_pendiente ? `${esc(t.proximo_pendiente)}${t.total_pendientes > 1 ? ` <span class="more">+${t.total_pendientes - 1}</span>` : ''}` : ''}</td>
        ${compacta ? '' : `<td data-label="Inicio" class="nowrap hide-sm">${fecha(t.fecha_inicio)}</td>`}
        ${compacta ? '' : `<td data-label="Entrega cotización" class="nowrap hide-sm">${fecha(t.fecha_cotizacion)}</td>`}
        <td data-label="Entrega" class="nowrap"><span>${fecha(t.fecha_entrega) || '<span class="muted">—</span>'}${etiquetaVencimiento(t)}</span></td>
        <td data-label="Responsable">${esc(t.responsable)}</td>
        ${compacta ? '' : `<td data-label="" class="nowrap">${t.total_adjuntos ? `<span class="clip" title="Archivos adjuntos">${icon('clip')}${t.total_adjuntos}</span>` : ''}</td>`}
        ${esAdmin() ? `<td data-label="" class="col-acciones">${botonPapelera(`data-borrar-trabajo="${t.id}"`, 'Eliminar trabajo')}</td>` : ''}
      </tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table class="data responsive">
    <thead><tr>
      <th>N°</th><th>Cliente</th><th>Marca</th><th>Tienda</th>
      ${compacta ? '' : '<th>Ubicación</th>'}
      <th>Descripción</th><th>Estatus</th><th>Pendiente</th>
      ${compacta ? '' : '<th>Inicio</th><th>Entrega cot.</th>'}
      <th class="sortable" data-sort="entrega">Entrega</th><th>Responsable</th>
      ${compacta ? '' : '<th></th>'}${esAdmin() ? '<th></th>' : ''}
    </tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}

// Mantiene sincronizadas las casillas de estatus y avisa cada cambio.
export function conectarSelectorEstatus(contenedor, valorInicial, alCambiar) {
  let valor = valorInicial || 'por_cotizar';
  contenedor.addEventListener('change', (e) => {
    const casilla = e.target.closest('input[type=checkbox]');
    if (!casilla) return;
    e.stopPropagation();
    valor = alternarEstatus(valor, casilla.value, casilla.checked);
    const actuales = listaEstatus(valor);
    contenedor.querySelectorAll('input[type=checkbox]').forEach((c) => (c.checked = actuales.includes(c.value)));
    alCambiar(valor);
  });
}

// Ventana flotante junto al botón de estatus de la tabla: cada casilla se guarda al momento.
function abrirSelectorTabla(boton, trabajo, alCerrar) {
  document.querySelector('.status-pop')?.cerrar();
  const pop = document.createElement('div');
  pop.className = 'status-pop';
  pop.dataset.de = trabajo.id;
  pop.innerHTML = `<div class="status-pop-title">Estatus de ${esc(numeroTrabajo(trabajo.numero))} <small>(puedes marcar varios)</small></div>
    ${selectorEstatus(trabajo.estatus)}`;
  document.body.append(pop);
  const r = boton.getBoundingClientRect();
  const ancho = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - ancho - 8))}px`;
  const abajo = r.bottom + 6 + pop.offsetHeight < window.innerHeight;
  pop.style.top = `${abajo ? r.bottom + 6 : Math.max(8, r.top - pop.offsetHeight - 6)}px`;

  let cambio = false;
  let guardando = Promise.resolve();
  conectarSelectorEstatus(pop, trabajo.estatus, (valor) => {
    cambio = true;
    trabajo.estatus = valor;
    boton.innerHTML = `${badgeEstatus(valor)}${icon('chevron')}`;
    guardando = guardando
      .then(() => api(`/trabajos/${trabajo.id}`, { method: 'PATCH', body: { estatus: valor } }))
      .catch((err) => toast(err.message, 'error'));
  });
  let cerrado = false;
  const cerrar = () => {
    if (cerrado) return;
    cerrado = true;
    pop.remove();
    document.removeEventListener('pointerdown', alTocarFuera, true);
    document.removeEventListener('keydown', alTeclear);
    window.removeEventListener('scroll', alDesplazar, true);
    window.removeEventListener('resize', cerrar);
    if (cambio) {
      guardando.then(() => {
        toast('Estatus actualizado');
        alCerrar();
      });
    }
  };
  const alTocarFuera = (e) => !pop.contains(e.target) && !boton.contains(e.target) && cerrar();
  const alTeclear = (e) => e.key === 'Escape' && cerrar();
  const alDesplazar = (e) => !pop.contains(e.target) && cerrar();
  pop.cerrar = cerrar;
  setTimeout(() => {
    document.addEventListener('pointerdown', alTocarFuera, true);
    document.addEventListener('keydown', alTeclear);
    window.addEventListener('scroll', alDesplazar, true);
    window.addEventListener('resize', cerrar);
  });
}

// Conecta los eventos de la tabla: abrir ficha al hacer clic y cambio rápido de estatus.
export function conectarTabla(contenedor, { alCambiar, obtenerTrabajo }) {
  conectarPapeleras(contenedor, '[data-borrar-trabajo]', {
    mensaje: (b) => {
      const t = obtenerTrabajo(Number(b.dataset.borrarTrabajo));
      return `¿Eliminar el trabajo ${numeroTrabajo(t.numero)} · ${t.cliente} y sus archivos? Esta acción no se puede deshacer.`;
    },
    eliminar: (b) => api(`/trabajos/${b.dataset.borrarTrabajo}`, { method: 'DELETE' }),
    alEliminar: alCambiar,
    exito: 'Trabajo eliminado',
  });
  contenedor.addEventListener('click', (e) => {
    const boton = e.target.closest('[data-estatus-de]');
    if (boton) {
      const abierto = document.querySelector('.status-pop');
      if (abierto?.dataset.de === boton.dataset.estatusDe) return abierto.cerrar(); // segundo toque: cerrar
      const t = obtenerTrabajo(Number(boton.dataset.estatusDe));
      if (t) abrirSelectorTabla(boton, t, alCambiar);
      return;
    }
    if (e.target.closest('[data-stop]')) return;
    const fila = e.target.closest('tr[data-id]');
    if (fila) abrirFicha(Number(fila.dataset.id), { alCerrar: alCambiar });
  });
}

// ---------- Ficha del trabajo ----------

let sugerencias = null;
async function cargarSugerencias() {
  sugerencias = await api('/trabajos/sugerencias').catch(() => ({}));
  return sugerencias;
}

function camposFicha(s = {}) {
  return [
    { name: 'cliente', label: 'Cliente', required: true, list: s.cliente },
    { name: 'marca', label: 'Marca', list: s.marca },
    { name: 'tienda', label: 'Nombre de tienda', list: s.tienda },
    { name: 'ubicacion', label: 'Ubicación', list: s.ubicacion },
    { name: 'descripcion', label: 'Descripción del trabajo', type: 'textarea', full: true },
    { name: 'estatus', label: 'Estatus (puedes marcar varios)', type: 'estatus', full: true },
    { name: 'responsable', label: 'Responsable', list: s.responsable },
    { name: 'fecha_inicio', label: 'Fecha de inicio', type: 'date' },
    { name: 'fecha_cotizacion', label: 'Fecha de entrega de cotización', type: 'date' },
    { name: 'fecha_entrega', label: 'Fecha de entrega del trabajo', type: 'date' },
    { name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true },
  ];
}

const esImagen = (a) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(a.mime || '');

function htmlAdjuntos(adjuntos) {
  if (!adjuntos.length) return '';
  return adjuntos
    .map(
      (a) => `<div class="file" data-adj="${a.id}">
        <a class="thumb" href="/api/adjuntos/${a.id}" target="_blank" rel="noopener" title="${esc(a.nombre_original)}">
          ${esImagen(a) ? `<img src="/api/adjuntos/${a.id}" alt="${esc(a.nombre_original)}" loading="lazy">` : icon('file')}
        </a>
        <div class="name" title="${esc(a.nombre_original)}">${esc(a.nombre_original)}<br><span class="muted">${tamanoArchivo(a.tamano)}</span></div>
        <button class="del" type="button" data-del-adj="${a.id}" aria-label="Eliminar archivo">${icon('trash')}</button>
      </div>`
    )
    .join('');
}

const subirAdjuntosTrabajo = (id, archivos) => subirArchivos({ ruta: `/trabajos/${id}/adjuntos`, carpeta: `trabajos/${id}`, archivos });

// Abre la ficha de un trabajo existente (id) o de uno nuevo (id = null).
export async function abrirFicha(id, { alCerrar, inicial = {} } = {}) {
  const [trabajo, sug] = await Promise.all([
    id ? api(`/trabajos/${id}`) : Promise.resolve({ estatus: 'por_cotizar', adjuntos: [], ...inicial }),
    sugerencias ? Promise.resolve(sugerencias) : cargarSugerencias(),
  ]);
  const nuevo = !id;
  const archivosPorSubir = []; // archivos elegidos antes de crear el trabajo
  let pendienteGuardado = Promise.resolve();
  let huboCambios = false;

  const rutaPrevia = location.hash;
  if (!nuevo) history.replaceState(null, '', `#/trabajos?id=${id}`);

  const titulo = () =>
    nuevo
      ? 'Nuevo trabajo'
      : `<span class="num">${numeroTrabajo(trabajo.numero)}</span> ${badgeEstatus(trabajo.estatus)} ${etiquetaVencimiento(trabajo)}`;

  const m = modal({
    wide: true,
    titulo: titulo(),
    body: `${
      nuevo
        ? ''
        : `<nav class="tabs ficha-tabs" role="tablist">
            <button type="button" class="activo" data-ficha-tab="datos">${icon('trabajos')}Datos del trabajo</button>
            <button type="button" data-ficha-tab="solicitudes">${icon('mensaje')}Solicitudes y novedades <span class="tab-contador" hidden></span></button>
            ${esAdmin() ? `<button type="button" data-ficha-tab="cotizacion">${icon('tag')}Cotización</button>` : ''}
          </nav><div data-ficha-panel="solicitudes" hidden></div>${esAdmin() ? '<div data-ficha-panel="cotizacion" hidden></div>' : ''}`
    }<div data-ficha-panel="datos"><form class="form-grid" novalidate>
        ${camposFicha(sug).map((c) => campo(c, trabajo[c.name])).join('')}
      </form>
      <div class="section-title">${icon('check')} Pendientes</div>
      <ul class="todo"></ul>
      <form class="todo-add">
        <input class="input" name="texto" placeholder="Agregar pendiente (ej. Presupuesto proveedor, Artes finales…)" autocomplete="off" maxlength="500">
        <button class="btn" type="submit">${icon('plus')}Agregar</button>
      </form>
      ${!nuevo && esAdmin() ? '<div class="pagos-ficha"></div>' : ''}
      <div class="section-title">${icon('clip')} Archivos y fotografías</div>
      <label class="dropzone">
        ${icon('upload')}
        <strong>Haz clic o arrastra archivos aquí</strong>
        <div style="font-size:12.5px">Fotos, renders, PDF, diseños… (máx. ${state.config.maxArchivoMb} MB c/u)</div>
        <input type="file" multiple hidden>
      </label>
      <div class="files"></div>
      ${nuevo ? '' : `<div class="meta-line">Creado ${fechaHora(trabajo.creado_en)} · Última actualización ${fechaHora(trabajo.actualizado_en)}</div>`}</div>`,
    foot: `${!nuevo && esAdmin() ? `<button class="btn btn-danger left" type="button" data-borrar>${icon('trash')}Eliminar</button>` : '<span class="left"></span>'}
      ${nuevo ? '' : '<span class="save-state saved">' + icon('check') + 'Los cambios se guardan automáticamente</span>'}
      ${nuevo ? '<button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-crear type="button">' + icon('plus') + 'Crear trabajo</button>' : '<button class="btn btn-primary" data-close type="button">Listo</button>'}`,
    onClose: async () => {
      if (!nuevo) {
        history.replaceState(null, '', rutaPrevia.includes('id=') ? '#/trabajos' : rutaPrevia);
        // Guarda lo que quedó escrito y aún no se había enviado.
        camposFicha().forEach((c) => guardarCampo(c.name));
      }
      await pendienteGuardado;
      if (huboCambios) alCerrar?.();
    },
  });

  const form = m.el.querySelector('form');
  const estado = m.el.querySelector('.save-state');
  const lista = m.el.querySelector('.files');
  // Pestaña "Solicitudes y novedades" del proyecto.
  const panelSolicitudes = m.el.querySelector('[data-ficha-panel=solicitudes]');
  if (panelSolicitudes) {
    const contadorTab = m.el.querySelector('.tab-contador');
    seccionSolicitudesTrabajo(panelSolicitudes, trabajo, {
      alContar: (n) => {
        contadorTab.hidden = !n;
        contadorTab.textContent = n;
      },
    }).catch((err) => {
      panelSolicitudes.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    });
    const panelCotizacion = m.el.querySelector('[data-ficha-panel=cotizacion]');
    let cotizacionCargada = false;
    m.el.querySelectorAll('[data-ficha-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        m.el.querySelectorAll('[data-ficha-tab]').forEach((x) => x.classList.toggle('activo', x === b));
        m.el.querySelectorAll('[data-ficha-panel]').forEach((p) => (p.hidden = p.dataset.fichaPanel !== b.dataset.fichaTab));
        if (b.dataset.fichaTab === 'cotizacion' && panelCotizacion && !cotizacionCargada) {
          cotizacionCargada = true;
          seccionCotizacionesTrabajo(panelCotizacion, trabajo).catch((err) => {
            panelCotizacion.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
          });
        }
      })
    );
  }
  const contPagos = m.el.querySelector('.pagos-ficha');
  if (contPagos) {
    seccionPagosTrabajo(contPagos, trabajo).catch((err) => {
      contPagos.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    });
  }
  const entrada = m.el.querySelector('input[type=file]');
  const zona = m.el.querySelector('.dropzone');
  lista.innerHTML = htmlAdjuntos(trabajo.adjuntos);
  if (nuevo) form.elements.cliente.focus();

  const pintarEstado = (clase, texto) => {
    if (!estado) return;
    estado.className = `save-state ${clase}`;
    estado.innerHTML = `${clase === 'saved' ? icon('check') : ''}${esc(texto)}`;
  };

  // --- Autoguardado (sólo trabajos existentes) ---
  const guardarCampo = (nombre) => {
    const valor = form.elements[nombre].value;
    if ((trabajo[nombre] ?? '') === valor) return;
    if (nombre === 'cliente' && !valor.trim()) {
      pintarEstado('error', 'El cliente es obligatorio');
      return;
    }
    trabajo[nombre] = valor;
    pintarEstado('saving', 'Guardando…');
    pendienteGuardado = pendienteGuardado
      .then(() => api(`/trabajos/${id}`, { method: 'PATCH', body: { [nombre]: valor } }))
      .then((t) => {
        Object.assign(trabajo, t);
        huboCambios = true;
        pintarEstado('saved', 'Guardado');
        m.el.querySelector('.modal-head h2').innerHTML = titulo();
      })
      .catch((err) => {
        pintarEstado('error', `No se pudo guardar: ${err.message}`);
        toast(err.message, 'error');
      });
  };
  if (!nuevo) {
    const porCampo = {};
    form.addEventListener('input', (e) => {
      const n = e.target.name;
      if (!n || e.target.tagName === 'SELECT' || e.target.type === 'date') return;
      porCampo[n] ??= debounce(() => guardarCampo(n), 900);
      porCampo[n]();
    });
    form.addEventListener('change', (e) => e.target.name && guardarCampo(e.target.name));
  }

  // --- Estatus (casillas; se guardan en el campo oculto "estatus") ---
  conectarSelectorEstatus(form.querySelector('.status-chips'), trabajo.estatus, (valor) => {
    form.elements.estatus.value = valor;
    if (!nuevo) guardarCampo('estatus');
  });

  // --- Pendientes ---
  // En un trabajo nuevo se guardan en memoria y se envían al crearlo.
  const listaPend = m.el.querySelector('.todo');
  const formPend = m.el.querySelector('.todo-add');
  let pendientes = trabajo.pendientes || [];
  const pintarPendientes = () => {
    listaPend.innerHTML = pendientes.length
      ? pendientes
          .map(
            (p, i) => `<li class="${p.hecho ? 'done' : ''}">
              <label><input type="checkbox" data-hecho="${p.id ?? i}" ${p.hecho ? 'checked' : ''} ${nuevo ? 'disabled' : ''}><span>${esc(p.texto)}</span></label>
              <button class="icon-btn btn-papelera" type="button" data-del-pend="${p.id ?? i}" title="Eliminar pendiente" aria-label="Eliminar pendiente">${icon('trash')}</button>
            </li>`
          )
          .join('')
      : '<li class="muted empty-todo">Sin pendientes</li>';
  };
  pintarPendientes();
  const accionPendiente = async (peticion) => {
    try {
      pendientes = await peticion;
      huboCambios = true;
      pintarPendientes();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  formPend.addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = formPend.elements.texto.value.trim();
    if (!texto) return;
    formPend.elements.texto.value = '';
    if (nuevo) {
      pendientes.push({ texto, hecho: 0 });
      pintarPendientes();
    } else {
      accionPendiente(api(`/trabajos/${id}/pendientes`, { method: 'POST', body: { texto } }));
    }
  });
  listaPend.addEventListener('change', (e) => {
    const c = e.target.closest('[data-hecho]');
    if (c) accionPendiente(api(`/pendientes/${c.dataset.hecho}`, { method: 'PATCH', body: { hecho: c.checked } }));
  });
  listaPend.addEventListener('click', (e) => {
    const b = e.target.closest('[data-del-pend]');
    if (!b) return;
    if (nuevo) {
      pendientes.splice(Number(b.dataset.delPend), 1);
      pintarPendientes();
    } else {
      accionPendiente(api(`/pendientes/${b.dataset.delPend}`, { method: 'DELETE' }));
    }
  });

  // --- Crear trabajo nuevo ---
  m.el.querySelector('[data-crear]')?.addEventListener('click', async (e) => {
    const datos = Object.fromEntries(new FormData(form).entries());
    if (!datos.cliente?.trim()) {
      toast('Indica el cliente del trabajo', 'error');
      form.elements.cliente.focus();
      return;
    }
    e.currentTarget.disabled = true;
    try {
      const creado = await api('/trabajos', { method: 'POST', body: { ...datos, pendientes: pendientes.map((p) => p.texto) } });
      if (archivosPorSubir.length) await subirAdjuntosTrabajo(creado.id, archivosPorSubir);
      sugerencias = null;
      huboCambios = true;
      toast(`Trabajo ${numeroTrabajo(creado.numero)} creado`);
      m.close();
    } catch (err) {
      toast(err.message, 'error');
      e.currentTarget.disabled = false;
    }
  });

  // --- Eliminar trabajo ---
  m.el.querySelector('[data-borrar]')?.addEventListener('click', async () => {
    if (!(await confirmar(`¿Eliminar el trabajo ${numeroTrabajo(trabajo.numero)} y sus archivos? Esta acción no se puede deshacer.`))) return;
    try {
      await api(`/trabajos/${id}`, { method: 'DELETE' });
      huboCambios = true;
      toast('Trabajo eliminado');
      m.close();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // --- Adjuntos ---
  const agregar = async (archivos) => {
    if (!archivos.length) return;
    const max = state.config.maxArchivoMb * 1024 * 1024;
    const grandes = archivos.filter((f) => f.size > max);
    if (grandes.length) {
      toast(`"${grandes[0].name}" supera ${state.config.maxArchivoMb} MB`, 'error');
      return;
    }
    if (nuevo) {
      archivosPorSubir.push(...archivos);
      lista.innerHTML = archivosPorSubir
        .map((f) => `<div class="file"><span class="thumb" style="display:grid;place-items:center;aspect-ratio:4/3">${icon('file')}</span><div class="name">${esc(f.name)}</div></div>`)
        .join('');
      return;
    }
    zona.classList.add('over');
    zona.querySelector('strong').textContent = 'Subiendo…';
    try {
      trabajo.adjuntos = await subirAdjuntosTrabajo(id, archivos);
      lista.innerHTML = htmlAdjuntos(trabajo.adjuntos);
      huboCambios = true;
      toast(archivos.length === 1 ? 'Archivo adjuntado' : `${archivos.length} archivos adjuntados`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      zona.classList.remove('over');
      zona.querySelector('strong').textContent = 'Haz clic o arrastra archivos aquí';
    }
  };
  entrada.addEventListener('change', () => {
    agregar([...entrada.files]);
    entrada.value = '';
  });
  zona.addEventListener('dragover', (e) => {
    e.preventDefault();
    zona.classList.add('over');
  });
  zona.addEventListener('dragleave', () => zona.classList.remove('over'));
  zona.addEventListener('drop', (e) => {
    e.preventDefault();
    zona.classList.remove('over');
    agregar([...e.dataTransfer.files]);
  });
  lista.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-adj]');
    if (!b) return;
    e.preventDefault();
    if (!(await confirmar('¿Eliminar este archivo?'))) return;
    try {
      await api(`/adjuntos/${b.dataset.delAdj}`, { method: 'DELETE' });
      trabajo.adjuntos = trabajo.adjuntos.filter((a) => String(a.id) !== b.dataset.delAdj);
      lista.innerHTML = htmlAdjuntos(trabajo.adjuntos);
      huboCambios = true;
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
