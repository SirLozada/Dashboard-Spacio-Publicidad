# Spacio Publicidad · Control de trabajos

Dashboard web para el control y seguimiento de trabajos de Spacio Publicidad.
Reemplaza los controles en Excel con una aplicación sencilla, accesible desde
computadora y teléfono, con la información guardada en una base de datos.

## Módulos

| Módulo | Qué permite |
| --- | --- |
| **Dashboard** | Tarjetas con la cantidad de trabajos por estatus (al hacer clic filtran la tabla), avisos de trabajos atrasados y próximos a entregar, y tabla de trabajos activos ordenada por fecha de entrega. |
| **Control de trabajos** | Registro con número automático (`SP-0001`…), cambio rápido de estatus desde la tabla, búsqueda (cliente, marca, tienda, descripción, N°), filtros por estatus y rango de fechas, orden por fecha de entrega, trabajos atrasados resaltados, ficha completa con **guardado automático**, lista de **pendientes** por trabajo (próximos pasos que se marcan al completarlos), archivos y fotografías adjuntos, y **exportación a Excel** (respeta los filtros aplicados). |
| **Materiales y precios** | Agregar, editar, eliminar y buscar materiales. Al cambiar un precio se registra la fecha de actualización. |
| **Proveedores** | Directorio con búsqueda y botones para llamar o escribir por WhatsApp. |
| **Solicitudes y novedades** | Comunicación interna por proyecto: solicitudes con tipo, prioridad, destinatarios y archivos; estados propios (Nueva, En revisión, Pendiente de aprobación, En proceso, Resuelta, Rechazada); conversación con menciones @nombre; aprobación por un administrador cuando modifica alcance, costo o fecha (queda registrado quién y cuándo); bandeja con filtros y vistas *Mis solicitudes* / *Asignadas a mí*; pestaña en la ficha de cada proyecto. |
| **Campanita 🔔** | Notificaciones individuales (nueva solicitud, asignación, comentario, mención, cambio de estado, aprobación/rechazo), sin duplicados por evento y nunca a quien hizo la acción. Se actualiza cada 20 s y al volver a la pestaña (Vercel no admite conexiones permanentes). |
| **Cotizaciones** (administradores) | Reemplaza la hoja de costeo en Excel: piezas con su lista de materiales (autocompletado desde *Materiales y precios*), cantidad a cotizar, margen y comisiones en cadena con la misma fórmula del Excel (costo ÷ (1 − %)), comisión en monto por pieza, transporte y viáticos con calculadora y reparto entre piezas, Excel interno y documento para el cliente (imprimible como PDF, sin costos internos). Pestaña *Cotización* en la ficha del proyecto. |
| **Pagos de producción** (administradores) | Pagos por proyecto a colaboradores: directorio de colaboradores, asignación a trabajos con monto acordado en USD, abonos en USD o Bs con la tasa BCV de la fecha del pago, estados automáticos (Pendiente / Pago parcial / Completado), ajustes y anulaciones identificables con historial, resumen semanal exportable a Excel y sección de pagos en la ficha de cada trabajo. |
| **Usuarios** (administradores) | Agregar usuarios, restablecer contraseñas y desactivar accesos. |

Estatus de trabajo: Por cotizar, Render, Pendiente por aprobación, Aprobado,
Producción, Instalado, Reclamo, Finalizado y Rechazado. Un trabajo se considera
**atrasado** si su fecha de entrega ya pasó y no está Instalado, Finalizado ni Rechazado;
**próximo** si vence en los próximos 3 días (configurable con `DIAS_ALERTA`).

## Acceso

En el primer arranque se crea el usuario administrador **`fernando`**.
Si no se define `ADMIN_PASSWORD`, la contraseña inicial es `Spacio2026!` y el
sistema obliga a cambiarla en el primer ingreso. Los usuarios nuevos también
deben cambiar su contraseña inicial.

- **Administrador:** todo, además de gestionar usuarios y eliminar trabajos/proveedores.
- **Usuario:** registrar, consultar y editar trabajos, materiales y proveedores.

## Tasa oficial BCV (Pagos de producción)

- La tasa se lee de **bcv.org.ve** junto con su *fecha valor* y se guarda en la tabla `tasas_bcv`.
  Vercel la consulta dos veces al día (`crons` en `vercel.json`) y también al registrar un pago.
- La tasa de un pago es la de mayor fecha valor que no supere la fecha del pago: los fines de semana
  y feriados usan la última tasa vigente.
- Si no hay una tasa verificada (p. ej. un pago antiguo o el BCV no responde), el sistema **no la inventa**:
  pide ingresarla manualmente con confirmación y la marca como *manual*. DolarApi se muestra sólo como
  referencia porque no indica la fecha valor.
