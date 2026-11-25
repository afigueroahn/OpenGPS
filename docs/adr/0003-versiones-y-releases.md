# ADR-0003: Versiones, releases e imágenes

- **Estado:** Aceptada. Superseded by ADR-0008 en un punto: el PR de una versión sube también las imágenes de los compose
- **Fecha:** 2026-11-24
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La plataforma mostraba una versión fija («x.x.x»). Cada instalación construía sus
imágenes en su propio servidor a partir del código, lo que tarda de 10 a 20 minutos y
pide unos 2 GB de memoria, y no había forma de saber qué versión corría ni si existía
una más nueva.

Se quiere que la versión sea la de las releases de GitHub, que el dueño de cada
instalación vea cuando hay una nueva y que pueda instalarla sin construir nada.

## Opciones consideradas

### De dónde sale el número

- **El `version` del `package.json` raíz:** el número vive en el código y una versión
  nueva es un PR que lo sube. A favor: se revisa como cualquier cambio. En contra: hay
  que mantener el tag de git igual al número.
- **El tag de git:** el número se decide al etiquetar. A favor: no hay que tocar
  archivos. En contra: la imagen no lo conoce si se construye desde el código, y
  etiquetar queda fuera de la revisión.

### Qué se instala

- **Imágenes ya armadas en un registro:** se publican al crear la release. A favor:
  instalar y actualizar tarda minutos y no pide memoria extra. En contra: la CI tiene que
  armarlas para Intel/AMD y ARM.
- **Construir en cada servidor:** lo de hoy. En contra: lento y pesado para un servidor
  pequeño.

## Decisión

- **Versionado semántico** (`MAYOR.MENOR.PARCHE`). La primera release es `0.1.0`.
- **Fuente única:** el `version` del `package.json` raíz. Una versión nueva es un PR
  `chore(release): vX.Y.Z` que sube ese número y cierra su sección del `CHANGELOG.md`.
  El merge de ese PR es la decisión de publicar.
- **Publicación:** al llegar a `main` un número sin tag `vX.Y.Z`, la CI arma las
  imágenes para amd64 y arm64, las sube a `ghcr.io/afigueroahn/` y **después** crea el
  tag y la release de GitHub, con la sección del CHANGELOG como notas. Así, nadie ve una
  release cuya imagen todavía no existe.
- **Tags de imagen:** solo `X.Y.Z`, nunca `latest`. Cada instalación fija su versión.
- **La versión en la plataforma:** la imagen de una release recibe `APP_VERSION` al
  construirse y la expone en `GET /api/config` y `GET /api/health`; la web la muestra.
  Construida desde el código, la plataforma muestra la del repositorio con `-dev`
  (`0.1.0-dev`).

## Consecuencias

- Las imágenes llevan las etiquetas OCI `org.opencontainers.image.version`,
  `.revision`, `.source` y `.licenses`.
- Si el registro publica las imágenes como privadas, el dueño del repositorio las hace
  públicas una vez, en la configuración de cada paquete.
- El aviso de versión nueva y la actualización desde la consola comparan contra la
  última release de este repositorio, y quedan en sus propios issues.
