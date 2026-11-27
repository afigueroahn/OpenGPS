# API de OpenGPS — contrato para las apps

**Versión del contrato:** 3 · **Tipos y esquemas:** [packages/shared/src](../packages/shared/src)

La web y las apps móviles hablan con la plataforma por esta API. Este documento fija qué rutas existen, quién puede usarlas y qué envían y devuelven. Una prueba automática ([contract.test.ts](../apps/server/test/contract.test.ts)) compara la lista de rutas de este documento con las que el servidor atiende de verdad: si se agrega, quita o renombra una ruta sin actualizar aquí, la prueba falla.

La forma exacta de cada dato vive en [packages/shared/src](../packages/shared/src), con un archivo por tema. Las apps importan esos mismos tipos y esquemas desde `@opengps/shared`, así que no hay una segunda definición que mantener.

## Reglas generales

| Tema | Regla |
|---|---|
| Dirección | `https://<dominio>/api`, la misma para la web y las apps |
| Formato | JSON en UTF-8, en peticiones y respuestas |
| Sesión | Cookie de sesión de 30 días. Sin sesión, las rutas responden 401, salvo las marcadas como públicas |
| Cuenta activa | Cada sesión trabaja sobre una cuenta. Se cambia con `POST /api/accounts/active` |
| Permisos | Cada ruta indica el permiso que exige. Sin él responde 403 |
| Alcance por grupo | Quien solo ve unos grupos recibe 404 al pedir un vehículo de otro grupo, igual que si no existiera |
| Otra cuenta | Lo que es de otra cuenta responde siempre 404 |
| Fechas | ISO 8601 en UTC: `2026-11-22T05:47:32.000Z` |
| Identificadores | Texto. Los de vehículos, grupos, geocercas, alertas y enlaces son UUID |
| Tamaño | El cuerpo de una petición admite hasta 256 KB; una evidencia de incidente, hasta 8 MB |
| Módulos | `GET /api/me` trae en `account.modules` los módulos habilitados en la cuenta. Las rutas de un módulo que la cuenta no tiene responden 404 |
| Origen | Las peticiones que cambian datos desde un navegador solo se aceptan desde la propia web, en cualquiera de las direcciones por las que se abre |
| Idioma | Los textos que trae una respuesta (errores, etiquetas, reportes, archivos exportados, la descripción OpenAPI) vienen en el idioma que pide la cabecera `X-Language` (`es` o `en`). Sin ella, el idioma que la persona eligió, el primero de `Accept-Language` que la plataforma habla y, si no, el idioma por defecto de la plataforma. Los correos y avisos llegan en el idioma de quien los recibe |

### Errores

Toda respuesta de error trae el mismo cuerpo. `message` está escrito para mostrarse a la persona tal cual, en el idioma de la petición; `code` no cambia con el idioma.

```json
{ "error": { "code": "not_found", "message": "No encontrado" } }
```

| Estado | Cuándo |
|---|---|
| 400 | Los datos enviados no son válidos |
| 401 | No hay sesión |
| 403 | La sesión no tiene permiso, o la cuenta está suspendida (`account_suspended`) |
| 404 | No existe, es de otra cuenta o queda fuera del alcance de quien pregunta |
| 409 | Choca con algo que ya existe (`device_taken`, `group_exists`, `driver_key_taken`) |
| 429 | Demasiadas peticiones seguidas |
| 500 | Falló el servidor |

## Compatibilidad

`GET /api/config` devuelve `apiVersion`. Dentro de una misma versión:

- No desaparece ninguna ruta de este documento ni cambia lo que significa.
- No se quita ni cambia de tipo ningún dato de una respuesta.
- No se vuelve obligatorio un dato que antes era opcional en una petición.
- Sí pueden aparecer rutas nuevas, datos nuevos en las respuestas y valores nuevos en listas como los tipos de evento o de alerta. Una app debe ignorar lo que no conozca.

Un cambio que rompa alguna de esas reglas sube `apiVersion`, y la versión anterior sigue atendiéndose el tiempo que haga falta para que las apps publicadas se actualicen.

Las versiones anteriores a la 3 se retiraron sin convivencia, porque aún no había apps publicadas.

## Rutas

### Estado y configuración

| Ruta | Quién | Devuelve |
|---|---|---|
| `GET /api/health` | Pública | `{ ok, version, ingest, live }`; 503 si la base no responde |
| `GET /api/config` | Pública | `PublicConfig`: nombre, mapa base, servidor de equipos, versión de los términos, los servicios con que se puede entrar (`signIn`, en el orden de sus botones), si hay passkeys (`passkeys`) si la dirección las permite aunque estén apagadas (`passkeysSupported`), si la app puede crearlas ahí (`passkeysFromApp`; una plataforma anterior no lo manda), `apiVersion` y `version`: la de la plataforma, la de su release (`0.1.0`) o la del repositorio con `-dev` si se construyó desde el código |

### Sesión y cuenta

| Ruta | Quién | Envía | Devuelve |
|---|---|---|---|
| `GET /api/auth/*` | Pública | | Rutas de sesión; ver "Sesión" más abajo |
| `POST /api/auth/*` | Pública | | Rutas de sesión; ver "Sesión" más abajo |
| `GET /api/app/oauth/start` | Pública | `?provider=` (uno de `signIn` de `GET /api/config`) y, para registrarse también, `&legalVersion=`: la versión de los términos que la app mostró junto a los botones | La app móvil la abre en la ventana de inicio de sesión del sistema, en modo efímero en iPhone (ADR-0013); en Android comparte las cookies de Chrome (ADR-0025). Empieza ahí la ida al servicio y lleva a su página. La vuelta llega a `GET /api/app/oauth`. Un servicio que la plataforma no tiene lleva a `opengps://oauth?error=unknown_provider` |
| `GET /api/app/oauth` | Pública | `?error=` y `?error_description=`, si vienen del servicio | Vuelta de la app móvil desde otro servicio (ADR-0013, ADR-0014): si el navegador trae una sesión creada hace menos de cinco minutos, lleva a la página `/app-sign-in` de la web, donde la persona confirma con qué cuenta vuelve a la app; si no, a `opengps://oauth?error=no_session`. El error del servicio llega a la app como vino: `opengps://oauth?error=…` |
| `POST /api/app/oauth` | Con sesión | `{}`, desde la página `/app-sign-in` | La persona confirmó (ADR-0014): `{ url }`, la dirección de la app con un pase de un solo uso que dura un minuto (`opengps://oauth?token=…`). La página lleva ahí a la persona. La respuesta borra en el navegador las cookies `gps.*` sin cerrar la sesión, que pasa a la app (ADR-0025). Solo con una sesión creada hace menos de cinco minutos; si no, 401 |
| `GET /api/me` | Con sesión | | `Me`: persona (con `photoUrl`, la dirección de su foto o `null`), cuenta activa, permisos, grupos que ve, cuentas y preferencias |
| `PUT /api/me/settings` | Con sesión | `{ name?, theme?, language?, phone? }`: solo cambia lo que se envía. `name` es el nombre de la persona, el mismo en todas sus cuentas; `theme` es `system`, `light` o `dark`; `language` es `es`, `en` o `null` (el de la plataforma); `phone` es el teléfono donde recibe los SMS, con su código de país, o `null` | 204 |
| `PUT /api/me/photo` | Con sesión | La imagen tal cual (JPG, PNG o WebP, hasta 512 KB), con su tipo en `Content-Type`. La web y la app la mandan ya recortada en un cuadrado de 256 px: en PNG si la imagen elegida era PNG o WebP, que puede tener fondo transparente, y si no en JPEG | `{ photoUrl }`. La dirección cambia con cada foto |
| `GET /api/me/photo` | Con sesión | | La imagen; 404 si la persona no tiene foto |
| `DELETE /api/me/photo` | Con sesión | | 204 |
| `PATCH /api/account` | Dueño o administrador de la cuenta | `{ name }` | 204. Cambia el nombre de la cuenta y lo anota en su actividad |
| `POST /api/consent` | Con sesión | `{ version }` | 204 |
| `POST /api/accounts/active` | Con sesión | `{ accountId }` | 204 |
| `POST /api/accounts/leave` | Con sesión | | 204 |

