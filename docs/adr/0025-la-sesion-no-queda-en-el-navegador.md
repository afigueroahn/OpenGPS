# ADR-0025: La sesión no queda en el navegador al volver a la app

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La app entra con otro servicio y con passkeys en la ventana de inicio de sesión del sistema, y la
plataforma le pasa la sesión con un pase de un solo uso cuando la persona confirma «Volver a la
app» (ADR-0013, ADR-0014, ADR-0020). En iPhone la ventana es efímera: al cerrarse olvida sus
cookies.

En Android la ventana es Chrome Custom Tabs, y `expo-web-browser` 55 no la abre efímera: comparte
las cookies con Chrome (#149). Eso trae dos problemas:

- La cookie de la sesión se queda en Chrome durante 30 días. Quien abra la web en Chrome de ese
  teléfono entra sin contraseña.
- Si la persona ya usaba la web en Chrome, «Entrar con passkey» encuentra esa sesión y no pide la
  passkey. La plataforma solo da el pase con una sesión de menos de cinco minutos, así que la app
  recibe `no_session`.

## Opciones consideradas

### La plataforma borra la cookie del navegador al dar el pase

- A favor: un cambio chico en la plataforma y la web, sin dependencias. En iPhone no cambia nada.
- En contra: quien tenía la web abierta en Chrome queda fuera de la web al entrar en la app con otro
  servicio o con passkey.

### Aceptarlo y documentarlo

- A favor: la plataforma no cambia.
- En contra: la sesión de la app queda también en Chrome, al alcance de quien tome el teléfono.

### Un módulo nativo propio con Custom Tabs efímeras

- A favor: se comporta como en iPhone.
- En contra: código Kotlin propio que mantener en cada versión de Android. Pide Chrome 136 o más
  nuevo y no sirve si el teléfono usa otro navegador.

## Decisión

La plataforma borra la cookie del navegador al dar el pase.

- **El pase.** La respuesta de `POST /api/app/oauth` borra (`Max-Age=0`) las cookies de la
  plataforma que trajo el navegador: las que empiezan con `gps.`, con o sin `__Secure-`. La sesión
  no se cierra: es la que el pase entrega a la app.
- **Entrar con passkey.** Con `?via=passkey`, la página `/app-sign-in` pide la passkey aunque el
  navegador ya tenga una sesión. Así la sesión es nueva y la plataforma da el pase.

## Consecuencias

- Al volver a la app, ningún navegador se queda con la sesión, en iPhone ni en Android.
- La sesión vieja de la web que Chrome tenía antes sigue abierta en la plataforma hasta que venza o
  se cierre desde el perfil, aunque Chrome ya no tiene su cookie.
- Crear una passkey desde la app (ADR-0023) ya cerraba la sesión de la ventana al terminar. En
  Android, eso también saca a la persona de la web en Chrome si entró con esa sesión.
