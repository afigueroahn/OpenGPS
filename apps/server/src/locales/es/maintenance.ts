// Texts of the backend in Spanish, the reference language: maintenance.
export default {
  errors: {
    planNotFound: "Ese plan no existe",
    vehicleNotFound: "Uno de los vehículos no existe",
    scheduleNotFound: "Ese servicio programado no existe",
    expiryNotFound: "Ese vencimiento no existe",
    orderNotFound: "Esa orden no existe",
    scheduleOtherVehicle: "Ese servicio programado no es de este vehículo",
    workshopNotFound: "Ese taller no existe",
    workshopExists: "Ya tienes un taller o proveedor con ese nombre",
    partNotFound: "Ese repuesto no existe",
    partExists: "Ya tienes un repuesto con ese nombre",
    partGone: "Uno de los repuestos ya no está en el catálogo",
    fileType: "Solo se admiten fotos (JPG, PNG, WebP) y documentos PDF",
    fileTooBig: "El archivo pasa de {{mb}} MB",
    tooManyFiles: "Una orden admite hasta {{max}} archivos. Borra alguno que ya no sirva.",
    fileNotFound: "Ese archivo no existe",
    fileMissing: "Ese archivo ya no está en el servidor",
  },
  /** The name an attachment gets when its own has nothing usable. */
  files: {
    defaultName: "archivo",
  },
  /** Why an expiry is notified. */
  notices: {
    expired: "venció el {{date}}",
    dueToday: "vence hoy",
    expires: "vence el {{date}}",
  },
} as const;