### Vehículos y equipos

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/device-models` | Con sesión | | `{ models: DeviceModel[] }`: cada familia de equipos con su protocolo, su puerto, los modelos que se sabe que le pertenecen (`models`) |
| `GET /api/vehicles` | Con sesión | | `{ vehicles: Vehicle[] }` |
| `POST /api/vehicles` | `vehicles.manage` | `createVehicleSchema`. `modelId` es la familia; `modelName`, opcional, uno de sus modelos | 201 `{ vehicle }` |
| `GET /api/vehicles/:id` | Con sesión | | `{ vehicle }` |
| `PATCH /api/vehicles/:id` | `vehicles.manage` | `updateVehicleSchema` | `{ vehicle }` |
| `DELETE /api/vehicles/:id` | `vehicles.manage` | | 204 |
| `POST /api/vehicles/:id/device` | `vehicles.manage` | `attachDeviceSchema` | 201 `{ vehicle }` |
| `DELETE /api/vehicles/:id/device` | `vehicles.manage` | | `{ vehicle }` |
| `POST /api/vehicles/:id/park` | `vehicles.manage` | `{ parked }` | `{ vehicle }` |
| `GET /api/vehicles/:id/track` | Con sesión | `?minutes&limit` | `{ points: TrackPoint[] }` |
| `GET /api/vehicles/:id/address` | Con sesión | | `{ address }` |
| `POST /api/geocode` | Con sesión | `{ lat, lon }` | `{ address }` |

### Historial

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/vehicles/:id/history` | Con sesión | `?from&to` (hasta 31 días) | `{ history: VehicleHistory }` |
| `GET /api/vehicles/:id/history/export` | Con sesión | `?from&to&format&zone` | El archivo: `xlsx`, `pdf`, `csv`, `gpx` o `kml` |

### Geocercas, alertas y eventos

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/geofences` | Con sesión | | `{ geofences: Geofence[] }` |
| `POST /api/geofences` | `geofences.manage` | `geofenceSchema`. Aplica a toda la cuenta, a unos grupos (`groupIds`) o a unos vehículos elegidos uno por uno (`vehicleIds`); las dos listas a la vez se rechazan | 201 `{ geofence }` |
| `PUT /api/geofences/:id` | `geofences.manage` | `geofenceSchema` | `{ geofence }` |
| `DELETE /api/geofences/:id` | `geofences.manage` | | 204 |
| `GET /api/alerts` | Con sesión | | `{ alerts: AlertRule[] }` |
| `POST /api/alerts` | `alerts.manage` | `alertRuleSchema` | 201 `{ alert }` |
| `PUT /api/alerts/:id` | `alerts.manage` | `alertRuleSchema` | `{ alert }` |
| `DELETE /api/alerts/:id` | `alerts.manage` | | 204 |
| `GET /api/events` | Con sesión | `?limit&before&vehicleId&geofenceId&alerts` | `{ events: VehicleEvent[] }`, del más reciente al más antiguo |

### Ubicación compartida

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/vehicles/:id/shares` | `links.share` | | `{ links: ShareLink[] }`, solo los vigentes |
| `POST /api/vehicles/:id/shares` | `links.share` | `shareSchema` | 201 `{ link, token }`. `token` no se vuelve a entregar |
| `DELETE /api/shares/:id` | `links.share` | | 204 |
| `POST /api/share/view` | Pública | `{ token }` | `{ view: SharedView }`; 404 si no existe, venció o se revocó |

La dirección que se envía a la otra persona es `https://<dominio>/shared#<token>`.

### Módulo A · Antirrobo y comandos

Bloquear el arranque va en dos pasos. El primero devuelve la situación del vehículo y una comprobación que vale dos minutos; el segundo la envía de vuelta junto con la palabra que la persona escribe (`BLOQUEAR` o `DESBLOQUEAR`). Una orden de bloqueo no sale mientras el vehículo vaya a más de 10 km/h: queda en espera hasta 30 minutos y, si ese momento no llega, vence.

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/vehicles/:id/security` | Con sesión | | `{ security: VehicleSecurity }` |
| `POST /api/vehicles/:id/lock/prepare` | `commands.send` | `lockPrepareSchema` | `{ check: LockCheck }` |
| `POST /api/vehicles/:id/lock` | `commands.send` | `lockSchema` | `{ security }` |
| `DELETE /api/vehicles/:id/lock` | `commands.send` | | `{ security }`; cancela la orden que espera. 409 si ya se envió |
| `POST /api/vehicles/:id/recovery` | `commands.send` | `{ on }` | `{ security, shareToken }`. `shareToken` es el enlace para autoridades y no se vuelve a entregar |
| `GET /api/incidents` | Con sesión | `?open&limit` | `{ incidents: Incident[] }`, los prioritarios primero |
| `POST /api/incidents` | `incidents.manage` | `incidentCreateSchema` | 201 `{ incident: IncidentDetail }` |
| `GET /api/incidents/:id` | Con sesión | | `{ incident: IncidentDetail }`, con su línea de tiempo |
| `POST /api/incidents/:id/attend` | `incidents.manage` | | `{ incident }` |
| `POST /api/incidents/:id/notes` | `incidents.manage` | `{ text }` | `{ incident }` |
| `POST /api/incidents/:id/close` | `incidents.manage` | `incidentCloseSchema` | `{ incident }` |
| `POST /api/incidents/:id/files` | `incidents.manage` | `?name` y el archivo como cuerpo, con su `Content-Type` | 201 `{ incident }`. JPG, PNG, WebP o PDF |
| `GET /api/incidents/:id/files/:fileId` | Con sesión | | El archivo |

### Módulo B · Conductor

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/drivers` | Con sesión | | `{ drivers: Driver[] }` |
| `POST /api/drivers` | `drivers.manage` | `driverSchema` | 201 `{ driver }` |
| `PUT /api/drivers/:id` | `drivers.manage` | `driverSchema` | `{ driver }` |
| `DELETE /api/drivers/:id` | `drivers.manage` | | 204 |
| `GET /api/drivers/settings` | Con sesión | | `{ settings: DriverSettings }` |
| `PUT /api/drivers/settings` | `drivers.manage` | `driverSettingsSchema` | `{ settings }` |
| `GET /api/drivers/ranking` | Con sesión | `?from&to&groupId` (hasta 31 días) | `{ ranking: DriverRank[] }`, del mejor puntaje al peor |
| `GET /api/drivers/:id/report` | Con sesión | `?from&to&zone` | `{ report: DriverReport }` |
| `GET /api/vehicles/:id/driver` | Con sesión | | `VehicleDriver`: quién conduce y la última llave sin dueño |
| `PUT /api/vehicles/:id/driver` | `drivers.manage` | `{ driverId }`, o `null` para dejarlo sin conductor | `VehicleDriver` |

