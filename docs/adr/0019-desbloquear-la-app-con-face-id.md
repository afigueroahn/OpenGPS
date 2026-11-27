# ADR-0019: Desbloquear la app para iPhone con Face ID, con `expo-local-authentication`

- **Estado:** Superseded by ADR-0021: la app ya no se bloquea; Face ID llega con las passkeys para entrar
- **Fecha:** 2026-11-26
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La app para iPhone guarda la sesión en el llavero (ADR-0017) y, al abrirla, entra directo.
Quien toma el teléfono desbloqueado ve el mapa en vivo, los vehículos y su historial. Se
quiere poder desbloquear la app con Face ID, o con Touch ID según el iPhone, y con el código
del iPhone como respaldo (#119). Hace falta elegir con qué se pide (#118).

## Opciones consideradas

### `expo-local-authentication`

- A favor: la app decide cuándo pide Face ID (al abrirla y al volver tras un rato). Si Face
  ID falla, ofrece el código del iPhone. Sabe si el teléfono tiene Face ID o Touch ID y si
  hay una cara o una huella guardada. Trae su texto de permiso (`faceIDPermission`) y sirve
  igual en Android.
- En contra: es una dependencia nueva y un módulo nativo, así que la app se recompila.

### `expo-secure-store` con `requireAuthentication`

- A favor: ya está en la app, y sin Face ID no se puede leer la sesión.
- En contra: no ofrece el código del iPhone como respaldo. Si cambian las caras
  registradas, la sesión se pierde. Leerla bloquea la app hasta pasar Face ID, y la app la
  lee al arrancar.

### Un módulo nativo propio sobre `LocalAuthentication` de Apple

- A favor: sin dependencias de terceros.
- En contra: código nativo propio que mantener y probar en cada versión de iOS, para hacer
  lo mismo que la primera opción.

## Decisión

`expo-local-authentication`, en la versión del SDK 55 de Expo. Desbloquear con Face ID es
una preferencia del teléfono, guardada en el llavero y apagada de inicio. Encendida, la app
pide Face ID al abrirse y al volver a ella tras 5 minutos o más fuera
(`apps/mobile/src/lib/lock.ts`). Mientras está bloqueada no dibuja ninguna pantalla de la
cuenta. Cerrar sesión o cambiar de plataforma la apaga.

## Consecuencias

- La sesión se sigue guardando como dice ADR-0017. Face ID bloquea la app, no la cookie.
- El aviso de permiso de Face ID del sistema va en español en `app.json`, también para
  `expo-secure-store`, que declara el mismo permiso.
- Licencia MIT, de Expo (#118).
