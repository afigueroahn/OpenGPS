# ADR-0027: Compartir archivos desde la app con `expo-sharing`

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La app baja un archivo de la plataforma y lo pasa a la hoja de compartir del sistema en dos
lugares: exportar el historial y abrir una evidencia de un incidente. Usaba `Share.share({ url })`
de React Native, que en iPhone acepta un archivo. En Android `Share` solo comparte texto, así que
esas dos funciones no hacían nada.

Para compartir un archivo, Android pide entregarlo con un `FileProvider` y dar permiso de lectura a
la app que lo recibe. Eso es código nativo (#155).

## Opciones consideradas

### `expo-sharing`

- A favor: la misma hoja del sistema en los dos teléfonos y un solo camino en el código. Es de Expo,
  con licencia MIT, se publica con cada SDK (55.x) y no pide permisos.
- En contra: una dependencia nueva y un módulo nativo.

### `expo-intent-launcher`, solo en Android

- A favor: abre el archivo directamente con otra app.
- En contra: también es una dependencia nueva, abre en lugar de compartir, e iPhone seguiría por otro
  camino.

### Quitar exportar y abrir evidencias en Android

- A favor: sin dependencias.
- En contra: la app de Android hace menos que la de iPhone; esas funciones quedan solo en la web.

## Decisión

`expo-sharing`, en la versión del SDK 55. `shareFile` (`apps/mobile/src/lib/api.ts`) abre la hoja
con el archivo bajado y su tipo, que Android necesita para ofrecer las apps que lo abren. Los
enlaces de texto (compartir la ubicación, el enlace de recuperación) siguen con `Share`.

## Consecuencias

- El complemento de configuración de `expo-sharing` es para recibir lo que otras apps comparten, y
  la app no lo registra.
- Al subir de SDK, `expo-sharing` sube con él.
- Licencia MIT, de Expo.