### Módulo C · Diagnóstico

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/vehicles/:id/diagnostics` | Con sesión | | `{ diagnostics: DiagStatus }`: lo último que el equipo leyó del vehículo, los códigos de falla, los datos que no se saben nombrar, los límites de aviso y el odómetro y las horas de motor |
| `GET /api/vehicles/:id/diagnostics/series` | Con sesión | `?param&from&to` (hasta 31 días); `param` es una de las claves de `DIAG_PARAMS` | `{ series: DiagSeries }`: los puntos de la gráfica, mínimo, máximo, promedio, lo que avanzó si es un contador y el límite de aviso |
| `GET /api/vehicles/:id/diagnostics/faults` | Con sesión | | `{ faults: DiagFault[] }`: activos primero, luego los resueltos |
| `PUT /api/vehicles/:id/diagnostics/limits` | `vehicles.manage` | `diagLimitsSchema`: los límites propios del vehículo; los que no se envían vuelven a ser los de la cuenta, y `null` apaga ese aviso | `{ diagnostics }` |
| `GET /api/diagnostics/settings` | Con sesión | | `{ settings: DiagSettings }`: límites de la cuenta y zona horaria |
| `PUT /api/diagnostics/settings` | `vehicles.manage` | `diagSettingsSchema` | `{ settings }` |
| `GET /api/vehicles/:id/meters` | Con sesión | | `{ meters: VehicleMeters }`: odómetro y horas de motor, y de dónde salen. La cuenta necesita el módulo C o el E |
| `PUT /api/vehicles/:id/meters` | `vehicles.manage` | `vehicleMetersSchema`: lo que marca el tablero ahora | `{ meters }` |

### Módulo D · Flota

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/fleet` | Con sesión | | `{ fleet: FleetVehicle[] }`: la ficha de cada vehículo, su disponibilidad, si está de alta, a quién está asignado, su odómetro, sus documentos por vencer y su vida útil |
| `GET /api/vehicles/:id/fleet` | Con sesión | | `{ vehicle: FleetDetail }`: lo mismo, con sus documentos y el registro de cambios |
| `PUT /api/vehicles/:id/fleet` | `vehicles.manage` | `fleetProfileSchema` | `{ vehicle }` |
| `PUT /api/vehicles/:id/fleet/status` | `vehicles.manage` | `{ status, note }`: `available`, `workshop` u `out_of_service` | `{ vehicle }`. «En ruta» no se fija: lo está un vehículo disponible que anda |
| `PUT /api/vehicles/:id/fleet/state` | `vehicles.manage` | `{ state, note }`: `active`, `suspended` o `retired` | `{ vehicle }` |
| `POST /api/vehicles/:id/fleet/documents` | `vehicles.manage` | El archivo tal cual (JPG, PNG, WebP o PDF), con su tipo en la cabecera, y `?name&kind&expiresOn&note` | 201 `{ vehicle }`. Con `kind=photo` pasa a ser la foto del vehículo |
| `GET /api/fleet/documents/:id` | Con sesión | | El archivo |
| `DELETE /api/fleet/documents/:id` | `vehicles.manage` | | `{ vehicle }` |
| `GET /api/vehicles/:id/fleet/assignments` | Con sesión | | `{ assignments: FleetAssignments }`. Con el módulo B, la historia es la de sus conductores y se cambia desde él |
| `POST /api/vehicles/:id/fleet/assignments` | `vehicles.manage` | `fleetAssignmentSchema` | 201 `{ assignments }`. Sin el módulo B |
| `DELETE /api/fleet/assignments/:id` | `vehicles.manage` | | `{ assignments }` |
| `GET /api/fleet/expenses` | Con sesión | `?from&to&vehicleId&zone`, fechas como `2026-11-22` | `{ expenses: FleetExpenses }`: los gastos y sus totales por moneda y categoría. Con el módulo F entran solos los abastecimientos anotados con su total (`id` nulo) |
| `POST /api/fleet/expenses` | `vehicles.manage` | `fleetExpenseSchema` | 201 `{ expense }` |
| `PUT /api/fleet/expenses/:id` | `vehicles.manage` | `fleetExpenseSchema` | `{ expense }` |
| `DELETE /api/fleet/expenses/:id` | `vehicles.manage` | | 204 |
| `GET /api/fleet/utilization` | Con sesión | `?from&to&zone` (hasta 31 días) | `{ utilization: FleetUtilization }`: por vehículo, lo recorrido, el tiempo en viaje y en ralentí, los días con uso y la parte de días sin usar |
| `GET /api/fleet/groups` | Con sesión | | `{ groups: VehicleGroup[] }`, cada uno con el grupo del que cuelga |
| `PUT /api/fleet/groups/:id/parent` | `vehicles.manage`, y ver toda la cuenta | `{ parentId }`, o `null` para dejarlo suelto | `{ groups }`. Lo que vale para un grupo vale para los que cuelgan de él |

### Módulo E · Mantenimiento

Solo existen para las cuentas con el módulo E. Las rutas que devuelven `overview` o aplican un plan admiten `?zone` (la zona horaria de quien consulta, para contar «hoy» con su reloj); sin ella vale la guardada en los ajustes. Los avisos de servicio y de vencimiento salen como eventos (`service_soon`, `service_due`, `expiry_soon`, `expiry_due`) con `detail.subject` y `detail.reason`.

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/maintenance` | Con sesión | | `{ overview: MaintOverview }`: los servicios programados de cada vehículo con lo que les falta, los vencimientos y cuántas órdenes hay abiertas. Con el módulo D entran los documentos de flota con fecha (`source: "fleet"`) |
| `GET /api/maintenance/settings` | Con sesión | | `{ settings: MaintSettings }` |
| `PUT /api/maintenance/settings` | `vehicles.manage` | `maintSettingsSchema` | `{ settings }` |
| `GET /api/maintenance/plans` | Con sesión | | `{ plans: MaintPlan[] }` |
| `POST /api/maintenance/plans` | `vehicles.manage` | `maintPlanSchema`: cada cuánto toca (km, horas de motor o días), con cuánta anticipación se avisa y a qué vehículos se aplica | 201 `{ plans }`. A un vehículo nuevo en el plan se le cuenta desde hoy, con su odómetro y sus horas |
| `PUT /api/maintenance/plans/:id` | `vehicles.manage` | `maintPlanSchema` | `{ plans }` |
| `DELETE /api/maintenance/plans/:id` | `vehicles.manage` | | 204 |
| `PUT /api/maintenance/schedules/:id` | `vehicles.manage` | `maintBaselineSchema`: cuándo se hizo el servicio por última vez | `{ overview }` |
| `POST /api/maintenance/expiries` | `vehicles.manage` | `maintExpirySchema` | 201 `{ overview }` |
| `PUT /api/maintenance/expiries/:id` | `vehicles.manage` | `maintExpirySchema` | `{ overview }` |
| `DELETE /api/maintenance/expiries/:id` | `vehicles.manage` | | `{ overview }` |
| `GET /api/maintenance/orders` | Con sesión | `?status&vehicleId&from&to`; `status=pending` son las abiertas y en proceso; las fechas filtran por cuándo se terminó | `{ orders: MaintOrder[] }` |
| `POST /api/maintenance/orders` | `vehicles.manage` | `maintOrderSchema` | 201 `{ order }`. Terminada sin fecha ni odómetro, toma los de hoy. Si cumple un servicio programado, su cuenta vuelve a empezar |
| `GET /api/maintenance/orders/:id` | Con sesión | | `{ order }` |
| `PUT /api/maintenance/orders/:id` | `vehicles.manage` | `maintOrderSchema` | `{ order }` |
| `DELETE /api/maintenance/orders/:id` | `vehicles.manage` | | 204 |
| `POST /api/maintenance/orders/:id/files` | `vehicles.manage` | El archivo tal cual (JPG, PNG, WebP o PDF) con su `Content-Type`, y `?name` | 201 `{ order }` |
| `GET /api/maintenance/files/:id` | Con sesión | | El archivo |
| `DELETE /api/maintenance/files/:id` | `vehicles.manage` | | `{ order }` |
| `GET /api/maintenance/workshops` | Con sesión | | `{ workshops: MaintWorkshop[] }` |
| `POST /api/maintenance/workshops` | `vehicles.manage` | `maintWorkshopSchema` | 201 `{ workshops }` |
| `PUT /api/maintenance/workshops/:id` | `vehicles.manage` | `maintWorkshopSchema` | `{ workshops }` |
| `DELETE /api/maintenance/workshops/:id` | `vehicles.manage` | | 204 |
| `GET /api/maintenance/parts` | Con sesión | | `{ parts: MaintPart[] }`, con lo usado de cada uno en órdenes terminadas |
| `POST /api/maintenance/parts` | `vehicles.manage` | `maintPartSchema` | 201 `{ parts }` |
| `PUT /api/maintenance/parts/:id` | `vehicles.manage` | `maintPartSchema` | `{ parts }` |
| `DELETE /api/maintenance/parts/:id` | `vehicles.manage` | | 204 |

### Módulo F · Combustible

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/vehicles/:id/fuel` | Con sesión | | `{ fuel: FuelStatus }`: tanque, nivel actual y datos que envía el equipo |
| `PUT /api/vehicles/:id/fuel` | `vehicles.manage` | `fuelTankSchema` | `{ fuel }` |
| `DELETE /api/vehicles/:id/fuel` | `vehicles.manage` | | 204 |
| `GET /api/vehicles/:id/fuel/report` | Con sesión | `?from&to` (hasta 31 días) | `{ report: FuelReport }`: consumo, cargas, descargas (con `engineOff` si fue con el motor apagado), ralentí, lo pagado por moneda y costo por kilómetro |
| `GET /api/vehicles/:id/fuel/fills` | Con sesión | `?from&to` (hasta 31 días) | `{ fills: FuelFill[] }`: los abastecimientos anotados, cada uno con lo que subió el tanque según el sensor (`detectedL`), y las cargas detectadas sin anotar (`id` nulo) |
| `POST /api/vehicles/:id/fuel/fills` | `vehicles.manage` | `fuelFillSchema` | 201 `{ fill }`. 409 `fill_repeated` si ya está anotado |
| `PUT /api/fuel/fills/:id` | `vehicles.manage` | `fuelFillSchema` | `{ fill }` |
| `DELETE /api/fuel/fills/:id` | `vehicles.manage` | | 204 |
| `POST /api/fuel/fills/import` | `vehicles.manage` | `{ csv, zone }`: el texto de un archivo CSV con títulos en la primera fila (Vehículo o Placa, Fecha, Litros; y si los trae Hora, Total, Moneda, Odómetro, Estación, Nota) y la zona horaria de sus fechas | `{ result: FuelImportResult }`: cuántos anotó, cuántos ya estaban y qué filas no entendió, con su número de línea |
| `GET /api/fuel/settings` | Con sesión | | `{ settings: FuelSettings }`: moneda de la cuenta y zona horaria |
| `PUT /api/fuel/settings` | `vehicles.manage` | `fuelSettingsSchema` | `{ settings }` |

