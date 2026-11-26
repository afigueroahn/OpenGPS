# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/).

## [Sin publicar]

### Corregido

- El historial de la web ya no vuelve al inicio mientras se reproduce un periodo que
  llega hasta ahora, como «Hoy». Cada minuto, al llegar los puntos nuevos, la
  reproducción se detenía, volvía a la velocidad inicial y el cursor regresaba al
  principio del día (#96).

## [0.7.0] - 2026-11-25

### Eliminado

- `api.<dominio>` ya no hace falta: la web y las apps usan una sola dirección, la de
  `PUBLIC_URL`, y la API para las apps es `https://<dominio>/api`. `deploy/caddy/` deja de
  atender `api.` bajo el dominio, y la guía ya no lo pide como registro DNS ni como nombre
  del túnel de Cloudflare. Quien lo haya creado puede borrarlo (ADR-0012, #91).

## [0.6.0] - 2026-11-25

### Cambiado

- Lo que se ajusta en la consola de administración ya no se puede dar con variables de
  entorno: el correo saliente, el mapa, los servicios de direcciones y de rutas, los
  plazos y la retención de equipos e historial, los avisos al dueño y los datos de los
  textos legales. Ninguna forma de instalar pasaba esas variables, así que una
  instalación hecha con la guía no cambia; quien las pasara por su cuenta escribe esos
  valores en la consola. En el servidor de correo, «apagado» dice ahora lo que pasa: la
  plataforma no envía correos (ADR-0010, #79).
- Una instalación 0.1.x ya no se actualiza con el botón de la consola: responde que no
  pudo preparar los archivos y no cambia nada. Se actualiza una vez a mano, con los pasos
  de la guía de instalación, y desde ahí vuelve a usar el botón. Las instalaciones 0.2.0
  en adelante no cambian (ADR-0011, #76).

## [0.5.2] - 2026-11-25

### Cambiado

- La web tiene un icono nuevo, cuadrado, con el marcador más grande y un verde más vivo:
  en la pestaña del navegador, en el logo de todas las pantallas y al guardarla en la
  pantalla de inicio de un iPhone (#72).

### Corregido

- La documentación vuelve a decir lo que hace la plataforma: el simulador no tiene tope
  de equipos, `build.yml` vale con las formas de Docker Compose, las copias y las
  actualizaciones están en Administración → Sistema, y `SECURITY.md` dice qué versión
  tiene soporte. `AGENTS.md` y los ADR 0004, 0005 y 0008 recogen lo que cambió con
  ADR-0009 (#74).

## [0.5.1] - 2026-11-25

### Cambiado

- El icono de la web ya no lleva el cuadro oscuro de fondo: en la pestaña del navegador y
  en el logo de todas las pantallas queda solo el marcador con su órbita. El icono al
  guardarla en la pantalla de inicio de un iPhone no cambia (#68).

## [0.5.0] - 2026-11-25

### Cambiado

- Si una versión nueva no arranca y la anterior tampoco, el ayudante pide restaurar la
  copia sacada antes de actualizar con el mismo pedido que deja la consola, en lugar de
  restaurarla por su cuenta. El resultado es el mismo, y la prueba de punta a punta de
  las actualizaciones ahora cubre ese caso (#60).
- Restaurar una copia ya no necesita al ayudante: la plataforma la restaura sola.
  Restaura aparte sin dejar de servir, se reinicia un momento para cambiar las bases,
  reinicia la entrada de los equipos y vuelve a lo que había si no arranca con la copia.
  El botón «Restaurar» aparece siempre que la plataforma tiene acceso a las bases. El
  ayudante queda solo para instalar versiones y ya no ve la carpeta de archivos
  (ADR-0009, #61).
- Dokploy y Coolify ya no llevan el ayudante ni su acceso a Docker: allí solo
  restauraba copias, y ahora lo hace la plataforma. Si después de volver a desplegar
  sigue apareciendo el contenedor `helper`, se puede detener y borrar (#62).

### Corregido

- El botón «Actualizar» de la consola vuelve a funcionar en una instalación en
  `/opt/opengps`, la carpeta de la guía. Las versiones 0.2.0 a 0.4.0 no se podían
  instalar ahí: el ayudante respondía «No se pudieron preparar los archivos» y no
  cambiaba nada. La versión con el arreglo se instala con el botón desde cualquier
  versión anterior (#58).

## [0.4.0] - 2026-11-25

### Cambiado

- Una instalación nueva queda en la última versión sin escribir su número: cada compose
  de `deploy/` trae escrita la versión de sus imágenes, y la variable `OPENGPS_VERSION`
  deja de existir. Con Coolify ya no hay variables que escribir, y con Dokploy y Coolify
  actualizar es volver a desplegar. Una instalación existente sigue funcionando: su
  `OPENGPS_VERSION` ya no se lee, y el ayudante la quita del `.env` en la siguiente
  actualización (ADR-0008, #54).

## [0.3.0] - 2026-11-25

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
- `AGENTS.md` y `CONTRIBUTING.md` describen la plataforma como es: se instala con
  `deploy/`, se trabaja con los scripts de pnpm y la CI corre los checks que se piden.
  Se quitan las reglas que no hacían falta (ADR-0007, #50).
- La web usa el icono oficial de la plataforma, el marcador con su órbita: en la pestaña
  del navegador, en el logo de todas las pantallas y al guardarla en la pantalla de
  inicio de un iPhone (#46).
- La sección de versión de la consola dice menos: la frase bajo su título queda en
  «Versión actual, última disponible y novedades.» y la tarjeta ya no muestra con qué
  repositorio se compara ni cuándo se consultó (#48).

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
