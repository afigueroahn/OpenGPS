# ADR-0005: Formas de instalar

- **Estado:** Aceptada. Superseded by ADR-0006 en un punto: `WEB_BIND` ya no existe. Superseded by ADR-0009 en otro: Dokploy y Coolify no llevan `helper`
- **Fecha:** 2026-11-25
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Había dos formas de instalar: `deploy/docker-compose/`, que no publicaba la web y traía
el túnel de Cloudflare como perfil opcional, y `deploy/dokploy/`. Quien quería otra
cosa (la web en un puerto, un proxy con certificado, Coolify) tenía que adaptar el
compose a mano, y el perfil opcional mezclaba dos formas en un mismo archivo.

## Opciones consideradas

### Un compose base y archivos que lo extienden

- A favor: los servicios comunes se escriben una vez.
- En contra: instalar pide descargar varios archivos y combinarlos, y Coolify reescribe
  el compose que recibe, así que no admite archivos que se extienden entre sí.

### Un solo compose con perfiles

- A favor: un archivo.
- En contra: cada forma se elige con variables, las obligatorias de una estorban a las
  demás, y las plataformas como Dokploy y Coolify no manejan perfiles.

### Una carpeta por forma, con un compose completo cada una

- A favor: instalar es descargar un archivo; cada forma se lee entera y se prueba sola.
- En contra: los servicios comunes se repiten en cada archivo.

## Decisión

Una carpeta por forma de instalar, cada una con un `docker-compose.yml` completo:

| Carpeta | Cómo llega la web | Se actualiza desde la consola |
|---|---|---|
| `deploy/docker-compose/` | En un puerto del servidor, en HTTP | Sí |
| `deploy/caddy/` | Por Caddy, con su certificado, en los puertos 80 y 443 | Sí |
| `deploy/cloudflare/` | Por un túnel de Cloudflare | Sí |
| `deploy/dokploy/` | Por el proxy de Dokploy | No: la despliega Dokploy |
| `deploy/coolify/` | Por el proxy de Coolify | No: la despliega Coolify |

- Los servicios `postgres`, `traccar`, `opengps` y `helper` son los mismos en todas. En
  todas, Traccar publica los puertos de los equipos en el servidor.
- Cada compose lleva la marca `x-opengps-deploy: <carpeta>`. La CI comprueba que
  coincide con su carpeta y que todos son válidos.
- La imagen del ayudante lleva el compose de cada forma que puede actualizar, en
  `/opt/opengps/<forma>/`. Al instalar una versión, toma el de la forma que tiene la
  instalación (ADR-0004).
- Una instalación 0.1.x, sin marca, queda en su forma al actualizar: `cloudflare` si
  usaba el perfil del túnel, y si no `docker-compose` con `WEB_BIND=127.0.0.1`, para no
  abrir un puerto que antes no publicaba.
- Cada release adjunta el compose de cada forma de Docker Compose:
  `docker-compose.yml`, `docker-compose.caddy.yml` y `docker-compose.cloudflare.yml`.
- `deploy/build.yml` construye las imágenes desde el código, detrás del compose de
  cualquiera de las formas.

## Consecuencias

- Un cambio en un servicio común se hace en los cinco archivos.
- `COMPOSE_PROFILES` deja de usarse. `CLOUDFLARE_TUNNEL_TOKEN` pasa a ser obligatoria
  en `deploy/cloudflare/`.
- La imagen de Caddy es una dependencia nueva de la instalación, solo en `deploy/caddy/`.
- La prueba de punta a punta (`.github/scripts/update-e2e.sh`) corre por forma, y con
  una instalación 0.1.2 publicada que debe terminar como `cloudflare`.
