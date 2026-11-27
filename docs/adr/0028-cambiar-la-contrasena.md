# ADR-0028: Cambiar la contraseña desde dentro

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Ni la web ni la app tienen cómo cambiar la contraseña estando dentro: solo «Olvidé mi
contraseña», que pide salir y esperar un correo (#162, #163). La librería de sesión ya tiene
`POST /api/auth/change-password`, con la contraseña actual, y la plataforma ya le aplica su
política a la nueva. Falta decidir qué pasa con las otras sesiones de la persona y qué se le
ofrece a quien no tiene contraseña porque entra con otro servicio o con una passkey.

Al restablecerla con el enlace del correo, la plataforma cierra todas las sesiones.

## Opciones consideradas

### Las otras sesiones

- **Cerrarlas siempre.** A favor: si alguien más tenía la contraseña, queda fuera. En contra:
  cambiarla desde la web cierra también la app del teléfono, aunque no haga falta.
- **Que la persona elija, con la casilla marcada de entrada.** A favor: lo seguro es lo que
  viene puesto, y quien solo quiere otra contraseña no pierde sus otras sesiones. En contra: una
  casilla más en la pantalla.
- **Dejarlas abiertas.** A favor: nada se cierra. En contra: quien cambia la contraseña porque
  otra persona la sabe sigue con esa persona dentro.

### Quien no tiene contraseña

- **Explicarle cómo crearla con «Olvidé mi contraseña».** A favor: no hay nada nuevo. En
  contra: tiene que salir para hacerlo.
- **Un botón que le envía el enlace a su correo.** A favor: lo hace desde su perfil, y el enlace
  prueba que el correo es suyo. El enlace de restablecimiento ya crea la contraseña a quien no
  tiene. En contra: en una plataforma sin correo el enlace no llega, como hoy con «Olvidé mi
  contraseña».
- **No mostrarle nada.** A favor: lo más simple. En contra: no se entera de que puede tener una.

## Decisión

- **Las otras sesiones:** la persona elige con «Cerrar la sesión en los demás dispositivos»,
  marcada de entrada. El cliente lo envía en `revokeOtherSessions`. La sesión desde la que se
  cambia sigue abierta: si se cierran las demás, la plataforma le da una nueva en la respuesta.
- **Quien no tiene contraseña** (`me.user.hasPassword` en falso): un botón le envía a su correo el
  enlace de `POST /api/auth/request-password-reset`, que crea la contraseña al usarlo.
- **El aviso por correo** de que la contraseña cambió va aparte (#164).

## Consecuencias

- Las pruebas de la plataforma aseguran el cambio con la actual, que una actual equivocada no
  cambia nada, la política, que las demás sesiones se cierran o no según se pida y que quien no
  tiene contraseña la crea con el enlace.
- La app guarda la sesión nueva que llega cuando se cierran las demás: ya guarda cada cookie de
  sesión que le da la plataforma.
- El restablecimiento con el enlace sigue cerrando todas las sesiones.
