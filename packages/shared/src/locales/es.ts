// Texts of the shared package in Spanish, the reference language: every other
// language must have exactly these keys (the compiler checks it).
//
// A label table has one branch, with one text per value: "event.speeding",
// "alertType.sos". What a helper says and the validation messages of the schemas
// come after the tables. A text that depends on a number has two forms, `_one`
// and `_other`, and is asked for by its base key with a `count`.
export const es = {
  // ─── Geofences and events ──────────────────────────────────────────────────────

  geofenceKind: {
    notify: "Zona de paso",
    forbidden: "Zona prohibida",
    authorized: "Zona autorizada",
  },
  geofenceKindNote: {
    notify: "Anota cada entrada y cada salida",
    forbidden: "Avisa cuando un vehículo entra",
    authorized: "Avisa cuando un vehículo sale",
  },
  event: {
    geofence_enter: "Entró a la zona",
    geofence_exit: "Salió de la zona",
    zone_forbidden: "Entró a una zona prohibida",
    zone_left: "Salió de su zona autorizada",
    stay_short: "Estuvo menos tiempo del mínimo",
    stay_long: "Lleva más tiempo del máximo",
    route_deviation: "Se desvió de la ruta",
    route_return: "Volvió a la ruta",
    speeding: "Exceso de velocidad",
    ignition_off_hours: "Encendido fuera de horario",
    signal_lost: "Perdió la señal",
    signal_back: "Recuperó la señal",
    unauthorized_movement: "Se movió estando estacionado",
    sos: "Botón de pánico",
    power_cut: "Desconexión de la batería",
    tow: "Posible remolque",
    harsh_driving: "Conducción brusca",
    custom: "Alerta personalizada",
    tampering: "Manipulación del equipo GPS",
    jamming: "Posible inhibidor de señal",
    engine_locked: "Arranque bloqueado",
    engine_unlocked: "Arranque desbloqueado",
    driving_time: "Demasiado tiempo al volante",
    fuel_refuel: "Carga de combustible",
    fuel_drain: "Descarga de combustible",
    fuel_theft: "Posible robo de combustible",
    engine_fault: "Código de falla del motor",
    engine_fault_cleared: "Código de falla resuelto",
    engine_overrev: "Motor pasado de revoluciones",
    engine_overheat: "Motor recalentado",
    battery_low: "Batería del vehículo baja",
    service_soon: "Servicio de mantenimiento próximo",
    service_due: "Servicio de mantenimiento vencido",
    expiry_soon: "Documento por vencer",
    expiry_due: "Documento vencido",
    sensor_alert: "Sensor fuera de rango",
  },

  // ─── Anti-theft and commands ───────────────────────────────────────────────────

  commandStatus: {
    waiting: "Esperando el momento seguro",
    sent: "Enviada al equipo",
    confirmed: "Confirmada por el equipo",
    unconfirmed: "El equipo no la confirmó",
    failed: "No se pudo enviar",
    expired: "Venció sin enviarse",
    cancelled: "Cancelada",
  },
  incidentKind: {
    sos: "Botón de pánico",
    tow: "Remolque",
    tampering: "Manipulación del equipo GPS",
    jamming: "Posible inhibidor de señal",
    power_cut: "Desconexión de la batería",
    movement: "Movimiento estando estacionado",
    manual: "Reportado por una persona",
  },
  incidentStatus: {
    open: "Sin atender",
    attended: "En atención",
    closed: "Cerrado",
  },
  incidentResolution: {
    recovered: "Vehículo recuperado",
    false_alarm: "Falsa alarma",
    resolved: "Resuelto",
    other: "Otro",
  },

  // ─── Drivers ───────────────────────────────────────────────────────────────────

  /** Driving events, as a count of them is titled. */
  driverEvent: {
    accel: "Aceleraciones bruscas",
    brake: "Frenadas fuertes",
    corner: "Giros agresivos",
    speeding: "Excesos de velocidad",
  },
  /** The name of a single driving event. */
  driverEventOne: {
    accel: "Aceleración brusca",
    brake: "Frenada fuerte",
    corner: "Giro agresivo",
    speeding: "Exceso de velocidad",
  },

  // ─── Diagnostics ───────────────────────────────────────────────────────────────

  diagParam: {
    rpm: "Revoluciones",
    coolantTemp: "Temperatura del motor",
    power: "Batería del vehículo",
    engineLoad: "Carga del motor",
    throttle: "Acelerador",
    obdSpeed: "Velocidad que marca el vehículo",
    fuelLevel: "Nivel de combustible",
    fuelLevelL: "Combustible en el tanque",
    fuelUsed: "Combustible gastado, contador",
    fuelRate: "Consumo del momento",
    intakeTemp: "Temperatura del aire de admisión",
    oilTemp: "Temperatura del aceite",
    ecuOdometer: "Odómetro del vehículo",
    ecuHours: "Horas de motor del vehículo",
    moduleVoltage: "Voltaje de la computadora",
    engineRuntime: "Tiempo desde el arranque",
    deviceBattery: "Batería del equipo GPS",
  },
  /** Vehicle system a fault code belongs to, by its first letter. */
  dtcSystem: {
    P: "Motor y transmisión",
    C: "Chasis",
    B: "Carrocería",
    U: "Red de comunicación",
  },

  // ─── Fleet ─────────────────────────────────────────────────────────────────────

  /** Kinds of vehicle offered in the fleet profile. */
  fleetKind: {
    car: "Automóvil",
    pickup: "Camioneta",
    truck: "Camión",
    motorcycle: "Motocicleta",
    bus: "Autobús",
    machinery: "Maquinaria",
    trailer: "Remolque",
    other: "Otro",
  },
  fleetAvailability: {
    available: "Disponible",
    on_route: "En ruta",
    workshop: "En taller",
    out_of_service: "Fuera de servicio",
  },
  fleetState: {
    active: "De alta",
    suspended: "Suspendido",
    retired: "De baja",
  },
  fleetExpense: {
    fuel: "Combustible",
    maintenance: "Mantenimiento",
    toll: "Peajes",
    fine: "Multas",
    insurance: "Seguros",
    tax: "Impuestos y matrícula",
    parking: "Estacionamiento",
    other: "Otros",
  },
  fleetDocument: {
    photo: "Foto del vehículo",
    registration: "Matrícula o tarjeta de circulación",
    insurance: "Seguro",
    inspection: "Revisión técnica",
    permit: "Permiso",
    invoice: "Factura",
    other: "Otro",
  },

  // ─── Maintenance ───────────────────────────────────────────────────────────────

  /** Common service plans, offered to avoid starting from scratch. */
  maintTemplate: {
    oil: "Cambio de aceite y filtro",
    tires: "Rotación de llantas",
    air: "Filtro de aire",
    brakes: "Revisión de frenos",
    major: "Servicio mayor",
  },
  maintDue: {
    ok: "Al día",
    soon: "Próximo",
    due: "Vencido",
  },
  maintExpiry: {
    insurance: "Seguro",
    inspection: "Revisión técnica",
    registration: "Matrícula",
    license: "Licencia de conducir",
    permit: "Permiso",
    other: "Otro",
  },
  maintOrderKind: {
    preventive: "Preventivo",
    corrective: "Correctivo",
  },
  maintOrderStatus: {
    open: "Abierta",
    in_progress: "En proceso",
    done: "Terminada",
    cancelled: "Anulada",
  },
  maintWorkshop: {
    workshop: "Taller",
    supplier: "Proveedor",
  },

  // ─── Routes and logistics ──────────────────────────────────────────────────────

  poiCategory: {
    client: "Cliente",
    warehouse: "Bodega",
    branch: "Sucursal",
    fuel: "Gasolinera",
    workshop: "Taller",
    parking: "Estacionamiento",
    other: "Otro",
  },
  routeTripStatus: {
    assigned: "Asignada",
    in_progress: "En curso",
    done: "Terminada",
    cancelled: "Anulada",
  },
  routeStopStatus: {
    pending: "Pendiente",
    arrived: "En el lugar",
    done: "Entregado",
    failed: "No se entregó",
    skipped: "Omitida",
  },

  // ─── Fuel ──────────────────────────────────────────────────────────────────────

  fuelKind: {
    percent: "Porcentaje del tanque",
    liters: "Litros",
    raw: "Valor del sensor, con tabla de calibración",
  },
  fuelCounter: {
    l: "Litros",
    dl: "Décimas de litro",
    ml: "Mililitros",
  },
  fuelFillSource: {
    manual: "Anotado a mano",
    imported: "Importado",
    detected: "Detectado por el sensor",
  },
  /** Currencies offered to choose from, by their code. */
  currency: {
    HNL: "Lempira hondureño",
    USD: "Dólar estadounidense",
    GTQ: "Quetzal guatemalteco",
    NIO: "Córdoba nicaragüense",
    CRC: "Colón costarricense",
    PAB: "Balboa panameño",
    BZD: "Dólar beliceño",
    MXN: "Peso mexicano",
    DOP: "Peso dominicano",
    COP: "Peso colombiano",
    VES: "Bolívar venezolano",
    PEN: "Sol peruano",
    BOB: "Boliviano",
    CLP: "Peso chileno",
    ARS: "Peso argentino",
    UYU: "Peso uruguayo",
    PYG: "Guaraní paraguayo",
    BRL: "Real brasileño",
    EUR: "Euro",
    CAD: "Dólar canadiense",
  },

  // ─── Reports and dashboards ────────────────────────────────────────────────────

  report: {
    trips: "Recorridos",
    stops: "Paradas",
    mileage: "Kilometraje",
    speed: "Velocidades",
    geofences: "Geocercas",
    alarms: "Alarmas",
    utilization: "Utilización",
    drivers: "Conductores",
    fuel: "Combustible",
    maintenance: "Mantenimiento",
  },
  reportNote: {
    trips: "Cada viaje con su origen, destino, distancia y velocidades",
    stops: "Dónde se detuvo cada vehículo y por cuánto tiempo",
    mileage: "Kilómetros por día, por vehículo y por grupo",
    speed: "Velocidad máxima y promedio, y cada exceso sobre el límite que elijas",
    geofences: "Entradas, salidas y tiempo dentro de cada geocerca",
    alarms: "Avisos por tipo, por vehículo y por día",
    utilization: "Cuánto se usó cada vehículo y cuánto estuvo sin usarse",
    drivers: "Puntaje, eventos y horas al volante de cada conductor",
    fuel: "Consumo, cargas, descargas, rendimiento y costos de los vehículos con tanque configurado",
    maintenance: "Servicios hechos, lo que costaron y lo que está pendiente",
  },
  reportFrequency: {
    daily: "Cada día",
    weekly: "Cada semana",
    monthly: "Cada mes",
  },
  /** What period each delivery of a scheduled report covers. */
  reportFrequencyPeriod: {
    daily: "el día anterior",
    weekly: "los siete días anteriores",
    monthly: "el mes anterior",
  },
  dashboardWidget: {
    totals: "Totales del periodo",
    fleet: "Estado actual de la flota",
    distance_by_day: "Kilómetros por día",
    usage_by_day: "Horas de uso por día",
    top_distance: "Vehículos con más kilómetros",
    least_used: "Vehículos con menos uso",
    alerts_by_type: "Alertas por tipo",
    alerts_by_day: "Alertas por día",
    driver_scores: "Puntaje de conductores",
  },
  dashboardWidgetNote: {
    totals: "Kilómetros, viajes, horas de uso, ralentí y alertas, comparados con el periodo anterior",
    fleet: "Cuántos vehículos están en movimiento, en ralentí, detenidos o sin conexión ahora",
    distance_by_day: "Lo recorrido por todos los vehículos cada día",
    usage_by_day: "Tiempo en movimiento y en ralentí cada día",
    top_distance: "Los diez que más recorrieron",
    least_used: "Los diez que menos tiempo estuvieron en viaje",
    alerts_by_type: "Qué avisos se repitieron más",
    alerts_by_day: "Cuántos avisos hubo cada día",
    driver_scores: "La clasificación del periodo",
  },
  dashboardPeriod: {
    today: "Hoy",
    "7d": "7 días",
    "30d": "30 días",
    month: "Este mes",
  },

  // ─── Alerts ────────────────────────────────────────────────────────────────────

  alertType: {
    speeding: "Exceso de velocidad",
    ignition_off_hours: "Encendido fuera de horario",
    signal_lost: "Pérdida de señal",
    parked_movement: "Movimiento estando estacionado",
    sos: "Botón de pánico",
    power_cut: "Desconexión de la batería",
    tow: "Remolque",
    harsh_driving: "Conducción brusca",
    geofence: "Avisos de geocercas",
    custom: "Personalizada",
  },
  alertTypeNote: {
    speeding: "Avisa si un vehículo pasa de un límite durante unos segundos",
    ignition_off_hours: "Avisa si encienden el motor fuera del horario permitido",
    signal_lost: "Avisa si un vehículo deja de reportar",
    parked_movement: "Avisa si un vehículo en modo estacionado se mueve",
    sos: "Avisa cuando alguien pulsa el botón de pánico del equipo",
    power_cut: "Avisa si desconectan el equipo de la batería del vehículo",
    tow: "Avisa si el vehículo se mueve con el motor apagado",
    harsh_driving: "Avisa de frenazos, acelerones y giros bruscos",
    geofence: "Elige de qué geocercas, vehículos y horas avisan las notificaciones de la cuenta",
    custom: "Tú eliges las condiciones que deben cumplirse",
  },

  // ─── Vehicles ──────────────────────────────────────────────────────────────────

  vehicleStatus: {
    no_device: "Sin GPS",
    pending: "Esperando señal",
    moving: "En movimiento",
    idle: "En ralentí",
    stopped: "Detenido",
    offline: "Sin conexión",
  },

  // ─── Platform ──────────────────────────────────────────────────────────────────

  module: {
    A: "Antirrobo y comandos",
    B: "Conductor",
    C: "Diagnóstico",
    D: "Flota",
    E: "Mantenimiento",
    F: "Combustible",
    G: "Reportes y paneles",
    H: "Rutas y logística",
    I: "Integraciones",
  },
  mailSecurity: {
    starttls: "STARTTLS (puerto 587)",
    ssl: "SSL/TLS (puerto 465)",
    none: "Sin cifrar",
  },
  backupPreset: {
    daily: "Diaria",
    "12h": "Cada 12 h",
    "6h": "Cada 6 h",
    weekly: "Semanal",
  },
  backupPart: {
    gps: "Base de la plataforma",
    traccar: "Base del receptor de equipos",
    files: "Archivos de los usuarios",
  },

  // ─── Roles and permissions ─────────────────────────────────────────────────────

  /** What a role can do. The key is the permission: "permission.vehicles.manage". */
  permission: {
    vehicles: { manage: "Agregar, editar y eliminar vehículos, GPS y grupos" },
    geofences: { manage: "Crear, editar y eliminar geocercas" },
    alerts: { manage: "Crear, editar y eliminar alertas" },
    links: { share: "Compartir la ubicación de un vehículo con un enlace" },
    commands: { send: "Bloquear y desbloquear el arranque y activar el modo recuperación" },
    incidents: { manage: "Atender y cerrar incidentes" },
    drivers: { manage: "Administrar conductores y asignarlos a vehículos" },
    reports: { schedule: "Programar informes que se envían por correo" },
    members: { manage: "Invitar usuarios y cambiar sus permisos" },
    audit: { view: "Ver el registro de actividad" },
    notifications: { manage: "Decidir a quién se avisa, de qué y por qué canal" },
    integrations: { manage: "Crear claves de la API, webhooks, automatizaciones y sensores, e importar datos" },
  },
  role: {
    admin: "Administrador",
    operator: "Operador",
    viewer: "Lector",
    owner: "Dueño",
  },
  roleDescription: {
    admin: "Todo, incluido invitar usuarios",
    operator: "Ve y administra vehículos, GPS y geocercas",
    viewer: "Solo ve el mapa y los vehículos",
    owner: "Creó la cuenta; tiene todos los permisos",
  },

  // ─── Integrations and notifications ────────────────────────────────────────────

  webhookStatus: {
    pending: "Pendiente",
    ok: "Entregado",
    failed: "Falló",
  },
  channel: {
    email: "Correo",
    sms: "Twilio",
    webhook: "Personalizado",
    push: "Push",
  },
  automationAction: {
    notify: "Avisar a un destino",
    webhook: "Avisar a un webhook",
    order: "Abrir una orden de trabajo",
  },
  sensorKind: {
    temperature: "Temperatura",
    humidity: "Humedad",
    door: "Puerta",
    level: "Nivel",
    weight: "Peso",
    other: "Otro",
  },
  transfer: {
    vehicles: "Vehículos",
    drivers: "Conductores",
    geofences: "Geocercas",
  },
  /** Columns of an import file, as the importer recognizes them. */
  transferColumns: {
    vehicles: "nombre, placa, imei, modelo, grupo",
    drivers: "nombre, licencia, telefono, llave, notas",
    geofences: "nombre, tipo, latitud, longitud, radio, puntos",
  },
  systemEvent: {
    backup_ok: "Una copia de seguridad terminó bien",
    backup_failed: "Una copia de seguridad falló",
    restore_done: "Terminó una restauración",
    disk_high: "El disco del servidor se está llenando",
    ingest_stalled: "Dejaron de llegar posiciones de los GPS",
    channel_failing: "Un canal de aviso está fallando",
    account_created: "Se creó una cuenta nueva",
  },

  // ─── Schedules, storage and confirmations ──────────────────────────────────────

  weekday: {
    sunday: "Domingo",
    monday: "Lunes",
    tuesday: "Martes",
    wednesday: "Miércoles",
    thursday: "Jueves",
    friday: "Viernes",
    saturday: "Sábado",
  },
  /** Storage providers whose name is not a brand. */
  storageProvider: {
    Other: "Cualquier otro compatible con S3",
    Rclone: "Rclone (servidor S3)",
  },
  /** The word a person types to confirm something dangerous. The backend accepts the word of any language. */
  confirmWord: {
    lock: "BLOQUEAR",
    unlock: "DESBLOQUEAR",
    restore: "RESTAURAR",
    deleteAccount: "ELIMINAR",
  },

  // ─── What the helpers say ──────────────────────────────────────────────────────

  /** The most urgent thing about a service (maintReason). `n` is the number already written in the reader's language. */
  maintReason: {
    noData: "sin datos para calcularlo",
    now: "toca ahora",
    overKm: "se pasó por {{n}} km",
    overHours_one: "se pasó por {{n}} hora de motor",
    overHours_other: "se pasó por {{n}} horas de motor",
    overDays_one: "se pasó por {{n}} día",
    overDays_other: "se pasó por {{n}} días",
    leftKm_one: "falta {{n}} km",
    leftKm_other: "faltan {{n}} km",
    leftHours_one: "falta {{n}} hora de motor",
    leftHours_other: "faltan {{n}} horas de motor",
    leftDays_one: "falta {{n}} día",
    leftDays_other: "faltan {{n}} días",
  },
  /** What a password lacks to meet the policy (passwordProblem). */
  password: {
    tooShort: "La contraseña debe tener al menos {{min}} caracteres.",
    tooLong: "La contraseña no puede pasar de {{max}} caracteres.",
    needsNumber: "La contraseña debe llevar al menos un número.",
    needsLowercase: "La contraseña debe llevar al menos una letra minúscula.",
    needsUppercase: "La contraseña debe llevar al menos una letra mayúscula.",
    needsSymbol: "La contraseña debe llevar al menos un símbolo, como ! o #.",
  },
  /** What a password must have, in one sentence (passwordHint): one text per combination of requirements. */
  passwordHint: {
    min: "Mínimo {{min}} caracteres.",
    minNumber: "Mínimo {{min}} caracteres, con un número.",
    minLowercase: "Mínimo {{min}} caracteres, con una minúscula.",
    minUppercase: "Mínimo {{min}} caracteres, con una mayúscula.",
    minSymbol: "Mínimo {{min}} caracteres, con un símbolo.",
    minNumberLowercase: "Mínimo {{min}} caracteres, con un número y una minúscula.",
    minNumberUppercase: "Mínimo {{min}} caracteres, con un número y una mayúscula.",
    minNumberSymbol: "Mínimo {{min}} caracteres, con un número y un símbolo.",
    minLowercaseUppercase: "Mínimo {{min}} caracteres, con una minúscula y una mayúscula.",
    minLowercaseSymbol: "Mínimo {{min}} caracteres, con una minúscula y un símbolo.",
    minUppercaseSymbol: "Mínimo {{min}} caracteres, con una mayúscula y un símbolo.",
    minNumberLowercaseUppercase: "Mínimo {{min}} caracteres, con un número, una minúscula y una mayúscula.",
    minNumberLowercaseSymbol: "Mínimo {{min}} caracteres, con un número, una minúscula y un símbolo.",
    minNumberUppercaseSymbol: "Mínimo {{min}} caracteres, con un número, una mayúscula y un símbolo.",
    minLowercaseUppercaseSymbol: "Mínimo {{min}} caracteres, con una minúscula, una mayúscula y un símbolo.",
    minNumberLowercaseUppercaseSymbol: "Mínimo {{min}} caracteres, con un número, una minúscula, una mayúscula y un símbolo.",
  },
  /** Why a newly traced geofence is not valid (geometryProblem). */
  geometry: {
    radiusMin: "El radio mínimo es de {{meters}} m",
    radiusMax: "El radio máximo es de {{km}} km",
    zoneMinPoints: "Marca al menos tres puntos",
    zoneMaxPoints: "Una zona admite hasta {{max}} puntos",
    zoneCrosses: "Los lados de la zona se cruzan; mueve los puntos para que no se crucen",
    zoneTooSmall: "La zona es demasiado pequeña",
    routeMinPoints: "Marca al menos dos puntos de la ruta",
    routeMaxPoints: "Una ruta admite hasta {{max}} puntos",
    widthMin: "El ancho mínimo es de {{meters}} m",
    widthMax: "El ancho máximo es de {{km}} km",
    routeTooShort: "La ruta es demasiado corta",
  },
  /** Why a schedule written as a cron expression is not valid (parseCron, cronProblem). */
  cron: {
    fields: "El horario lleva cinco datos: minuto, hora, día del mes, mes y día de la semana",
    unreadable: {
      minute: 'No se entiende el minuto: "{{part}}"',
      hour: 'No se entiende la hora: "{{part}}"',
      day: 'No se entiende el día del mes: "{{part}}"',
      month: 'No se entiende el mes: "{{part}}"',
      weekday: 'No se entiende el día de la semana: "{{part}}"',
    },
    step: {
      minute: "El paso de el minuto debe ser 1 o más",
      hour: "El paso de la hora debe ser 1 o más",
      day: "El paso de el día del mes debe ser 1 o más",
      month: "El paso de el mes debe ser 1 o más",
      weekday: "El paso de el día de la semana debe ser 1 o más",
    },
    range: {
      minute: "En el minuto solo valen números de {{min}} a {{max}}",
      hour: "En la hora solo valen números de {{min}} a {{max}}",
      day: "En el día del mes solo valen números de {{min}} a {{max}}",
      month: "En el mes solo valen números de {{min}} a {{max}}",
      weekday: "En el día de la semana solo valen números de {{min}} a {{max}}",
    },
    never: "Ese horario no llega nunca",
    tooOftenHours: "Ese horario es demasiado seguido: como mucho, una vez cada {{n}} h",
    tooOftenMinutes: "Ese horario es demasiado seguido: como mucho, una vez cada {{n}} min",
  },
  /** What is wrong with an additional argument for the external storage (parseStorageFlag, storageFlagProblem). */
  storageFlag: {
    empty: "El argumento está vacío",
    tooLong: "Un argumento lleva como mucho {{max}} caracteres",
    oneLine: "Un argumento va en una sola línea",
    format: "Un argumento empieza con dos guiones y va en minúsculas, por ejemplo --s3-sign-accept-encoding=false",
    ownField: "--{{name}} ya tiene su campo en el formulario: escríbelo ahí",
    notAllowed: "La plataforma no admite --{{name}}. Valen los argumentos de S3, que empiezan por --s3-, y estos generales: {{general}}",
    onePerLine: "Escribe un solo argumento por línea",
  },

  // ─── Validation ────────────────────────────────────────────────────────────────
  // What the schemas answer when something sent does not fit. A schema carries the
  // key as its message; whoever shows it says it in the reader's language.

  validation: {
    // Shared by several schemas.
    zone: "Zona horaria no válida",
    dateFormat: "La fecha va como 2026-11-22",
    currencyCode: "La moneda es un código de tres letras, como HNL o USD",
    emailNeeded: "Escribe un correo válido",
    emailInvalid: "Ese correo no es válido",
    phone: "Escribe el teléfono con su código de país, por ejemplo +50499887766",
    emailOrPhone: "Escribe un correo o un teléfono con su código de país, por ejemplo +50499887766",
    peopleOnly: "Por este canal solo se avisa a personas de la cuenta",
    unknownVariable: "La variable {{name}} no existe",
    variableInHost: "El servidor de la dirección no puede llevar variables: ponlas en la ruta o en los parámetros",
    urlInvalid: "Esa dirección no es válida",
    urlHttps: "La dirección empieza por https://",
    aNameNeeded: "Escribe un nombre",
    nameNeeded: "Escribe el nombre",
    giveName: "Ponle un nombre",
    personName: "Escribe tu nombre, de al menos 2 letras",
    accountName: "Escribe el nombre de la cuenta, de al menos 2 letras",
    appName: "Escribe el nombre de la plataforma",
    dayNeeded: "Elige al menos un día",
    vehicleNeeded: "Elige al menos un vehículo",
    groupNeeded: "Elige al menos un grupo",
    groupsOrVehicles: "Elige unos grupos o unos vehículos, no las dos cosas",
    groupOrVehicles: "Elige un grupo o unos vehículos, no las dos cosas",
    fileEmpty: "El archivo está vacío",
    fileTooBig: "El archivo es demasiado grande",
    // Vehicles, groups and people.
    deviceId: "Escribe el identificador tal como aparece en el equipo, sin espacios",
    simIdentifierNeeded: "Escribe el identificador del equipo",
    simIdentifierRepeated: "Hay un identificador repetido",
    simImei: "El IMEI son 15 dígitos y el último es de control: revisa que esté completo y bien escrito",
    simDigits: "El identificador de esta marca son {{length}} dígitos",
    simTargetNeeded: "Escribe el servidor y el puerto",
    simHost: "El servidor es un nombre o una IP, sin http:// ni espacios",
    simWaypoints: "Marca al menos dos puntos: de dónde sale y a dónde llega",
    simLine: "El trazo de la ruta no es válido: vuelve a trazarla",
    simLineShort: "La ruta es demasiado corta: separa más sus puntos",
    simPlaceQuery: "Escribe al menos tres letras de la dirección",
    simSeconds: "Los segundos van de 1 a 86400",
    simStretch: "El tramo mide al menos 50 metros",
    simPercent: "El porcentaje va de 1 a 100",
    simSpeed: "La velocidad va de 5 a 250 km/h",
    simDriverKey: "La llave del conductor son de 4 a 16 dígitos hexadecimales (0-9, A-F)",
    simFaultCode: "Un código de falla es una letra (P, C, B o U) y cuatro dígitos, como P0300",
    simBackfill: "El viaje pasado puede haber terminado hasta hace 720 horas",
    metersNeeded: "Escribe el odómetro o las horas de motor",
    groupName: "Escribe un nombre para el grupo",
    roleName: "Escribe un nombre para el rol",
    shareMin: "El enlace dura al menos una hora",
    shareMax: "Un enlace dura como mucho 30 días",
    // Geofences and alerts.
    geofenceName: "Escribe un nombre para la geocerca",
    stayMin: "El tiempo mínimo es de 1 minuto",
    stayMax: "El tiempo máximo es de 30 días",
    stayOrder: "La permanencia mínima debe ser menor que la máxima",
    alertName: "Ponle un nombre a la alerta",
    speedLimitMin10: "El límite mínimo es de 10 km/h",
    signalLostMin: "El mínimo es de 5 minutos",
    conditionNeeded: "Agrega al menos una condición",
    // Anti-theft.
    confirmLock: "Escribe BLOQUEAR para confirmar",
    confirmUnlock: "Escribe DESBLOQUEAR para confirmar",
    incidentDescription: "Describe qué pasó",
    noteNeeded: "Escribe la nota",
    // Drivers.
    driverName: "Escribe el nombre del conductor",
    driverKey: "La llave son letras de la A a la F y números, como la muestra el equipo",
    // Fleet.
    purchaseCurrency: "Indica en qué moneda está el precio de compra",
    salvageOverPrice: "El valor de rescate no puede pasar del precio de compra",
    assigneeNeeded: "Escribe a quién se le asigna",
    endBeforeStart: "La fecha final no puede ser anterior a la inicial",
    amountNeeded: "Escribe el monto",
    amountPositive: "El monto debe ser más que cero",
    // Maintenance.
    planName: "Ponle un nombre al plan",
    planInterval: "Indica cada cuánto toca: kilómetros, horas de motor o días",
    orderTitle: "Escribe qué trabajo es",
    partName: "Cada repuesto lleva su nombre",
    quantityPositive: "La cantidad debe ser más que cero",
    doneBeforeOpened: "La fecha en que se terminó no puede ser anterior a la de apertura",
    // Routes and logistics.
    placeName: "Ponle un nombre al lugar",
    stopName: "Cada parada lleva su nombre",
    routeName: "Ponle un nombre a la ruta",
    routeStopNeeded: "Una ruta tiene al menos una parada",
    dispatchName: "Ponle un nombre al despacho",
    departureNeeded: "Indica cuándo sale",
    // Fuel.
    tankCapacityMin: "La capacidad mínima es de 5 litros",
    attrInvalid: "Ese dato no es válido",
    calibrationPoints: "La tabla necesita al menos dos puntos",
    tankSource: "Indica el dato del sensor de nivel o al menos una norma de consumo",
    calibrationNeeded: "Con un valor de sensor hace falta la tabla de calibración",
    calibrationOrder: "Los valores del sensor deben ir de menor a mayor",
    fillDateNeeded: "Falta la fecha del abastecimiento",
    dateInFuture: "Esa fecha todavía no llega",
    litersNeeded: "Escribe los litros",
    litersPositive: "Los litros deben ser más que cero",
    totalCurrency: "Indica en qué moneda está el total",
    // Reports and dashboards.
    speedLimitMin20: "El límite mínimo es de 20 km/h",
    stopMin: "Las paradas se cuentan a partir de 3 minutos",
    reportName: "Ponle un nombre al informe",
    recipientNeeded: "Elige al menos una persona que lo reciba",
    dashboardName: "Ponle un nombre al tablero",
    widgetNeeded: "Elige al menos un indicador",
    widgetRepeated: "Hay un indicador repetido",
    // Platform settings.
    mapUrl: "La dirección del mapa no es válida",
    geocoderUrl: "La dirección del servicio de direcciones no es válida",
    routingUrl: "La dirección del servicio de rutas no es válida",
    claimWindowMin: "El plazo mínimo es de 5 minutos",
    historyRetention: "El historial se conserva sin límite o al menos {{days}} días",
    passwordMinLength: "El mínimo no puede bajar de {{min}} caracteres",
    mailServer: "Escribe el servidor de correo y el remitente",
    mailTemplateField: "Escribe el asunto, el título, el texto y el botón del correo",
    mailTemplateVariable: "{{variable}} no es una variable de este correo",
    storageProvider: "Ese proveedor no está en la lista",
    storageEndpoint: "La dirección del servicio no es válida",
    storageEndpointNeeded: "Escribe la dirección del servicio",
    bucketName: "El nombre del bucket lleva minúsculas, números, puntos y guiones",
    storagePrefix: "La carpeta lleva letras, números, puntos, guiones y barras",
    storageFlagsMax: "Son como mucho {{max}} argumentos",
    storageBucketAndKey: "Escribe el bucket y la clave de acceso",
    confirmRestore: "Escribe RESTAURAR para confirmar",
    // Integrations and notifications.
    apiKeyName: "Ponle un nombre a la clave",
    headerName: "El nombre de una cabecera lleva letras, números y guiones",
    triggerNeeded: "Elige al menos un evento que la dispare",
    destinationNeeded: "Escribe al menos un destino",
    sensorName: "Ponle un nombre al sensor",
    minBelowMax: "El mínimo debe ser menor que el máximo",
    notificationName: "Ponle un nombre al aviso",
    eventNotAlert: "Ese evento no genera avisos",
    alertTypeNeeded: "Elige al menos un tipo de alerta",
    alertNeeded: "Elige al menos una alerta",
    whoNeeded: "Elige a quién avisar",
    targetNeeded: "Escribe a dónde va",
    systemEventNeeded: "Elige al menos una cosa de la que avisar",
  },
} as const;
