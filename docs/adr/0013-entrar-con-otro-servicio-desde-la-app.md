# ADR-0013: Entrar con otro servicio desde la app móvil

- **Estado:** Aceptada
- **Fecha:** 2026-11-26
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La plataforma deja entrar y registrarse con Google, GitHub, Facebook, Apple o cualquier
servicio de OpenID Connect que conecte su dueño. La web lo hace llevando a la persona a la
página del servicio y de vuelta: al volver, la librería de sesión deja la cookie en el
navegador.

La app móvil guarda su propia cookie de sesión y la envía en cada petición. Si abre esa
misma ida y vuelta en el navegador del sistema, la sesión queda en el navegador y la app no
la recibe. Hace falta una forma de que la sesión llegue a la app.

## Opciones consideradas

### Navegador del sistema y un pase de un solo uso

La app abre la ventana segura de inicio de sesión del sistema (`ASWebAuthenticationSession`
en iOS) en una dirección de la plataforma que empieza la ida al servicio. Al volver, la
plataforma convierte la sesión recién creada en un código de un solo uso y lleva a la
persona a la dirección de la app (`opengps://`). La app cambia el código por la sesión.

- A favor: sirve para todos los servicios que tenga la plataforma, sin configurar nada más
  en ellos ni en la consola. La persona ve la página real del servicio. Usa un complemento
  que ya trae la librería de sesión (`oneTimeToken`), sin paquetes nuevos en el servidor.
- En contra: la app suma un módulo nativo (`expo-web-browser`) y se recompila. La dirección
  de la app (`opengps://`) puede registrarla otra app; ver «Consecuencias».

### Inicio de sesión nativo de Apple y Google

La app usa los botones del propio teléfono, obtiene un token del servicio y lo envía a
`POST /api/auth/sign-in/social`.

- A favor: se ve y se siente del sistema, sin abrir ninguna página.
- En contra: solo Apple y Google. Pide un ID de cliente para iOS en la consola, la capacidad
  «Sign in with Apple» en la cuenta de Apple Developer y dos dependencias nativas.

### Solo correo y contraseña en la app

- A favor: nada cambia en la plataforma.
- En contra: quien se registró con un servicio no tiene contraseña y no puede entrar a la
  app.

## Decisión

Navegador del sistema y un pase de un solo uso.

- La plataforma usa el complemento `oneTimeToken` de la librería de sesión: el código dura un
  minuto, se guarda cifrado, sirve una sola vez y no se puede pedir desde fuera de la
  plataforma.
- Nueva ruta `GET /api/app/oauth/start?provider=…`: la app abre ahí la ventana y la ida al
  servicio empieza en ese navegador. Tiene que ser así porque la librería de sesión comprueba
  que vuelve el mismo navegador que salió.
- Nueva ruta `GET /api/app/oauth`: es la vuelta que se pide al servicio. Si hay una sesión
  creada hace menos de cinco minutos, lleva a `opengps://oauth?token=…`. Si el servicio
  devolvió un error, lleva a `opengps://oauth?error=…`. Una sesión más vieja no se entrega.
- La app cambia el código con `POST /api/auth/one-time-token/verify`, que le devuelve la
  cookie de la sesión.
- La app abre el navegador en modo efímero: no comparte cookies con Safari, así que la
  sesión de la plataforma no queda guardada en el navegador.
- Registrarse con un servicio desde la app sigue las reglas de la web: la app muestra los
  términos junto a los botones y envía la versión que mostró (`&legalVersion=`); la
  plataforma la pasa como `additionalData` y crea la cuenta solo si es la vigente.

## Consecuencias

- Una página puede intentar abrir `GET /api/app/oauth/start` o `GET /api/app/oauth` en el navegador de alguien que ya
  tiene sesión en la web. Por eso la ruta solo entrega sesiones creadas hace unos minutos,
  que en la práctica son las de una ida y vuelta al servicio que la persona acaba de hacer.
- Otra app puede registrar `opengps://`. La ventana segura del sistema le entrega la vuelta
  solo a la app que la abrió, así que no puede quedarse con el pase de una entrada que hizo
  la app de OpenGPS. Los enlaces universales (`https://`) lo cerrarían del todo, pero cada
  instalación tiene su propio dominio y la app tendría que conocerlos todos.
- Si el servicio falla antes de volver a la plataforma, la librería de sesión muestra la
  página de entrada de la web dentro de la ventana; la persona la cierra y vuelve a la app.
- `docs/API.md` documenta la ruta nueva y las de `/api/auth/one-time-token/`.
- La app usa `expo-web-browser`, que trae Expo 55.
