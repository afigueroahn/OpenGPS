# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/).

## [Sin publicar]

### Cambiado

- La plataforma acepta entrar y guardar cambios desde cualquier dirección por la que se
  abra (una IP, otro dominio), sin configurar nada, y sigue rechazando a las páginas
  ajenas (ADR-0006, #44).
- Los equipos GPS apuntan siempre a `gw.` + el dominio, o a la misma IP cuando la
  plataforma se abre por una IP. La IP que se muestra a quien configura un equipo sale
  del registro DNS de ese nombre (#44).
- `deploy/caddy/` atiende la dirección de `PUBLIC_URL` y `api.` bajo su dominio, cada
  una con su certificado (#44).
- `deploy/docker-compose/` publica la web siempre hacia toda la red. Una instalación
  0.1.x sin túnel que se actualiza pasa a publicar el puerto 3000 (#44).
- El simulador de la consola ya no tiene tope de equipos a la vez (#44).

### Eliminado

- Las variables `WEB_BIND`, `CADDY_SITES`, `DEVICE_GATEWAY_HOST`, `DEVICE_GATEWAY_IP`,
  `TRUSTED_ORIGINS` y `SIMULATOR_MAX_DEVICES`. Quien las tenga en su `.env` puede
  borrarlas: ya no se leen (ADR-0006, #44).

## [0.2.0] - 2026-11-25

### Añadido

- `deploy/cloudflare/`: instalar con Docker Compose y un túnel de Cloudflare es una
  forma propia, con su compose (ADR-0005, #36).
- `deploy/caddy/`: instalar con Docker Compose y Caddy, que pone el dominio con HTTPS y
  consigue el certificado solo. `CADDY_SITES` suma otros nombres, como `api.`. Se
  actualiza desde la consola y cada release adjunta `docker-compose.caddy.yml` (#38).
- `deploy/coolify/`: instalar en Coolify, que genera los secretos y pone el dominio.
  Solo pide `OPENGPS_VERSION` (#38).
- `TRUSTED_ORIGINS` y `SIMULATOR_MAX_DEVICES` se pueden fijar en una instalación: los
  cinco compose se las pasan a la plataforma (#40).

### Cambiado

- `deploy/docker-compose/` publica la web en un puerto del servidor (`WEB_PORT`, 3000;
  `WEB_BIND`) y ya no trae el túnel de Cloudflare como perfil opcional:
  `COMPOSE_PROFILES` deja de usarse (#36).
- El ayudante conserva la forma de instalar al actualizar: cada compose lleva su marca
  y la imagen del ayudante trae el de cada forma. Una instalación 0.1.x queda sola en
  la suya: `cloudflare` si usaba el túnel, y si no `docker-compose` con
  `WEB_BIND=127.0.0.1` (#36).
- Cada release adjunta también `docker-compose.cloudflare.yml`.
- `deploy/docker-compose/build.yml` pasa a `deploy/build.yml` y sirve para cualquier
  forma.
- `deploy/.env.example` queda ordenado por forma de instalar, y la CI comprueba con
  `.github/scripts/env-check.sh` que explica las variables que leen los compose, y
  ninguna otra (#40).

## [0.1.2] - 2026-11-25

### Cambiado

- La confirmación de «Actualizar a X.Y.Z» dice solo que la plataforma podría estar
  fuera de servicio unos segundos y que se restablecerá sola (#32).
- Después de actualizar desde la consola, Actualizaciones muestra un solo mensaje, «La
  plataforma se actualizó a la versión X.Y.Z», durante una hora, en lugar de ese más
  «Esta instalación tiene la última versión» para siempre. Un fallo se muestra mientras
  esa versión siga siendo la que se ofrece (#32).

## [0.1.1] - 2026-11-25

### Cambiado

- La confirmación de «Actualizar a X.Y.Z» usa el botón principal en lugar del rojo de
  las acciones que borran: instalar una versión no borra nada y vuelve atrás sola si
  falla (#30).

## [0.1.0] - 2026-11-25

### Añadido

- Forma de trabajo del proyecto en `AGENTS.md` y `CLAUDE.md`.
- Gobernanza del repositorio: licencia Apache-2.0 (ADR-0001), `README.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, `CODEOWNERS`, plantillas de issues y de PR,
  `.gitignore` y `.editorconfig` (#1).
- Archivo `NOTICE` con la atribución del proyecto (#3).
- La plataforma: núcleo (mapa en vivo, historial, alertas, avisos, reportes, cuentas y
  administración), nueve módulos opcionales, simulador de equipos e instalación con
  Docker Compose o Dokploy, importada del repositorio donde se construyó (ADR-0002).
- CI en GitHub Actions para cada PR y cada cambio en `main`: estilo, tipos,
  compilación, auditoría de dependencias, pruebas contra PostgreSQL con TimescaleDB,
  construcción de las imágenes de Docker y escaneo de secretos (#9).
- La plataforma conoce su versión: la de su release cuando la imagen se arma para
  publicarla, o la del repositorio con `-dev` cuando se construye desde el código. La
  devuelven `GET /api/config` y `GET /api/health`, y la web la muestra en lugar de
  «x.x.x» (ADR-0003, #12).
- Flujo `Release`: cuando `main` trae una versión nueva con su sección en este archivo,
  publica las imágenes para amd64 y arm64 en `ghcr.io/afigueroahn/` y después crea el
  tag y la release de GitHub (#14).
- Aviso de versión nueva para el dueño de la plataforma: el servidor compara la
  versión instalada con la última release de `UPDATE_REPOSITORY`, como mucho una vez
  por hora, y el dueño ve «Versión nueva» en el menú de su cuenta y al pie de
  Administración. La sección Sistema → Actualizaciones muestra las dos versiones, las
  notas de la nueva y cómo instalarla (#20).
- El ayudante instala versiones nuevas cuando se le piden: descarga sus imágenes, toma
  el `docker-compose.yml` de la versión nueva, la levanta y vuelve a la anterior si no
  responde, o restaura la copia sacada antes si ni esa arranca. Una prueba de punta a
  punta lo comprueba con Docker en la CI (ADR-0004, #22).
- Botón «Actualizar a X.Y.Z» en Sistema → Actualizaciones: hace antes una copia de todo
  («Antes de actualizar»), deja el pedido al ayudante y muestra en qué va; la página se
  recarga sola con la versión nueva, o dice por qué no se instaló. Con Dokploy muestra
  los pasos a mano (#24).

### Cambiado

- La instalación descarga las imágenes publicadas en lugar de construirlas: los
  compose usan `ghcr.io/afigueroahn/` con el tag de `OPENGPS_VERSION`, una variable
  obligatoria nueva que `generate-env.sh` pone sola. Cada release adjunta los archivos
  para instalar sin el código, y `deploy/docker-compose/build.yml` construye desde el
  código. La guía explica cómo pasar una instalación hecha con git a imágenes (#18).
- El ayudante `restorer` pasa a llamarse `helper`, con `deploy/helper.sh` y
  `deploy/helper.Dockerfile`, porque además de restaurar va a actualizar la
  plataforma. Su señal de vida es `helper.alive`. Al actualizar una instalación con
  Docker Compose, `--remove-orphans` quita el servicio viejo (#16).
- El menú de Administración ya no muestra «Gestión GPS» bajo el logo, y a su pie
  queda solo la versión, sin los datos de la persona.
- El §7 de `AGENTS.md` exige que las dependencias nuevas tengan licencia compatible con
  Apache-2.0 (#3).
- El §10 de `AGENTS.md` lista `NOTICE` en la estructura del repositorio (#5).

### Corregido

- El flujo `Release` unía bajo el tag de `opengps` también los digests de
  `opengps-postgres` y `opengps-helper`, y fallaba al publicar (#28).