### Módulo G · Reportes y paneles

Todos los reportes devuelven la misma forma, `ReportDocument`: totales, una gráfica opcional y tablas con el tipo de cada columna. Las fechas van en ISO, las duraciones en segundos, las distancias en metros y las velocidades en km/h; quien lo muestra les da formato. Los viajes cuentan en el día en que empezaron, en la zona horaria que se pida con `zone`.

`:type` es uno de `trips`, `stops`, `mileage`, `speed`, `geofences`, `alarms`, `utilization`, `drivers` (pide el módulo B) o `fuel` (pide el módulo F). Un reporte de un módulo que la cuenta no tiene responde 404.

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/reports/:type` | Con sesión | `?from&to&zone` (hasta 31 días) y, si se quiere, `groupId`, `vehicleIds` separados por comas, `speedLimitKmh` y `minStopMin` | `{ report: ReportDocument }` |
| `GET /api/reports/:type/export` | Con sesión | Lo mismo, más `format` (`xlsx` o `pdf`) | El archivo, con su nombre en `Content-Disposition` |
| `GET /api/reports/schedules` | `reports.schedule` | | `{ schedules: ReportSchedule[], people }`. `people` son las personas de la cuenta que pueden recibir un informe |
| `POST /api/reports/schedules` | `reports.schedule` | `reportScheduleSchema` | 201 `{ schedule }` |
| `PUT /api/reports/schedules/:id` | `reports.schedule` | `reportScheduleSchema` | `{ schedule }` |
| `DELETE /api/reports/schedules/:id` | `reports.schedule` | | 204 |
| `POST /api/reports/schedules/:id/send` | `reports.schedule` | | `{ sentTo, schedule }`. Envía ya el informe del periodo que toca; 429 si acaba de enviarse |
| `GET /api/dashboards` | Con sesión | | `{ dashboards: Dashboard[] }`, los de la persona en esa cuenta |
| `POST /api/dashboards` | Con sesión | `dashboardSchema`. Muestra todos los vehículos, los de un grupo (`groupId`) o unos elegidos uno por uno (`vehicleIds`) | 201 `{ dashboard }` |
| `PUT /api/dashboards/:id` | Con sesión | `dashboardSchema` | `{ dashboard }` |
| `DELETE /api/dashboards/:id` | Con sesión | | 204 |
| `GET /api/dashboards/data` | Con sesión | `?from&to&zone` y, si se quiere, `groupId` o `vehicleIds` (separados por comas) | `{ data: DashboardData }`: totales del periodo y del anterior, cada día, cada vehículo y las alertas por tipo |

Un informe programado lleva lo que puede ver quien lo programó y solo llega a personas de la cuenta. Quien ve todos los grupos administra todos los informes; los demás, solo los suyos.

### Módulo H · Rutas y logística

Solo existen para las cuentas con el módulo H. Las rutas de «con el enlace» no piden sesión: la clave del enlace va en el cuerpo (o en la cabecera `X-Route-Token` al subir una imagen) y tienen un límite de consultas por dirección. Un enlace que no existe, se cambió o venció responde siempre 404.

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/routes/pois` | Con sesión | | `{ pois: Poi[] }` |
| `POST /api/routes/pois` | `geofences.manage` | `poiSchema` | 201 `{ pois }` |
| `PUT /api/routes/pois/:id` | `geofences.manage` | `poiSchema` | `{ pois }` |
| `DELETE /api/routes/pois/:id` | `geofences.manage` | | 204 |
| `GET /api/routes/plans` | Con sesión | | `{ plans: RoutePlan[] }` |
| `POST /api/routes/plans` | `geofences.manage` | `routePlanSchema`: el camino, la tolerancia y las paradas | 201 `{ plans }` |
| `PUT /api/routes/plans/:id` | `geofences.manage` | `routePlanSchema` | `{ plans }` |
| `DELETE /api/routes/plans/:id` | `geofences.manage` | | 204 |
| `GET /api/routes/line` | Con sesión | `?vehicleId&from&to` | `{ line, lengthM }`: el camino que hizo el vehículo en ese periodo, aligerado, para tomarlo como ruta |
| `GET /api/routes/nearest` | Con sesión | `?lat&lon` | `{ vehicles: NearbyVehicle[] }`: del más cercano al más lejano en línea recta; primero los disponibles |
| `GET /api/routes/trips` | Con sesión | `?from&to` | `{ trips: RouteTrip[] }`: los despachos sin cerrar y los del periodo |
| `POST /api/routes/trips` | `geofences.manage` | `routeTripSchema`; con `planId`, las paradas y el camino salen de la ruta planificada | 201 `{ trip }` |
| `GET /api/routes/trips/:id` | Con sesión | | `{ trip }` |
| `PUT /api/routes/trips/:id/status` | `geofences.manage` | `{ status }`: `in_progress`, `done` o `cancelled` | `{ trip }` |
| `DELETE /api/routes/trips/:id` | `geofences.manage` | | 204 |
| `POST /api/routes/trips/:id/link` | `geofences.manage` | | `{ token }`: la clave del enlace del conductor; el anterior deja de servir |
| `PUT /api/routes/stops/:id` | `geofences.manage` | `routeStopUpdateSchema` | `{ trip }` |
| `POST /api/routes/stops/:id/link` | `geofences.manage` | | `{ token }`: la clave del enlace público de esa entrega; el anterior deja de servir |
| `GET /api/routes/stops/:id/proof/:kind` | Con sesión | `kind`: `photo` o `signature` | La imagen |
| `POST /api/routes/driver/view` | Con el enlace | `{ token }` | `{ view: DriverTripView }` |
| `POST /api/routes/driver/status` | Con el enlace | `{ token, status }`: `in_progress` o `done` | `{ view }` |
| `POST /api/routes/driver/stop` | Con el enlace | `{ token, stopId, status, recipient, note }` | `{ view }` |
| `POST /api/routes/driver/proof` | Con el enlace | La imagen tal cual (JPG, PNG o WebP), `?stopId&kind` y la clave en `X-Route-Token` | 201 `{ view }` |
| `POST /api/routes/track/view` | Con el enlace | `{ token }` | `{ view: DeliveryView }`: el estado de la entrega y, mientras va en camino, dónde está el vehículo |

