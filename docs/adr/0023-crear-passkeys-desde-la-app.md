# ADR-0023: Crear passkeys desde la app: volviendo a entrar en la ventana del sistema

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Las passkeys se creaban solo en la web; la app solo entraba con una ya creada (ADR-0020).
Para crearlas desde la app hay tres condiciones (#140):

- Se crean en la ventana de inicio de sesión del sistema, como al entrar, porque las
  passkeys nativas no sirven con los dominios de las instalaciones propias.
- Esa ventana no tiene la sesión de la app, que vive en su llavero (ADR-0017).
- Crear una passkey pide una sesión fresca, de menos de un día, para que una sesión vieja o
  robada no sume una forma permanente de entrar. La de la app dura 30 días y casi siempre
  tiene más de un día.

## Opciones consideradas

### Volver a entrar en la ventana del sistema

- A favor: mantiene la sesión fresca, no toca la plataforma y sirve para cualquier cuenta.
- En contra: la persona entra otra vez, aunque con el autocompletado y Face ID de iOS son
  unos toques.

### Pasar la sesión de la app a la ventana con un pase

- A favor: el primer día después de entrar en la app, no hay que volver a entrar.
- En contra: después termina igual que la primera opción, y suma una ruta que lleva la
  sesión de la app al navegador.

### Un pase que abre una sesión nueva

- A favor: nunca hay que volver a entrar.
- En contra: quien tenga el teléfono con la app abierta suma una passkey sin saber la
  contraseña. Se pierde la protección de la sesión fresca.

## Decisión

Volver a entrar en la ventana del sistema.

- **El botón:** la app tiene «Crear passkey» en Cuenta, si la plataforma dice que se puede
  (`passkeysFromApp`).
- **La ventana:** abre `/app-passkey` en modo efímero, sin la sesión de la app ni la del
  navegador.
- **La página:** sin sesión, lleva a entrar de las formas de siempre y vuelve. Ya dentro, crea
  la passkey con un nombre que se puede cambiar. Después cierra esa sesión del navegador y
  vuelve a `opengps://passkey?created=1`, o a `?error=` con la razón (`access_denied`,
  `unavailable`).
- **La plataforma** solo suma `passkeysFromApp` en `GET /api/config`. Una plataforma anterior no
  tiene la página, y sin esa marca la app no ofrece el botón.

## Consecuencias

- La sesión de la app no cambia, y la del navegador no queda abierta.
- Ver, renombrar o borrar passkeys sigue siendo cosa de la web.
