// OpenCutList en la ficha del proyecto: importación (con vista previa y
// confirmación), materiales requeridos, despiece, diagramas de corte e historial.
import { api } from '../api.js';
import { icon } from '../icons.js';
import { esAdmin } from '../state.js';
import { esc, modal, toast, confirmar, fechaHora, tamanoArchivo, vacio } from '../ui.js';
import { subirArchivos } from './adjuntos.js';
import { analizarCsv, combinar, diferencias, ETIQUETAS_CAMPO, TIPOS_LISTA } from '../lib/opencutlist.js';

const cantidadTxt = (n) => new Intl.NumberFormat('es', { maximumFractionDigits: 2 }).format(Number(n) || 0);
const piezasTxt = (n) => `${cantidadTxt(n)} ${Number(n) === 1 ? 'pieza' : 'piezas'}`;
const extension = (nombre) => String(nombre).split('.').pop().toLowerCase();
const CAMPOS_POR_TIPO = {
  piezas: ['numero', 'nombre', 'cantidad', 'largo', 'ancho', 'espesor', 'material', 'tipo', 'observaciones'],
  instancias: ['nombre', 'largo', 'ancho', 'espesor', 'material', 'tipo', 'observaciones', 'ruta'],
  resumen: ['material', 'tipo', 'formato', 'comercial', 'area', 'longitud_total'],
  desconocido: ['nombre', 'cantidad', 'largo', 'ancho', 'espesor', 'material'],
};
const UNIDADES = ['Tablero', 'Lámina', 'Barra', 'Metro lineal', 'Rollo', 'm²', 'Unidad'];
const sinAcentos = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

let catalogo = null;
const cargarCatalogo = async () => (catalogo = await api('/materiales').catch(() => catalogo || []));

function comprar(m) {
  if (m.cantidad_comercial === null || m.cantidad_comercial === undefined) return '<span class="ocl-por-definir">Por definir</span>';
  return `<strong>${cantidadTxt(m.cantidad_comercial)}</strong> ${esc(m.unidad_compra || '')}${
    m.origen_cantidad === 'manual' ? ' <span class="ocl-origen" title="Indicada a mano según el diagrama de corte">manual</span>' : ''
  }`;
}

