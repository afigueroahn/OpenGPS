// Texts of the backend in Spanish, the reference language: mail.
// What leaves the platform for someone to read: emails, the notifications of
// an account and of the platform, test messages and how their delivery went.
export default {
  /** The button of a message: where to look at it. */
  action: {
    map: "Ver en el mapa",
    platform: "Abrir la plataforma",
    console: "Abrir la consola",
  },
  /** The frame every email goes in. */
  layout: {
    buttonFallback: "Si el botón no funciona, copia esta dirección en tu navegador:",
  },

  // ─── Emails of the session ─────────────────────────────────────────────────

  resetPassword: {
    subject: "Restablece tu contraseña de {{app}}",
    heading: "Restablece tu contraseña",
    body: "Recibimos una solicitud para cambiar tu contraseña. El enlace vence en 1 hora. Si no fuiste tú, ignora este mensaje.",
    action: "Crear una contraseña nueva",
  },
  passwordChanged: {
    subject: "Tu contraseña de {{app}} cambió",
    heading: "Tu contraseña cambió",
    body: "La contraseña de tu cuenta en {{app}} se cambió el {{when}}. Si fuiste tú, no tienes que hacer nada. Si no fuiste tú, elige otra ahora con «Olvidé mi contraseña»: al hacerlo se cierran todas las sesiones de tu cuenta.",
    action: "Elegir otra contraseña",
  },
  existingAccount: {
    subject: "Ya tienes una cuenta en {{app}}",
    heading: "Ya tienes una cuenta",
    body: "Alguien, quizá tú, intentó crear una cuenta con este correo, pero ya existe una. Entra con tu contraseña o con el servicio con que la creaste. Si no recuerdas tu contraseña, en la entrada puedes pedir una nueva con «Olvidé mi contraseña». Si no fuiste tú, no tienes que hacer nada.",
    action: "Entrar a mi cuenta",
  },
  verifyEmail: {
    subject: "Confirma tu correo en {{app}}",
    heading: "Confirma tu correo",
    body: "Para activar tu cuenta y agregar tu GPS, confirma que este correo es tuyo. El enlace vence en 24 horas.",
    action: "Confirmar mi correo",
  },

  // ─── Tests ─────────────────────────────────────────────────────────────────

  /** The email the console sends to check the mail server. */
  mailTest: {
    subject: "Correo de prueba de {{app}}",
    heading: "El correo funciona",
    body: "Este mensaje salió de {{app}} con el servidor de correo {{host}}. Si lo estás leyendo, la configuración es correcta.",
  },
  /** The message the console sends through a channel to check it. */
  channelTest: {
    title: "Mensaje de prueba de {{app}}",
    body: "Si lo estás leyendo, este canal de aviso funciona.",
    label: "Mensaje de prueba",
  },
  /** The test of one of the account's notifications. */
  notificationTest: {
    title: "Aviso de prueba de {{app}}",
    body: "Este mensaje comprueba que el aviso «{{name}}» llega por este canal. No ocurrió nada con tus vehículos.",
    label: "Aviso de prueba",
  },
  /** The test of one of the platform's notifications; its title follows the platform's name. */
  systemTest: {
    title: "aviso de prueba",
    body: "Este mensaje comprueba que el aviso del sistema «{{name}}» llega por este canal. No ocurrió nada en la plataforma.",
  },

  // ─── Events ────────────────────────────────────────────────────────────────

  /** The message that tells an event. `what` is the event in words; `sender`, who sends it. */
  event: {
    body: "{{what}}. Ocurrió el {{at}} (hora de {{zone}}). {{sender}}.",
    sentByNotification: "Te lo envía el aviso «{{name}}»",
  },
  /** An event's own data, in words, after its title. */
  facts: {
    speeding: "iba a {{speed}} km/h con un límite de {{limit}} km/h",
    stayShort: "estuvo {{stayed}}; el mínimo es {{minimum}}",
    stayLong: "lleva {{stayed}}; el máximo es {{maximum}}",
    signalLost: "no reporta desde hace {{silent}}",
    routeDeviation: "se apartó {{meters}} m del camino de su ruta",
    unauthorizedMovement: "se alejó {{meters}} m de donde quedó estacionado",
    tow: "se mueve a {{speed}} km/h con el motor apagado",
    fuelTheft: "salieron {{liters}} L del tanque con el motor apagado",
    fuelDrain: "salieron {{liters}} L del tanque estando detenido",
    fuelRefuel: "entraron {{liters}} L al tanque",
    noDescription: "sin descripción",
    engineOverrev: "llegó a {{rpm}} rpm; el límite es {{limit}} rpm",
    engineOverheat: "llegó a {{temp}} °C; el límite es {{limit}} °C",
    batteryLow: "está en {{volts}} V; el mínimo es {{limit}} V",
  },

  // ─── The platform's own notifications ──────────────────────────────────────

  /** Their titles follow the platform's name: "OpenGPS: se creó una cuenta nueva". */
  system: {
    accountCreated: {
      title: "se creó una cuenta nueva",
      body: "Alguien se registró y creó la cuenta «{{name}}».",
    },
    channelFailing: {
      title: "el canal {{channel}} está fallando",
      body: "En la última hora {{n}} mensajes no pudieron salir por {{channel}}. El último motivo: {{reason}}. Revisa los datos del canal.",
      noDetail: "sin detalle",
    },
  },

  // ─── Channels and deliveries ───────────────────────────────────────────────

  /** Why a channel cannot send right now. */
  channelProblem: {
    off: "Ese canal está apagado en la plataforma",
    incomplete: "Al canal de Twilio le faltan sus datos",
    incompleteWebhook: "Al canal Personalizado le falta la dirección a la que envía",
  },
  /** The same, when an account saves something that would send through it. */
  channelProblemChooseOther: {
    off: "Ese canal está apagado en la plataforma. Elige otro canal",
    incomplete: "Al canal de Twilio le faltan sus datos. Elige otro canal",
    incompleteWebhook: "Al canal Personalizado le falta la dirección a la que envía. Elige otro canal",
  },
  /** The same, when the console saves a notification of the platform. */
  channelProblemConnectFirst: {
    off: "Ese canal está apagado en la plataforma. Conéctalo primero en Canales de aviso",
    incomplete: "Al canal de Twilio le faltan sus datos. Conéctalo primero en Canales de aviso",
    incompleteWebhook: "Al canal Personalizado le falta la dirección a la que envía. Conéctalo primero en Canales de aviso",
  },
  /** Why an account cannot send more messages for now. */
  cap: {
    emailHour: "La cuenta llegó a su tope de correos por hora",
    monthly: "La cuenta llegó a su tope mensual de mensajes por este canal",
  },
  /** Why a message did not go out, as the log of messages shows it. */
  delivery: {
    answered: "Respondió {{code}}",
    failed: "No se pudo enviar",
    mailFailed: "No se pudo enviar el correo",
    pushNotYet: "Las notificaciones push llegarán con la app móvil",
    unreadableTarget: "Ese destino ya no se puede leer: vuelve a escribirlo",
  },
} as const;
