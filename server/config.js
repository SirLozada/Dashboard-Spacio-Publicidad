// Configuración central del sistema. Todo lo que el frontend necesita conocer
// (estatus, prefijos, moneda...) se define aquí y se expone en /api/config,
// de modo que exista una sola fuente de verdad.
const path = require('path');

const ESTATUS = [
  { key: 'por_cotizar', label: 'Por cotizar', tarjeta: 'Por cotizar', color: '#64748b', dashboard: true },
  { key: 'render', label: 'Render', tarjeta: 'Render', color: '#8b5cf6', dashboard: true },
  { key: 'pendiente_aprobacion', label: 'Pendiente por aprobación', tarjeta: 'Pendiente por aprobación', color: '#f59e0b', dashboard: true },
  { key: 'aprobado', label: 'Aprobado', tarjeta: 'Aprobado', color: '#0ea5e9', dashboard: true },
  { key: 'produccion', label: 'Producción', tarjeta: 'En producción', color: '#2563eb', dashboard: true },
  { key: 'reclamo', label: 'Reclamo', tarjeta: 'Reclamos', color: '#e11d48', dashboard: true },
  { key: 'finalizado', label: 'Finalizado', tarjeta: 'Finalizado', color: '#16a34a', dashboard: true },
  { key: 'rechazado', label: 'Rechazado', tarjeta: 'Rechazado', color: '#78716c', dashboard: false },
];

// Estatus que se consideran "cerrados": no cuentan como activos ni como atrasados.
const ESTATUS_CERRADOS = ['finalizado', 'rechazado'];

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  NODE_ENV: process.env.NODE_ENV || 'development',
  ESTATUS,
  ESTATUS_KEYS: ESTATUS.map((e) => e.key),
  ESTATUS_CERRADOS,
  PREFIJO_TRABAJO: process.env.PREFIJO_TRABAJO || 'SP-',
  MONEDA: process.env.MONEDA || 'USD',
  DIAS_ALERTA: Number(process.env.DIAS_ALERTA) || 3,
  MAX_ARCHIVO_MB: Number(process.env.MAX_ARCHIVO_MB) || 25,
  ADMIN_USUARIO: process.env.ADMIN_USUARIO || 'fernando',
  ADMIN_NOMBRE: process.env.ADMIN_NOMBRE || 'Fernando',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'Spacio2026!',
};
