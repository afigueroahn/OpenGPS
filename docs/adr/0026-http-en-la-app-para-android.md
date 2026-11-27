# ADR-0026: La app para Android también entra por HTTP

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La app pide la dirección de la plataforma: propone `https://` y acepta `http://` si la persona lo
escribe. La guía de instalación permite una plataforma sin dominio, en `http://IP-DEL-SERVIDOR:3000`
(`deploy/README.md`). La app para iPhone entra así a una IP, porque su seguridad de transporte
permite la red local.

Android bloquea HTTP en la app compilada para instalar (`usesCleartextTraffic`, desde Android 9), y
solo la versión de desarrollo lo deja pasar. Su configuración de red no puede autorizar «solo
direcciones IP»: se autoriza por nombre de dominio o para todo (#152).

## Opciones consideradas

### Permitir HTTP, con un complemento de configuración propio

- A favor: quien instaló sin dominio usa la app de Android, como la de iPhone. Sin dependencias: el
  complemento usa `expo/config-plugins`, que ya viene en `expo`.
- En contra: Android también deja HTTP con un dominio, y la app para iPhone no.

### Solo HTTPS

- A favor: más estricto.
- En contra: quien instaló con IP no tiene app de Android, y la demo local solo se prueba en la
  versión de desarrollo.

### `expo-build-properties`

- A favor: es la forma que documenta Expo.
- En contra: una dependencia nueva para una sola línea del manifiesto.

## Decisión

Permitir HTTP. El complemento `apps/mobile/plugins/allow-http.js` pone
`android:usesCleartextTraffic="true"` en el manifiesto de la app, y `app.json` lo registra.

## Consecuencias

- La app sigue proponiendo `https://`: solo usa HTTP quien lo escribe.
- Con HTTP la cookie de la sesión viaja sin cifrar. Es igual en la web con esa instalación.
- Si las instalaciones sin dominio se retiran, el complemento se borra.
