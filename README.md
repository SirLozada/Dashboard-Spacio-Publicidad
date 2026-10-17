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

## Puesta en marcha

Requisitos: Node.js 20 o superior.

```bash
npm install
npm start            # http://localhost:3000
npm test             # pruebas automáticas de la API
```

Variables de configuración: ver [`.env.example`](.env.example).

### Despliegue

La base de datos (SQLite) y los adjuntos se guardan en la carpeta `DATA_DIR`.
**Esa carpeta debe estar en un disco persistente** y conviene respaldarla
periódicamente (basta copiar la carpeta).

Con Docker:

```bash
docker build -t spacio-dashboard .
docker run -d -p 3000:3000 -v spacio-data:/data \
  -e ADMIN_PASSWORD='una-clave-segura' -e TZ=America/Caracas spacio-dashboard
```

En servicios como Render, Railway o Fly.io: crear el servicio desde este
repositorio con `npm start`, añadir un volumen/disco persistente y apuntar
`DATA_DIR` a él. Usar siempre HTTPS (lo proveen estos servicios).

## Estructura (preparada para crecer)

```
server/
  index.js            Arranque y registro de módulos del backend
  config.js           Estatus, prefijos, moneda… (fuente única, expuesta en /api/config)
  db.js               Conexión SQLite y migraciones automáticas
  migrations/         Cambios de base de datos numerados (001_inicial.sql, …)
  auth.js             Inicio de sesión, sesiones y permisos
  lib/crud.js         Fábrica de rutas CRUD para módulos sencillos
  modules/            trabajos, materiales, proveedores, usuarios
public/
  index.html, css/    Interfaz
  js/app.js           Menú, rutas y registro de módulos del frontend
  js/modules/         Una vista por módulo
  js/components/      Piezas compartidas (tabla y ficha de trabajos)
```

**Agregar un módulo nuevo:**
1. Crear `server/migrations/00X_nombre.sql` con la tabla (se aplica sola al arrancar).
2. Crear `server/modules/nombre.js` (para tablas simples basta `crearCrud({...})`) y añadirlo a `MODULOS` en `server/index.js`.
3. Crear `public/js/modules/nombre.js` con `{ id, titulo, icono, render }` y añadirlo a `MODULOS` en `public/js/app.js`; aparecerá en el menú lateral.

Para añadir un estatus nuevo basta con editar la lista `ESTATUS` en `server/config.js`.