### Módulo I · Integraciones

Solo existen para las cuentas con el módulo I. Administrarlo pide el permiso `integrations.manage`. Las claves (de la API, de un sensor, el secreto de un webhook) se devuelven una sola vez, al crearlas o cambiarlas: después solo se guarda su huella.

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/integrations/keys` | `integrations.manage` | | `{ keys: ApiKey[] }` |
| `POST /api/integrations/keys` | `integrations.manage` | `apiKeySchema` | 201 `{ keys, secret }`: `secret` es la clave entera |
| `DELETE /api/integrations/keys/:id` | `integrations.manage` | | 204; la clave deja de servir en el acto |
| `GET /api/integrations/webhooks` | `integrations.manage` | | `{ webhooks: Webhook[] }` |
| `POST /api/integrations/webhooks` | `integrations.manage` | `webhookSchema` | 201 `{ webhooks, secret }`: `secret` firma cada aviso |
| `PUT /api/integrations/webhooks/:id` | `integrations.manage` | `webhookSchema`; sin `headers`, las cabeceras que había se quedan | `{ webhooks }` |
| `DELETE /api/integrations/webhooks/:id` | `integrations.manage` | | 204 |
| `POST /api/integrations/webhooks/:id/secret` | `integrations.manage` | | `{ secret }`; el anterior deja de valer |
| `GET /api/integrations/webhooks/:id/deliveries` | `integrations.manage` | | `{ deliveries: WebhookDelivery[] }`: los últimos 50 envíos |
| `POST /api/integrations/webhooks/:id/test` | `integrations.manage` | | `{ deliveries }`, con el aviso de prueba ya enviado |
| `GET /api/integrations/automations` | `integrations.manage` | | `{ automations: Automation[] }` |
| `POST /api/integrations/automations` | `integrations.manage` | `automationSchema`. La acción es avisar a unos correos o teléfonos por un canal (`notify`), avisar a un webhook de la cuenta (`webhook`) o abrir una orden de trabajo (`order`). Por el canal Personalizado los destinos son opcionales: cada uno llena sus variables de la persona, y sin ninguno se envía una vez | 201 `{ automations }` |
| `PUT /api/integrations/automations/:id` | `integrations.manage` | `automationSchema` | `{ automations }` |
| `DELETE /api/integrations/automations/:id` | `integrations.manage` | | 204 |
| `GET /api/integrations/automations/:id/runs` | `integrations.manage` | | `{ runs: AutomationRun[] }`: las últimas 50 veces que actuó |
| `GET /api/integrations/sensors` | Con sesión | | `{ sensors: Sensor[] }` |
| `POST /api/integrations/sensors` | `integrations.manage` | `sensorSchema` | 201 `{ sensors, secret }`: `secret` es la clave del sensor |
| `PUT /api/integrations/sensors/:id` | `integrations.manage` | `sensorSchema` | `{ sensors }` |
| `DELETE /api/integrations/sensors/:id` | `integrations.manage` | | 204 |
| `POST /api/integrations/sensors/:id/key` | `integrations.manage` | | `{ secret }`; la clave anterior deja de valer |
| `GET /api/integrations/sensors/:id/readings` | Con sesión | `?from&to` | `{ series: SensorSeries }` |
| `GET /api/integrations/export/:kind` | Con sesión | `kind`: `vehicles`, `drivers` o `geofences`; `?format=csv` o `xlsx` | El archivo |
| `POST /api/integrations/import/:kind` | `integrations.manage` | `{ csv }`, con las columnas de `TRANSFER_INFO` | `{ result: ImportResult }`: lo creado, lo que ya existía y los fallos fila por fila |

#### Cómo llega un webhook

Un `POST` con cuerpo JSON `{ id, type, label, createdAt, event }` y estas cabeceras: `X-OpenGPS-Event` (el tipo), `X-OpenGPS-Delivery` (el número del envío), `X-OpenGPS-Timestamp` y `X-OpenGPS-Signature: t=<segundos>,v1=<firma>`. La firma es el HMAC-SHA256, en hexadecimal, de `<segundos>.<cuerpo>` con el secreto del webhook. Una respuesta 2xx lo da por entregado; cualquier otra cosa se reintenta al minuto, a los 5 y 30 minutos, a las 2 y a las 6 horas. En el servidor de producción solo se envía por HTTPS y nunca a direcciones internas.

#### API pública · `/api/v1`

La usa otro sistema con una clave de la cuenta (`Authorization: Bearer gps_…`), sin sesión. Cada clave admite 120 consultas por minuto (`X-RateLimit-*`, y 429 con `Retry-After` al pasarse). Su descripción completa, en formato OpenAPI, está en `/api/v1/openapi.json`.

| Ruta | Clave | Envía | Devuelve |
|---|---|---|---|
| `GET /api/v1` | Ninguna | | Nombre, versión y dónde está la documentación |
| `GET /api/v1/openapi.json` | Ninguna | | La descripción OpenAPI 3 |
| `GET /api/v1/vehicles` | De lectura | | `{ vehicles }`, con equipo, estado, última posición, odómetro y horas de motor |
| `GET /api/v1/vehicles/:id` | De lectura | | `{ vehicle }` |
| `GET /api/v1/vehicles/:id/positions` | De lectura | `?from&to` | `{ positions }` |
| `GET /api/v1/vehicles/:id/trips` | De lectura | `?from&to` | `{ summary, trips }` |
| `GET /api/v1/events` | De lectura | `?after&limit&vehicleId&type&alerts` | `{ events, last }`: del más antiguo al más reciente; `last` se envía como `after` en la siguiente consulta |
| `GET /api/v1/geofences` | De lectura | | `{ geofences }` |
| `GET /api/v1/groups` | De lectura | | `{ groups }` |
| `GET /api/v1/drivers` | De lectura; módulo B | | `{ drivers }` |
| `GET /api/v1/maintenance/orders` | De lectura; módulo E | `?status&vehicleId&from&to` | `{ orders }` |
| `GET /api/v1/routes/trips` | De lectura; módulo H | `?from&to` | `{ trips }` |
| `POST /api/v1/routes/trips` | De escritura; módulo H | `routeTripSchema` | 201 `{ trip }` |
| `POST /api/v1/vehicles/:id/fuel/fills` | De escritura; módulo F | `fuelFillSchema` | 201 `{ fill }` |
| `POST /api/v1/sensors/readings` | La del sensor (`sns_…`) | Una lectura `{ value, at? }` o una lista de hasta 500 | 201 `{ stored }` |

### Notificaciones

Cada aviso de la cuenta dice a quién se avisa, de qué y por qué canal. Los canales los conecta quien administra la plataforma; la cuenta solo usa los que estén conectados. Una persona recibe únicamente lo que trata de vehículos que puede ver.

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/notifications` | `notifications.manage` | | `{ notifications: AccountNotification[], options: NotificationOptions }`: los avisos y lo que su pantalla necesita (canales conectados, personas y si tienen teléfono, roles, alertas y uso de los canales con tope) |
| `POST /api/notifications` | `notifications.manage` | `accountNotificationSchema`: canal (`email`, `sms`, `webhook` o `push`), a quién (`everyone`, `roles`, `userIds` y, solo en `email` y `sms`, `addresses`), de qué (`events`, `ruleIds`) y de qué vehículos (`groupIds` o `vehicleIds`) | 201 `{ notifications }` |
| `PUT /api/notifications/:id` | `notifications.manage` | `accountNotificationSchema` | `{ notifications }` |
| `DELETE /api/notifications/:id` | `notifications.manage` | | 204 |
| `POST /api/notifications/:id/test` | `notifications.manage` | | `{ deliveries: Delivery[] }`: envía ahora un mensaje de prueba a todos sus destinos y devuelve cómo fue |
| `GET /api/notifications/deliveries` | `notifications.manage` | | `{ deliveries: Delivery[] }`: los últimos mensajes de la cuenta, a dónde fueron y cómo terminaron |

