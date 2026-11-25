# ADR-0004: Actualizar desde la consola

- **Estado:** Aceptada. Superseded by ADR-0008 en un punto: la versión va en el compose, ya no en `.env`
- **Fecha:** 2026-11-24
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Con ADR-0003 cada versión publica sus imágenes y la consola avisa al dueño cuando hay
una nueva. Falta instalarla. A mano son cuatro comandos en el servidor; se quiere que
el dueño pueda hacerlo desde la consola.

La plataforma no puede actualizarse a sí misma. Su contenedor no tiene acceso a Docker,
a propósito: si alguien entrara por la web, no podría tocar el servidor. Y un proceso
que pidiera reemplazar su propio contenedor se detendría a mitad del cambio.

## Opciones consideradas

### Un botón que lleva a cabo el ayudante

El servicio `helper`, el único con acceso a Docker (ya restaura copias), recibe el
pedido, prepara la versión nueva y la instala. A favor: el dueño no entra al servidor, y
el ayudante puede volver atrás si algo falla. En contra: es la parte más delicada de la
instalación, y solo funciona con Docker Compose: con Dokploy, Dokploy desharía el cambio.

### Solo avisar y mostrar los comandos

A favor: no hay nada nuevo que pueda fallar. En contra: el dueño tiene que entrar al
servidor por SSH cada vez.

### Descargar el código y construir en el servidor

En contra: tarda de 10 a 20 minutos, pide unos 2 GB de memoria y deja el servidor sin
plataforma si la construcción falla.

## Decisión

Un botón «Actualizar» en la consola, que lleva a cabo el ayudante:

1. La plataforma saca una copia de seguridad y deja un pedido `update.request` con la
   versión, en la carpeta de copias, como ya hace al restaurar.
2. El ayudante descarga las imágenes de la versión nueva. Saca el `docker-compose.yml`
   de esa versión de su imagen nueva y comprueba que vale con el `.env` de la
   instalación. Ve esos archivos porque el compose monta su carpeta en `/data/install`.
3. Un contenedor no puede reemplazarse a sí mismo. Por eso el ayudante arranca un
   contenedor de su versión nueva, fuera del proyecto de Compose, que:
   - cambia el `docker-compose.yml` y `OPENGPS_VERSION` en `.env`, y guarda los
     anteriores con `.previous`;
   - levanta todo con `docker compose up -d --remove-orphans`, ayudante incluido;
   - espera a que la plataforma responda con la versión nueva.
4. Si no responde, vuelve a los archivos anteriores y a la versión anterior. Si
   tampoco arranca, restaura la copia sacada antes. El resultado queda en
   `update.result`, con su motivo.

Con Dokploy, o si el ayudante no ve la carpeta de la instalación, la consola muestra
los pasos en lugar del botón.

## Consecuencias

- El servicio `helper` monta la carpeta de la instalación, con `.env` y sus secretos. Ya
  tenía acceso a Docker, que equivale a tener acceso al servidor.
- Cada imagen de `opengps-helper` lleva el `docker-compose.yml` de su versión.
- Las migraciones de la base solo avanzan. Volver a la versión anterior funciona mientras
  la versión nueva no cambie la base de un modo que la anterior no entienda; si no, la
  copia sacada antes es la salida.
- Una prueba de punta a punta (`.github/scripts/update-e2e.sh`) instala una versión
  buena y deshace una rota, con Docker, en la CI.
