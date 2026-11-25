// Texts of the backend in Spanish, the reference language: api.
// What the HTTP layer answers: its errors, the session's, the notifications'
// and the console's, and the problems with Traccar that a person gets to read.
export default {
  errors: {
    signIn: "Inicia sesión para continuar",
    forbidden: "No tienes permiso para hacer esto",
    notFound: "No encontrado",
    internal: "Algo falló de nuestro lado. Inténtalo de nuevo.",
    badRequest: "La petición no es válida",
    invalidData: "Datos inválidos",
    origin: "Origen no autorizado",
    accountSuspended: "Esta cuenta está suspendida. Escríbenos para revisarla.",
    registrationClosed: "El registro de cuentas nuevas está cerrado. Para entrar hace falta una invitación.",
    notYourAccount: "No perteneces a esa cuenta",
    tooManyLookups: "Demasiadas consultas. Espera un momento.",
    shareGone: "Este enlace ya no está disponible",
  },
  /** What the API's own schemas answer when something sent does not fit. */
  validation: {
    fromNeeded: "Falta la fecha inicial",
    toNeeded: "Falta la fecha final",
    formatUnavailable: "Formato no disponible",
    legalVersion: "Esa versión de los términos ya no está vigente",
    testTarget: "Escribe a dónde enviar la prueba",
    deleteWord: "Escribe ELIMINAR para confirmar",
  },
  account: {
    renameOwnerOnly: "Solo el dueño o un administrador de la cuenta cambia su nombre",
  },
  auth: {
    /** The name a new account gets when its person has none. */
    defaultAccountName: "Mi cuenta",
    legalNotAccepted: "Debes aceptar los términos de uso y la política de privacidad",
    ownerStays: "Eres el dueño de la plataforma: tu cuenta no se puede borrar",
  },
  invitation: {
    otherEmail: "Esta invitación es para otro correo. Entra con la cuenta que la recibió.",
    alreadyMember: "Ya eres parte de esa cuenta",
    invalid: "Esta invitación ya no es válida",
    failed: "No se pudo aceptar la invitación. Puede que haya vencido.",
  },
  /** The notifications of an account and those of the platform. */
  notifications: {
    notFound: "Ese aviso no existe",
    vehiclesGone: "Alguno de los vehículos ya no existe o no puedes verlo",
    onlyYourVehicles: "Solo puedes crear avisos para los vehículos que ves",
    groupsGone: "Alguno de los grupos ya no existe",
    rolesGone: "Alguno de los roles ya no existe",
    peopleGone: "Alguna de las personas ya no es parte de la cuenta",
    alertsGone: "Alguna de las alertas ya no existe",
    addressesWholeAccount: "Solo quien ve toda la cuenta puede avisar a direcciones escritas a mano",
    https: "La dirección tiene que empezar por https://",
    max: "Una cuenta puede tener hasta {{max}} avisos",
    systemMax: "Puede haber hasta {{max}} avisos del sistema",
    noTargets: "Este aviso no tiene a quién enviarle",
    noPushYet: "Nadie de este aviso tiene todavía la app móvil: las notificaciones push le llegarán cuando la instale",
    noTargetsOnChannel: "Ninguna de las personas de este aviso tiene dónde recibirlo por este canal",
  },
  /** The platform's console: mail, storage, channels and backups. */
  platform: {
    noMailServer: "No hay un servidor de correo configurado",
    mailRefused: "El servidor de correo no aceptó el envío: {{reason}}",
    storageNeeded: "Escribe primero los datos del almacenamiento, con su clave secreta",
    pushNotYet: "Las notificaciones push llegarán con la app móvil: todavía no hay dónde recibirlas",
    testNotSent: "El mensaje de prueba no salió",
    backupsUnavailable: "Este servidor no tiene preparado el acceso para hacer copias de seguridad",
  },
  /** What Traccar answered, when it ends up where a person reads it (a command's note). */
  traccar: {
    unreachable: "El servidor de los GPS no responde. Inténtalo de nuevo en unos minutos.",
    offline: "El equipo no está conectado en este momento",
  },
} as const;
