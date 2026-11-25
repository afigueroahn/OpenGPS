// Texts of the backend in Spanish, the reference language: core.
export default {
  // ─── Access and scope ────────────────────────────────────────────────────────
  access: {
    customRole: "Rol personalizado",
    notAllowed: "Tu rol en esta cuenta no permite hacer esto",
    allGroupsOnly: "Solo quien ve todos los grupos puede hacer esto",
  },
  /** What alerts and geofences point to. */
  scope: {
    vehiclesGone: "Alguno de los vehículos ya no existe o no puedes verlo",
    groupsGone: "Alguno de los grupos ya no existe",
  },

  // ─── Vehicles, groups and history ────────────────────────────────────────────
  vehicles: {
    notFound: "Ese vehículo no existe",
    tooManyClaims: "Hiciste demasiados intentos de alta. Espera una hora y vuelve a intentarlo.",
    chooseBrand: "Elige una marca de la lista",
    chooseModel: "Elige un modelo de la lista de esa marca",
    deviceInAccount: "Ese GPS ya está en tu cuenta",
    deviceTaken: "Ese GPS ya está registrado en otra cuenta. Si es tuyo, escríbenos para revisarlo.",
    tooManyPending: "Tienes muchos GPS esperando su primera señal. Termina de conectarlos antes de agregar más.",
    justTaken: "Ese GPS acaba de registrarse en otra cuenta",
    noGroup: "No tienes ningún grupo asignado donde agregar vehículos",
    hasDevice: "Este vehículo ya tiene un GPS. Quítalo antes de conectar otro.",
    ownGroupsOnly: "Solo puedes mover el vehículo entre los grupos que tienes asignados",
    noPosition: "Este vehículo aún no tiene una posición para dejarlo estacionado",
  },
  groups: {
    exists: "Ya tienes un grupo con ese nombre",
    notFound: "Ese grupo no existe",
  },
  history: {
    endBeforeStart: "La fecha final debe ser posterior a la inicial",
    rangeTooLong: "El periodo no puede pasar de {{days}} días",
    tooManyPositions: "Ese periodo tiene demasiadas posiciones. Elige un rango más corto.",
  },
  share: {
    limit: "Este vehículo ya tiene {{max}} enlaces vigentes. Revoca alguno para crear otro.",
    notFound: "Ese enlace no existe",
  },

  // ─── Alerts and geofences ────────────────────────────────────────────────────
  alerts: {
    notFound: "Esa alerta no existe",
    ownGroupsOnly: "Solo puedes crear alertas para los grupos que ves",
    geofencesGone: "Alguna de las geocercas elegidas ya no existe",
    wider: "Esta alerta también vigila vehículos que no ves; solo puede cambiarla quien ve todos los grupos",
    limit: "Una cuenta puede tener hasta {{max}} alertas",
    typeFixed: "El tipo de una alerta no se cambia; crea otra",
  },
  geofences: {
    notFound: "Esa geocerca no existe",
    ownGroupsOnly: "Solo puedes crear geocercas para los grupos que ves",
    chooseGroup: "Elige al menos un grupo, o aplica la geocerca a todos los vehículos",
    wider: "Esta geocerca también aplica a vehículos que no ves; solo puede cambiarla quien ve todos los grupos",
    limit: "Una cuenta puede tener hasta {{max}} geocercas",
  },

  // ─── People of an account ────────────────────────────────────────────────────
  members: {
    roleNotFound: "Ese rol no existe",
    roleExists: "Ya tienes un rol con ese nombre",
    groupsNotFound: "Alguno de los grupos no existe",
    vehiclesNotFound: "Alguno de los vehículos no existe",
    invitationNotFound: "Esta invitación no existe o fue retirada",
    invitationNotPending: "Esa invitación ya no está pendiente",
    invitationInvalid: "Esta invitación ya no es válida",
    alreadyMember: "Esa persona ya es parte de esta cuenta",
    notMember: "Esa persona no es parte de esta cuenta",
    ownerFixed: "El dueño de la cuenta no se puede cambiar",
    notYourself: "No puedes cambiar tu propio acceso",
    /** The email that carries an invitation. */
    invitationMail: {
      subject: "{{inviter}} te invitó a {{account}} en {{app}}",
      heading: "Te invitaron a {{account}}",
      body: "{{inviter}} te invitó a ver sus vehículos en {{app}} como {{role}}. La invitación vence en {{days}} días.",
      action: "Ver la invitación",
    },
  },
  privacy: {
    ownerCantLeave: "Eres el dueño de esta cuenta. Para dejarla tienes que eliminarla.",
  },

  // ─── Platform administration ─────────────────────────────────────────────────
  platform: {
    vehicleQuota_one: "Tu cuenta llegó a su límite de {{count}} vehículo. Escríbenos si necesitas más.",
    vehicleQuota_other: "Tu cuenta llegó a su límite de {{count}} vehículos. Escríbenos si necesitas más.",
    userQuota_one: "Tu cuenta llegó a su límite de {{count}} usuario. Escríbenos si necesitas más.",
    userQuota_other: "Tu cuenta llegó a su límite de {{count}} usuarios. Escríbenos si necesitas más.",
    accountNotFound: "Esa cuenta no existe",
    notYourself: "No puedes suspenderte a ti mismo",
    userNotFound: "Ese usuario no existe",
    ownerAccount: "Es la cuenta del dueño de la plataforma: no se puede eliminar",
    ownerUser: "Es el dueño de la plataforma: no se puede eliminar",
  },
  photo: {
    type: "La foto debe ser una imagen JPG, PNG o WebP",
    tooBig: "La foto pesa más de {{kb}} KB",
    notFound: "No tienes foto",
  },
  settings: {
    twilioIncomplete: "Para encender Twilio escribe la cuenta, su clave y el número remitente",
    customUrl: "Para encender Personalizado escribe la dirección a la que se envía",
    oauthIncomplete: "Para encender {{provider}} escribe todos sus datos y su secreto",
    appleKey: "Esa no es la clave de Apple: pega el contenido completo del archivo .p8",
    storageSecret: "Escribe la clave secreta del almacenamiento",
    storageBucket: "Escribe el bucket y la clave de acceso",
  },
  /** What the server's own watch tells whoever runs the platform. */
  tasks: {
    diskTitle: "el disco del servidor va al {{used}} %",
    diskBody: "Quedan {{free}} GB libres en el servidor. Conviene ampliar el disco o activar la retención del historial antes de que se llene.",
    ingestTitle: "dejaron de llegar posiciones de los GPS",
    ingestBody: "La plataforma lleva más de {{minutes}} minutos sin poder leer las posiciones que reciben los equipos. El último error: {{error}}.",
  },

  // ─── Backups and external storage ────────────────────────────────────────────
  backups: {
    unavailable: "Este servidor no tiene preparado el acceso para hacer copias de seguridad",
    notInstalled: "Este servidor no tiene instalado {{command}}",
    exitCode: "{{command}} terminó con el código {{code}}",
    dumpPlatform: "No se pudo copiar la base de la plataforma: {{reason}}",
    dumpReceiver: "No se pudo copiar la base del receptor de equipos: {{reason}}",
    emptyDump: "La copia de la base salió vacía",
    filesFailed: "No se pudieron copiar los archivos de los usuarios: {{reason}}",
    noStorage: "El almacenamiento externo no está configurado",
    notUploaded: "La copia quedó en el servidor, pero no llegó al almacenamiento externo: {{reason}}",
    interrupted: "El servidor se reinició mientras se hacía",
    running: "Ya hay una copia en marcha. Espera a que termine.",
    busy: "Hay una copia en marcha. Espera a que termine.",
    stillRunning: "Esa copia todavía se está haciendo",
    notFound: "Esa copia no existe",
    fileNotFound: "Ese archivo no existe",
    fileGone: "Ese archivo ya no está en el servidor ni en el almacenamiento externo",
    filesGone: "Los archivos de esa copia ya no están en el servidor ni en el almacenamiento externo",
    incompleteDownload: "Un archivo de esa copia no bajó entero del almacenamiento externo",
    configureStorage: "Configura primero el almacenamiento externo",
    discovering: "Ya se está buscando en el almacenamiento. Espera a que termine.",
    incomplete: "Esa copia no está completa y no se puede restaurar",
    noRunner: "Este servidor no tiene en marcha el ayudante que restaura copias",
    restoreRunning: "Ya hay una restauración pedida o en marcha",
    safetyFailed: "No se pudo hacer la copia previa ({{reason}}); no se restauró nada",
    noDetail: "sin detalle",
    noReason: "El servidor no dijo por qué",
    reason: {
      invalid: "El pedido de restauración no era válido o le faltaban archivos. No se cambió nada.",
      unreadable: "La copia no se pudo leer entera. No se cambió nada.",
      incomplete: "La copia no trae el historial como debe. No se cambió nada.",
      files: "El archivo con los archivos que suben las personas no se pudo leer. No se cambió nada.",
      swap: "No se pudieron cambiar las bases. No se restauró: la plataforma sigue con los datos que tenía.",
      start: "La plataforma no arrancó con la copia. No se restauró: sigue con los datos que tenía.",
      cut: "El ayudante se detuvo mientras restauraba. No se restauró: la plataforma sigue con los datos que tenía.",
      broken: "La restauración se cortó y la plataforma no quedó bien. Hay que revisarla en el servidor.",
    },
    /** The platform's own notifications about backups. */
    notify: {
      failedTitle: "una copia de seguridad falló",
      failedBody: "{{error}}. Revisa las copias en la consola de la plataforma.",
      doneTitle: "copia de seguridad hecha",
      doneManual: "La copia pedida a mano terminó bien y ya está en la lista.",
      doneScheduled: "La copia programada terminó bien y ya está en la lista.",
      doneBeforeRestore: "La copia hecha antes de restaurar terminó bien y ya está en la lista.",
      restoredTitle: "terminó una restauración",
      restoredBody: "La plataforma volvió al estado de la copia elegida y ya está en marcha otra vez.",
    },
  },
  /** Problems of the external storage, in plain words. */
  storage: {
    blocked: "Cloudflare Access bloqueó la petición antes de que llegara al almacenamiento: en Cloudflare hay que dar paso a este servidor en esa dirección",
    notS3: "Esa dirección no respondió como un almacenamiento S3, sino con una página: revisa que sea la del servicio S3 y no la de otra cosa, como un panel de administración",
    noAnswer: "Sin respuesta del almacenamiento: no se pudo conectar con esa dirección",
    tooSlow: "Sin respuesta del almacenamiento: el servicio tardó demasiado en responder",
    noHost: "Sin respuesta del almacenamiento: esa dirección no existe",
    noEtag:
      "El archivo es grande y sube por partes, pero el almacenamiento no confirmó una de ellas: su respuesta llegó sin la cabecera ETag. Si hay un intermediario delante, como Cloudflare, puede estar quitándola",
    badSignature: "El servicio rechazó la firma: revisa la clave secreta, la región y la dirección",
    unknownKey: "El servicio no reconoce esa clave de acceso",
    denied: "Esa clave no tiene permiso para leer y escribir en el bucket",
    noBucket: "Ese bucket no existe en el servicio",
    badRegion: "El servicio no acepta esa región para el bucket",
    moved: "El bucket está en otra región o en otra dirección",
    noFile: "El archivo no está en el almacenamiento",
    clock: "El reloj de este servidor y el del almacenamiento no coinciden",
    notFound: "El bucket o el archivo no existe en el servicio",
    noRclone: "Este servidor no tiene instalado rclone, el programa que mueve los archivos al almacenamiento",
    rcloneFailed: "No se pudo ejecutar rclone: {{reason}}",
    unknownFlag: "rclone no conoce el argumento {{flag}}",
    badValue: "El valor «{{value}}» no vale para el argumento {{flag}}",
    missingValue: "Al argumento {{flag}} le falta su valor",
    flagsRejected: "rclone no aceptó los argumentos: {{reason}}",
    certificate: "El certificado de esa dirección no se pudo comprobar. Si es uno propio, agrega el argumento --no-check-certificate",
    notSaved: "La dirección respondió, pero no guardó lo que se le envió: revisa que sea la del servicio S3",
    notReturned: "La dirección respondió, pero no devolvió lo que se guardó: revisa que sea la del servicio S3",
    rejected: "El almacenamiento no aceptó la operación. rclone dijo: {{reason}}",
    rejectedExit: "El almacenamiento no aceptó la operación. rclone dijo: salida {{code}}",
    downloadCut: "La descarga del almacenamiento se cortó",
    downloadCutBecause: "La descarga del almacenamiento se cortó: {{reason}}",
  },
  /** Why a request to another system could not go out. */
  outbound: {
    invalidAddress: "La dirección no es válida",
    httpsOnly: "La dirección tiene que empezar por https://",
    internal: "Esa dirección es interna: no se envía a ella",
    timeout: "No respondió a tiempo",
    notFound: "No se encontró esa dirección",
    refused: "El otro sistema rechazó la conexión",
    reset: "El otro sistema cortó la conexión",
    certificate: "El certificado de esa dirección no es válido",
    failed: "No se pudo conectar",
  },

  // ─── Compatible GPS devices ──────────────────────────────────────────────────
  /** The families shown when adding a GPS device. Texts accept {host}, {ip} and {port}, which the web app fills in. */
  catalog: {
    steps: {
      simTitle: "Prepara la SIM",
      simText: "Usa una SIM con datos móviles activos y sin PIN. Ten a mano el APN de tu operador.",
      powerTitle: "Enciende el equipo",
      powerText: "Conéctalo a la corriente del vehículo y déjalo a cielo abierto unos minutos. Cuando envíe su primera posición, lo verás en el mapa.",
      apnTitle: "Configura el APN",
      serverTitle: "Apunta al servidor",
      idTitle: "Identificador",
      dataTitle: "Activa el envío por datos",
      sendSms: "Envía este SMS:",
      sendSmsToSim: "Envía este SMS al número de la SIM:",
      sendSmsCode123456: "Envía este SMS (123456 es la clave de fábrica):",
    },
    /** Words a person replaces in the commands with their own. */
    placeholders: {
      apn: "TU_APN",
      user: "USUARIO",
      password: "CLAVE",
    },
    teltonika: {
      name: "Teltonika serie FM",
      apn: "Con Teltonika Configurator (USB o Bluetooth), o por SMS al número de la SIM. El SMS empieza con dos espacios cuando el equipo no tiene usuario ni contraseña de SMS.",
      server: "Dominio {host}, puerto {port}, protocolo TCP. Por SMS:",
    },
    gt06: {
      name: "Concox, Jimi y compatibles GT06",
      server: "Envía este SMS. El 1 indica que el servidor va por nombre; con IP sería SERVER,0,{ip},{port},0#",
    },
    h02: {
      name: "SinoTrack, MiCODUS y compatibles H02",
      apn: "Envía este SMS al número de la SIM (0000 es la clave de fábrica):",
      server: "En SinoTrack, envía este SMS. En MiCODUS el comando es: adminip123456 {ip} {port}",
      id: "Estos equipos se identifican con el ID de 10 dígitos de su etiqueta, no con el IMEI.",
    },
    gps103: {
      name: "Coban TK103 y GPS303",
    },
    tk103: {
      brand: "Genérico",
      name: "TK103 genérico y clones",
      examples: "TK103 de otros fabricantes, Xexun",
      server: "Envía este SMS. Si el equipo no aparece en unos minutos, es de la familia Coban: elígela en el paso anterior.",
    },
    jt808: {
      name: "Equipos con protocolo JT808",
      examples: "Jimi VL502 y otros equipos chinos con JT/T 808",
      idLabel: "ID del terminal",
      server: "Servidor {host} (o IP {ip}), puerto {port}, TCP. En equipos Jimi se hace con este SMS; en otras marcas, consulta su manual.",
      id: "Usa el número de terminal que reporta el equipo, normalmente de 12 dígitos. Si no conecta con el IMEI, prueba con ese número.",
    },
    gl200: {
      name: "Queclink series GV y GL",
      server: "Con Manage Tool de Queclink: modo de reporte TCP, servidor principal {host} (o IP {ip}), puerto {port}, y el APN de tu operador.",
    },
    suntech: {
      name: "Suntech serie ST",
      server: "Con SyncTrak de Suntech: en los parámetros de red, servidor {host} (o IP {ip}), puerto {port}, TCP, y el APN de tu operador.",
      id: "Usa el ID del equipo que muestra SyncTrak o su etiqueta.",
    },
    ruptela: {
      name: "Ruptela Eco y Pro",
      server: "Con Device Center de Ruptela: en la conexión, servidor {host} (o IP {ip}), puerto {port}, protocolo TCP, y el APN de tu operador.",
    },
  },
} as const;
