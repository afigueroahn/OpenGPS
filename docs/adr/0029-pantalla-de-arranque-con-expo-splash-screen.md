# ADR-0029: Pantalla de arranque de la app con `expo-splash-screen`

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La pantalla de arranque nativa de la app nunca se configuró. `android/` e `ios/` se generan con
`expo prebuild` sin `splash` en `app.json`, y traen la plantilla de Expo: fondo blanco y, en Android,
un logo de prueba. Después la app pinta su propia pantalla de carga, azul `#101623` con una ruedita,
mientras carga las fuentes y pregunta a la plataforma quién es la persona. Al abrir se ve blanco,
luego azul con la ruedita, luego el mapa (#170).

## Opciones consideradas

### `expo-splash-screen`

- A favor: usa la pantalla de arranque de AndroidX, que se ve igual en todas las versiones de
  Android, y la de iPhone. La app decide cuándo quitarla, así que puede pasar del logo a lo que sigue
  sin la pantalla de la ruedita. Es de Expo, con licencia MIT, se publica con cada SDK (55.x) y no
  pide permisos.
- En contra: una dependencia nueva y un módulo nativo.

### La clave `splash` de `app.json`, sin paquete

- A favor: sin dependencias; `prebuild` la aplica con su complemento incluido.
- En contra: en Android solo pinta el fondo de la ventana, sin los atributos de Android 12 o más
  nuevo, que tienen casi todos los teléfonos. Ahí el sistema sigue con su propio arranque. Expo lo
  mantiene solo por compatibilidad.

### Un complemento propio en `plugins/`

- A favor: sin dependencias, y controla Android 12+.
- En contra: código propio que repite lo que hace `expo-splash-screen` y hay que mantener con cada
  SDK. Tampoco decide cuándo se quita el arranque.

## Decisión

`expo-splash-screen`, en la versión del SDK 55.

- **Cómo se ve:** fondo `#101623` con el logo de OpenGPS, en iPhone y Android, en modo claro y
  oscuro. El logo es el del ícono adaptable (`assets/adaptive-icon.png`), que ya trae ese fondo.
- **Cuándo se quita:** cuando la app tiene sus fuentes y, si hay una sesión guardada, la respuesta
  de la plataforma sobre quién es la persona. Si la plataforma tarda más de 4 segundos, se quita
  igual y se ve la pantalla de carga de la app, con la ruedita, hasta que responda.

## Consecuencias

- Para que la pantalla de arranque nueva llegue a los teléfonos hay que volver a generar `android/`
  e `ios/` y compilar las apps.
- Al subir de SDK, `expo-splash-screen` sube con él.
- Licencia MIT, de Expo.
