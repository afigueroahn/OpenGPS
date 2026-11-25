// Texts of the backend in Spanish, the reference language: routes.
export default {
  errors: {
    fromNeeded: "Falta la fecha inicial",
    toNeeded: "Falta la fecha final",
    placeNotFound: "Ese lugar no existe",
    routeNotFound: "Esa ruta no existe",
    lineTooShort: "El camino necesita al menos dos puntos",
    noHistory: "El vehículo no tiene recorrido en ese periodo",
    tripNotFound: "Ese despacho no existe",
    stopNeeded: "El despacho necesita al menos una parada",
    tripClosed: "Ese despacho ya está cerrado",
    tripCancelled: "Ese despacho está anulado",
    stopNotFound: "Esa parada no existe",
    linkGone: "Este enlace ya no está disponible",
    proofType: "La prueba de entrega tiene que ser una imagen (JPG, PNG o WebP)",
    imageEmpty: "La imagen está vacía",
    imageTooBig: "La imagen pasa de {{mb}} MB",
    proofNotFound: "Esa parada no tiene esa prueba de entrega",
  },
  /** Why a vehicle is not offered for a dispatch. */
  nearest: {
    onTrip: "En la ruta «{{name}}»",
    notReporting: "No está reportando",
  },
} as const;
