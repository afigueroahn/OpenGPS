# ADR-0030: Publicar las apps en Google Play y la App Store

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Las apps para iPhone y Android funcionan, pero no están en las tiendas (#175, #176). Para enviarlas
hace falta firmarlas con cuentas de pago, darles una versión, preparar la ficha de cada tienda y una
cuenta para que Apple y Google las revisen. Angel ya tiene el Apple Developer Program y Google Play
Console.

## Opciones consideradas

### Dónde se compilan y se firman

- **En la Mac del proyecto.** A favor: sin servicios nuevos; Xcode archiva y Gradle genera el `.aab`.
  En contra: la Mac Intel no pasa de Xcode 26.3, así que una SDK nueva de Expo pedirá otra Mac o la
  nube (ADR-0015); y la clave de subida de Android queda a cargo de Angel.
- **EAS Build de Expo.** A favor: compila en la nube, guarda las firmas y puede enviar a las tiendas.
  En contra: un servicio y una cuenta nuevos, la dependencia `eas-cli` y los límites del plan gratis.

### Dónde viven los materiales de las fichas

- **En el repo** (`apps/mobile/store/`): versionados y revisados en un PR. En contra: las capturas
  suman algunos MB.
- **Fuera del repo:** no pesan, pero nadie los revisa y se pierden.

## Decisión

- **Compilar y firmar en la Mac del proyecto.**
  - **iPhone:** se firma con el equipo de pago, que va en `ios.appleTeamId` para que
    `expo prebuild` lo escriba en cada `ios/` nuevo.
  - **Android:** se firma con una clave de subida que Angel crea y guarda fuera del repo, y que
    Gradle lee de `~/.gradle/gradle.properties` (complemento `plugins/upload-signing.js`). Google
    Play guarda la clave que firma la app para la gente (Play App Signing).
- **Versión:** la app sale como 1.0.0 y su versión va aparte de la de la plataforma.
  `ios.buildNumber` y `android.versionCode` suben en cada envío a una tienda.
- **Cifrado:** la app declara que solo usa el cifrado del sistema (HTTPS), así que App Store
  Connect no lo pregunta en cada envío.
- **Fichas:** en `apps/mobile/store/`, en español e inglés, en la categoría Navegación.
- **Revisión:** Apple y Google usan la cuenta `demo@opengps.dev` en `app.opengps.dev`. Su contraseña
  se escribe solo en las consolas de cada tienda, nunca en el repo.

## Consecuencias

- Si se pierde la clave de subida, Google Play deja pedir otra desde Play Console; la app sigue
  firmada con la clave que guarda Google.
- Subir a las tiendas y publicar lo hace Angel desde App Store Connect y Play Console.
- Cuando Apple exija un Xcode que esta Mac no puede instalar, habrá que compilar la app de iPhone en
  otra Mac o en la nube, y registrar esa decisión.
