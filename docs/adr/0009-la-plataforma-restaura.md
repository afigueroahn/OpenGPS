# ADR-0009: La plataforma restaura las copias

- **Estado:** Aceptada
- **Fecha:** 2026-11-25
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Restaurar una copia desde la consola lo hacía el ayudante (`helper`), el único servicio
con acceso a Docker. Restauraba las bases y los archivos aparte, detenía la plataforma
y Traccar, cambiaba las bases por nombre, los volvía a levantar y deshacía el cambio si
la plataforma no arrancaba. La plataforma no lo hacía porque tendría que cambiar la base
en la que vive y detener a Traccar.

Ninguna de las dos cosas necesita Docker. La plataforma se conecta con el único usuario
de Postgres, que puede crear, renombrar y borrar bases; su imagen trae `pg_restore`, y
monta las carpetas de copias y de archivos. Puede terminar su propio proceso, y Docker
la vuelve a levantar (`restart: unless-stopped`). Traccar se reinicia por su API
(`POST /api/server/reboot`, solo para administradores), y la plataforma ya entra a
Traccar como administrador.

## Opciones consideradas

### La plataforma restaura sola

Atiende el mismo pedido (`restore.request`) que atendía el ayudante, deja el mismo
resultado (`restore.result`) y la consola no cambia. A favor: la restauración vive en un
solo lugar, en TypeScript y con pruebas, y no depende de otro contenedor; en Dokploy y
Coolify, donde el ayudante solo restauraba, se puede quitar junto con su acceso a
Docker. En contra: la comprobación de que todo volvió la hace la misma plataforma al
arrancar, y el reinicio de Traccar depende de un endpoint de su API.

### Dejar que restaure el ayudante

Nada que cambiar, pero el ayudante sigue siendo obligatorio para restaurar en todas las
formas de instalar, con acceso a Docker solo para eso en Dokploy y Coolify.

### Dar acceso a Docker a la plataforma

Montar `docker.sock` en la plataforma. Descartada por la misma razón que en ADR-0004: un
contenedor expuesto a la web con acceso a Docker equivale a acceso al servidor.

## Decisión

La plataforma restaura sola, con el pedido que deja la consola, o el ayudante cuando ni
una versión nueva ni la anterior arrancan (ADR-0004):

1. Mientras sigue sirviendo, restaura las dos bases y los archivos aparte
   (`<base>_new` y `.restore-new`) y comprueba que la copia trae el historial. Si la
   copia no se puede leer entera, se detiene ahí y no cambia nada.
2. Termina su proceso, y Docker la vuelve a levantar.
3. Al arrancar, antes de abrir la base, abre una sesión en Traccar, cambia las bases por
   nombre (las de uso quedan como `<base>_previous`) y los archivos, y reinicia Traccar
   con esa sesión, para que olvide lo que guardaba de la base anterior. La sesión se abre
   antes porque la clave de la plataforma puede no estar en la base restaurada.
4. Arranca sobre lo restaurado. Cuando arrancó y Traccar responde, borra lo de antes. Si
   no arranca, o Traccar no vuelve en 5 minutos, vuelve a lo que había.

`restore.running` dice en qué paso va. Si la plataforma se corta a mitad, el siguiente
arranque deshace lo que quedó a medias.

## Consecuencias

- El ayudante solo instala versiones. Ya no monta la carpeta de archivos ni usa la base.
  Sigue haciendo falta en las formas con Docker Compose.
- La consola ofrece restaurar siempre que la plataforma tiene acceso a las bases, sin
  depender del ayudante.
- Mientras restaura aparte, la plataforma sigue sirviendo. Se detiene solo el tiempo de
  reiniciarse, cambiar las bases y arrancar.
- Si una versión nueva y la anterior no arrancan, la restauración la hace la plataforma
  de la versión anterior al arrancar. Si esa versión es de antes de este cambio, la hace
  su ayudante: el pedido es el mismo.
- La prueba de punta a punta (`.github/scripts/update-e2e.sh`) restaura una copia con
  Docker y el Traccar fijado, y comprueba que una copia ilegible no cambia nada y que una
  sobre la que la plataforma no arranca se deshace.
