# ADR-0014: Confirmar en la plataforma antes de volver a la app

- **Estado:** Aceptada
- **Fecha:** 2026-11-26
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Con ADR-0013, al volver de otro servicio la plataforma convierte la sesión recién creada en
un pase de un solo uso y lleva a la persona a `opengps://oauth?token=…`, sin que ella haga
nada más.

Eso deja un caso abierto (#103):
1. Una página maliciosa abre `GET /api/app/oauth/start` en Safari.
2. Si la persona ya tenía sesión en ese servicio y había autorizado a la plataforma, el
   servicio la deja pasar sin preguntar.
3. Se crea una sesión nueva, y su pase va a la app que tenga registrado `opengps://`.

El límite de cinco minutos no lo evita, porque la sesión sí es nueva.

RFC 8252 §8.6 pide que, cuando no se puede comprobar qué app recibe la vuelta, no se entregue
nada sin que la persona intervenga, aunque ya hubiera autorizado antes.

## Opciones consideradas

### Confirmar en la plataforma

La vuelta lleva a una página de la web donde la persona confirma con qué cuenta vuelve a la
app. El pase se crea solo entonces.

- A favor:
  - No depende de ningún servicio.
  - Otra página no puede confirmar por la persona.
  - La página dice con qué cuenta se entra.
- En contra: cada entrada desde la app suma un toque.

### Que el servicio siempre pregunte

Al empezar desde la app, la plataforma agrega a la dirección del servicio el parámetro que
lo obliga a preguntar (`prompt=select_account`, `prompt=login`, `auth_type=reauthenticate`).

- A favor: no suma toques.
- En contra:
  - Depende de que cada servicio lo respete, y un servicio de OpenID Connect puede ignorarlo.
  - En el ataque, a la persona le basta un toque para elegir su cuenta, en una página del
    servicio que se ve legítima.

### Aceptarlo

- A favor: nada cambia.
- En contra: el caso queda abierto.

Se descartaron otras dos salidas:
- **Ligar el pase a quien empezó la entrada, como PKCE.** No sirve si la página y la app
  falsa son del mismo atacante.
- **Enlaces universales.** Cada instalación tiene su propio dominio.

## Decisión

Confirmar en la plataforma. Esto reemplaza el punto de ADR-0013 en que la vuelta entrega el
pase directamente.

- **La vuelta.** Si `GET /api/app/oauth` encuentra una sesión creada hace menos de cinco
  minutos, ya no lleva a la app: lleva a la página `/app-sign-in` de la web. Los errores del
  servicio, y la falta de sesión, siguen llegando a la app como antes.
- **La página.** Dice con qué cuenta se entra y ofrece «Volver a la app» o «Cancelar».
- **El pase.** Se crea solo con `POST /api/app/oauth` desde esa página. La página lleva
  entonces a `opengps://oauth?token=…`, y el pase sigue las reglas de ADR-0013.
- **Cancelar.** Lleva a `opengps://oauth?error=access_denied`.

## Consecuencias

- Cada entrada con otro servicio desde la app suma un toque. La app no cambia: sigue
  esperando `opengps://oauth`.
- Otra página no puede crear el pase por la persona:
  - la web no se deja mostrar dentro de otra página (`frame-ancestors 'none'`);
  - un `POST` desde otro sitio no lleva la cookie de sesión (`SameSite=Lax`);
  - la plataforma rechaza los cambios que llegan de otro origen.
- El caso abierto sigue dependiendo de que la persona no confirme una página que no pidió.
  Pero ahora tiene que tocar «Volver a la app» y además aceptar la pregunta de Safari, y la
  página le dice con qué cuenta.
- `docs/API.md` documenta la ruta nueva.
