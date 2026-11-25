// Texts of the backend in Spanish, the reference language: fleet.
export default {
  errors: {
    fromNeeded: "Falta la fecha inicial",
    toNeeded: "Falta la fecha final",
    fileType: "Solo se admiten fotos (JPG, PNG, WebP) y documentos PDF",
    photoNotImage: "La foto del vehículo tiene que ser una imagen",
    fileTooBig: "El archivo pasa de {{mb}} MB",
    tooManyFiles: "Un vehículo admite hasta {{max}} archivos. Borra alguno que ya no sirva.",
    documentNotFound: "Ese documento no existe",
    documentGone: "El archivo de ese documento ya no está en el servidor",
    expenseNotFound: "Ese gasto no existe",
    assignedInDrivers: "Esta cuenta lleva los conductores en su módulo: la asignación se cambia desde la ficha del vehículo, en Conductor",
    alreadyAssigned: "En esas fechas el vehículo ya está asignado a otra persona",
    assignmentNotFound: "Esa asignación no existe",
    groupNotFound: "Ese grupo no existe",
    parentNotFound: "El grupo del que quieres colgarlo no existe",
    groupLoop: "Un grupo no puede colgar de sí mismo ni de uno de sus subgrupos",
  },
  /** Notes of the expenses that come from other modules. */
  expenses: {
    fill: "Abastecimiento de {{liters}} L",
    fillAt: "Abastecimiento de {{liters}} L en {{station}}",
    workOrder: "Orden de trabajo n.º {{number}}: {{title}}",
  },
  assignments: {
    /** An assignment the drivers module made because the driver used their key. */
    byKey: "Se identificó con su llave",
  },
  /** Name of a document that came without a usable one. */
  documents: { unnamed: "archivo" },
} as const;