Las direcciones escritas a mano (`addresses`) solo las cambia quien ve toda la cuenta. El canal Personalizado (`webhook`) llama al sistema que configuró quien administra la plataforma: si su dirección, cabeceras o cuerpo usan datos de la persona (`{{name}}`, `{{email}}`, `{{phone}}`, `{{phone_digits}}`, `{{language}}`), cada persona del aviso recibe su propio mensaje; si no, se envía uno solo por aviso, y `options.customPerPerson` lo dice. Quien ve solo unos grupos o vehículos crea avisos para esos, y ve y cambia los que no abarcan nada más. Los correos tienen un tope por hora y cuenta; los SMS de Twilio, un tope mensual por cuenta que fija la plataforma: lo que no sale por un tope queda en la bitácora como rechazado. Push llega a las personas de la cuenta que tengan la app móvil; mientras la app no reciba avisos push, nadie lo recibe y su prueba lo dice.

### Grupos, usuarios y roles

| Ruta | Permiso | Envía | Devuelve |
|---|---|---|---|
| `GET /api/groups` | Con sesión | | `{ groups: VehicleGroup[] }` |
| `POST /api/groups` | `vehicles.manage` | `groupSchema` | 201 `{ group }` |
| `PATCH /api/groups/:id` | `vehicles.manage` | `groupSchema` | `{ groups }` |
| `DELETE /api/groups/:id` | `vehicles.manage` | | 204 |
| `GET /api/members` | `members.manage` | | `{ members, invitations, roles }` |
| `POST /api/members/invitations` | `members.manage` | `inviteSchema`. Con `groups` en `null` la persona ve toda la cuenta; con una lista ve esos grupos y, además, los vehículos sueltos de `vehicles` | 201 `{ invitation }` |
| `DELETE /api/members/invitations/:id` | `members.manage` | | 204 |
| `PATCH /api/members/:id` | `members.manage` | `memberUpdateSchema`: el rol, los grupos (`groups`), los vehículos sueltos (`vehicles`) o el bloqueo | 204 |
| `DELETE /api/members/:id` | `members.manage` | | 204 |
| `POST /api/roles` | `members.manage` | `roleSchema` | 201 `{ roles }` |
| `PATCH /api/roles/:id` | `members.manage` | `roleSchema` | `{ roles }` |
| `DELETE /api/roles/:id` | `members.manage` | | 204 |
| `GET /api/invitations/:id` | Pública | | `{ invitation: InvitationPreview }` |
| `POST /api/invitations/:id/accept` | Con sesión | | 204 |
| `GET /api/audit` | `audit.view` | `?limit&before` | `{ entries: AuditEntry[] }` |
| `GET /api/account/summary` | | | `{ summary: AccountSummary }`: vehículos, los que reportan, personas y eventos del último día, contando solo lo que la persona puede ver |

Crear, renombrar y borrar grupos exige además ver todos los grupos de la cuenta.

### Consola de la plataforma

Solo para quien administra la plataforma: la primera persona que se registró y confirmó su correo. A los demás estas rutas les responden 404.

