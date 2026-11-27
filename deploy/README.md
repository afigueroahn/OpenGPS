# Instalar OpenGPS

La plataforma se instala con Docker, de la forma que le convenga a cada servidor. Cada forma es una carpeta con su `docker-compose.yml`:

| Carpeta | Para qué servidor | Cómo llega la web |
|---|---|---|
| [`docker-compose/`](docker-compose/docker-compose.yml) | Cualquier servidor con Docker | En un puerto del servidor, en HTTP. Si quieres HTTPS, lo pone tu propio proxy |
| [`caddy/`](caddy/docker-compose.yml) | Cualquier servidor con Docker y un dominio | Por Caddy, que pone el HTTPS y consigue el certificado solo, en los puertos 80 y 443 |
| [`cloudflare/`](cloudflare/docker-compose.yml) | Cualquier servidor con Docker, con el dominio en Cloudflare | Por un túnel de Cloudflare, con HTTPS y sin abrir los puertos 80 y 443 |
| [`dokploy/`](dokploy/docker-compose.yml) | Un servidor con [Dokploy](https://dokploy.com) | Por el proxy de Dokploy, que pone el dominio y su certificado |
| [`coolify/`](coolify/docker-compose.yml) | Un servidor con [Coolify](https://coolify.io) | Por el proxy de Coolify, que pone el dominio y su certificado |

Esta guía va desde un servidor recién creado hasta la plataforma en marcha, con sus copias de seguridad.

Las acompañan estos archivos:

| Archivo | Para qué |
|---|---|
| [`.env.example`](.env.example) | Las variables, con lo que hace cada una |
| [`build.yml`](build.yml) | Construir las imágenes desde el código, para desarrollar o probar un cambio antes de publicarlo. Va detrás del compose de cualquiera de las formas con Docker Compose |
| [`generate-env.sh`](generate-env.sh) | Escribe las variables con sus secretos ya generados |
| [`opengps.Dockerfile`](opengps.Dockerfile) | La plataforma: la imagen con la web dentro |
| [`postgres.Dockerfile`](postgres.Dockerfile) | La base de datos, con [`postgres-init.sh`](postgres-init.sh), que crea la base `traccar` la primera vez que arranca |
| [`helper.Dockerfile`](helper.Dockerfile) | El ayudante de la plataforma, con [`helper.sh`](helper.sh): instala una versión nueva cuando se pide desde la consola |

Las formas con Docker Compose levantan cuatro contenedores; Dokploy y Coolify, los tres primeros:

| Contenedor | Qué hace | Puerto |
|---|---|---|
| `opengps` | La plataforma: la web y la API juntas, la sesión, el mapa en vivo, las tareas y las copias | 3000, dentro de la red de Docker. Con `docker-compose/`, además en un puerto del servidor |
| `traccar` | La entrada de los equipos GPS | 5001, 5002, 5004, 5011, 5013, 5015, 5023, 5027 y 5046, por TCP y UDP, publicados en el servidor |
| `postgres` | Las bases `opengps` (la plataforma) y `traccar` (los equipos), con un solo usuario, `postgres` de fábrica | 5432, solo dentro de la red de Docker |
| `helper` | El ayudante de la plataforma, el único con acceso a Docker: instala las versiones nuevas que se piden desde la consola. Dokploy y Coolify no lo llevan, porque allí se actualiza volviendo a desplegar | Ninguno |

Dos formas suman un quinto: `caddy/` trae `caddy`, el proxy con HTTPS, y `cloudflare/` trae `tunnel`, el túnel de Cloudflare.

Las dos bases, por dentro:

| | Plataforma | Equipos GPS |
|---|---|---|
| Motor | PostgreSQL 18 con TimescaleDB | El mismo |
| Base | `POSTGRES_DB` (`opengps` de fábrica) | `traccar`, siempre |
| Usuario y contraseña | `POSTGRES_USER` (`postgres` de fábrica) y `POSTGRES_PASSWORD` | Los mismos |
| Host y puerto, dentro de Docker | `postgres:5432` | Los mismos |
| Esquemas | `gps` (vehículos, posiciones, alertas, módulos, ajustes) y `auth` (personas, sesiones, cuentas e invitaciones); `public` queda vacío | `public`, con las tablas `tc_*` de Traccar |

La web y la API van en el mismo puerto a propósito: si fueran en puertos distintos serían dos sitios para el navegador, y la sesión y las llamadas de la web a la API dejarían de funcionar.

En todas, el servidor publica los puertos de los equipos, y la base no se publica. La web sale en HTTP por el puerto 3000 del contenedor `opengps`. Lo que cambia de una forma a otra es quién la lleva hasta el navegador: un puerto del servidor, Caddy, el túnel de Cloudflare, o el proxy de Dokploy o de Coolify.

Las imágenes vienen ya armadas, para procesadores Intel/AMD y ARM: cada versión las publica en `ghcr.io/afigueroahn/` y el servidor solo las descarga. Cada compose trae escrita la versión que instala: el de la última versión instala la última, sin escribir su número en ninguna parte.

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

Con Dokploy o con Coolify, prepara el servidor como digan ellos y sigue en «Apuntar el dominio».

1. En el panel del proveedor, crea el servidor con Ubuntu, en la región más cercana a tus usuarios, y agrega tu llave SSH. Anota su IP pública.
2. Si el proveedor tiene un cortafuegos propio (lo suelen llamar *firewall*), abre en él:
   - 22, por TCP, para entrar por SSH;
   - 5001, 5002, 5004, 5011, 5013, 5015, 5023, 5027 y 5046, por TCP y por UDP: por ahí llegan los equipos GPS;
   - 80 y 443, por TCP, solo si el HTTPS lo pone un proxy en el servidor, como con `caddy/`. Con el túnel de Cloudflare no hacen falta.
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

   Si el HTTPS lo pone un proxy en el servidor, abre también `ufw allow 80/tcp` y `ufw allow 443/tcp`. Docker publica sus puertos por encima de `ufw`: los de los equipos y, con `docker-compose/`, el de la web quedan abiertos aunque `ufw` no los liste.

8. Deja el acceso por SSH solo con llave. Antes, comprueba que entras con tu llave: si no, te quedas fuera del servidor.

   ```bash
   printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-opengps.conf
   sshd -t && systemctl reload ssh
   ```

   El nombre empieza por 10 para que mande sobre el archivo que deja el proveedor. Desde ahí la contraseña de root ya no sirve para entrar.

9. Descarga los archivos de la última versión. El compose es el de la forma que elegiste:

   ```bash
   mkdir -p /opt/opengps && cd /opt/opengps
   B=https://github.com/afigueroahn/OpenGPS/releases/latest/download
   curl -fsSLO "$B/generate-env.sh"
   curl -fsSLO "$B/env.example"
   curl -fsSL -o docker-compose.yml "$B/docker-compose.yml"
   ```

   | Forma | Archivo de la última línea |
   |---|---|
   | En un puerto del servidor | `docker-compose.yml` |
   | Con Caddy | `docker-compose.caddy.yml` |
   | Con el túnel de Cloudflare | `docker-compose.cloudflare.yml` |

   Siempre se guarda como `docker-compose.yml`. No hace falta descargar el código.

## Apuntar el dominio

| Nombre | Para qué | Cómo |
|---|---|---|
| `tu-dominio.com` | La web y la API que usan las apps (`https://tu-dominio.com/api`) | Con el túnel, lo crea Cloudflare al agregarlo como nombre público del túnel. Con otro proxy, un registro A hacia la IP del servidor |
| `gw.tu-dominio.com` | La entrada de los equipos GPS | Siempre un registro A **directo** a la IP del servidor: en Cloudflare, «solo DNS» (nube gris). Cloudflare no transporta las conexiones de los equipos |
| `www.tu-dominio.com` | Opcional: redirige al dominio | En Cloudflare, una regla de redirección hacia `https://tu-dominio.com` |

Los cambios de DNS pueden tardar unos minutos en verse.

A quien configura un equipo, la plataforma le muestra el nombre `gw.tu-dominio.com` y la IP a la que apunta ese registro: no hay que escribirlos en ninguna parte. Si la plataforma se abre por una IP en lugar de un dominio, los equipos apuntan a esa misma IP.

## Las variables

Solo hay tres obligatorias. Si falta una, el despliegue se detiene y dice cuál.

| Variable | Qué es |
|---|---|
| `PUBLIC_URL` | La dirección de la web, como la abren las personas: `https://tu-dominio.com` |
| `AUTH_SECRET` | Firma las sesiones y cifra las claves que se guardan en la consola |
| `POSTGRES_PASSWORD` | La contraseña del único usuario de la base. Solo letras y números: va dentro de una dirección |

`generate-env.sh` genera los dos secretos. El usuario, la contraseña y el nombre de la base solo se aplican la primera vez que arranca: cambiarlos después exige cambiarlos también dentro de la base. `AUTH_SECRET` no se cambia una vez en uso: cierra todas las sesiones y obliga a escribir otra vez las claves guardadas en la consola.

Las opcionales:

| Variable | De fábrica | Qué es |
|---|---|---|
| `POSTGRES_USER` | `postgres` | El único usuario de la base, para la plataforma, los equipos y las copias. Letras, números y `_` |
| `POSTGRES_DB` | `opengps` | El nombre de la base de la plataforma; la de los equipos es siempre `traccar` |
| `APP_NAME` | `OpenGPS` | El nombre con que nace la plataforma: en la web, la app, los correos, los avisos y las passkeys. Después se cambia en la consola, en Ajustes. Dokploy no lo pasa, porque escribe ahí el nombre interno del compose |
| `UPDATE_REPOSITORY` | `afigueroahn/OpenGPS` | El repositorio de GitHub cuyas releases son las versiones nuevas: el dueño las ve en Administración → Sistema → Actualizaciones. Vacío, la plataforma no consulta |
| `COMPOSE_PROJECT_NAME` | `opengps` | Solo con Docker Compose: el nombre del grupo de contenedores |
| `WEB_PORT` | `3000` | Solo con `docker-compose/`: el puerto del servidor donde responde la web |
| `CLOUDFLARE_TUNNEL_TOKEN` | | Solo con `cloudflare/`, y ahí es obligatoria: el token del túnel |
| `POSTGRES_TUNE_MEMORY`, `TRACCAR_JAVA_OPTS` | | Para servidores de 2 GB o menos: `768MB` y `-Xmx320m` |

Todo lo demás se configura desde la consola de la plataforma, con la primera cuenta (ver «Configurar desde la consola»).

## Con Docker Compose, en un puerto del servidor

La forma más simple: la web responde en un puerto del servidor, en HTTP. Sirve para una red interna, o para poner delante tu propio proxy con HTTPS. En HTTP no hay passkeys: necesitan HTTPS y un dominio.

En el servidor, en la carpeta con los archivos de la versión:

```bash
cd /opt/opengps
sh generate-env.sh http://IP-DEL-SERVIDOR:3000 .env
docker compose up -d
```

La dirección que le das a `generate-env.sh` es la que la gente abre en el navegador: queda en `PUBLIC_URL`. La primera vez tarda unos minutos: lo que se demora en descargar las imágenes. Para ver cómo van: `docker compose ps`. Los contenedores deben decir `Up`, y `postgres`, `traccar` y `opengps` además `(healthy)`.

La web abre en `http://IP-DEL-SERVIDOR:3000`. El puerto se cambia con `WEB_PORT` en `.env`. Si el proveedor tiene un cortafuegos propio, hay que abrirlo ahí.

**Con tu propio proxy y HTTPS.** `PUBLIC_URL` es entonces `https://tu-dominio.com`, y el proxy dirige el dominio a la plataforma:

- Si el proxy está instalado en el servidor, lo dirige a `http://127.0.0.1:3000`. Para que ese puerto no se vea desde fuera, ciérralo en el cortafuegos del proveedor: `ufw` no alcanza a los puertos que publica Docker.
- Si el proxy es otro contenedor (Nginx Proxy Manager, Traefik…), se une a la red de la plataforma, `opengps_default` (`<COMPOSE_PROJECT_NAME>_default` si le cambiaste el nombre), y lo dirige a `http://opengps:3000`. En el compose del proxy, con OpenGPS ya levantado, porque la red se crea con él:

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

## Con Docker Compose y Caddy

Caddy pone el dominio con HTTPS: pide el certificado él solo la primera vez y lo renueva. Necesita que el dominio ya apunte al servidor y que los puertos 80 y 443 lleguen hasta él.

1. Crea el registro DNS del dominio (tipo A) hacia la IP del servidor. Si el dominio está en Cloudflare, déjalo en «solo DNS» (nube gris): así Caddy puede conseguir el certificado.
2. Abre los puertos 80 y 443 en el cortafuegos del proveedor, si lo hay. En el servidor: `ufw allow 80/tcp` y `ufw allow 443`.
3. Con el compose `docker-compose.caddy.yml` descargado como `docker-compose.yml`:

   ```bash
   cd /opt/opengps
   sh generate-env.sh https://tu-dominio.com .env
   docker compose up -d
   ```

   Aparece el contenedor `caddy`. A los pocos segundos de levantar, `https://tu-dominio.com` abre con su certificado. Si no, `docker compose logs caddy` dice por qué no pudo conseguirlo.

Esta forma pide Docker Compose 2.23.1 o posterior (`docker compose version`), porque la configuración de Caddy va dentro del compose.

## Con Docker Compose y un túnel de Cloudflare

El túnel lleva el dominio con HTTPS hasta la plataforma sin abrir los puertos 80 y 443: el servidor solo deja entrar SSH y los equipos GPS. El contenedor `tunnel` sale hacia Cloudflare, y Cloudflare pone el certificado.

1. El dominio tiene que estar en tu cuenta de Cloudflare.
2. En Cloudflare, **Zero Trust → Networks → Tunnels**, crea un túnel: tipo *Cloudflared*, entorno *Docker*. Copia su token: es el texto largo que va después de `--token` en el comando que muestra Cloudflare. No hace falta ejecutar ese comando.
3. En el túnel, agrega un nombre público (*public hostname*): `tu-dominio.com`, con servicio **HTTP** y dirección **`opengps:3000`**. Cloudflare crea solo su registro DNS. Si ya había un registro con ese nombre, bórralo antes.
4. En el servidor, con el compose `docker-compose.cloudflare.yml` descargado como `docker-compose.yml`, genera las variables:

   ```bash
   cd /opt/opengps
   sh generate-env.sh https://tu-dominio.com .env
   ```

   Después abre `.env` con `nano` y completa el token:

   ```
   CLOUDFLARE_TUNNEL_TOKEN=el-token-del-túnel
   ```

   Escribe el token directamente en el servidor. No lo mandes por correo ni por chat. Guarda con `Ctrl+O`, Enter y `Ctrl+X`.

5. Levanta la plataforma:

   ```bash
   cd /opt/opengps && docker compose up -d
   ```

   Aparece el contenedor `tunnel`, y en Cloudflare el túnel pasa a *Healthy*.

6. Crea el registro `gw` (A, «solo DNS») hacia la IP del servidor, como dice «Apuntar el dominio».
7. Opcional: para `www`, crea en Cloudflare una regla de redirección (*Rules → Redirect Rules*) de `www.tu-dominio.com` a `https://tu-dominio.com`. El nombre `www` necesita un registro con el proxy de Cloudflare activado: puedes agregarlo también como nombre público del túnel.

## Con Dokploy

1. **Proyecto:** en Dokploy, *Projects → Create Service → Compose*. Como origen, el repositorio `https://github.com/afigueroahn/OpenGPS`, rama `main`. En *Compose Path*: `./deploy/dokploy/docker-compose.yml`.
2. **Variables:** en tu computadora, con `generate-env.sh` y `env.example` de la última versión (ver «Preparar un servidor Ubuntu nuevo», paso 9), `sh generate-env.sh https://tu-dominio.com` imprime las variables con los secretos ya generados. Pégalas en la pestaña *Environment*. Los secretos se quedan en Dokploy: no los mandes por correo ni por chat.
3. **Dominio:** en la pestaña *Domains*, agrega `tu-dominio.com` al servicio **`opengps`**, puerto **3000**, con HTTPS y el certificado de Let's Encrypt. El registro DNS del dominio apunta al servidor de Dokploy.
4. **Equipos GPS:** el registro `gw` apunta directo al servidor (en Cloudflare, «solo DNS») y sus puertos se abren en el cortafuegos. No pasan por el proxy de Dokploy: Dokploy los publica tal cual.
5. **Deploy.** La primera vez tarda unos minutos, lo que se demora en descargar las imágenes. Cuando abra `https://tu-dominio.com`, crea tu cuenta enseguida.

Para instalar una versión nueva, pulsa *Deploy*: el compose de `main` dice siempre la última versión publicada.

Las instalaciones anteriores tenían además el servicio `helper`, que ya no se usa: si después de desplegar sigue apareciendo, detenlo y bórralo.

## Con Coolify

1. **Proyecto:** en Coolify, *Projects → New → Public Repository*, con `https://github.com/afigueroahn/OpenGPS` y la rama `main`. En *Build Pack*, **Docker Compose**; en *Base Directory*, `/`; en *Docker Compose Location*, `/deploy/coolify/docker-compose.yml`.
2. **Variables:** no hay que escribir ninguna. Los secretos los genera Coolify, y la dirección de la web es el dominio del paso siguiente.
3. **Dominio:** en el servicio **`opengps`**, en *Domains*, escribe `https://tu-dominio.com:3000`. El `:3000` es el puerto del contenedor al que Coolify dirige el dominio; la web abre en `https://tu-dominio.com`, con su certificado. El registro DNS del dominio apunta al servidor de Coolify.
4. **Equipos GPS:** el registro `gw` apunta directo al servidor (en Cloudflare, «solo DNS») y sus puertos se abren en el cortafuegos. No pasan por el proxy de Coolify: Coolify los publica tal cual.
5. **Deploy.** La primera vez tarda unos minutos, lo que se demora en descargar las imágenes. Cuando abra `https://tu-dominio.com`, crea tu cuenta enseguida.

Para instalar una versión nueva, pulsa *Redeploy*: el compose de `main` dice siempre la última versión publicada.

Las instalaciones anteriores tenían además el servicio `helper`, que ya no se usa: si después de desplegar sigue apareciendo, detenlo y bórralo.

## Instalar una versión nueva

Cada versión está en [las releases del repositorio](https://github.com/afigueroahn/OpenGPS/releases), con sus cambios. Sus notas dicen si pide algo más, como una variable nueva. La consola avisa al dueño cuando sale una.

**Desde la consola**, con cualquiera de las formas de Docker Compose: en Administración → Sistema → Actualizaciones, pulsa «Actualizar a X.Y.Z».
1. La plataforma hace antes una copia de todo, de tipo «Antes de actualizar».
2. El ayudante descarga la versión y la instala. La plataforma queda sin servicio unos segundos.
3. Si la versión nueva no arranca, vuelve sola a la anterior, y si tampoco arranca la anterior, restaura esa copia.
4. Deja `docker-compose.yml.previous` y `.env.previous` con lo que había.

La instalación conserva su forma: el ayudante toma el compose de la misma carpeta (`docker-compose/`, `caddy/` o `cloudflare/`) en la versión nueva. Una instalación 0.1.x, de antes de que hubiera varias formas, no se actualiza con el botón: responde «No se pudieron preparar los archivos de la instalación» y no cambia nada. Se actualiza una vez a mano, con los pasos de abajo: su compose es `docker-compose.cloudflare.yml` si usaba el túnel y, si no, `docker-compose.yml`, que publica la web en el puerto 3000 del servidor. Desde ahí vuelve a actualizarse con el botón.

Con Dokploy y con Coolify el botón no aparece, porque ellos desharían el cambio: allí basta con volver a desplegar. Justo después de publicarse una versión, sus imágenes tardan unos minutos en estar: si el despliegue no las encuentra, vuelve a desplegar cuando la versión aparezca en las releases.

**A mano**, cambia `X.Y.Z` por su número:

```bash
cd /opt/opengps
V=X.Y.Z
F=docker-compose.yml
curl -fsSL -o docker-compose.yml "https://github.com/afigueroahn/OpenGPS/releases/download/v$V/$F"
docker compose up -d --remove-orphans
```

Con Caddy, `F=docker-compose.caddy.yml`. Con el túnel de Cloudflare, `F=docker-compose.cloudflare.yml`.

El compose trae escrita su versión. Las migraciones de la base se aplican solas al arrancar la plataforma. `--remove-orphans` quita los servicios que la versión nueva ya no tiene, para que no queden contenedores viejos en marcha. Si `.env` todavía tiene una línea `OPENGPS_VERSION`, de cuando la versión iba ahí, o `COMPOSE_PROFILES`, de una 0.1.x, se pueden borrar: ya no se leen.

## Construir desde el código

Para desarrollar, o para probar un cambio antes de que se publique, las imágenes se construyen desde el repositorio en lugar de descargarse:

```bash
git clone https://github.com/afigueroahn/OpenGPS /opt/opengps-dev && cd /opt/opengps-dev
sh deploy/generate-env.sh https://tu-dominio.com deploy/docker-compose/.env
docker compose -f deploy/docker-compose/docker-compose.yml -f deploy/build.yml up -d --build
```

`build.yml` va detrás del compose de cualquiera de las formas con Docker Compose; no vale con Dokploy ni con Coolify, que no llevan el ayudante que también construye. La primera construcción tarda de 10 a 20 minutos y pide unos 2 GB de memoria. La plataforma muestra la versión del repositorio con `-dev`.

## Pasar una instalación con git a imágenes

Una instalación hecha antes de las releases, con `git clone` y `--build`, pasa a las imágenes una sola vez. Sus datos están en los volúmenes de Docker y se quedan como están:

```bash
cd /opt
mv opengps opengps-git
mkdir opengps && cd opengps
B=https://github.com/afigueroahn/OpenGPS/releases/latest/download
curl -fsSL -o docker-compose.yml "$B/docker-compose.yml"
cp /opt/opengps-git/deploy/docker-compose/.env .env
docker compose up -d --remove-orphans
```

Si la instalación usaba el túnel de Cloudflare, el compose es `docker-compose.cloudflare.yml`, y sobra la línea `COMPOSE_PROFILES` de `.env`. Si no lo usaba, la web pasa a responder en el puerto 3000 del servidor.

`.env` conserva sus secretos, su túnel y el nombre del grupo (`COMPOSE_PROJECT_NAME`), así que los contenedores se reemplazan sobre los mismos volúmenes. `--remove-orphans` quita el ayudante viejo, `restorer`. Cuando la web vuelva a abrir con todo en su lugar, `/opt/opengps-git` se puede borrar.

## La primera cuenta

**En cuanto la web abra, crea tu cuenta.** Mientras la plataforma no tiene dueño ni correo configurado, la primera cuenta entra sin confirmar su correo y queda como **dueña de la plataforma**: ve el grupo «Sistema» en Administración y su cuenta no se puede borrar. Por eso conviene que seas tú, antes que nadie. Después, en Canales de aviso → Correo, configura el correo saliente: desde ese momento las cuentas nuevas confirman su correo como siempre.

## Configurar desde la consola

En la web, menú de tu perfil → **Administración**, grupo **Sistema**:

1. **Canales de aviso → Correo:** el servidor de correo saliente (servidor, puerto, seguridad, usuario, contraseña y remitente). Pruébalo con «Enviar prueba». El remitente conviene que sea de un dominio cuyo correo tenga SPF y DKIM, o los mensajes caen en no deseado. Si tienes Twilio, escribe sus datos; si tienes otro sistema (por ejemplo una pasarela de SMS), configúralo en Personalizado.
2. **Ajustes:**
   - el nombre de la plataforma, registro abierto o solo por invitación, idioma por defecto y política de contraseñas;
   - las passkeys (Face ID, huella, Windows Hello o una llave física), encendidas de fábrica. Solo funcionan con HTTPS y un dominio, no en HTTP ni con una IP. Son del dominio de la plataforma: si cambia, las de cada persona dejan de servir;
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

En **Administración → Sistema → Simulador** el dueño de la plataforma crea equipos simulados, que se conectan al receptor como un GPS real y recorren una ruta. Sirve para comprobar una instalación nueva de punta a punta: agrega un GPS con «Agregar GPS» usando el identificador que da el simulador, inícialo y míralo moverse en el mapa. Por ahora habla Teltonika y SinoTrack / MiCODUS. Sus rutas se arman en la pestaña «Rutas»: de una dirección a otra por calles, o marcando puntos en el mapa.

## Copias de seguridad

Las hace la plataforma, como las programes en Administración → Sistema → Copias de seguridad, y se guardan en el volumen `backups-data` (`/data/backups` dentro del contenedor `opengps`). Desde la consola se descargan, y con el almacenamiento externo (S3) se guardan también fuera del servidor: conviene tenerlo antes de abrir al público.

## Restaurar una copia

Restaurar devuelve toda la plataforma (cuentas, vehículos, historial, ajustes y archivos subidos) al momento de la copia. Lo que pasó después se pierde. La plataforma deja de responder un momento, mientras cambia las bases; los equipos guardan lo que reportan en ese rato y lo envían después.

### Desde la consola

En Administración → Sistema → Copias de seguridad, cada copia completa tiene el botón **Restaurar**. Pide escribir RESTAURAR para confirmar, y después:

1. La plataforma hace una copia de cómo está todo ahora, de tipo «Antes de restaurar»: con ella se puede deshacer la restauración, restaurándola igual.
2. Si la copia elegida ya no está en el servidor pero sí en el almacenamiento externo, la baja primero.
3. La plataforma restaura las bases y los archivos aparte y los comprueba, sin dejar de servir. Si la copia no se puede leer entera, se detiene ahí y no cambia nada.
4. Se reinicia, cambia las bases y los archivos por los de la copia y reinicia la entrada de los equipos. Si no arranca con la copia, o la entrada de los equipos no vuelve, regresa a lo que había.
5. La consola muestra en qué va y cómo terminó. Como la sesión puede no existir en la copia, a veces hay que volver a entrar para verlo.

Las claves que se escriben en la consola (correo, almacenamiento, canales de aviso, inicio de sesión) se conservan: si la copia viene de otro servidor con otro `AUTH_SECRET`, quedan las de este.

Lo hace la propia plataforma, sin el ayudante (ADR-0009): lo que pasa queda en su registro, `logs opengps`.

### A mano

Sirve para restaurar en un servidor recién instalado los archivos de una copia que tienes en tu computadora.

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

Estos pasos son para Docker Compose. Con Dokploy y con Coolify son los mismos, sobre sus contenedores: `docker ps` dice cómo se llaman.

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
| La web no abre o Cloudflare muestra un error | `docker compose ps`. Con el túnel: que `tunnel` esté `Up`, su registro (`logs tunnel`), el token en `.env` y que los nombres públicos apunten a HTTP `opengps:3000`. Con Caddy: su registro (`logs caddy`), que el dominio apunte al servidor y que los puertos 80 y 443 estén abiertos. Con otro proxy: que esté unido a la red `opengps_default` y los puertos 80 y 443 abiertos |
| No llega el correo de confirmación | Canales de aviso → Correo y «Enviar prueba»; la carpeta de no deseado; el registro con `logs opengps` |
| Los equipos no se conectan | `gw` con el proxy de Cloudflare desactivado; los puertos de los equipos abiertos por TCP y UDP en el cortafuegos del proveedor y en `ufw` |
| El servidor se queda sin memoria | `POSTGRES_TUNE_MEMORY` y `TRACCAR_JAVA_OPTS`, la memoria de intercambio, o un plan con más memoria |

## A tener en cuenta

- **El ayudante de la plataforma tiene acceso a Docker** (monta `/var/run/docker.sock`) para instalar las versiones nuevas que se piden desde la consola, y ve la carpeta de la instalación (`docker-compose.yml` y `.env`). Solo está en las formas con Docker Compose. Es el único servicio con ese acceso y no abre ningún puerto. Si no lo quieres, quita el servicio `helper` del Compose: las versiones se instalan a mano, y las copias se siguen haciendo y restaurando desde la consola.
- **Una instalación por servidor recibe equipos.** Los puertos de los equipos son fijos: dos instalaciones en el mismo servidor no pueden usarlos a la vez.
- **La IP de quien visita** la toma la plataforma de lo que escribe el proxy de delante, si ese proxy está en una red privada (como el de Dokploy). Detrás de Cloudflare y de Dokploy a la vez se ve la de Cloudflare, salvo que el proxy de Dokploy esté configurado para confiar en Cloudflare. Solo afecta al registro y a los límites de intentos.
- **Los textos legales** no nombran a un titular ni a un país: dicen «quien presta el servicio en» tu dominio, y dan el correo de contacto que pongas en Ajustes. Las leyes de privacidad suelen pedir que se identifique al responsable: revísalo con quien te asesore en lo legal.
