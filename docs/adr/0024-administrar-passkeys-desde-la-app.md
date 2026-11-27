# ADR-0024: Administrar passkeys desde la app con su propia sesión

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La app para iPhone crea passkeys en la ventana de inicio de sesión del sistema, porque
crearlas pide una sesión fresca (ADR-0023). Para ver las que se tienen, cambiarles el nombre o
borrarlas había que ir a la web. Se quiere hacerlo también desde la app (#145).

Listar, renombrar y borrar no piden una sesión fresca, ni en la web: basta con la sesión
de siempre. La de la app dura 30 días y casi siempre tiene más de un día.

## Opciones consideradas

### Con la sesión de la app

- A favor: no hay que volver a entrar ni abrir otra ventana. Usa las mismas rutas que la web, y la
  plataforma no cambia.
- En contra: quien tenga el teléfono con la app abierta puede borrar o renombrar una passkey. Lo
  mismo pasa en la web con una sesión abierta, y borrar una no da otra forma de entrar.

### En la ventana del sistema, como al crearlas

- A favor: todo lo de passkeys pide entrar otra vez.
- En contra: entrar otra vez para algo que no lo pide. Habría que llevar a la página la lista,
  renombrar y borrar.

## Decisión

Con la sesión de la app.

- **La sección:** Cuenta tiene «Passkeys», si la plataforma las tiene (`passkeys`). Muestra cada
  una con su nombre y su fecha, se renombra en su fila y se borra con una confirmación.
- **Las rutas:** las de la web, `list-user-passkeys`, `update-passkey` y `delete-passkey`
  bajo `/api/auth/passkey/`.
- **Crear:** como dice el ADR-0023, solo donde la plataforma lo permite (`passkeysFromApp`).

## Consecuencias

- Una prueba de la plataforma asegura que una sesión de más de un día lista, renombra y borra, y
  que crear sigue pidiendo una fresca.
- Esto reemplaza la consecuencia del ADR-0023 de que ver, renombrar o borrar queda en la web.
