// Texts of the backend in Spanish, the reference language: fuel.
export default {
  errors: {
    fromNeeded: "Falta la fecha inicial",
    toNeeded: "Falta la fecha final",
    calibrationOverCapacity: "La tabla de calibración pasa de la capacidad del tanque",
    notConfigured: "Ese vehículo no tiene el combustible configurado",
    tooManyPositions: "Ese periodo tiene demasiadas posiciones. Elige un rango más corto.",
    fillRepeated: "Ese abastecimiento ya está anotado: mismo vehículo, misma hora y mismos litros",
    fillClash: "Ya hay otro abastecimiento anotado con esa hora y esos litros",
    fillNotFound: "Ese abastecimiento no existe",
  },
  /** Importing fills from a CSV file: what is wrong with the file, and with each row. */
  import: {
    noRows: "El archivo no trae filas: la primera son los títulos y las siguientes, los abastecimientos",
    tooManyRows: "El archivo trae más de {{max}} filas. Divídelo en partes.",
    missingColumns: "Al archivo le falta la columna {{columns}}. Los títulos van en la primera fila.",
    column: {
      vehicle: "Vehículo (o Placa)",
      date: "Fecha",
      liters: "Litros",
    },
    unknownVehicle: "No hay ningún vehículo llamado «{{name}}» ni con esa placa",
    vehicleMissing: "Falta el vehículo",
    ambiguousVehicle: "Hay más de un vehículo que se llama «{{name}}» o tiene esa placa",
    badDate: "No se entiende la fecha «{{value}}». Sirve 2026-11-22 14:30 o 22/11/2026 14:30",
    badLiters: "Los litros «{{value}}» no son un número válido",
    badTotal: "El total «{{value}}» no es un número válido",
    badCurrency: "La moneda «{{value}}» no es un código de tres letras",
  },
} as const;
