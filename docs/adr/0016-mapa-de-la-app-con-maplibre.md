# ADR-0016: El mapa de la app para iPhone, con MapLibre React Native

- **Estado:** Aceptada
- **Fecha:** 2026-11-26
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La web dibuja el mapa con MapLibre GL y el estilo que da la plataforma (`mapStyleUrl` de
`GET /api/config`). La app para iPhone necesita el mismo mapa, en vivo y en el historial:
los vehículos agrupados cuando se aleja el mapa, cada uno con el color de su estado, la
flecha de su rumbo y su nombre, y el recorrido del elegido.

## Opciones consideradas

### MapLibre React Native (`@maplibre/maplibre-react-native`)

- A favor: el mismo motor que la web, nativo. Usa el mismo estilo y las mismas teselas, sin
  claves de ningún servicio, y las capas se escriben como en la web.
- En contra: es un módulo nativo, así que la app se recompila al cambiarlo.

### `react-native-maps`

- A favor: se ve como los mapas del sistema.
- En contra: no usa el estilo de la plataforma, en Android pide una clave de Google y no
  agrupa los vehículos por sí solo.

### MapLibre GL JS dentro de una WebView

- A favor: reusa el código de la web.
- En contra: en el teléfono es más lento, gasta más memoria, los gestos se sienten peor y
  la página y la app tienen que pasarse mensajes.

## Decisión

MapLibre React Native, con el estilo de `mapStyleUrl`. Las capas de la app
(`apps/mobile/src/map/layers.ts`) siguen las de la web: grupos, color por estado, flecha de
rumbo, nombre y recorrido.

## Consecuencias

- El mapa de la app cambia junto con el estilo de la plataforma, sin publicar la app.
- La flecha de rumbo va como imagen de la app (`assets/arrow.png`), con un nombre propio,
  porque el estilo ya trae una flecha para las calles de un solo sentido.
- Licencia MIT, de la organización MapLibre (#111).