| Ruta | Envía | Devuelve |
|---|---|---|
| `GET /api/admin/stats` | | `{ stats: PlatformStats }` |
| `GET /api/admin/audit` | `?limit&before` | `{ entries: AuditEntry[] }`: lo hecho desde la administración de la plataforma |
| `GET /api/admin/accounts` | `?search&limit&offset` | `{ accounts: AdminAccount[] }` |
| `GET /api/admin/accounts/:id` | | `{ account: AdminAccountDetail }` |
| `PATCH /api/admin/accounts/:id` | `accountAdminSchema` | `{ account }` |
| `POST /api/admin/users/:id/ban` | `{ banned, reason }` | 204 |
| `POST /api/admin/accounts/:id/delete` | `{ word: "ELIMINAR" }` (o `DELETE`) | 204. Borra la cuenta con sus vehículos, equipos, historial, archivos y registro; sus personas quedan. 403 si su dueño administra la plataforma |
| `POST /api/admin/users/:id/delete` | `{ word: "ELIMINAR" }` (o `DELETE`) | 204. Borra a la persona y las cuentas de las que es dueña; de las demás solo sale. 403 si administra la plataforma |
| `GET /api/admin/settings` | | `{ settings: PlatformSettings }`. Las claves no vienen: solo si hay una guardada |
| `PUT /api/admin/settings/:section` | El esquema de la sección: `general`, `passwords`, `mail`, `storage`, `backups`, `channels`, `oauth` o `mailTemplates` | `{ settings }`. Vale desde ese momento. En `backups`, `cron` es una expresión de horario de cinco campos, en UTC, con al menos una hora entre copias. En `storage`, `provider` es uno de la lista de proveedores y `flags` son los argumentos adicionales para rclone, uno por elemento: se rechazan los que la plataforma no admite y los que rclone no conoce. En `channels.webhook` (Personalizado), `method` es `POST`, `GET` o `PUT`; `url`, `headers` (sin el campo se conservan las guardadas, y de ellas solo vuelven los nombres en `headerNames`) y `body` pueden llevar variables `{{nombre}}` de `CUSTOM_VARIABLES`, salvo en el servidor de la dirección; un cuerpo vacío envía todas las variables como JSON. En `oauth`, cada servicio (`google`, `github`, `facebook`, `apple`, `custom`) lleva su ID de cliente y su secreto (en Apple, el contenido del archivo `.p8`, con `teamId` y `keyId`; en `custom`, `name`, `issuer` y `scopes`); los secretos no vuelven, solo `hasSecret`. En `mailTemplates`, por correo (`MAIL_TEMPLATES`) y por idioma, `subject`, `heading`, `body` y `action` (el texto del botón): solo lo que se cambió; lo que falta sale con el texto de fábrica. Cada campo puede usar las variables `{{nombre}}` de ese correo (`MAIL_TEMPLATE_VARIABLES`) y ninguna otra |
| `DELETE /api/admin/settings/:section` | | `{ settings }`. La sección vuelve a sus valores de fábrica y se borran sus claves guardadas |
| `POST /api/admin/settings/mail/test` | | `{ sentTo }`: envía un correo de prueba a quien lo pide |
| `GET /api/admin/settings/mail/templates` | | `{ templates }`: cada correo que escribe la plataforma, con sus variables, si lleva botón y su texto de fábrica en cada idioma |
| `POST /api/admin/settings/storage/test` | Opcional: los datos de `storage` tal como están en el formulario, para probarlos sin guardarlos. Sin `secretAccessKey` vale la clave guardada. Sin cuerpo se prueba lo guardado | 204 si escribe, lee y borra en el almacenamiento externo; 400 con el motivo si no |
| `POST /api/admin/channels/:channel/test` | `{ to }`: un correo o un teléfono, según el canal (`email`, `sms`); en `webhook`, opcional, un correo o un teléfono que llena sus variables de la persona. `push` responde 400 hasta que la app móvil reciba avisos push | `{ sentTo }`: envía ahora un mensaje de prueba con lo guardado. 400, con el motivo que dio el servicio, si no salió |
| `GET /api/admin/notifications` | | `{ notifications: SystemNotification[], deliveries: Delivery[] }`: los avisos del sistema y sus últimos mensajes |
| `POST /api/admin/notifications` | `systemNotificationSchema`: canal (`email`, `sms` o `webhook`), destino (en `webhook`, opcional: un correo o un teléfono para sus variables) y de qué avisa (`SYSTEM_EVENTS`) | 201 `{ notifications }` |
| `PUT /api/admin/notifications/:id` | `systemNotificationSchema` | `{ notifications }` |
| `DELETE /api/admin/notifications/:id` | | 204 |
| `POST /api/admin/notifications/:id/test` | | `{ deliveries }`: envía ahora un mensaje de prueba a ese destino |
| `GET /api/admin/backups` | | `{ info: BackupsInfo }`: las copias, si hay una en marcha, cuándo toca la próxima, si se puede restaurar (`canRestore`: la plataforma tiene acceso a las bases) y en qué va la última restauración (`restore`) |
| `POST /api/admin/backups` | | 202 `{ info }`: empieza una copia. 409 si ya hay una en marcha |
| `POST /api/admin/backups/discover` | | `{ found, added, info }`. Busca en la carpeta `backups/` del almacenamiento externo las copias completas que no estén en la lista y las agrega como `imported`. `found` son las que hay allí; `added`, las nuevas. 400 si el almacenamiento no está configurado o no responde |
| `POST /api/admin/backups/:id/restore` | `{ word: "RESTAURAR" }` | 202 `{ info }`. Hace antes una copia de cómo está todo y deja el pedido, que la plataforma restaura sola (ADR-0009): restaura aparte sin dejar de servir y se reinicia un momento para cambiar las bases; `info.restore` dice en qué va. 400 si este servidor no tiene acceso a las bases o la copia no está completa; 409 si ya hay una restauración o una copia en marcha |
| `DELETE /api/admin/backups/:id` | | 204. La borra del servidor y del almacenamiento externo |
| `GET /api/admin/backups/:id/files/:name` | | Uno de los archivos de la copia |
| `GET /api/admin/updates` | | `{ updates: UpdateStatus }`: la versión que corre (`current`), la última release del repositorio de `UPDATE_REPOSITORY` (`latest`, con su nombre, notas, dirección y fecha), si es más nueva (`available`), cuándo se consultó y por qué falló la última consulta (`error`: `unreachable`, `rate_limited`, `unexpected`). `install` dice cómo se instala (`mode`: `console`, desde la consola; `manual`, a mano, como con Dokploy; `source`, construida desde el código) y cómo va o cómo terminó la última instalación pedida (`last`). Consulta GitHub si la última vez fue hace más de una hora |
| `POST /api/admin/updates/check` | | `{ updates }`: consulta ahora, salvo que se haya consultado hace menos de un minuto |
| `POST /api/admin/updates/install` | `{ version }`, la última publicada | 202 `{ updates }`. Hace antes una copia de todo (tipo `pre_update`) y deja el pedido al ayudante, que instala la versión y vuelve a la anterior si no arranca (ADR-0004). 400 si no es la última versión más nueva que la instalada, o si la instalación no se actualiza desde la consola; 409 si ya hay una actualización, una restauración o una copia en marcha |
| `GET /api/admin/simulator/meta` | | `{ meta: SimulatorMeta }`: las marcas que habla el simulador (con el formato de su identificador y lo que cada una transporta), la dirección que se da a los equipos reales para llegar a esta plataforma (`host`, con la que nace cada equipo simulado), y cuántos equipos simulados están corriendo (`running`). `routing` dice si hay servicio de rutas para trazar por calles y `placeSearch`, si el servicio de direcciones busca lugares |
| `GET /api/admin/simulator/routes` | | `{ routes: SimRouteSummary[] }`: las rutas que recorren los equipos simulados |
| `POST /api/admin/simulator/routes` | `simRouteSchema`: nombre, los puntos marcados (`waypoints`), si va por calles (`snapped`), el trazo (`line`) y los segundos acumulados en cada punto (`secs`, o `null` para ir a velocidad de crucero) | 201 `{ route: SimRoute }` |
| `GET /api/admin/simulator/routes/:id` | | `{ route: SimRoute }`: la ruta con sus puntos y su trazo, para editarla |
| `PUT /api/admin/simulator/routes/:id` | `simRouteSchema` | `{ route }`. Los equipos simulados que la recorren empiezan de nuevo sobre el trazo cambiado |
| `DELETE /api/admin/simulator/routes/:id` | | 204. 409 `route_in_use` si algún equipo simulado la recorre |
| `POST /api/admin/simulator/route-line` | `{ points: [{ lon, lat }] }`, de 2 a 25 | `{ trace: SimTrace }`: el trazo por calles que pasa por esos puntos, con sus segundos y su largo, pedido al servicio de rutas. No guarda nada. 400 `routing_off` si el servicio está apagado y `no_route` si no hay camino; 502 `routing_failed` si no respondió |
| `GET /api/admin/simulator/trip-line` | `?vehicleId=&from=&to=` | `{ line, lengthM }`: el trazo que hizo un vehículo de la cuenta del dueño en ese periodo, para usarlo como ruta. 400 si no hay recorrido |
| `GET /api/admin/simulator/places` | `?q=` | `{ places: SimPlace[] }`: lugares que coinciden con una dirección escrita, el más probable primero. Se pide al enviar, nunca mientras se escribe. 400 `places_off` si el servicio de direcciones está apagado; 502 `places_failed` si no respondió |
| `GET /api/admin/simulator/simulations` | | `{ simulations: SimulationSummary[] }`: cada equipo simulado con su estado |
| `POST /api/admin/simulator/simulations` | `simulationSchema`: nombre, marca (`modelId`), identificadores, el servidor y el puerto a los que se conecta (`host` y `port`), segundos entre reportes, ruta y cómo la recorre (`scenario`: velocidad, final de la ruta, pausas, lo que reporta el equipo —combustible, llave del conductor, parámetros numerados— y `actions`, lo que pasa en el camino: paradas, carga y descarga de combustible, exceso de velocidad, arranque desactivado, remolque, alarmas, pérdida de señal, cambio de conductor y códigos de falla, cada cosa a sus metros del inicio) | 201 `{ simulation: SimulationDetail }`. 409 si un identificador ya está en otra simulación. 400 `not_carried` si la ruta pide algo que esa marca no transporta. El identificador se da de alta aparte, con `POST /api/vehicles`, como un GPS real |
| `GET /api/admin/simulator/simulations/:id` | | `{ simulation: SimulationDetail }`: si su servidor es esta plataforma (`toPlatform`), su ruta con el lugar de cada cosa que pasa en ella (`route.marks`), dónde va cada equipo, su combustible, lo enviado y lo que guarda sin señal, lo que la plataforma recibió y cuánto tardó, y su bitácora |
| `PUT /api/admin/simulator/simulations/:id` | `simulationSchema` | `{ simulation }`. Si estaba en marcha, empieza de nuevo con lo que cambió |
| `DELETE /api/admin/simulator/simulations/:id` | | 204. Si estaba en marcha, la detiene antes. El vehículo y su historial no se tocan |
| `POST /api/admin/simulator/simulations/:id/run` | `{ run }` | `{ simulation }`: la inicia o la detiene. 400 al iniciar si el simulador aún no habla su marca o su ruta ya no existe |
| `POST /api/admin/simulator/simulations/:id/inject` | `simInjectSchema`: `{ kind: "alarm", alarm }`, `{ kind: "engineLock", on }`, `{ kind: "theft", seconds }`, `{ kind: "fuel", pct, seconds }` (negativo descarga) o `{ kind: "disconnect", seconds }` | `{ simulation }`: lo hace al momento en los equipos de esa simulación. 409 `not_running` si está detenida; 400 `not_carried` si la marca no lo transporta y `no_tank` si el equipo no reporta combustible |
| `POST /api/admin/simulator/simulations/:id/backfill` | `{ hoursAgo }`, de 0 a 720; por defecto 24 | `{ simulation, reports }`: envía una vuelta completa de su ruta como un viaje que terminó hace esas horas, con la hora que habría tenido cada reporte. 409 `not_running` o `not_connected`; 400 `backfill_too_long` si serían más de 5000 reportes |
| `POST /api/admin/simulator/run` | `{ run }` | `{ simulations }`: inicia o detiene todas; las que no pueden iniciar, por su marca o su ruta, quedan detenidas |