- Cada abono guarda su tasa, el monto en USD y en Bs: cambios posteriores de la tasa no lo modifican.
- Los abonos nunca se editan ni se borran; los errores se corrigen con ajustes que quedan en el historial.

## Importar los Excel anteriores

Al arrancar por primera vez (base de datos sin trabajos), el sistema carga
automáticamente los Excel de la carpeta [`datos-iniciales/`](datos-iniciales).
Esto ocurre una sola vez.

También se puede importar un archivo en cualquier momento:

```bash
npm run importar -- "ruta/al/archivo.xlsx"
```

El importador reconoce las columnas por su nombre (FECHA, CLIENTE, DESCRIPCION,
STATUS, PENDIENTE, ENTREGA, Marca, Nombre de tienda, Observación…). En el Excel
de pendientes, las filas siguientes a un trabajo se agregan como sus pendientes.
Los trabajos que ya existen (mismo cliente, tienda y descripción) se omiten.
Equivalencias de estatus: PENDIENTE → Por cotizar (o Render si el próximo
pendiente es el render), PENDIENTE APROBACION → Pendiente por aprobación,
PRODUCCION → Producción, PENDIENTE REINSTALACION / Reclamo pendiente → Reclamo,
Instalado → Instalado.

## Publicar en Vercel

La aplicación corre en Vercel con dos servicios de almacenamiento, ambos se
agregan desde el panel del proyecto en Vercel (**Storage**):

| Qué | Servicio | Variables que crea |
| --- | --- | --- |
| Base de datos | **Turso** (Marketplace → Turso Cloud) | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` |
| Archivos y fotos | **Vercel Blob** (acceso *Public*) | `BLOB_READ_WRITE_TOKEN` |

Variables a definir en **Settings → Environment Variables**:

- `ADMIN_PASSWORD`: contraseña inicial de Fernando (sólo se usa la primera vez).
- `ZONA_HORARIA` (opcional, por defecto `America/Caracas`): zona horaria para calcular los atrasos.
- `BLOB_ACCESS=private` sólo si el almacén Blob se creó como privado.

Después de conectar Turso y Blob, hacer **Redeploy** (o subir cualquier cambio a
la rama: Vercel publica de nuevo automáticamente). Las variables nuevas sólo se
aplican a los despliegues creados después de conectarlas.

Para comprobar el estado abrir `/api/salud`: responde `{"ok":true}` cuando la
base de datos está lista, o un mensaje que indica qué falta. En la primera visita se
crean las tablas, el usuario `fernando` y se importan los Excel de `datos-iniciales/`.

`vercel.json` ya define todo lo necesario: la carpeta `public/` se sirve como
sitio estático y `api/index.js` atiende todas las rutas `/api/*`.

## Desarrollo local / servidor propio

Requisitos: Node.js 20 o superior.

```bash
npm install
npm start            # http://localhost:3000
npm test             # pruebas automáticas de la API
```

Sin las variables de Turso y Blob, la base de datos y los adjuntos se guardan en
la carpeta `DATA_DIR` (por defecto `./data`). Variables disponibles: ver
[`.env.example`](.env.example).

## Estructura (preparada para crecer)

```
server/
  app.js              Aplicación y registro de módulos del backend
  index.js            Arranque como servidor propio (en Vercel: api/index.js)
  config.js           Estatus, prefijos, moneda… (fuente única, expuesta en /api/config)
  db.js               Conexión libSQL/Turso (o SQLite local) y migraciones automáticas
  migrations/         Cambios de base de datos numerados (001_inicial.sql, …)
  auth.js             Inicio de sesión, sesiones y permisos
  lib/crud.js         Fábrica de rutas CRUD para módulos sencillos
  lib/almacen.js      Adjuntos: disco local o Vercel Blob
  modules/            trabajos, materiales, proveedores, usuarios
public/
  index.html, css/    Interfaz
  js/app.js           Menú, rutas y registro de módulos del frontend
  js/modules/         Una vista por módulo
  js/components/      Piezas compartidas (tabla y ficha de trabajos)
```

**Agregar un módulo nuevo:**
1. Crear `server/migrations/00X_nombre.sql` con la tabla (se aplica sola al arrancar).
2. Crear `server/modules/nombre.js` (para tablas simples basta `crearCrud({...})`) y añadirlo a `MODULOS` en `server/app.js`.
3. Crear `public/js/modules/nombre.js` con `{ id, titulo, icono, render }` y añadirlo a `MODULOS` en `public/js/app.js`; aparecerá en el menú lateral.

Para añadir un estatus nuevo basta con editar la lista `ESTATUS` en `server/config.js`.