function htmlDiferencias(d) {
  if (!d || !d.total) return '<p class="muted nota">Sin cambios en piezas ni materiales respecto a la versión anterior.</p>';
  const bloque = (titulo, lista, clase) =>
    lista.length ? `<div class="ocl-dif ${clase}"><strong>${titulo} (${lista.length})</strong><ul>${lista.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
  return `<div class="ocl-difs">
    ${bloque('Piezas nuevas', d.piezas.agregadas, 'mas')}
    ${bloque('Piezas modificadas', d.piezas.modificadas, 'cambio')}
    ${bloque('Piezas eliminadas', d.piezas.eliminadas, 'menos')}
    ${bloque('Materiales nuevos', d.materiales.agregados, 'mas')}
    ${bloque('Materiales modificados', d.materiales.modificados, 'cambio')}
    ${bloque('Materiales eliminados', d.materiales.eliminados, 'menos')}
  </div>`;
}

function tablaMateriales(materiales, { editable = false } = {}) {
  if (!materiales.length) return '<p class="muted nota">Sin materiales.</p>';
  return `<div class="table-wrap"><table class="data responsive ocl-materiales">
    <thead><tr><th>Material</th><th>Tipo y espesor</th><th>Formato comercial</th><th class="right">A comprar</th><th>Observaciones</th>${editable ? '<th></th>' : ''}</tr></thead>
    <tbody>${materiales
      .map(
        (m) => `<tr class="sin-clic">
          <td data-label="Material"><strong>${esc(m.nombre)}</strong>${
            m.catalogo_nombre ? `<br><span class="ocl-catalogo" title="Vinculado al catálogo de materiales">${icon('materiales')}${esc(m.catalogo_nombre)}</span>` : ''
          }</td>
          <td data-label="Tipo y espesor">${esc([m.tipo, m.espesor].filter(Boolean).join(' · ') || '—')}</td>
          <td data-label="Formato">${esc(m.formato || '—')}</td>
          <td data-label="A comprar" class="right nowrap">${comprar(m)}</td>
          <td data-label="Observaciones">${esc([m.cantidad_piezas ? piezasTxt(m.cantidad_piezas) : '', m.total, m.observaciones].filter(Boolean).join(' · '))}</td>
          ${editable ? `<td class="col-acciones"><button class="icon-btn" type="button" data-editar-material="${m.id}" title="Corregir cantidad, unidad o vínculo" aria-label="Editar">${icon('edit')}</button></td>` : ''}
        </tr>`
      )
      .join('')}</tbody></table></div>`;
}

function tablaPiezas(piezas, filtro = '') {
  const q = sinAcentos(filtro);
  const visibles = q ? piezas.filter((p) => sinAcentos([p.numero, p.nombre, p.material, p.observaciones].join(' ')).includes(q)) : piezas;
  if (!visibles.length) return `<p class="muted nota">${piezas.length ? 'Ninguna pieza coincide con la búsqueda.' : 'Sin piezas.'}</p>`;
  const grupos = new Map();
  for (const p of visibles) {
    const k = p.material || 'Sin material';
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(p);
  }
  return [...grupos]
    .map(
      ([material, lista]) => `<div class="ocl-grupo"><h4>${esc(material)} <span class="muted">· ${piezasTxt(lista.reduce((s, p) => s + Number(p.cantidad || 0), 0))}</span></h4>
      <div class="table-wrap"><table class="data responsive">
        <thead><tr><th>N°</th><th>Pieza</th><th class="right">Cant.</th><th class="right">Largo</th><th class="right">Ancho</th><th class="right">Espesor</th><th>Observaciones técnicas</th></tr></thead>
        <tbody>${lista
          .map(
            (p) => `<tr class="sin-clic"><td data-label="N°">${esc(p.numero || '')}</td><td data-label="Pieza"><strong>${esc(p.nombre)}</strong></td>
              <td data-label="Cantidad" class="right num">${cantidadTxt(p.cantidad)}</td><td data-label="Largo" class="right nowrap">${esc(p.largo || '')}</td>
              <td data-label="Ancho" class="right nowrap">${esc(p.ancho || '')}</td><td data-label="Espesor" class="right nowrap">${esc(p.espesor || '')}</td>
              <td data-label="Observaciones">${esc(p.observaciones || '')}</td></tr>`
          )
          .join('')}</tbody></table></div></div>`
    )
    .join('');
}

function htmlArchivos(archivos) {
  const diagramas = archivos.filter((a) => a.tipo !== 'csv');
  const csv = archivos.filter((a) => a.tipo === 'csv');
  return `${
    diagramas.length
      ? `<div class="ocl-diagramas">${diagramas
          .map(
            (a) => `<div class="ocl-diagrama">
              ${
                a.tipo === 'pdf'
                  ? `<a class="ocl-vista pdf" href="/api/opencutlist/archivos/${a.id}" target="_blank" rel="noopener">${icon('file')}<span>PDF · abrir</span></a>`
                  : `<a class="ocl-vista" href="/api/opencutlist/archivos/${a.id}/vista" target="_blank" rel="noopener" title="Ver en grande"><img src="/api/opencutlist/archivos/${a.id}/vista" alt="${esc(a.nombre_original)}" loading="lazy"></a>`
              }
              <div class="ocl-diagrama-pie"><span title="${esc(a.nombre_original)}">${esc(a.nombre_original)}</span>
                <a class="icon-btn" href="/api/opencutlist/archivos/${a.id}?descargar" title="Descargar original" aria-label="Descargar">${icon('download')}</a></div>
            </div>`
          )
          .join('')}</div>`
      : '<p class="muted nota">No hay diagramas de corte. Puedes agregarlos (PDF, SVG o DXF exportados desde OpenCutList).</p>'
  }
  ${
    csv.length
      ? `<p class="ocl-originales">${icon('clip')} Listas originales: ${csv
          .map((a) => `<a href="/api/opencutlist/archivos/${a.id}?descargar">${esc(a.nombre_original)}</a> <span class="muted">(${tamanoArchivo(a.tamano)})</span>`)
          .join(', ')}</p>`
      : ''
  }`;
}

// ---------- Pestaña "Despieces" de la ficha ----------

export async function seccionOpenCutList(contenedor, trabajo) {
  let datos = null;
  let filtro = '';

  async function cargar() {
    datos = await api(`/opencutlist/trabajo/${trabajo.id}`);
    pintar();
  }

  function pintar() {
    const v = datos.vigente;
    if (!v) {
      contenedor.innerHTML = `<div class="ocl-vacio">
        ${vacio('Este proyecto todavía no tiene datos de OpenCutList', 'materiales')}
        <p class="muted nota">En SketchUp, abre OpenCutList y exporta la <strong>lista de piezas</strong> y el <strong>resumen</strong> en CSV, y si quieres los <strong>diagramas de corte</strong> (PDF, SVG o DXF). Luego impórtalos aquí.</p>
        <button class="btn btn-primary" type="button" data-importar>${icon('upload')}Importar OpenCutList</button>
      </div>`;
      return;
    }
    contenedor.innerHTML = `
      <div class="ocl-barra">
        <div><strong>Versión ${v.version}</strong> <span class="muted">· ${esc(fechaHora(v.creado_en))}${v.creado_por_nombre ? ` · ${esc(v.creado_por_nombre)}` : ''}</span>
          ${v.nota ? `<div class="muted nota">${esc(v.nota)}</div>` : ''}</div>
        <div class="ocl-acciones">
          <button class="btn btn-primary btn-sm" type="button" data-importar>${icon('upload')}Importar OpenCutList</button>
          <a class="btn btn-sm" href="/api/opencutlist/trabajo/${trabajo.id}/despiece.pdf" target="_blank" rel="noopener">${icon('file')}Imprimir despiece</a>
          ${datos.historial.length > 1 ? `<button class="btn btn-sm btn-ghost" type="button" data-historial>${icon('historial')}Historial (${datos.historial.length})</button>` : ''}
        </div>
      </div>
      ${v.version > 1 && v.diferencias ? `<details class="ocl-cambios" ${v.diferencias.total ? 'open' : ''}><summary>${icon('refrescar')} Cambios respecto a la versión ${v.version - 1}${v.diferencias.total ? ` (${v.diferencias.total})` : ''}</summary>${htmlDiferencias(v.diferencias)}</details>` : ''}
      <div class="section-title">${icon('materiales')} Materiales requeridos</div>
      <p class="muted nota" style="margin-top:-4px">Cantidades comerciales según OpenCutList (tableros, barras…), no la cantidad de piezas. Si el archivo no las trae quedan «por definir»: puedes indicarlas con el resultado del diagrama de corte.</p>
      ${tablaMateriales(v.materiales, { editable: true })}
      <div class="section-title">${icon('trabajos')} Despieces</div>
      ${v.piezas.length > 8 ? `<div class="search ocl-buscar">${icon('search')}<input type="search" data-filtro placeholder="Buscar pieza o material…" value="${esc(filtro)}"></div>` : ''}
      <div data-piezas>${tablaPiezas(v.piezas, filtro)}</div>
      <div class="section-title">${icon('clip')} Diagramas de corte <button class="btn btn-sm btn-ghost" type="button" data-agregar-diagramas>${icon('plus')}Agregar</button>
        <input type="file" data-archivo-diagrama multiple hidden accept=".pdf,.svg,.dxf"></div>
      ${htmlArchivos(v.archivos)}`;
  }

  contenedor.addEventListener('click', async (e) => {
    if (e.target.closest('[data-importar]')) return importarOpenCutList(trabajo, datos.vigente, { alGuardar: cargar });
    if (e.target.closest('[data-historial]')) return historial(trabajo, datos, { alCambiar: cargar });
    if (e.target.closest('[data-agregar-diagramas]')) return contenedor.querySelector('[data-archivo-diagrama]').click();
    const editar = e.target.closest('[data-editar-material]');
    if (editar) {
      const m = datos.vigente.materiales.find((x) => String(x.id) === editar.dataset.editarMaterial);
      return editarMaterial(m, { alGuardar: cargar });
    }
  });
  contenedor.addEventListener('input', (e) => {
    if (!e.target.matches('[data-filtro]')) return;
    filtro = e.target.value;
    contenedor.querySelector('[data-piezas]').innerHTML = tablaPiezas(datos.vigente.piezas, filtro);
  });
  contenedor.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-archivo-diagrama]')) return;
    const archivos = [...e.target.files];
    e.target.value = '';
    const malos = archivos.filter((f) => !['pdf', 'svg', 'dxf'].includes(extension(f.name)));
    if (malos.length) return toast(`"${malos[0].name}" no es un diagrama admitido (PDF, SVG o DXF)`, 'error');
    try {
      await subirArchivos({ ruta: `/opencutlist/importacion/${datos.vigente.id}/archivos`, carpeta: `opencutlist/${trabajo.id}/${datos.vigente.id}`, archivos });
      toast(archivos.length === 1 ? 'Diagrama agregado' : `${archivos.length} diagramas agregados`);
      cargar();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  contenedor.innerHTML = '<p class="muted">Cargando…</p>';
  await cargar();
}

// Corrección de un material de la versión vigente.
async function editarMaterial(m, { alGuardar }) {
  const cat = await cargarCatalogo();
  const md = modal({
    titulo: `${icon('materiales')} ${esc(m.nombre)}`,
    body: `<form class="form-grid" id="form-ocl-material">
      <label class="field"><span>Cantidad a comprar</span><input class="input" name="cantidad_comercial" type="number" min="0" step="0.01" value="${m.cantidad_comercial ?? ''}" placeholder="Por definir"></label>
      <label class="field"><span>Unidad de compra</span><input class="input" name="unidad_compra" list="dl-unidades-ocl" value="${esc(m.unidad_compra || '')}"></label>
      <datalist id="dl-unidades-ocl">${UNIDADES.map((u) => `<option value="${u}">`).join('')}</datalist>
      <label class="field"><span>Formato comercial</span><input class="input" name="formato" value="${esc(m.formato || '')}" placeholder="Ej. 2440 x 1830 mm"></label>
      <label class="field"><span>Material del catálogo</span><select class="input" name="material_id"><option value="">Sin vincular</option>
        ${cat.map((c) => `<option value="${c.id}" ${c.id === m.material_id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>
      <label class="field full"><span>Observaciones</span><textarea class="input" name="observaciones" rows="2">${esc(m.observaciones || '')}</textarea></label>
      <p class="muted nota full" style="margin:0">Usa la cantidad que da el diagrama de corte de OpenCutList (tableros usados), no la cantidad de piezas.</p>
    </form>`,
    foot: '<button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" type="submit" form="form-ocl-material">Guardar</button>',
  });
  md.el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      await api(`/opencutlist/materiales/${m.id}`, { method: 'PATCH', body: d });
      toast('Material actualizado');
      md.close();
      alGuardar?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// Historial de versiones: diferencias, archivos originales y despiece de cada una.
function historial(trabajo, datos, { alCambiar }) {
  const m = modal({
    wide: true,
    titulo: `${icon('historial')} Historial de OpenCutList`,
    body: `<div class="ocl-historial">${datos.historial
      .map(
        (h, i) => `<div class="ocl-version ${i === 0 ? 'vigente' : ''}">
          <div class="ocl-version-cab"><strong>Versión ${h.version}</strong>${i === 0 ? ' <span class="badge" style="--c:#16a34a">Vigente</span>' : ''}
            <span class="muted">· ${esc(fechaHora(h.creado_en))}${h.creado_por_nombre ? ` · ${esc(h.creado_por_nombre)}` : ''} · ${h.piezas} piezas · ${h.materiales} materiales</span>
            <span class="spacer"></span>
            <a class="btn btn-sm" href="/api/opencutlist/trabajo/${trabajo.id}/despiece.pdf?version=${h.id}" target="_blank" rel="noopener">${icon('file')}Despiece</a>
            ${esAdmin() ? `<button class="icon-btn btn-papelera" type="button" data-borrar-version="${h.id}" title="Eliminar versión" aria-label="Eliminar versión">${icon('trash')}</button>` : ''}</div>
          ${h.nota ? `<p class="muted nota">${esc(h.nota)}</p>` : ''}
          ${h.diferencias ? `<details><summary>Cambios respecto a la versión anterior${h.diferencias.total ? ` (${h.diferencias.total})` : ''}</summary>${htmlDiferencias(h.diferencias)}</details>` : ''}
          ${h.archivos.length ? `<p class="ocl-originales">${icon('clip')} ${h.archivos.map((a) => `<a href="/api/opencutlist/archivos/${a.id}?descargar">${esc(a.nombre_original)}</a>`).join(', ')}</p>` : ''}
        </div>`
      )
      .join('')}</div>`,
    foot: '<button class="btn btn-primary" data-close type="button">Cerrar</button>',
  });
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-borrar-version]');
    if (!b) return;
    if (!(await confirmar('¿Eliminar esta versión y sus archivos? Si es la vigente, la anterior vuelve a serlo.'))) return;
    try {
      await api(`/opencutlist/importacion/${b.dataset.borrarVersion}`, { method: 'DELETE' });
      toast('Versión eliminada');
      m.close();
      alCambiar?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------- Importar (vista previa y confirmación) ----------

export async function importarOpenCutList(trabajo, vigente, { alGuardar } = {}) {
  const cat = await cargarCatalogo();
  const csvs = []; // { nombre, contenido, mapeo, analisis }
  const diagramas = []; // File
  let combinado = { piezas: [], materiales: [] };
  let ajustes = []; // por posición de combinado.materiales

  const m = modal({
    wide: true,
    titulo: `${icon('upload')} Importar OpenCutList`,
    body: `<div class="ocl-importar">
      <label class="dropzone" data-zona>
        ${icon('upload')}
        <strong>Elige o arrastra los archivos exportados desde OpenCutList</strong>
        <div style="font-size:12.5px">CSV (lista de piezas, resumen o instancias) · PDF, SVG o DXF (diagramas de corte)</div>
        <input type="file" multiple hidden accept=".csv,.txt,.pdf,.svg,.dxf">
      </label>
      <div data-vista-previa></div>
    </div>`,
    foot: `<span class="muted left" data-resumen-import></span>
      <button class="btn" data-close type="button">Cancelar</button>
      <button class="btn btn-primary" type="button" data-confirmar disabled>${icon('check')}${vigente ? `Guardar versión ${vigente.version + 1}` : 'Guardar'}</button>`,
  });
  const zona = m.el.querySelector('[data-zona]');
  const entrada = zona.querySelector('input');
  const previa = m.el.querySelector('[data-vista-previa]');
  const botonConfirmar = m.el.querySelector('[data-confirmar]');

  function recalcular() {
    csvs.forEach((c) => (c.analisis = analizarCsv(c.contenido, c.mapeo)));
    combinado = csvs.length ? combinar(csvs.map((c) => c.analisis)) : { piezas: vigente?.piezas || [], materiales: vigente?.materiales || [] };
    // Ajustes por material: se conservan los que ya se escribieron; el catálogo se sugiere por nombre.
    ajustes = combinado.materiales.map((mat) => {
      const previo = ajustes.find((a) => a.nombre === mat.nombre);
      if (previo) return previo;
      const anterior = vigente?.materiales.find((x) => sinAcentos(x.nombre) === sinAcentos(mat.nombre));
      // Sin dato en el archivo: se propone la cantidad anterior sólo si las piezas de ese material no cambiaron.
      const mismasPiezas = anterior && Number(anterior.cantidad_piezas || 0) === Number(mat.cantidad_piezas || 0);
      const previa = anterior?.cantidad_comercial ?? null;
      return {
        nombre: mat.nombre,
        cantidad_comercial: mat.cantidad_comercial ?? (mismasPiezas && previa !== null ? previa : ''),
        antes: mat.cantidad_comercial === null && previa !== null && !mismasPiezas ? `Antes: ${cantidadTxt(previa)}` : '',
        unidad_compra: mat.unidad_compra || anterior?.unidad_compra || '',
        formato: mat.formato || anterior?.formato || '',
        material_id: anterior?.material_id ?? cat.find((c) => sinAcentos(c.nombre) === sinAcentos(mat.nombre))?.id ?? '',
      };
    });
    pintar();
  }

  function mapeoCsv(c, i) {
    const a = c.analisis;
    const campos = CAMPOS_POR_TIPO[a.tipo] || CAMPOS_POR_TIPO.desconocido;
    const opciones = (valor) =>
      `<option value="">—</option>${a.encabezados.map((h, k) => `<option value="${k}" ${valor === k ? 'selected' : ''}>${esc(h)}</option>`).join('')}`;
    return `<div class="ocl-csv">
      <div class="ocl-csv-cab">${icon('file')} <strong>${esc(c.nombre)}</strong>
        <select class="input" data-tipo-csv="${i}" aria-label="Tipo de lista">${Object.entries(TIPOS_LISTA)
          .filter(([k]) => k !== 'desconocido' || a.tipo === 'desconocido')
          .map(([k, v]) => `<option value="${k}" ${a.tipo === k ? 'selected' : ''}>${v}</option>`)
          .join('')}</select>
        <span class="muted">${a.filas} filas · ${a.tipo === 'resumen' ? `${a.materiales.length} materiales` : `${a.piezas.length} piezas`}</span>
        <button class="icon-btn btn-papelera" type="button" data-quitar-csv="${i}" title="Quitar archivo" aria-label="Quitar archivo">${icon('trash')}</button></div>
      ${a.avisos.map((x) => `<p class="aviso-cot">${icon('alert')} ${esc(x)}</p>`).join('')}
      <details ${a.tipo === 'desconocido' || a.avisos.length ? 'open' : ''}><summary>Columnas reconocidas (puedes corregirlas)</summary>
        <div class="ocl-mapeo">${campos
          .map((campo) => `<label class="field"><span>${ETIQUETAS_CAMPO[campo]}</span><select class="input" data-mapeo="${i}" data-campo="${campo}">${opciones(a.mapeo[campo])}</select></label>`)
          .join('')}</div></details>
    </div>`;
  }

  function pintar() {
    const hay = csvs.length || diagramas.length;
    botonConfirmar.disabled = !hay || (csvs.length > 0 && !combinado.piezas.length && !combinado.materiales.length);
    if (!hay) {
      previa.innerHTML = '';
      m.el.querySelector('[data-resumen-import]').textContent = '';
      return;
    }
    // Las diferencias se calculan con las cantidades y unidades tal como se van a guardar.
    const conAjustes = {
      piezas: combinado.piezas,
      materiales: combinado.materiales.map((mat, i) => ({
        ...mat,
        cantidad_comercial: ajustes[i]?.cantidad_comercial === '' || ajustes[i]?.cantidad_comercial === undefined ? null : Number(ajustes[i].cantidad_comercial),
        unidad_compra: ajustes[i]?.unidad_compra || mat.unidad_compra,
      })),
    };
    const dif = vigente && csvs.length ? diferencias(vigente, conAjustes) : null;
    m.el.querySelector('[data-resumen-import]').textContent = `${combinado.piezas.length} piezas · ${combinado.materiales.length} materiales · ${diagramas.length} diagramas`;
    previa.innerHTML = `
      ${csvs.map(mapeoCsv).join('')}
      ${!csvs.length && vigente ? `<p class="aviso-cot">${icon('alert')} Sólo diagramas: se conservan las piezas y materiales de la versión ${vigente.version}.</p>` : ''}
      ${
        diagramas.length
          ? `<div class="section-title">${icon('clip')} Diagramas de corte</div><ul class="ocl-lista-archivos">${diagramas
              .map((f, i) => `<li>${icon('file')} ${esc(f.name)} <span class="muted">${tamanoArchivo(f.size)}</span> <button class="icon-btn btn-papelera" type="button" data-quitar-diagrama="${i}" aria-label="Quitar">${icon('trash')}</button></li>`)
              .join('')}</ul>`
          : ''
      }
      ${dif ? `<div class="section-title">${icon('refrescar')} Diferencias con la versión ${vigente.version}</div>${htmlDiferencias(dif)}` : ''}
      ${vigente && csvs.length && !diagramas.length && vigente.archivos.some((a) => a.tipo !== 'csv') ? `<p class="aviso-cot">${icon('alert')} Los diagramas de corte de la versión ${vigente.version} quedan en el historial. Si el diseño cambió, agrega aquí los nuevos.</p>` : ''}
      ${
        csvs.length && combinado.materiales.length
          ? `<div class="section-title">${icon('materiales')} Materiales requeridos</div>
            <p class="muted nota" style="margin-top:-4px">Revisa la cantidad comercial a comprar. Si el archivo no la trae, déjala en blanco («por definir») o escribe la del diagrama de corte de OpenCutList.</p>
            <div class="table-wrap"><table class="data ocl-ajustes"><thead><tr><th>Material</th><th>Piezas</th><th>A comprar</th><th>Unidad</th><th>Formato</th><th>Catálogo de Spacio</th></tr></thead>
            <tbody>${combinado.materiales
              .map((mat, i) => {
                const a = ajustes[i];
                return `<tr class="sin-clic"><td><strong>${esc(mat.nombre)}</strong><br><span class="muted">${esc([mat.tipo, mat.espesor].filter(Boolean).join(' · '))}</span></td>
                  <td class="num">${mat.cantidad_piezas ? cantidadTxt(mat.cantidad_piezas) : '—'}${a.antes ? `<br><span class="ocl-por-definir">cambió</span>` : ''}</td>
                  <td><input class="input" type="number" min="0" step="0.01" data-ajuste="${i}" data-campo="cantidad_comercial" value="${esc(a.cantidad_comercial)}" placeholder="${esc(a.antes || 'Por definir')}" title="${esc(a.antes ? `${a.antes} ${a.unidad_compra} (cambiaron las piezas: revisa el nuevo diagrama de corte)` : '')}"></td>
                  <td><input class="input" list="dl-unidades-import" data-ajuste="${i}" data-campo="unidad_compra" value="${esc(a.unidad_compra)}"></td>
                  <td><input class="input" data-ajuste="${i}" data-campo="formato" value="${esc(a.formato)}" placeholder="Ej. 2440 x 1830"></td>
                  <td><select class="input" data-ajuste="${i}" data-campo="material_id"><option value="">Sin vincular</option>${cat
                    .map((c) => `<option value="${c.id}" ${String(c.id) === String(a.material_id) ? 'selected' : ''}>${esc(c.nombre)}</option>`)
                    .join('')}</select></td></tr>`;
              })
              .join('')}</tbody></table></div>
            <datalist id="dl-unidades-import">${UNIDADES.map((u) => `<option value="${u}">`).join('')}</datalist>`
          : ''
      }
      ${
        csvs.length && combinado.piezas.length
          ? `<div class="section-title">${icon('trabajos')} Despiece (${combinado.piezas.length} piezas)</div>
            <div class="ocl-previa-piezas">${tablaPiezas(combinado.piezas.slice(0, 60))}</div>
            ${combinado.piezas.length > 60 ? `<p class="muted nota">… y ${combinado.piezas.length - 60} piezas más.</p>` : ''}`
          : ''
      }
      <label class="field" style="margin-top:12px"><span>Nota de esta versión (opcional)</span><input class="input" data-nota placeholder="Ej. Se cambió el ancho de la isla"></label>`;
  }

  async function agregar(archivos) {
    for (const f of archivos) {
      const ext = extension(f.name);
      if (ext === 'csv' || ext === 'txt') {
        const contenido = await f.text();
        if (contenido.length > 3.5 * 1024 * 1024) {
          toast(`"${f.name}" es demasiado grande`, 'error');
          continue;
        }
        csvs.push({ nombre: f.name, contenido, mapeo: null });
      } else if (['pdf', 'svg', 'dxf'].includes(ext)) diagramas.push(f);
      else toast(`"${f.name}" no es un archivo de OpenCutList admitido`, 'error');
    }
    recalcular();
  }

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
  previa.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-tipo-csv]')) {
      const c = csvs[Number(t.dataset.tipoCsv)];
      c.mapeo = { ...c.analisis.mapeo, lista: t.value };
      recalcular();
    } else if (t.matches('[data-mapeo]')) {
      const c = csvs[Number(t.dataset.mapeo)];
      c.mapeo = { ...c.analisis.mapeo, ...(c.mapeo?.lista ? { lista: c.mapeo.lista } : {}), [t.dataset.campo]: t.value === '' ? null : Number(t.value) };
      recalcular();
    } else if (t.matches('[data-ajuste]')) ajustes[Number(t.dataset.ajuste)][t.dataset.campo] = t.value;
  });
  previa.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('[data-ajuste]') && t.tagName === 'INPUT') ajustes[Number(t.dataset.ajuste)][t.dataset.campo] = t.value;
  });
  previa.addEventListener('click', (e) => {
    const q = e.target.closest('[data-quitar-csv]');
    if (q) {
      csvs.splice(Number(q.dataset.quitarCsv), 1);
      return recalcular();
    }
    const d = e.target.closest('[data-quitar-diagrama]');
    if (d) {
      diagramas.splice(Number(d.dataset.quitarDiagrama), 1);
      pintar();
    }
  });

  botonConfirmar.addEventListener('click', async () => {
    botonConfirmar.disabled = true;
    botonConfirmar.textContent = 'Guardando…';
    try {
      const r = await api(`/opencutlist/trabajo/${trabajo.id}`, {
        method: 'POST',
        body: {
          nota: m.el.querySelector('[data-nota]')?.value || '',
          csv: csvs.map((c) => ({ nombre: c.nombre, contenido: c.contenido, mapeo: c.mapeo })),
          ajustes: csvs.length ? ajustes : [],
          diagramas: diagramas.length,
        },
      });
      if (diagramas.length) {
        await subirArchivos({ ruta: `/opencutlist/importacion/${r.id}/archivos`, carpeta: `opencutlist/${trabajo.id}/${r.id}`, archivos: diagramas });
      }
      toast(vigente ? `Versión ${vigente.version + 1} guardada` : 'Datos de OpenCutList importados');
      m.close();
      alGuardar?.();
    } catch (err) {
      toast(err.message, 'error');
      botonConfirmar.disabled = false;
      botonConfirmar.innerHTML = `${icon('check')}Guardar`;
    }
  });
}