### Canal en vivo

| Ruta | Quién | Qué es |
|---|---|---|
| `GET /api/live` | Con sesión | WebSocket. El servidor envía mensajes `LiveMessage`; el cliente no envía nada |

Mensajes que llegan por el canal:

| `type` | Cuándo | Qué hacer |
|---|---|---|
| `hello` | Al conectar | Nada |
| `position` | Un vehículo reportó | Actualizar su `state` |
| `device` | Cambió el equipo de un vehículo | Actualizar su `device` |
| `vehicles_changed` | Se creó, editó o borró un vehículo o un grupo | Volver a pedir vehículos y grupos |
| `geofences_changed` | Cambió una geocerca | Volver a pedir las geocercas |
| `event` | Ocurrió un evento | Mostrarlo si pide atención (`ALERT_EVENTS`) |
| `incidents_changed` | Módulo A: se abrió o cambió un incidente | Volver a pedir los incidentes |
| `security_changed` | Módulo A: cambió el bloqueo o el modo recuperación de un vehículo | Volver a pedir su `security` |
| `drivers_changed` | Módulo B: cambiaron los conductores o quién conduce | Volver a pedir los conductores |

Si el servidor cierra el canal con el código 4001, cambió el acceso de la persona: se vuelve a conectar y a pedir `GET /api/me`. Ante cualquier otro corte se reconecta con espera creciente y se piden de nuevo los vehículos.

## Sesión

Las rutas bajo `/api/auth/` las atiende la librería de sesión. Las que usan la web y las apps:

| Ruta | Para qué |
|---|---|
| `POST /api/auth/sign-up/email` | Registro. Lleva `name`, `email`, `password` y `legalVersion`, la versión de los términos que la persona aceptó |
| `POST /api/auth/sign-in/email` | Entrar con correo y contraseña |
| `POST /api/auth/sign-in/social` | Entrar con otro servicio: `provider` (uno de `signIn` de `GET /api/config`), `callbackURL` y `errorCallbackURL`. Devuelve la dirección del servicio (`url`) a la que llevar a la persona. Solo entra quien ya tiene cuenta, salvo que lleve `requestSignUp: true` y `additionalData: { legalVersion }`: así lo piden la entrada y el registro de la web, que muestran los términos junto a los botones, y quien no tenía cuenta la obtiene al volver. Si algo falla, el servicio devuelve a la persona a `errorCallbackURL` con `?error=` (`signup_disabled`, `account_not_linked`, `LEGAL_NOT_ACCEPTED`, `REGISTRATION_CLOSED`…) |
| `GET /api/auth/callback/:provider` | La dirección de regreso que se registra en cada servicio |
| `POST /api/auth/one-time-token/verify` | La app móvil cambia el pase de `POST /api/app/oauth` (`{ token }`) por la cookie de su sesión. Un pase sirve una sola vez: el segundo intento responde 400. `GET /api/auth/one-time-token/generate` no se puede usar desde fuera: responde 400 |
| `POST /api/auth/sign-out` | Cerrar sesión |
| `GET /api/auth/passkey/generate-register-options` | Opciones para crear una passkey (WebAuthn), con una sesión de menos de un día. Deja una cookie con el reto, que vuelve en la verificación |
| `POST /api/auth/passkey/verify-registration` | Guarda la passkey: `response`, lo que devolvió el navegador, y `name`, opcional |
| `GET /api/auth/passkey/generate-authenticate-options` | Opciones para entrar con una passkey, sin sesión ni correo. Deja una cookie con el reto |
| `POST /api/auth/passkey/verify-authentication` | Entrar con una passkey: `response`. Abre la misma sesión que el correo y la contraseña |
| `GET /api/auth/passkey/list-user-passkeys` | Las passkeys propias: `id`, `name`, `createdAt`, `deviceType`, `backedUp` (sincronizada) y `aaguid` |
| `POST /api/auth/passkey/update-passkey` | Cambiar el nombre de una propia: `id` y `name` |
| `POST /api/auth/passkey/delete-passkey` | Borrar una propia: `id` |
| `GET /api/auth/verify-email` | Enlace del correo de verificación |
| `POST /api/auth/send-verification-email` | Volver a enviar el correo de verificación |
| `POST /api/auth/request-password-reset` | Pedir el correo para cambiar la contraseña |
| `POST /api/auth/reset-password` | Cambiar la contraseña con el enlace del correo |
| `POST /api/auth/delete-user` | Eliminar la cuenta propia, con la contraseña; quien no tiene contraseña (`me.user.hasPassword` en falso), sin ella y con una sesión de menos de un día. Quien administra la plataforma no puede: responde 403 con `code: "PLATFORM_OWNER"` |

Las rutas `/api/auth/passkey/*` solo responden si `GET /api/config` dice `passkeys: true`: la plataforma tiene HTTPS y un nombre de dominio (o es `localhost`), y la consola no las apagó (`passkeysEnabled` en la sección `general`). Si no, responden 404 con `code: "passkeys_off"`. Cada passkey pide Face ID, huella o PIN, y es del dominio de `PUBLIC_URL`: si la instalación cambia de dominio, dejan de servir (ADR-0020).

La app crea passkeys en la página `/app-passkey`, que abre en la ventana de inicio de sesión del sistema en modo efímero. Ahí la persona vuelve a entrar y crea la passkey. La página cierra esa sesión y vuelve a `opengps://passkey?created=1`, o a `opengps://passkey?error=` con `access_denied` (canceló) o `unavailable` (la plataforma o el navegador no tienen passkeys) (ADR-0023). Las ve, renombra y borra con su propia sesión y las rutas de arriba, que no piden una sesión de menos de un día (ADR-0024).

Las rutas `/api/auth/organization/*` y `/api/auth/admin/*` no están disponibles: responden 404. Las cuentas, los usuarios y los roles se administran con las rutas de este documento.
