# ADR-0017: La sesión de la app para iPhone, con la cookie en el llavero

- **Estado:** Aceptada
- **Fecha:** 2026-11-26
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La plataforma inicia sesión con una cookie de la librería de sesión, pensada para el
navegador. En la app para iPhone, esa cookie la puede guardar el sistema, como lo hace un
navegador, o la propia app. La persona además elige a qué plataforma se conecta
(`app.opengps.dev` u otra instalación) y puede cambiarla.

## Opciones consideradas

### La app guarda la cookie de sesión en el llavero

- A favor: la plataforma no cambia, la sesión queda cifrada en el llavero del iPhone y al
  cambiar de plataforma no se mezclan sesiones.
- En contra: la app lee ella misma la cabecera `Set-Cookie`.

### El complemento `bearer` de la librería de sesión

- A favor: un token en `Authorization` es lo habitual en una app.
- En contra: cambia la plataforma: cada ruta aceptaría también un token, y eso es una
  forma nueva de entrar que hay que cuidar.

### El cliente para Expo de la librería de sesión (`@better-auth/expo`)

- A favor: viene hecho.
- En contra: dos dependencias nuevas, en la plataforma y en la app, para hacer lo mismo
  que la primera opción.

### Dejar la cookie al sistema

- A favor: no hay que escribir nada.
- En contra: la cookie queda en el almacén de cookies del sistema, fuera del llavero, y la
  app no decide a qué plataforma va ni cuándo se borra.

## Decisión

La app guarda la cookie de sesión en el llavero (`expo-secure-store`) y la envía en cada
petición, solo a la plataforma que la dio:

- De cada `Set-Cookie` guarda solo las cookies de sesión de la plataforma, las que empiezan
  con `gps.` (con o sin `__Secure-`), y borra las que la plataforma da por vencidas
  (`apps/mobile/src/lib/cookies.ts`, con sus pruebas).
- Las cookies del sistema no se usan.
- En los cambios (todo lo que no es `GET` ni `HEAD`) envía `Origin` y `Referer` con la
  dirección de la plataforma, como la web, porque la librería de sesión solo acepta cambios
  que vienen de ella.
- Si la plataforma responde 401, la app olvida la cookie y vuelve a la entrada.

## Consecuencias

- La plataforma atiende a la app igual que a la web. Cualquier cambio en los nombres de sus
  cookies tiene que llegar también a `cookies.ts`.
- La entrada con otro servicio (ADR-0013) termina igual: la app cambia el pase por la
  cookie y la guarda en el llavero.
