// Texts of the backend in Spanish, the reference language: drivers.
export default {
  errors: {
    fromNeeded: "Falta la fecha inicial",
    toNeeded: "Falta la fecha final",
    notFound: "Ese conductor no existe",
    keyTaken: "Esa llave ya es de otro conductor",
    inactive: "Ese conductor está dado de baja",
    restTooLong: "El descanso debe ser más corto que el tiempo máximo de conducción continua",
    dailyBelowContinuous: "El máximo diario no puede ser menor que el máximo continuo",
  },
  ranking: {
    /** The row of what was driven with nobody assigned. */
    noDriver: "Sin conductor asignado",
  },
} as const;
