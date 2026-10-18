// Orden de producción: se abre desde la ficha de un proyecto aprobado.
// Permite completar los datos técnicos que falten (se guardan en el mismo
// proyecto, sin duplicarlos) y generar el PDF para el taller.
import { api } from '../api.js';
import { icon } from '../icons.js';
import { esc, modal, toast, debounce } from '../ui.js';

const ETIQUETAS_FALTANTES = {
  descripcion: 'descripción del trabajo',
  fecha_inicio: 'fecha de inicio',
  fecha_entrega: 'fecha de entrega',
  especificaciones_tecnicas: 'medidas y especificaciones técnicas',
};

// alGuardar(trabajo): avisa a la ficha los campos actualizados.
export async function abrirOrdenProduccion(trabajoId, { alGuardar } = {}) {
  const datos = await api(`/trabajos/${trabajoId}/orden-produccion`);
  const t = datos.trabajo;
  let guardando = Promise.resolve();

  const campoTexto = (name, label, valor, placeholder, filas = 3) =>
    `<label class="field full ${datos.faltantes.includes(name) ? 'falta' : ''}"><span>${label}</span>
      <textarea class="input" name="${name}" rows="${filas}" placeholder="${esc(placeholder)}">${esc(valor || '')}</textarea></label>`;
  const campoFecha = (name, label, valor) =>
    `<label class="field ${datos.faltantes.includes(name) ? 'falta' : ''}"><span>${label}</span><input class="input" type="date" name="${name}" value="${esc(valor || '')}"></label>`;

  const m = modal({
    wide: true,
    titulo: `${icon('file')} Orden de producción · <span class="num">${esc(t.codigo)}</span>`,
    body: `<div class="orden">
      <p class="muted nota" style="margin-top:0">Se genera con la información del proyecto. <strong>No incluye precios, costos ni pagos.</strong></p>
      <div class="orden-aviso" data-aviso></div>
      <form class="form-grid" data-form>
        ${campoTexto('descripcion', 'Descripción del trabajo', t.descripcion, 'Qué se va a fabricar', 2)}
        ${campoFecha('fecha_inicio', 'Fecha de inicio', t.fecha_inicio)}
        ${campoFecha('fecha_entrega', 'Fecha de entrega', t.fecha_entrega)}
        ${campoTexto('especificaciones_tecnicas', 'Medidas y especificaciones técnicas', t.especificaciones_tecnicas, 'Ej. Suite: 3,60 m ancho x 2,40 m alto x 0,60 m fondo. Fórmica gris oscuro, cantos en PVC…', 4)}
        ${campoTexto('observaciones_fabricacion', 'Observaciones de fabricación', t.observaciones_fabricacion, 'Ej. Entregar armado por módulos. Revisar medidas en sitio antes de cortar.', 2)}
      </form>
      <div class="section-title">${icon('materiales')} Piezas, cantidades y materiales</div>
      ${
        datos.piezas.length
          ? `<p class="muted nota">Tomados de la cotización aprobada <strong>${esc(datos.cotizacion)}</strong> (sin montos).</p>
             <ul class="orden-piezas">${datos.piezas
               .map((p) => `<li><strong>${esc(p.nombre)}</strong> · Cantidad: ${esc(p.cantidad)}<small>${p.materiales.length} ${p.materiales.length === 1 ? 'material' : 'materiales'}</small></li>`)
               .join('')}</ul>`
          : '<p class="muted nota">Este proyecto no tiene una cotización aprobada: indica las piezas y cantidades en las especificaciones técnicas.</p>'
      }
      <div class="section-title">${icon('materiales')} Despiece de OpenCutList</div>
      ${
        datos.despiece
          ? `<div class="orden-opciones">
              <label class="check"><input type="checkbox" data-incluir="despiece" checked> Lista de piezas con medidas, cantidades y materiales requeridos <span class="muted">(versión ${datos.despiece.version} · ${datos.despiece.piezas} piezas · ${datos.despiece.materiales} materiales)</span></label>
              <label class="check"><input type="checkbox" data-incluir="diagramas" ${datos.despiece.diagramas ? 'checked' : 'disabled'}> Diagramas de corte <span class="muted">(${datos.despiece.diagramas || 'no hay'})</span></label>
            </div>`
          : '<p class="muted nota">Este proyecto no tiene datos de OpenCutList. Puedes importarlos en la pestaña «Despieces» de la ficha.</p>'
      }
      <div class="section-title">${icon('clip')} Renders, planos y fotografías</div>
      ${
        datos.imagenes.length
          ? `<div class="orden-imagenes">${datos.imagenes
              .map(
                (i) => `<label class="orden-img ${i.compatible ? '' : 'no-compatible'}" title="${esc(i.nombre)}">
                  <input type="checkbox" value="${i.id}" ${i.compatible ? 'checked' : 'disabled'}>
                  <img src="/api/adjuntos/${i.id}" alt="" loading="lazy">
                  <span>${i.compatible ? esc(i.nombre) : 'Formato no compatible (usa JPG o PNG)'}</span></label>`
              )
              .join('')}</div>`
          : '<p class="muted nota">No hay imágenes adjuntas. Puedes subirlas en la ficha del proyecto (Archivos y fotografías).</p>'
      }
    </div>`,
    foot: `<span class="save-state saved left" data-guardado>${icon('check')}Los datos se guardan en el proyecto</span>
      <button class="btn" type="button" data-compartir>${icon('whatsapp')}Compartir por WhatsApp</button>
      <button class="btn" type="button" data-descargar>${icon('download')}Descargar PDF</button>
      <button class="btn btn-primary" type="button" data-ver>${icon('file')}Ver e imprimir</button>`,
    onClose: async () => {
      await guardando;
    },
  });

  const form = m.el.querySelector('[data-form]');
  const estado = m.el.querySelector('[data-guardado]');
  const pintarEstado = (clase, texto) => {
    estado.className = `save-state ${clase} left`;
    estado.innerHTML = `${clase === 'saved' ? icon('check') : ''}${esc(texto)}`;
  };
  const pintarAviso = () => {
    const faltan = Object.keys(ETIQUETAS_FALTANTES).filter((k) => {
      if (k === 'especificaciones_tecnicas') return !t[k] && !datos.piezas.some((p) => p.descripcion);
      return !t[k];
    });
    m.el.querySelector('[data-aviso]').innerHTML = faltan.length
      ? `<p class="aviso-cot">${icon('alert')} Falta: ${faltan.map((k) => ETIQUETAS_FALTANTES[k]).join(', ')}. Puedes completarlo aquí o generar la orden igualmente.</p>`
      : '';
    form.querySelectorAll('.field').forEach((f) => {
      const n = f.querySelector('[name]').name;
      f.classList.toggle('falta', faltan.includes(n));
    });
  };
  pintarAviso();

  const guardar = (nombre) => {
    const valor = form.elements[nombre].value;
    if ((t[nombre] ?? '') === valor) return;
    t[nombre] = valor;
    pintarEstado('saving', 'Guardando…');
    guardando = guardando
      .then(() => api(`/trabajos/${trabajoId}`, { method: 'PATCH', body: { [nombre]: valor } }))
      .then((actualizado) => {
        pintarEstado('saved', 'Guardado en el proyecto');
        pintarAviso();
        alGuardar?.(actualizado);
      })
      .catch((err) => {
        pintarEstado('error', `No se pudo guardar: ${err.message}`);
        toast(err.message, 'error');
      });
  };
  const porCampo = {};
  form.addEventListener('input', (e) => {
    const n = e.target.name;
    if (!n || e.target.type === 'date') return;
    porCampo[n] ??= debounce(() => guardar(n), 800);
    porCampo[n]();
  });
  form.addEventListener('change', (e) => e.target.name && guardar(e.target.name));

  // --- Generar ---
  const urlPdf = (descargar) => {
    const ids = [...m.el.querySelectorAll('.orden-img input:checked')].map((c) => c.value).join(',');
    const p = new URLSearchParams({ imagenes: ids });
    for (const c of m.el.querySelectorAll('[data-incluir]:checked')) p.set(c.dataset.incluir, '1');
    if (descargar) p.set('descargar', '1');
    return `/api/trabajos/${trabajoId}/orden-produccion.pdf?${p}`;
  };
  const antesDeGenerar = async () => {
    form.querySelectorAll('[name]').forEach((el) => guardar(el.name));
    await guardando;
  };
  m.el.querySelector('[data-ver]').addEventListener('click', async () => {
    const ventana = window.open('', '_blank'); // se abre antes de esperar para que no la bloquee el navegador
    await antesDeGenerar();
    if (ventana) ventana.location.href = urlPdf(false);
    else window.location.href = urlPdf(false);
  });
  m.el.querySelector('[data-descargar]').addEventListener('click', async () => {
    await antesDeGenerar();
    window.location.href = urlPdf(true);
  });
  m.el.querySelector('[data-compartir]').addEventListener('click', async (e) => {
    const boton = e.currentTarget;
    boton.disabled = true;
    try {
      await antesDeGenerar();
      const r = await fetch(urlPdf(false), { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'No se pudo generar el PDF');
      const nombre = `orden-produccion-${t.codigo}.pdf`;
      const archivo = new File([await r.blob()], nombre, { type: 'application/pdf' });
      const texto = `Orden de producción ${t.codigo} · ${t.cliente}${t.tienda ? ` · ${t.tienda}` : ''}`;
      if (navigator.canShare?.({ files: [archivo] })) {
        // En el teléfono abre el menú del dispositivo para elegir WhatsApp.
        await navigator.share({ files: [archivo], title: texto, text: texto });
      } else {
        // En la computadora: se descarga el PDF y se abre WhatsApp para adjuntarlo.
        const enlace = document.createElement('a');
        enlace.href = URL.createObjectURL(archivo);
        enlace.download = nombre;
        enlace.click();
        setTimeout(() => URL.revokeObjectURL(enlace.href), 10000);
        window.open(`https://wa.me/?text=${encodeURIComponent(`${texto} (adjunto el PDF)`)}`, '_blank', 'noopener');
        toast('PDF descargado: adjúntalo en el chat de WhatsApp');
      }
    } catch (err) {
      if (err.name !== 'AbortError') toast(err.message, 'error');
    } finally {
      boton.disabled = false;
    }
  });
}
