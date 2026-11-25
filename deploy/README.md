# Instalar OpenGPS

La única forma de instalar la plataforma: con Docker Compose en cualquier servidor con Docker, o con Dokploy. Esta guía va desde un servidor recién creado hasta la plataforma en marcha, con sus copias de seguridad.

| Archivo o carpeta | Para qué |
|---|---|
| [`docker-compose/`](docker-compose/docker-compose.yml) | Cualquier servidor con Docker y Docker Compose |
| [`dokploy/`](dokploy/docker-compose.yml) | Un servidor con [Dokploy](https://dokploy.com), que pone el dominio y su certificado |
| [`.env.example`](.env.example) | Las variables, con lo que hace cada una |
| [`docker-compose/build.yml`](docker-compose/build.yml) | Construir las imágenes desde el código, para desarrollar o probar un cambio antes de publicarlo |
| [`generate-env.sh`](generate-env.sh) | Escribe las variables con sus secretos ya generados |
| [`opengps.Dockerfile`](opengps.Dockerfile) | La plataforma: la imagen con la web dentro |
| [`postgres.Dockerfile`](postgres.Dockerfile) | La base de datos, con [`postgres-init.sh`](postgres-init.sh), que crea la base `traccar` la primera vez que arranca |
| [`helper.Dockerfile`](helper.Dockerfile) | El ayudante de la plataforma, con [`helper.sh`](helper.sh): restaura una copia cuando se pide desde la consola |

Las dos formas levantan cuatro contenedores:

| Contenedor | Qué hace | Puerto |
|---|---|---|
| `opengps` | La plataforma: la web y la API juntas, la sesión, el mapa en vivo, las tareas y las copias | 3000, solo dentro de la red de Docker |
| `traccar` | La entrada de los equipos GPS | 5001, 5002, 5004, 5011, 5013, 5015, 5023, 5027 y 5046, por TCP y UDP, publicados en el servidor |
| `postgres` | Las bases `opengps` (la plataforma) y `traccar` (los equipos), con un solo usuario, `postgres` de fábrica | 5432, solo dentro de la red de Docker |
| `helper` | El ayudante de la plataforma, el único con acceso a Docker: cuando se pide desde la consola, cambia las bases y los archivos por los de una copia | Ninguno |

Con Docker Compose se puede sumar un quinto, `tunnel`: el túnel de Cloudflare, que pone el dominio con HTTPS (ver «Con un túnel de Cloudflare»).

Las dos bases, por dentro:

| | Plataforma | Equipos GPS |
|---|---|---|
| Motor | PostgreSQL 18 con TimescaleDB | El mismo |
| Base | `POSTGRES_DB` (`opengps` de fábrica) | `traccar`, siempre |
| Usuario y contraseña | `POSTGRES_USER` (`postgres` de fábrica) y `POSTGRES_PASSWORD` | Los mismos |
| Host y puerto, dentro de Docker | `postgres:5432` | Los mismos |
| Esquemas | `gps` (vehículos, posiciones, alertas, módulos, ajustes) y `auth` (personas, sesiones, cuentas e invitaciones); `public` queda vacío | `public`, con las tablas `tc_*` de Traccar |

La web y la API van en el mismo puerto a propósito: si fueran en puertos distintos serían dos sitios para el navegador, y la sesión y las llamadas de la web a la API dejarían de funcionar.

Con Docker Compose y con Dokploy se comporta igual: el servidor solo publica los puertos de los equipos. La web y la base no se publican; se llega a ellas desde la red de Docker. El puerto de la web es HTTP, y el HTTPS lo pone lo que va delante: el túnel de Cloudflare que trae el Compose, el proxy de Dokploy, o un proxy en un contenedor unido a esa red, como Nginx Proxy Manager, Traefik o Caddy.

Las imágenes vienen ya armadas, para procesadores Intel/AMD y ARM: cada versión las publica en `ghcr.io/afigueroahn/` y el servidor solo las descarga. Cada instalación dice en `OPENGPS_VERSION` qué versión corre.

## Lo que necesitas

| Qué | Para qué | Notas |
|---|---|---|
| Un servidor (VPS) con Ubuntu 24.04 o 26.04 recién instalado | Donde corre todo | Una IP pública fija. Para empezar con pocos equipos: 1 vCPU y 2 GB. Para abrir al público: 2 vCPU, 4 GB y 50 GB de disco. Sirve cualquier proveedor (Vultr, DigitalOcean, Hetzner, Linode…), o un servidor con Dokploy |
| Un dominio | La dirección de la web | Con acceso para crear registros DNS. Para el túnel, el dominio tiene que estar en Cloudflare (la cuenta gratuita basta) |
| Una cuenta de correo saliente (SMTP) | Confirmar cuentas, invitaciones, alertas e informes | Servidor, puerto, usuario, contraseña y remitente. Por ejemplo Google Workspace, Microsoft 365, Brevo, Amazon SES o el correo de tu hosting |
| Tu llave SSH | Entrar al servidor | La de tu computadora: `~/.ssh/id_ed25519.pub` |

Opcional, se agrega después desde la consola de la plataforma:

- Un almacenamiento S3 (o compatible) para tener las copias de seguridad también fuera del servidor. Antes de abrir al público hace falta.
- Una cuenta de Twilio, para avisos por SMS.
- Aplicaciones OAuth de Google, GitHub, Facebook o Apple, para entrar con esas cuentas.

## Preparar un servidor Ubuntu nuevo

Con Dokploy, prepara el servidor como diga Dokploy y sigue en «Apuntar el dominio».

1. En el panel del proveedor, crea el servidor con Ubuntu, en la región más cercana a tus usuarios, y agrega tu llave SSH. Anota su IP pública.
2. Si el proveedor tiene un cortafuegos propio (lo suelen llamar *firewall*), abre en él:
   - 22, por TCP, para entrar por SSH;
   - 5001, 5002, 5004, 5011, 5013, 5015, 5023, 5027 y 5046, por TCP y por UDP: por ahí llegan los equipos GPS;
   - 80 y 443, por TCP, solo si el HTTPS lo pone un proxy en el servidor. Con el túnel de Cloudflare no hacen falta.
3. Entra al servidor desde tu computadora:

   ```bash
   ssh root@IP-DEL-SERVIDOR
   ```

4. Pon el sistema al día, con la hora en UTC:

   ```bash
   apt-get update && apt-get -y upgrade
   apt-get -y install ca-certificates curl git ufw unattended-upgrades
   timedatectl set-timezone UTC
   ```

5. Instala Docker con el script oficial de Docker. Trae Docker Compose:

   ```bash
   curl -fsSL https://get.docker.com | sh
   docker compose version
   ```

6. En servidores de 2 GB o menos, crea 2 GB de memoria de intercambio (si `swapon --show` no muestra ninguna):

   ```bash
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```

7. Configura el cortafuegos del servidor: SSH y los puertos de los equipos, nada más.

   ```bash
   ufw default deny incoming
   ufw default allow outgoing
   ufw allow 22/tcp
   for p in 5001 5002 5004 5011 5013 5015 5023 5027 5046; do ufw allow $p; done
   ufw --force enable
   ```

   Si el HTTPS lo pone un proxy en el servidor, abre también `ufw allow 80/tcp` y `ufw allow 443/tcp`. Docker publica sus puertos por encima de `ufw`: por eso el Compose solo publica los de los equipos.

8. Deja el acceso por SSH solo con llave. Antes, comprueba que entras con tu llave: si no, te quedas fuera del servidor.

   ```bash
   printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-opengps.conf
   sshd -t && systemctl reload ssh
   ```

   El nombre empieza por 10 para que mande sobre el archivo que deja el proveedor. Desde ahí la contraseña de root ya no sirve para entrar.

9. Descarga los archivos de la última versión:

   ```bash
   mkdir -p /opt/opengps && cd /opt/opengps
   for f in docker-compose.yml generate-env.sh env.example; do
     curl -fsSLO "https://github.com/afigueroahn/OpenGPS/releases/latest/download/$f"
   done
   ```

   Son el compose, el script que escribe las variables y su ejemplo, con la versión ya puesta. No hace falta descargar el código.

## Apuntar el dominio

| Nombre | Para qué | Cómo |
|---|---|---|
| `tu-dominio.com` | La web | Con el túnel, lo crea Cloudflare al agregarlo como nombre público del túnel. Con otro proxy, un registro A hacia la IP del servidor |
| `api.tu-dominio.com` | La API para las apps, que también responde en `https://tu-dominio.com/api` | Igual que el anterior |
| `gw.tu-dominio.com` | La entrada de los equipos GPS | Siempre un registro A **directo** a la IP del servidor: en Cloudflare, «solo DNS» (nube gris). Cloudflare no transporta las conexiones de los equipos |
| `www.tu-dominio.com` | Opcional: redirige al dominio | En Cloudflare, una regla de redirección hacia `https://tu-dominio.com` |

Los cambios de DNS pueden tardar unos minutos en verse.

## Las variables

Solo hay cuatro obligatorias. Si falta una, el despliegue se detiene y dice cuál.

| Variable | Qué es |
|---|---|
| `PUBLIC_URL` | La dirección de la web, como la abren las personas: `https://tu-dominio.com` |
| `AUTH_SECRET` | Firma las sesiones y cifra las claves que se guardan en la consola |
| `POSTGRES_PASSWORD` | La contraseña del único usuario de la base. Solo letras y números: va dentro de una dirección |
| `OPENGPS_VERSION` | La versión que corre la instalación: el tag de sus imágenes (`0.1.0`). La escribe `generate-env.sh` |

`generate-env.sh` genera los dos secretos y pone la versión. El usuario, la contraseña y el nombre de la base solo se aplican la primera vez que arranca: cambiarlos después exige cambiarlos también dentro de la base. `AUTH_SECRET` no se cambia una vez en uso: cierra todas las sesiones y obliga a escribir otra vez las claves guardadas en la consola.

Las opcionales:

| Variable | De fábrica | Qué es |
|---|---|---|
| `POSTGRES_USER` | `postgres` | El único usuario de la base, para la plataforma, los equipos y las copias. Letras, números y `_` |
| `POSTGRES_DB` | `opengps` | El nombre de la base de la plataforma; la de los equipos es siempre `traccar` |
| `DEVICE_GATEWAY_HOST` | `gw.` + el dominio | A qué nombre se configuran los equipos |
| `DEVICE_GATEWAY_IP` | | La IP del servidor, para los equipos que solo aceptan números |
| `APP_NAME` | `OpenGPS` | El nombre de la plataforma en la web, los correos y los avisos |
| `UPDATE_REPOSITORY` | `afigueroahn/OpenGPS` | El repositorio de GitHub cuyas releases son las versiones nuevas: el dueño las ve en Administración → Actualizaciones. Vacío, la plataforma no consulta |
| `COMPOSE_PROJECT_NAME` | `opengps` | Solo con Docker Compose: el nombre del grupo de contenedores |
| `COMPOSE_PROFILES`, `CLOUDFLARE_TUNNEL_TOKEN` | | Solo con Docker Compose: `tunnel` y el token del túnel de Cloudflare (ver «Con un túnel de Cloudflare») |
| `POSTGRES_TUNE_MEMORY`, `TRACCAR_JAVA_OPTS` | | Para servidores de 2 GB o menos: `768MB` y `-Xmx320m` |

Todo lo demás se configura desde la consola de la plataforma, con la primera cuenta (ver «Configurar desde la consola»).

## Con Docker Compose

En el servidor, en la carpeta con los archivos de la versión:

```bash
cd /opt/opengps
sh generate-env.sh https://tu-dominio.com .env
docker compose up -d
```

La primera vez tarda unos minutos: lo que se demora en descargar las imágenes. Para ver cómo van: `docker compose ps`. Los contenedores deben decir `Up`, y `postgres`, `traccar` y `opengps` además `(healthy)`.

La web queda en el puerto 3000 del contenedor `opengps`, dentro de la red de Docker `opengps_default` (`<COMPOSE_PROJECT_NAME>_default` si le cambiaste el nombre). Lo que pone el HTTPS dirige `https://tu-dominio.com` a `http://opengps:3000`: el túnel de Cloudflare (abajo) u otro proxy en un contenedor unido a esa red. Por ejemplo, en el compose del proxy, con OpenGPS ya levantado, porque la red se crea con él:

```yaml
services:
  proxy:
    networks: [default, opengps]
networks:
  opengps:
    name: opengps_default
    external: true
```

Para entrar a la base con una herramienta: `docker compose exec postgres psql -U postgres opengps`.

Para ver el registro de la plataforma en vivo: `docker compose logs -f opengps`.

### Instalar una versión nueva

Cada versión está en [las releases del repositorio](https://github.com/afigueroahn/OpenGPS/releases), con sus cambios. Sus notas dicen si pide algo más, como una variable nueva. Para instalarla, cambia `X.Y.Z` por su número:

```bash
cd /opt/opengps
V=X.Y.Z
curl -fsSLO "https://github.com/afigueroahn/OpenGPS/releases/download/v$V/docker-compose.yml"
sed -i "s/^OPENGPS_VERSION=.*/OPENGPS_VERSION=$V/" .env
docker compose up -d --remove-orphans
```

Las migraciones de la base se aplican solas al arrancar la plataforma. `--remove-orphans` quita los servicios que la versión nueva ya no tiene, para que no queden contenedores viejos en marcha.

### Construir desde el código

Para desarrollar, o para probar un cambio antes de que se publique, las imágenes se construyen desde el repositorio en lugar de descargarse:

```bash
git clone https://github.com/afigueroahn/OpenGPS /opt/opengps-dev && cd /opt/opengps-dev
sh deploy/generate-env.sh https://tu-dominio.com deploy/docker-compose/.env
docker compose -f deploy/docker-compose/docker-compose.yml -f deploy/docker-compose/build.yml up -d --build
```

La primera construcción tarda de 10 a 20 minutos y pide unos 2 GB de memoria. La plataforma muestra la versión del repositorio con `-dev`.

### Pasar una instalación con git a imágenes

Una instalación hecha antes de las releases, con `git clone` y `--build`, pasa a las imágenes una sola vez. Sus datos están en los volúmenes de Docker y se quedan como están:

```bash
cd /opt
mv opengps opengps-git
mkdir opengps && cd opengps
for f in docker-compose.yml generate-env.sh env.example; do
  curl -fsSLO "https://github.com/afigueroahn/OpenGPS/releases/latest/download/$f"
done
cp /opt/opengps-git/deploy/docker-compose/.env .env
grep "^OPENGPS_VERSION=" env.example >> .env
docker compose up -d --remove-orphans
```

`.env` conserva sus secretos, su túnel y el nombre del grupo (`COMPOSE_PROJECT_NAME`), así que los contenedores se reemplazan sobre los mismos volúmenes. `--remove-orphans` quita el ayudante viejo, `restorer`. Cuando la web vuelva a abrir con todo en su lugar, `/opt/opengps-git` se puede borrar.

### Con un túnel de Cloudflare

El túnel lleva el dominio con HTTPS hasta la plataforma sin abrir los puertos 80 y 443: el servidor solo deja entrar SSH y los equipos GPS. El contenedor `tunnel` sale hacia Cloudflare, y Cloudflare pone el certificado.

1. El dominio tiene que estar en tu cuenta de Cloudflare.
2. En Cloudflare, **Zero Trust → Networks → Tunnels**, crea un túnel: tipo *Cloudflared*, entorno *Docker*. Copia su token: es el texto largo que va después de `--token` en el comando que muestra Cloudflare. No hace falta ejecutar ese comando.
3. En el túnel, agrega dos nombres públicos (*public hostnames*): `tu-dominio.com` y `api.tu-dominio.com`, los dos con servicio **HTTP** y dirección **`opengps:3000`**. Cloudflare crea solo sus registros DNS. Si ya había registros con esos nombres, bórralos antes.
4. En el servidor, abre `/opt/opengps/.env` con `nano` y completa:

   ```
   COMPOSE_PROFILES=tunnel
   CLOUDFLARE_TUNNEL_TOKEN=el-token-del-túnel
   ```

   Escribe el token directamente en el servidor. No lo mandes por correo ni por chat. Guarda con `Ctrl+O`, Enter y `Ctrl+X`.

5. Levanta o actualiza la plataforma:

   ```bash
   cd /opt/opengps && docker compose up -d
   ```

   Aparece el contenedor `tunnel`, y en Cloudflare el túnel pasa a *Healthy*.

6. Crea el registro `gw` (A, «solo DNS») hacia la IP del servidor, como dice «Apuntar el dominio».
7. Opcional: para `www`, crea en Cloudflare una regla de redirección (*Rules → Redirect Rules*) de `www.tu-dominio.com` a `https://tu-dominio.com`. El nombre `www` necesita un registro con el proxy de Cloudflare activado: puedes agregarlo también como nombre público del túnel.

## Con Dokploy

1. **Proyecto:** en Dokploy, *Projects → Create Service → Compose*. Como origen, el repositorio `https://github.com/afigueroahn/OpenGPS`, rama `main`. En *Compose Path*: `./deploy/dokploy/docker-compose.yml`.
2. **Variables:** en tu computadora, con los archivos de la última versión (ver «Preparar un servidor Ubuntu nuevo», paso 9), `sh generate-env.sh https://tu-dominio.com` imprime las variables con los secretos ya generados y la versión. Pégalas en la pestaña *Environment*. Los secretos se quedan en Dokploy: no los mandes por correo ni por chat.
3. **Dominio:** en la pestaña *Domains*, agrega `tu-dominio.com` al servicio **`opengps`**, puerto **3000**, con HTTPS y el certificado de Let's Encrypt. El registro DNS del dominio apunta al servidor de Dokploy.
4. **Equipos GPS:** el registro `gw` apunta directo al servidor (en Cloudflare, «solo DNS») y sus puertos se abren en el cortafuegos. No pasan por el proxy de Dokploy: Dokploy los publica tal cual.
5. **Deploy.** La primera vez tarda unos minutos, lo que se demora en descargar las imágenes. Cuando abra `https://tu-dominio.com`, crea tu cuenta enseguida.

Para instalar una versión nueva: en *Environment*, cambia `OPENGPS_VERSION` por su número y pulsa *Deploy*.

## La primera cuenta

**En cuanto la web abra, crea tu cuenta.** Mientras la plataforma no tiene dueño ni correo configurado, la primera cuenta entra sin confirmar su correo y queda como **dueña de la plataforma**: ve el grupo «Sistema» en Administración y su cuenta no se puede borrar. Por eso conviene que seas tú, antes que nadie. Después, en Canales de aviso → Correo, configura el correo saliente: desde ese momento las cuentas nuevas confirman su correo como siempre.

## Configurar desde la consola

En la web, menú de tu perfil → **Administración**, grupo **Sistema**:

1. **Canales de aviso → Correo:** el servidor de correo saliente (servidor, puerto, seguridad, usuario, contraseña y remitente). Pruébalo con «Enviar prueba». El remitente conviene que sea de un dominio cuyo correo tenga SPF y DKIM, o los mensajes caen en no deseado. Si tienes Twilio, escribe sus datos; si tienes otro sistema (por ejemplo una pasarela de SMS), configúralo en Personalizado.
2. **Ajustes:**
   - registro abierto o solo por invitación, idioma por defecto y política de contraseñas;
   - cuotas y módulos de las cuentas nuevas;
   - el estilo del mapa y el servicio de direcciones (dirección, identificación y espera entre consultas), que viene encendido con el público y gratuito de OpenStreetMap: una consulta por segundo. Vacío lo apaga;
   - el servicio de rutas, que traza por calles las rutas del simulador y viene encendido con el público de OSRM sobre datos de OpenStreetMap: una consulta por segundo y sin garantía de disponibilidad. Vacío lo apaga, y las rutas se trazan con líneas rectas;
   - plazos: primer reporte, GPS esperando, historial y copia de Traccar;
   - el correo de avisos y el límite de disco;
   - el correo de contacto de los textos legales.
3. **Inicio de sesión** (opcional): crea en Google, GitHub, Facebook o Apple su aplicación con la *dirección de regreso* que muestra cada ventana (`https://tu-dominio.com/api/auth/callback/…`) y escribe aquí sus claves.
4. **Almacenamiento:** los datos de tu S3 y «Probar la conexión».
5. **Copias de seguridad:** la frecuencia y cuántos días se guardan, y «Hacer una copia ahora» para comprobar que funciona.
6. **Avisos del sistema:** a quién avisar de una copia fallida, un disco lleno o equipos que dejan de reportar.

## Conectar los GPS

Cada cuenta agrega sus equipos con «Agregar GPS»: elige la marca o el modelo y la plataforma le muestra a qué servidor y puerto apuntarlo (`gw.tu-dominio.com`, o la IP si el equipo solo acepta números) y los mensajes para configurarlo. El equipo necesita una SIM con datos.

| Familia | Puerto |
|---|---|
| Coban | 5001 |
| TK103 genérico y clones | 5002 |
| Queclink | 5004 |
| Suntech | 5011 |
| SinoTrack / MiCODUS | 5013 |
| JT808 | 5015 |
| Concox / Jimi | 5023 |
| Teltonika | 5027 |
| Ruptela | 5046 |

### Probar sin equipos

En **Administración → Sistema → Simulador** el dueño de la plataforma crea equipos simulados, que se conectan al receptor como un GPS real y recorren una ruta. Sirve para comprobar una instalación nueva de punta a punta: agrega un GPS con «Agregar GPS» usando el identificador que da el simulador, inícialo y míralo moverse en el mapa. Por ahora habla Teltonika y SinoTrack / MiCODUS, y corren hasta 50 a la vez. Sus rutas se arman en la pestaña «Rutas»: de una dirección a otra por calles, o marcando puntos en el mapa.

## Copias de seguridad

Las hace la plataforma, como las programes en Administración → Copias de seguridad, y se guardan en el volumen `backups-data` (`/data/backups` dentro del contenedor `opengps`). Desde la consola se descargan, y con el almacenamiento externo (S3) se guardan también fuera del servidor: conviene tenerlo antes de abrir al público.

## Restaurar una copia

Restaurar devuelve toda la plataforma (cuentas, vehículos, historial, ajustes y archivos subidos) al momento de la copia. Lo que pasó después se pierde. La plataforma queda sin servicio unos minutos; los equipos guardan lo que reportan en ese rato y lo envían después.

### Desde la consola

En Administración → Copias de seguridad, cada copia completa tiene el botón **Restaurar**. Pide escribir RESTAURAR para confirmar, y después:

1. La plataforma hace una copia de cómo está todo ahora, de tipo «Antes de restaurar»: con ella se puede deshacer la restauración, restaurándola igual.
2. Si la copia elegida ya no está en el servidor pero sí en el almacenamiento externo, la baja primero.
3. El ayudante (`helper`) restaura las bases y los archivos aparte y los comprueba, sin detener nada. Si la copia no se puede leer entera, se detiene ahí y no cambia nada.
4. Detiene la plataforma y la entrada de los equipos, cambia las bases y los archivos por los de la copia y los vuelve a levantar. Si la plataforma no arranca, vuelve a lo que había.
5. La consola muestra en qué va y cómo terminó. Como la sesión puede no existir en la copia, a veces hay que volver a entrar para verlo.

Las claves que se escriben en la consola (correo, almacenamiento, canales de aviso, inicio de sesión) se conservan: si la copia viene de otro servidor con otro `AUTH_SECRET`, quedan las de este.

El botón aparece cuando el ayudante está en marcha: `docker compose ps` lo muestra como `helper`, y su registro está en `logs helper`.

### A mano

Sirve si el ayudante no está, o para restaurar en un servidor recién instalado los archivos de una copia que tienes en tu computadora.

Antes de empezar:

- Haz una copia de cómo está todo ahora («Hacer una copia ahora») y descarga sus tres archivos, por si hay que volver atrás.
- La copia tiene que venir de las mismas versiones de PostgreSQL y TimescaleDB que fija `deploy/postgres.Dockerfile`.
- Si cambiaste `POSTGRES_USER` o `POSTGRES_DB`, escribe los tuyos donde los comandos dicen `postgres` (después de `-U`) y `opengps`.
- Si un comando da error, no sigas con el siguiente.

Cada copia son tres archivos con la misma fecha, como `20261124_080000`:

| Archivo | Qué es | A dónde va |
|---|---|---|
| `gps_<fecha>.dump` | La base de la plataforma | La base `opengps` |
| `traccar_<fecha>.dump` | La base de los equipos | La base `traccar` |
| `files_<fecha>.tar.gz` | Los archivos que suben las personas | `/data/files`, dentro del contenedor `opengps` |

Estos pasos son para Docker Compose. Con Dokploy son los mismos, sobre sus contenedores: `docker ps` dice cómo se llaman.

1. **Junta los tres archivos en una carpeta del servidor.** Entra a la carpeta de la instalación y escribe la fecha de la copia. Si cierras la sesión a mitad de camino, vuelve a escribir estas líneas:

   ```bash
   cd /opt/opengps
   STAMP=20261124_080000
   mkdir -p /root/restore
   ```

   Si la copia está en este servidor, en el volumen `backups-data`:

   ```bash
   for f in gps_$STAMP.dump traccar_$STAMP.dump files_$STAMP.tar.gz; do docker compose cp opengps:/data/backups/$f /root/restore/; done
   ```

   Si la descargaste desde la consola, pásala desde tu computadora:

   ```bash
   scp gps_<fecha>.dump traccar_<fecha>.dump files_<fecha>.tar.gz root@IP-DEL-SERVIDOR:/root/restore/
   ```

2. **Detén la plataforma y la entrada de los equipos.** La base sigue encendida.

   ```bash
   docker compose stop opengps traccar
   ```

3. **Restaura la base de la plataforma.** Borra la base `opengps` y la crea vacía, avisa a TimescaleDB antes de cargar la copia, la carga y le avisa al terminar.

   ```bash
   docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS opengps WITH (FORCE)' -c 'CREATE DATABASE opengps'
   docker compose exec -T postgres psql -U postgres -d opengps -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS timescaledb' -c 'SELECT timescaledb_pre_restore()'
   docker compose exec -T postgres pg_restore -U postgres -d opengps --no-owner --no-privileges --exit-on-error < /root/restore/gps_$STAMP.dump
   docker compose exec -T postgres psql -U postgres -d opengps -v ON_ERROR_STOP=1 -c 'SELECT timescaledb_post_restore()'
   ```

4. **Restaura la base de los equipos**, igual, en la base `traccar`:

   ```bash
   docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS traccar WITH (FORCE)' -c 'CREATE DATABASE traccar'
   docker compose exec -T postgres psql -U postgres -d traccar -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS timescaledb' -c 'SELECT timescaledb_pre_restore()'
   docker compose exec -T postgres pg_restore -U postgres -d traccar --no-owner --no-privileges --exit-on-error < /root/restore/traccar_$STAMP.dump
   docker compose exec -T postgres psql -U postgres -d traccar -v ON_ERROR_STOP=1 -c 'SELECT timescaledb_post_restore()'
   ```

5. **Levanta la plataforma y la entrada de los equipos:**

   ```bash
   docker compose up -d
   ```

6. **Restaura los archivos subidos.** Borra los que hay en `/data/files` y pone los de la copia:

   ```bash
   docker compose exec -T opengps sh -c 'find /data/files -mindepth 1 -delete && tar -xzf - -C /data/files' < /root/restore/files_$STAMP.tar.gz
   ```

7. **Comprueba.** `docker compose ps`: `postgres`, `traccar` y `opengps` dicen `(healthy)`. Entra a la web con una cuenta de la copia y mira que estén sus vehículos y su historial. Después borra la carpeta de trabajo: `rm -rf /root/restore`.

Después de restaurar:

- Quien inició sesión después de la copia tiene que entrar otra vez.
- La lista de copias de la consola no retrocede: al arrancar, la plataforma la repone con la que guarda en el volumen de copias (`backups.json`).
- Las claves que se guardan en la consola (correo, almacenamiento, canales de aviso, inicio de sesión) van cifradas con `AUTH_SECRET`. Si la copia viene de otro servidor con otro `AUTH_SECRET`, no se pueden leer: escríbelas otra vez en la consola, o usa en este servidor el `AUTH_SECRET` de aquel (ver «Mudar una instalación que ya existe»).

## Mudar una instalación que ya existe

Para llevar a un servidor nuevo una plataforma que ya funciona, con sus cuentas, vehículos e historial:

1. **En el servidor de siempre**, haz una copia desde la consola («Hacer una copia ahora») y descarga sus tres archivos. Con el almacenamiento externo, quedan también en el bucket.
2. **Copia el `AUTH_SECRET`** del `.env` del servidor de siempre (`/opt/opengps/.env`) (en Dokploy, de la pestaña *Environment*). Así las claves guardadas en la consola se siguen leyendo y, si el dominio es el mismo, las sesiones abiertas siguen valiendo. Pásalo de servidor a servidor por SSH; nunca por correo ni por chat.
3. **En el servidor nuevo**, instala desde cero con esta guía. Antes del primer `up`, cambia en su `.env` el `AUTH_SECRET` generado por el del servidor de siempre.
4. **Crea la primera cuenta** en cuanto la web abra, aunque sea provisional: desaparece al restaurar.
5. **Restaura la copia.** Con el almacenamiento externo, desde la consola del servidor nuevo: en Almacenamiento, escribe los datos del mismo bucket y la misma carpeta; en Copias de seguridad, pulsa «Buscar en el almacenamiento» y luego «Restaurar» en la copia. Si tienes sus tres archivos en tu computadora, sigue «Restaurar una copia» → «A mano».
6. **Mueve el tráfico.** Con el túnel: quita los nombres públicos del túnel del servidor de siempre y agrégalos al del nuevo. Con otro proxy: cambia los registros del dominio y de `api` a la IP nueva. En los dos casos, cambia `gw` a la IP nueva: los equipos configurados con `gw.tu-dominio.com` llegan solos al servidor nuevo en cuanto el cambio se propaga; los configurados con la IP antigua hay que cambiarlos uno por uno.
7. Si además cambia el dominio, actualiza `PUBLIC_URL` y la dirección de regreso en cada aplicación de inicio de sesión (Google, GitHub…). Los enlaces ya enviados con el dominio anterior dejan de abrir.
8. Deja encendido el servidor de siempre un par de días, por si hay que volver, y después apágalo.

## Si algo no funciona

| Qué pasa | Qué revisar |
|---|---|
| La web no abre o Cloudflare muestra un error | `docker compose ps`. Con el túnel: que `tunnel` esté `Up`, su registro (`logs tunnel`), el token en `.env` y que los nombres públicos apunten a HTTP `opengps:3000`. Con otro proxy: que esté unido a la red `opengps_default` y los puertos 80 y 443 abiertos |
| No llega el correo de confirmación | Canales de aviso → Correo y «Enviar prueba»; la carpeta de no deseado; el registro con `logs opengps` |
| Los equipos no se conectan | `gw` con el proxy de Cloudflare desactivado; los puertos de los equipos abiertos por TCP y UDP en el cortafuegos del proveedor y en `ufw` |
| El servidor se queda sin memoria | `POSTGRES_TUNE_MEMORY` y `TRACCAR_JAVA_OPTS`, la memoria de intercambio, o un plan con más memoria |

## A tener en cuenta

- **El ayudante de la plataforma tiene acceso a Docker** (monta `/var/run/docker.sock`) para detener y levantar la plataforma y la entrada de los equipos. Con Docker Compose ve además la carpeta de la instalación (`docker-compose.yml` y `.env`), para instalar las versiones nuevas que se piden desde la consola. Es el único servicio con ese acceso, no abre ningún puerto y solo atiende pedidos con nombres de archivo de copias que estén en el volumen de copias. Si no lo quieres, quita el servicio `helper` del Compose: las copias se siguen haciendo y se restauran a mano.
- **Una instalación por servidor recibe equipos.** Los puertos de los equipos son fijos: dos instalaciones en el mismo servidor no pueden usarlos a la vez.
- **La IP de quien visita** la toma la plataforma de lo que escribe el proxy de delante, si ese proxy está en una red privada (como el de Dokploy). Detrás de Cloudflare y de Dokploy a la vez se ve la de Cloudflare, salvo que el proxy de Dokploy esté configurado para confiar en Cloudflare. Solo afecta al registro y a los límites de intentos.
- **Los textos legales** no nombran a un titular ni a un país: dicen «quien presta el servicio en» tu dominio, y dan el correo de contacto que pongas en Ajustes. Las leyes de privacidad suelen pedir que se identifique al responsable: revísalo con quien te asesore en lo legal.
