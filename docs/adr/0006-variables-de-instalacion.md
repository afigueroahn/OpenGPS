# ADR-0006: Variables de instalación, solo las que hacen falta

- **Estado:** Aceptada. Superseded by ADR-0012 en un punto: Caddy ya no atiende `api.` bajo el dominio
- **Fecha:** 2026-11-25
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Una instalación pedía variables que la plataforma puede resolver sola, o que no hace
falta ofrecer: `WEB_BIND`, `CADDY_SITES`, `DEVICE_GATEWAY_HOST`, `DEVICE_GATEWAY_IP`,
`TRUSTED_ORIGINS` y `SIMULATOR_MAX_DEVICES`. Cada una es algo más que entender, y que
puede quedar mal escrito.

## Opciones consideradas

### Dejarlas como están

- A favor: máxima flexibilidad.
- En contra: más que leer y configurar para instalar.

### Dejarlas, pero sin documentar

- A favor: nadie las ve al instalar.
- En contra: siguen funcionando sin que nadie sepa que existen.

### Quitarlas y que la plataforma resuelva sola lo que configuraban

- A favor: instalar pide lo mínimo, y no hay valores que puedan quedar mal.
- En contra: se pierde elegir otro nombre para los equipos y cerrar el puerto de la web
  desde el compose.

## Decisión

Se quitan las seis:

| Variable | Qué pasa ahora |
|---|---|
| `WEB_BIND` | `deploy/docker-compose/` publica la web en `WEB_PORT`, hacia toda la red |
| `CADDY_SITES` | Caddy atiende la dirección de `PUBLIC_URL` y `api.` bajo su dominio. Con una IP, solo la dirección |
| `DEVICE_GATEWAY_HOST` | Los equipos apuntan a `gw.` + el dominio de `PUBLIC_URL`. Si `PUBLIC_URL` es una IP o `localhost`, a ese mismo lugar |
| `DEVICE_GATEWAY_IP` | La plataforma consulta en el DNS a qué IP apunta ese nombre, y lo vuelve a consultar cada cinco minutos de uso. Sin registro, no muestra IP |
| `TRUSTED_ORIGINS` | La plataforma acepta los cambios que vienen de la misma dirección a la que llega la petición, además de `PUBLIC_URL`. Así funciona en cualquier dirección por la que se abra |
| `SIMULATOR_MAX_DEVICES` | El simulador no tiene tope de equipos a la vez |

- Un certificado comodín (`*`) pediría las claves del proveedor de DNS, así que Caddy
  pide uno por nombre. El de `api.` espera a su registro DNS sin detener al del dominio.
- La IP de los equipos no se pregunta a un servicio externo: sale del registro DNS que
  los equipos van a usar.
- La comprobación del origen no se quita. Sin ella, una página ajena podría actuar con la
  sesión abierta de una persona.

## Consecuencias

- Reemplaza un punto de ADR-0005: una instalación 0.1.x sin túnel que se actualiza ya no
  queda con `WEB_BIND=127.0.0.1`, y publica la web en el puerto 3000 del servidor.
- Quien tenga alguna de estas variables en su `.env` puede borrarla: ya no se lee.
- Un nombre que no es de la plataforma pero apunta a su servidor también se acepta como
  dirección propia. No lleva la sesión de nadie, porque el navegador la guarda por
  dirección.
- Para que el puerto de la web no se vea desde fuera con `deploy/docker-compose/`, se
  cierra en el cortafuegos del proveedor.
- Cuántos equipos simular lo decide quien usa el simulador; el servidor no lo frena.
