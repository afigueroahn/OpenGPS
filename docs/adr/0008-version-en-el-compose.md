# ADR-0008: La versión de una instalación va en su compose

- **Estado:** Aceptada
- **Fecha:** 2026-11-25
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Cada instalación decía en la variable `OPENGPS_VERSION` qué versión corría, y era
obligatoria en las cinco formas de instalar (ADR-0005). Con Docker Compose la escribía
`generate-env.sh`; con Coolify había que escribirla a mano al instalar, y con Dokploy y
Coolify había que cambiarla a mano en cada actualización. Se quiere que una instalación
limpia quede en la última versión sin que nadie tenga que escribir bien su número.

## Opciones consideradas

### La versión escrita en cada compose

Las imágenes dicen su versión en el compose (`ghcr.io/afigueroahn/opengps:X.Y.Z`) y la
variable desaparece. A favor: no hay nada que escribir en ninguna forma, y con Dokploy y
Coolify actualizar es volver a desplegar. En contra: el PR de cada versión sube también
los compose.

### Variable opcional, con la versión de fábrica en el compose

`${OPENGPS_VERSION:-X.Y.Z}`. A favor: se puede fijar otra versión. En contra: la versión
queda en dos lugares, y Coolify suele copiar el valor de fábrica a sus variables la
primera vez y dejarlo fijo, así que habría que cambiarlo a mano al actualizar.

### `generate-env.sh` consulta a GitHub la última release

En contra: la variable sigue siendo obligatoria, y no resuelve Coolify ni la
actualización con Dokploy y Coolify. Con Docker Compose ya pasaba en la práctica: el
`env.example` de cada release traía su versión.

### El tag `latest`

Descartada: AGENTS.md §5 y ADR-0003 lo prohíben, y cualquier reinicio podría cambiar de
versión sin una copia antes.

## Decisión

- Las tres imágenes de la plataforma (`opengps`, `opengps-postgres` y `opengps-helper`)
  llevan su versión escrita en los cinco compose de `deploy/`. La variable
  `OPENGPS_VERSION` deja de existir.
- La versión de los compose es la del `package.json` raíz, la última publicada: el PR
  `chore(release): vX.Y.Z` sube las dos. `.github/scripts/version-check.sh` lo comprueba
  en la CI, y una release no se publica si no coinciden.
- Con Docker Compose, cada release adjunta sus compose: el de la última release instala
  la última versión. Dokploy y Coolify leen el compose de `main`: desplegar instala la
  última versión publicada, y volver a desplegar la actualiza.
- La imagen del ayudante lleva los compose con su propia versión. Al instalar una versión
  desde la consola, el compose nuevo trae la versión nueva, y el ayudante quita
  `OPENGPS_VERSION` del `.env`.
- Las imágenes siguen fijadas por versión, nunca `latest` (ADR-0003).

## Consecuencias

- Reemplaza un punto de ADR-0003: el PR de una versión sube también las imágenes de los
  compose. Y uno de ADR-0004: al instalar una versión, el ayudante cambia el compose, que
  dice la versión, y ya no escribe `OPENGPS_VERSION` en `.env`.
- Una instalación existente sigue funcionando: su `OPENGPS_VERSION` ya no se lee. Con
  Docker Compose, el ayudante la quita en la siguiente actualización; con Dokploy y
  Coolify se puede borrar de sus variables.
- Con Docker Compose, instalar otra versión es descargar el compose de esa versión.
- Mientras la CI publica las imágenes de una versión nueva, `main` ya dice esa versión:
  un despliegue con Dokploy o Coolify en esos minutos no encuentra las imágenes, y hay
  que volver a desplegar cuando la release aparezca.
- `deploy/build.yml` construye las imágenes con el nombre y la versión que dice el
  compose.
