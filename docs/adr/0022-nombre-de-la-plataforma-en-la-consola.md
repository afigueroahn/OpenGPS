# ADR-0022: El nombre de la plataforma, en la consola

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

El nombre de la plataforma salía de la variable `APP_NAME`, que las cinco formas de instalar
pasan a la plataforma. Dokploy escribe en `APP_NAME` el nombre interno del compose: en
`app.opengps.dev` la plataforma se llamaba `opengps-opengps-skdmgp`. Ese nombre sale en la
web, en la app, en los correos, en los avisos y en el aviso de Face ID de las passkeys
(ADR-0020). Es el mismo origen que el remitente de #112 (#132).

ADR-0010 sacó a la consola los ajustes que se cambiaban desde el entorno, pero el nombre se
quedó en el entorno.

## Opciones consideradas

### El nombre en la consola, y Dokploy deja de pasar `APP_NAME`

- A favor: cualquier instalación pone su nombre sin tocar el servidor, como los demás
  ajustes. Arregla Dokploy al actualizar.
- En contra: más código: el ajuste, su campo y rehacer la librería de sesión al cambiarlo.

### Solo Dokploy deja de pasar `APP_NAME`

- A favor: una línea.
- En contra: con Dokploy no se puede poner otro nombre sin editar el compose.

### Otra variable, `PLATFORM_NAME`, en las cinco formas

- A favor: cada forma sigue poniendo el nombre desde el entorno.
- En contra: una variable más, y `APP_NAME` de respaldo igual.

## Decisión

El nombre en la consola, y Dokploy deja de pasar `APP_NAME`.

- **Dónde se cambia:** «Nombre de la plataforma» en Ajustes, `appName` en la sección `general`,
  de 1 a 60 letras. Vale desde que se guarda.
- **Con qué nace:** con `APP_NAME`, y «OpenGPS» si no está. Volver a los valores de fábrica lo
  deja así. Una instalación que tenía `APP_NAME` puesto no cambia de nombre al actualizar.
- **Dokploy:** su compose no pasa `APP_NAME`. Una instalación con Dokploy se llama «OpenGPS»
  hasta que el dueño lo cambie.
- **Quién lo usa:** la web y la app lo leen de `GET /api/config`, y los correos y los avisos de
  la configuración en vivo. La librería de sesión se rehace al guardar los ajustes generales,
  para que sus correos y las passkeys nuevas tomen el nombre.

## Consecuencias

- Las passkeys ya creadas guardan el nombre que tenían; las nuevas, el de ahora.
- `APP_NAME` sigue siendo opcional en las demás formas: solo da el nombre con que se nace.
