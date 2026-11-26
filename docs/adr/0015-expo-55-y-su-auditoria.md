# ADR-0015: La app para iPhone en Expo SDK 55, y los avisos de su auditoría

- **Estado:** Aceptada
- **Fecha:** 2026-11-26
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La app para iPhone está hecha con Expo (ADR-0002). Se compila y se prueba en una MacBook
Pro Intel de 2019 que no puede pasar de macOS 15, y ahí el Xcode más nuevo es el 26.3.
Expo SDK 56 en adelante pide Xcode 26.4, que necesita macOS 26.

Expo 55 ya está en su última versión (55.0.32), y la auditoría de dependencias que exige la
CI encuentra cinco avisos en paquetes que trae:

| Paquete | Versión | Aviso | Dónde corre | Corregido en |
|---|---|---|---|---|
| `zod` | 3.25.76 | GHSA-mrhx-c7xc-m3w5 (alta) | `@expo/cli`, en la computadora de quien desarrolla | 4.6.6 |
| `glob` | 13.0.7 | GHSA-3g3m-2fjr-6pw4 (moderada) | `@expo/fingerprint`, ídem | 14.0.2 |
| `minimatch` | 10.2.6 | GHSA-g3hv-75wg-m249 (moderada) | `@expo/fingerprint`, ídem | 11.0.1 |
| `decode-uri-component` | 0.2.2 | GHSA-qr28-fpjm-wq7f (alta) y GHSA-vcc3-ghjq-m6fr (moderada) | `query-string` 7 de `expo-router`, dentro de la app | 0.5.1 |

## Opciones consideradas

### Expo SDK 55; forzar las versiones corregidas que Expo aguante y excluir el resto

- A favor: se compila y se prueba en el simulador de esta Mac, sin servicios nuevos.
- En contra: tres paquetes de las herramientas de Expo corren con una versión mayor que la
  que piden, y dos avisos quedan excluidos.

### Expo SDK 55, excluyendo los cinco avisos

- A favor: más simple.
- En contra: no corrige nada.

### Expo SDK 58, compilado en la nube (EAS Build) o en otra Mac con macOS 26

- A favor: sin avisos: `expo-router` 58 ya no usa `query-string`.
- En contra: suma un proveedor y una cuenta, o pide otra Mac, y la app ya no se puede
  probar en el simulador de esta Mac.

## Decisión

Expo SDK 55. En `pnpm-workspace.yaml`:

- `overrides` fuerza `zod` 4.6.6, `glob` 14.0.2 y `minimatch` 11.0.1 o más nuevas. Las usan
  solo las herramientas de Expo; se comprobó que `expo config`, `expo export` y la app en el
  simulador siguen funcionando.
- `auditConfig.ignoreGhsas` excluye los dos avisos de `decode-uri-component`. Su versión
  corregida solo se publica como módulo ES, y `query-string` 7 la carga con `require`, así
  que forzarla rompe la app.

## Consecuencias

- Dentro de la app, una dirección mal formada que la app lea, como un enlace `opengps://`,
  podría dejarla trabada un rato. No expone datos.
- La CI vuelve a avisar de cualquier vulnerabilidad nueva, también en la app.
- Al subir de SDK se quitan los `overrides` y las exclusiones. Subir pide compilar en la
  nube o en otra Mac, y eso es una decisión aparte.
