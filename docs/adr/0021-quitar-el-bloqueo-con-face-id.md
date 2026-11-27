# ADR-0021: Quitar el bloqueo de la app con Face ID: lo reemplazan las passkeys

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

ADR-0019 bloqueó la app para iPhone con Face ID: al abrirla y al volver tras 5 minutos,
con `expo-local-authentication`. Después se decidió que Face ID sirva para entrar, no
para desbloquear: con passkeys en la web y en las apps (ADR-0020). En la app, las passkeys
entran por la ventana de inicio de sesión del sistema, que pide Face ID ella misma (#125).

## Opciones consideradas

### Quitar el bloqueo en el mismo cambio que trae las passkeys a la app

- A favor: la app nunca se queda sin Face ID, y no quedan dos formas de usarlo que la persona
  tenga que entender.
- En contra: el cambio de la app suma lo que se quita.

### Quitarlo antes, en un cambio propio

- A favor: un cambio más chico.
- En contra: la app queda sin Face ID hasta que lleguen las passkeys.

### Dejar el bloqueo junto a las passkeys

- A favor: quien tiene la app abierta en un teléfono desbloqueado sigue protegido.
- En contra: dos usos de Face ID distintos y una dependencia nativa más que mantener.

## Decisión

Quitar el bloqueo en el mismo cambio que trae las passkeys a la app (#125). Se van el
interruptor, la pantalla de bloqueo y `expo-local-authentication`. Como la app ya no usa
Face ID por sí misma, tampoco pide su permiso: `expo-secure-store` va con
`faceIDPermission: false`. Así el sistema no muestra ningún aviso de Face ID de la app;
el de las passkeys es el del propio sistema.

## Consecuencias

- La sesión de la app se sigue guardando como dice ADR-0017, y la app entra directo al
  abrirla, como antes de ADR-0019.
- Quien quiera proteger la app abierta depende del bloqueo del propio iPhone.
