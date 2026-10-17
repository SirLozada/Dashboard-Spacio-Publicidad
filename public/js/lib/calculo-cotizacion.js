// Cálculo de cotizaciones de Spacio Publicidad (mismo método que su Excel).
// Se usa tanto en el navegador (cálculo en vivo) como en el servidor
// (exportaciones), para que los resultados siempre coincidan.
//
// Por pieza (valores por unidad):
//   costo        = Σ cantidad × costo unitario de sus materiales y servicios
//   con margen   = costo ÷ (1 − margen)                 (p. ej. 30 %)
//   comisiones   = precio ÷ (1 − comisión), en cadena    (p. ej. Fernando 20 %, Darwin 5 %)
//   fabricación  = precio final unitario × cantidad a cotizar
// Viáticos del proyecto:
//   costo ÷ (1 − margen de viáticos), repartido entre las piezas
//   (proporcional a la fabricación o con porcentajes manuales)
// Total de la pieza = fabricación + viáticos asignados + comisión en monto (p. ej. Francisco).

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const redondear = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

function aplicarMargen(costo, margen, comisiones) {
  const pasos = [];
  let precio = margen < 1 ? costo / (1 - margen) : NaN;
  pasos.push({ nombre: 'Ganancia', porcentaje: margen, monto: precio - costo });
  for (const c of comisiones) {
    const anterior = precio;
    precio = c.porcentaje < 1 ? precio / (1 - c.porcentaje) : NaN;
    pasos.push({ nombre: c.nombre || 'Comisión', porcentaje: c.porcentaje, monto: precio - anterior });
  }
  return { precio, pasos };
}

export const subtotalLineas = (lineas = []) => lineas.reduce((s, l) => s + num(l.cantidad) * num(l.costo_unitario), 0);

export function calcularCotizacion(c) {
  const margen = num(c.margen);
  const comisiones = (c.comisiones || []).map((x) => ({ nombre: x.nombre, porcentaje: num(x.porcentaje) }));
  const avisos = [];
  if (margen >= 1 || comisiones.some((x) => x.porcentaje >= 1)) avisos.push('Un margen o una comisión no puede ser 100 % o más.');

  const piezas = (c.piezas || []).map((p) => {
    const cantidad = num(p.cantidad) || 0;
    const costo = subtotalLineas(p.lineas);
    const { precio, pasos } = aplicarMargen(costo, margen, comisiones);
    return {
      nombre: p.nombre,
      cantidad,
      costo_unitario: costo,
      precio_unitario: precio,
      pasos, // montos por unidad
      fabricacion: precio * cantidad,
      comision_fija: num(p.comision_fija),
      viaticos_pct_manual: p.viaticos_pct === null || p.viaticos_pct === undefined || p.viaticos_pct === '' ? null : num(p.viaticos_pct),
    };
  });

  const costoViaticos = subtotalLineas(c.viaticos);
  const margenViaticos = num(c.margen_viaticos);
  const precioViaticos = costoViaticos > 0 ? (margenViaticos < 1 ? costoViaticos / (1 - margenViaticos) : NaN) : 0;

  // Reparto de los viáticos entre las piezas
  const totalFab = piezas.reduce((s, p) => s + p.fabricacion, 0);
  let sumaPct = 0;
  for (const p of piezas) {
    if (c.reparto_viaticos === 'manual') p.viaticos_pct = p.viaticos_pct_manual ?? 0;
    else p.viaticos_pct = totalFab > 0 ? p.fabricacion / totalFab : piezas.length ? 1 / piezas.length : 0;
    sumaPct += p.viaticos_pct;
    p.viaticos = precioViaticos * p.viaticos_pct;
    p.total = p.fabricacion + p.viaticos + p.comision_fija;
    p.precio_unitario_cliente = p.cantidad > 0 ? p.total / p.cantidad : p.total;
  }
  if (precioViaticos > 0 && piezas.length && Math.abs(sumaPct - 1) > 0.0001) {
    avisos.push(`El reparto de viáticos suma ${Math.round(sumaPct * 1000) / 10} % (debe sumar 100 %).`);
  }

  const suma = (k) => piezas.reduce((s, p) => s + p[k], 0);
  const resumenPasos = [];
  for (const p of piezas) {
    p.pasos.forEach((paso, i) => {
      resumenPasos[i] ??= { nombre: paso.nombre, porcentaje: paso.porcentaje, monto: 0 };
      resumenPasos[i].monto += paso.monto * p.cantidad;
    });
  }
  return {
    piezas,
    costo_fabricacion: piezas.reduce((s, p) => s + p.costo_unitario * p.cantidad, 0),
    fabricacion: suma('fabricacion'),
    costo_viaticos: costoViaticos,
    viaticos: precioViaticos,
    ganancia_viaticos: precioViaticos - costoViaticos,
    comisiones_fijas: suma('comision_fija'),
    total: suma('total'),
    pasos: resumenPasos, // ganancia y cada comisión, en montos totales
    avisos,
  };
}
