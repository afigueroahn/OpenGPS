# ADR-0018: El identificador de la app para iPhone, `dev.opengps.app`

- **Estado:** Aceptada
- **Fecha:** 2026-11-26
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Apple reconoce cada app por su identificador (bundle ID), que no se puede cambiar una vez
publicada. Se escribe con un dominio de quien la publica, al revés. El dominio del proyecto
es `opengps.dev`: la app ya propone `app.opengps.dev` como plataforma. La app decía
`org.opengps.mobile`, un dominio que no es del proyecto.

## Opciones consideradas

### `dev.opengps.app`

- A favor: corto, del dominio del proyecto y sirve igual como paquete de la app de Android.

### `dev.opengps.mobile`

- A favor: también del dominio.
- En contra: «mobile» nombra la carpeta del repositorio, no la app.

### `io.github.afigueroahn.opengps`

- A favor: no depende de un dominio.
- En contra: ata la app a una cuenta personal de GitHub.

## Decisión

`dev.opengps.app`, en `ios.bundleIdentifier` de `apps/mobile/app.json`.

## Consecuencias

- La dirección de la app para volver de otro servicio sigue siendo `opengps://` (ADR-0013).
- Publicarla en la App Store pide registrar este identificador en la cuenta de Apple
  Developer del proyecto.
