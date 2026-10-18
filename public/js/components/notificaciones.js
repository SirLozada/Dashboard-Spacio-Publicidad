// Campanita de notificaciones (esquina superior derecha, visible en todos los módulos).
// Se actualiza cada 20 s mientras la página está visible y al volver a ella:
// en Vercel no hay conexiones permanentes, así que es la forma viable de "tiempo real".
import { api } from '../api.js';
import { icon } from '../icons.js';
import { esc, toast } from '../ui.js';
import { detalleSolicitud, tiempoRelativo } from './solicitudes-comun.js';
import { abrirTarea } from './mi-dia-comun.js';
import { abrirFicha } from './trabajos-comun.js';

const INTERVALO_MS = 20000;
const ICONOS = {
  nueva: 'mensaje', asignada: 'user', comentario: 'mensaje', mencion: 'arroba', estado: 'refrescar', aprobacion: 'alert', aprobada: 'check', rechazada: 'x',
  tarea_asignada: 'check', tarea_reasignada: 'user', tarea_etiqueta: 'arroba', recordatorio: 'clock', vencido: 'alert',
};

let temporizador = null;
let ultimaVista = 0;
let boton;
let panel;
let contador;

async function consultar({ avisar = true } = {}) {
  if (document.hidden) return;
  try {
    const r = await api('/notificaciones/conteo');
    contador.hidden = !r.no_leidas;
    contador.textContent = r.no_leidas > 99 ? '99+' : r.no_leidas;
    boton.classList.toggle('con-avisos', r.no_leidas > 0);
    if (avisar && r.ultima > ultimaVista && ultimaVista) {
      const { items } = await api('/notificaciones?limite=1');
      if (items[0]) toast(`🔔 ${items[0].titulo}`);
      if (!panel.hidden) await pintarPanel();
    }
    ultimaVista = Math.max(ultimaVista, r.ultima);
  } catch {
    /* sin conexión o sesión expirada: se reintenta en el próximo ciclo */
  }
}

async function pintarPanel() {
  panel.innerHTML = '<div class="campana-vacio">Cargando…</div>';
  const { items, no_leidas } = await api('/notificaciones?limite=25');
  panel.innerHTML = `
    <div class="campana-cab"><strong>Notificaciones</strong>${no_leidas ? `<button type="button" class="link" data-todas>Marcar todas como leídas</button>` : ''}</div>
    <div class="campana-lista">${
      items.length
        ? items
            .map(
              (n) => `<button type="button" class="notif ${n.leida ? '' : 'no-leida'}" data-notif="${n.id}" data-solicitud="${n.solicitud_id || ''}" data-tarea="${n.tarea_id || ''}" data-trabajo="${n.trabajo_id || ''}">
                <span class="notif-icono tipo-${n.tipo}">${icon(ICONOS[n.tipo] || 'campana')}</span>
                <span class="notif-texto"><strong>${esc(n.titulo)}</strong>
                  ${n.mensaje ? `<span>${esc(n.mensaje)}</span>` : ''}
                  <small>${esc(n.actor_nombre || '')}${n.actor_nombre ? ' · ' : ''}${tiempoRelativo(n.creada_en)}</small></span>
                ${n.leida ? '' : `<span class="notif-marcar" data-leer="${n.id}" title="Marcar como leída" role="button" tabindex="0"></span>`}
              </button>`
            )
            .join('')
        : `<div class="campana-vacio">${icon('campana')}<div>No tienes notificaciones</div></div>`
    }</div>`;
}

function cerrarPanel() {
  panel.hidden = true;
  boton.setAttribute('aria-expanded', 'false');
}

export function iniciarCampana() {
  boton = document.getElementById('btn-campana');
  panel = document.getElementById('campana-panel');
  boton.innerHTML = `${icon('campana')}<span class="campana-contador" hidden></span>`;
  contador = boton.querySelector('.campana-contador');
  if (!boton.dataset.listo) {
    boton.dataset.listo = '1';
    boton.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!panel.hidden) return cerrarPanel();
      panel.hidden = false;
      boton.setAttribute('aria-expanded', 'true');
      await pintarPanel();
    });
    panel.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (e.target.closest('[data-todas]')) {
        await api('/notificaciones/leidas', { method: 'POST' });
        await Promise.all([pintarPanel(), consultar({ avisar: false })]);
        return;
      }
      const leer = e.target.closest('[data-leer]');
      if (leer) {
        await api(`/notificaciones/${leer.dataset.leer}/leida`, { method: 'POST' });
        await Promise.all([pintarPanel(), consultar({ avisar: false })]);
        return;
      }
      const n = e.target.closest('[data-notif]');
      if (!n) return;
      await api(`/notificaciones/${n.dataset.notif}/leida`, { method: 'POST' }).catch(() => {});
      cerrarPanel();
      consultar({ avisar: false });
      if (n.dataset.solicitud) detalleSolicitud(Number(n.dataset.solicitud), { alCambiar: () => consultar({ avisar: false }) });
      else if (n.dataset.tarea) abrirTarea(Number(n.dataset.tarea));
      else if (n.dataset.trabajo) abrirFicha(Number(n.dataset.trabajo)).catch((err) => toast(err.message, 'error'));
    });
    document.addEventListener('click', (e) => {
      if (!panel.hidden && !panel.contains(e.target)) cerrarPanel();
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && !panel.hidden && cerrarPanel());
    document.addEventListener('visibilitychange', () => !document.hidden && consultar());
    window.addEventListener('focus', () => consultar());
  }
  detenerCampana();
  ultimaVista = 0;
  consultar({ avisar: false });
  temporizador = setInterval(consultar, INTERVALO_MS);
}

export function detenerCampana() {
  clearInterval(temporizador);
  temporizador = null;
  if (panel) cerrarPanel();
}

// Para refrescar el contador tras acciones propias (p. ej. abrir una solicitud).
export const refrescarCampana = () => boton && consultar({ avisar: false });
