# ADR-0012: Una sola dirección para la web y las apps

- **Estado:** Aceptada
- **Fecha:** 2026-11-25
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La API responde en `https://<dominio>/api`, por donde la usa la web. Además había un
segundo nombre para las apps móviles, `api.<dominio>`: el contrato de la API lo daba como
su dirección, `deploy/caddy/` lo atendía con un certificado propio (ADR-0006) y la guía lo
pedía como registro DNS y como segundo nombre del túnel de Cloudflare.

La plataforma no hace nada distinto según el nombre por el que llega una petición: los dos
llevan al mismo puerto. Dokploy, Coolify y una instalación por IP no tienen ese segundo
nombre. Todavía no hay apps publicadas que lo usen.

## Opciones consideradas

### Quitar `api.<dominio>`

- A favor: instalar pide un registro DNS, un certificado y un nombre del túnel menos. La
  dirección de la API es la misma en todas las formas de instalar, y una app que pregunte
  por el servidor usa la que la persona ya conoce.
- En contra: quien ya lo creó con Caddy deja de tenerlo al actualizar.

### Dejarlo como estaba

- A favor: nada cambia para quien ya lo tiene.
- En contra: dos formas de llegar a lo mismo, y el contrato de las apps apunta a un nombre
  que no toda instalación tiene.

### Atender la API solo en `api.<dominio>`

- A favor: separa la web de la API.
- En contra: la cookie de sesión y las llamadas de la web esperan una sola dirección;
  habría que rehacerlas, y cada instalación necesitaría el segundo nombre.

## Decisión

Se quita. La web y las apps usan una sola dirección, la de `PUBLIC_URL`, y la API para las
apps es `https://<dominio>/api`.

- `deploy/caddy/` atiende solo la dirección de `PUBLIC_URL`.
- La guía de instalación no pide `api.<dominio>` en el DNS ni en el túnel de Cloudflare.
- La prueba de actualización de punta a punta comprueba que Caddy responde por el nombre de
  `PUBLIC_URL` y que no lleva `api.` a la plataforma.

## Consecuencias

- Deja sin efecto un punto de ADR-0006: Caddy ya no atiende `api.` bajo el dominio de
  `PUBLIC_URL`.
- Una instalación con Caddy que tenía `api.<dominio>` deja de responder por ese nombre al
  actualizar. Su registro DNS se puede borrar; el certificado que quedó guardado no
  estorba.
- Con el túnel de Cloudflare, `api.<dominio>` sigue respondiendo mientras ese nombre siga
  en el túnel, porque lo lleva Cloudflare y no la plataforma. Se puede quitar de allí.
- La comprobación del origen no cambia: la plataforma sigue aceptando los cambios que
  vienen de la misma dirección a la que llega la petición (ADR-0006).
