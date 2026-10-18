// Calendario reutilizable (mes, semana y lista de próximos compromisos).
// No guarda fechas propias: recibe eventos ya calculados a partir de los
// registros existentes (trabajos, tareas…) mediante cargarEventos(desde, hasta).
//
// Evento: { fecha: 'AAAA-MM-DD', titulo, detalle, tipo, etiqueta, vencido, proximo, abrir() }
import { icon } from '../icons.js';
import { esc, hoyIso, vacio } from '../ui.js';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const DIAS_LARGOS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const aFecha = (iso) => new Date(`${iso}T12:00:00`);
const aIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const sumarDias = (iso, n) => {
  const d = aFecha(iso);
  d.setDate(d.getDate() + n);
  return aIso(d);
};
const lunesDe = (iso) => {
  const d = aFecha(iso);
  return sumarDias(iso, -((d.getDay() + 6) % 7));
};
const mayuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);
export const fechaLarga = (iso) => {
  const d = aFecha(iso);
  return `${DIAS_LARGOS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
};

// opciones:
//  cargarEventos(desde, hasta) → Promise<eventos>  (en "lista" también se piden los atrasados)
//  leyenda: [{ tipo, label }]
//  vista: 'mes' | 'semana' | 'lista'
//  diasLista: días hacia adelante en la vista de lista
//  alCambiarVista(vista)
export function montarCalendario(contenedor, opciones) {
  const { cargarEventos, leyenda = [], diasLista = 30, alCambiarVista } = opciones;
  let vista = opciones.vista || (window.innerWidth < 700 ? 'lista' : 'mes');
  let ancla = hoyIso();
  let eventos = [];

  contenedor.innerHTML = `<div class="cal">
    <div class="cal-barra">
      <div class="cal-nav">
        <button class="btn btn-sm" type="button" data-nav="-1" aria-label="Anterior">‹</button>
        <button class="btn btn-sm" type="button" data-nav="0">Hoy</button>
        <button class="btn btn-sm" type="button" data-nav="1" aria-label="Siguiente">›</button>
        <h3 class="cal-titulo"></h3>
      </div>
      <div class="tabs cal-vistas" role="tablist">
        <button type="button" data-vista="mes">Mes</button>
        <button type="button" data-vista="semana">Semana</button>
        <button type="button" data-vista="lista">Próximos</button>
      </div>
    </div>
    ${leyenda.length ? `<div class="cal-leyenda">${leyenda.map((l) => `<span class="ev-${l.tipo}"><i></i>${esc(l.label)}</span>`).join('')}</div>` : ''}
    <div class="cal-cuerpo"></div>
  </div>`;
  const cuerpo = contenedor.querySelector('.cal-cuerpo');
  const tituloEl = contenedor.querySelector('.cal-titulo');

  const rango = () => {
    if (vista === 'mes') {
      const d = aFecha(ancla);
      const primero = aIso(new Date(d.getFullYear(), d.getMonth(), 1, 12));
      const desde = lunesDe(primero);
      return { desde, hasta: sumarDias(desde, 41) };
    }
    if (vista === 'semana') {
      const desde = lunesDe(ancla);
      return { desde, hasta: sumarDias(desde, 6) };
    }
    return { desde: ancla, hasta: sumarDias(ancla, diasLista) };
  };

  const chip = (e, i) =>
    `<button type="button" class="ev ev-${e.tipo} ${e.vencido ? 'vencido' : ''} ${e.proximo ? 'proximo' : ''}" data-ev="${i}" title="${esc(`${e.etiqueta || ''}: ${e.titulo}${e.detalle ? ` · ${e.detalle}` : ''}`)}">
      <span class="ev-titulo">${e.vencido ? icon('alert') : ''}${esc(e.titulo)}</span>
      ${e.detalle || e.etiqueta ? `<span class="ev-detalle">${esc([e.etiqueta, e.detalle].filter(Boolean).join(' · '))}</span>` : ''}
    </button>`;

  const porFecha = (lista) => {
    const mapa = {};
    lista.forEach((e) => (mapa[e.fecha] ??= []).push(e));
    return mapa;
  };

  function pintar() {
    contenedor.querySelectorAll('[data-vista]').forEach((b) => b.classList.toggle('activo', b.dataset.vista === vista));
    const { desde, hasta } = rango();
    const hoy = hoyIso();
    const indice = new Map(eventos.map((e, i) => [e, i]));
    const mapa = porFecha(eventos.filter((e) => e.fecha >= desde && e.fecha <= hasta));

    if (vista === 'mes') {
      const d = aFecha(ancla);
      tituloEl.textContent = `${mayuscula(MESES[d.getMonth()])} ${d.getFullYear()}`;
      let celdas = '';
      for (let i = 0; i < 42; i++) {
        const f = sumarDias(desde, i);
        const lista = mapa[f] || [];
        const fuera = aFecha(f).getMonth() !== d.getMonth();
        celdas += `<div class="cal-dia ${fuera ? 'fuera' : ''} ${f === hoy ? 'hoy' : ''}" data-dia="${f}">
          <button type="button" class="cal-num" data-ir-dia="${f}">${aFecha(f).getDate()}</button>
          ${lista.slice(0, 3).map((e) => chip(e, indice.get(e))).join('')}
          ${lista.length > 3 ? `<button type="button" class="cal-mas" data-ir-dia="${f}">+${lista.length - 3} más</button>` : ''}
        </div>`;
      }
      cuerpo.innerHTML = `<div class="cal-mes"><div class="cal-cab">${DIAS.map((x) => `<span>${x}</span>`).join('')}</div><div class="cal-grilla">${celdas}</div></div>`;
      return;
    }

    if (vista === 'semana') {
      const a = aFecha(desde);
      const b = aFecha(hasta);
      tituloEl.textContent = `${a.getDate()} ${a.getMonth() !== b.getMonth() ? MESES[a.getMonth()].slice(0, 3) : ''} – ${b.getDate()} ${MESES[b.getMonth()]} ${b.getFullYear()}`;
      let columnas = '';
      for (let i = 0; i < 7; i++) {
        const f = sumarDias(desde, i);
        const lista = mapa[f] || [];
        columnas += `<div class="cal-col ${f === hoy ? 'hoy' : ''}">
          <div class="cal-col-cab"><span>${DIAS[i]}</span><strong>${aFecha(f).getDate()}</strong></div>
          ${lista.map((e) => chip(e, indice.get(e))).join('') || '<span class="cal-libre">—</span>'}
        </div>`;
      }
      cuerpo.innerHTML = `<div class="cal-semana">${columnas}</div>`;
      return;
    }

    // Lista: atrasados (sin importar la fecha) y luego los próximos días.
    tituloEl.textContent = desde === hoy ? `Próximos ${diasLista} días` : `Desde el ${fechaLarga(desde)}`;
    const atrasados = desde === hoy ? eventos.filter((e) => e.vencido && e.fecha < desde) : [];
    const grupos = Object.keys(mapa).sort();
    let html = '';
    if (atrasados.length) {
      html += `<div class="cal-grupo atrasado"><h4>${icon('alert')} Atrasados (${atrasados.length})</h4>${atrasados
        .sort((x, y) => x.fecha.localeCompare(y.fecha))
        .map((e) => chip({ ...e, detalle: [e.detalle, `era el ${fechaLarga(e.fecha)}`].filter(Boolean).join(' · ') }, indice.get(e)))
        .join('')}</div>`;
    }
    for (const f of grupos) {
      html += `<div class="cal-grupo ${f === hoy ? 'hoy' : ''}"><h4>${f === hoy ? `Hoy · ${fechaLarga(f)}` : f === sumarDias(hoy, 1) ? `Mañana · ${fechaLarga(f)}` : mayuscula(fechaLarga(f))}</h4>
        ${mapa[f].map((e) => chip(e, indice.get(e))).join('')}</div>`;
    }
    cuerpo.innerHTML = html || vacio('No hay compromisos en estas fechas', 'calendario');
  }

  async function cargar() {
    const { desde, hasta } = rango();
    cuerpo.classList.add('cargando');
    try {
      eventos = await cargarEventos(vista === 'lista' && desde === hoyIso() ? null : desde, hasta);
      // En la lista también se muestran los atrasados (desde = null significa "sin límite inferior").
    } finally {
      cuerpo.classList.remove('cargando');
    }
    pintar();
  }

  contenedor.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const paso = Number(nav.dataset.nav);
      if (!paso) ancla = hoyIso();
      else if (vista === 'mes') {
        const d = aFecha(ancla);
        ancla = aIso(new Date(d.getFullYear(), d.getMonth() + paso, 1, 12));
      } else ancla = sumarDias(ancla, paso * (vista === 'semana' ? 7 : diasLista));
      return cargar();
    }
    const v = e.target.closest('[data-vista]');
    if (v) {
      vista = v.dataset.vista;
      if (vista === 'lista') ancla = hoyIso();
      alCambiarVista?.(vista);
      return cargar();
    }
    const dia = e.target.closest('[data-ir-dia]');
    if (dia) {
      vista = 'semana';
      ancla = dia.dataset.irDia;
      alCambiarVista?.(vista);
      return cargar();
    }
    const ev = e.target.closest('[data-ev]');
    if (ev) eventos[Number(ev.dataset.ev)]?.abrir?.();
  });

  cargar();
  return { recargar: cargar };
}
