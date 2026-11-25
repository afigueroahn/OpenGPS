// Texts of the backend in Spanish, the reference language: antitheft.
export default {
  errors: {
    fileType: "Solo se admiten fotos (JPG, PNG, WebP) y documentos PDF",
    incidentNotFound: "Ese incidente no existe",
    incidentClosed: "Ese incidente ya está cerrado",
    fileTooBig: "El archivo pasa de {{mb}} MB",
    tooManyFiles: "Un incidente admite hasta {{max}} archivos",
    fileNotFound: "Ese archivo no existe",
    fileGone: "Ese archivo ya no está disponible",
    noGps: "Este vehículo no tiene un GPS que esté reportando",
    lockUnsupported: "El GPS de este vehículo no admite el bloqueo a distancia",
    confirmExpired: "La confirmación venció. Vuelve a empezar.",
    nothingWaiting: "No hay ninguna orden esperando: la última ya se envió",
    recoveryAlreadyOn: "El modo recuperación ya está encendido",
    recoveryAlreadyOff: "El modo recuperación ya está apagado",
  },
  // Emails to those who administer the account when a panic button is pressed.
  mail: {
    openPlatform: "Abrir la plataforma",
    vehicle: "vehículo",
    sosSubject: "Botón de pánico: {{vehicle}}",
    sosBody: "Alguien pulsó el botón de pánico de este vehículo. Abre la plataforma para ver dónde está y atender el incidente.",
    unattendedSubject: "SIN ATENDER · Botón de pánico: {{vehicle}}",
    unattendedBody: "El botón de pánico de este vehículo lleva {{minutes}} minutos sin que nadie lo atienda. Abre la plataforma ahora.",
  },
  // The timeline of an incident. Its entries are stored already written.
  entry: {
    attending: "Empezó a atender el incidente",
    closed: "Cerró el incidente: {{resolution}}",
    closedWithNote: "Cerró el incidente: {{resolution}}. {{note}}",
    attached: "Adjuntó {{name}}",
    escalated: "Sigue sin atender después de {{minutes}} minutos: se volvió a avisar a quienes administran la cuenta",
    lockRequested: "Pidió bloquear el arranque",
    unlockRequested: "Pidió desbloquear el arranque",
    sendFailed: "La orden no se pudo enviar al equipo",
    lockSent: "Se envió al equipo la orden de bloquear el arranque",
    unlockSent: "Se envió al equipo la orden de desbloquear el arranque",
    lockConfirmed: "El equipo confirmó que el arranque está bloqueado",
    unlockConfirmed: "El equipo confirmó que el arranque está desbloqueado",
    commandExpired: "La orden venció sin enviarse",
    recoveryStarted: "Se encendió el modo recuperación",
    recoveryOnFaster: "Modo recuperación encendido: enlace para autoridades válido {{hours}} horas y reporte cada {{seconds}} segundos",
    recoveryOnNotSent: "Modo recuperación encendido: enlace para autoridades válido {{hours}} horas; el equipo no recibió la orden de reportar más seguido",
    recoveryOnFixedRate: "Modo recuperación encendido: enlace para autoridades válido {{hours}} horas; este equipo no permite cambiar su ritmo de reporte a distancia",
    recoveryOff: "Modo recuperación apagado: el enlace para autoridades dejó de funcionar",
  },
  // Why a lock order is waiting, or how it ended. Stored already written.
  command: {
    waitingFix: "Esperando a que el equipo reporte su posición",
    waitingSlower: "Esperando a que baje de {{kmh}} km/h",
    waitingRecentFix: "Esperando una posición reciente del equipo",
    replaced: "Sustituida por otra orden",
    cancelled: "Cancelada antes de enviarse",
    retrying: "{{error}}; se vuelve a intentar",
    noFeedback: "Este equipo no informa si aplicó la orden",
    noSafeMoment: "No llegó el momento seguro para enviarla",
    unconfirmed: "El equipo no confirmó la orden",
  },
  /** Name of an evidence file that came without a usable one. */
  evidence: { unnamed: "archivo" },
  /** Note of the link created for the authorities. */
  recovery: { shareNote: "Recuperación" },
} as const;
