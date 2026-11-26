# OpenGPS

Plataforma abierta y gratuita de rastreo GPS vehicular: web, app Android y app iPhone. Cualquier persona o empresa registra su cuenta y agrega sus propios GPS. Ve en el mapa dónde están sus vehículos, en vivo y en su historial, y recibe alertas y reportes. Además activa los módulos que necesite: antirrobo, conductores, diagnóstico, flota, mantenimiento, combustible, reportes, rutas e integraciones.

## Cómo funciona

1. **Traccar** recibe por internet las señales de los equipos GPS. Cada marca habla su propio protocolo.
2. **La plataforma** (el backend) lee esas posiciones y las guarda. Calcula viajes y alertas, envía los avisos y atiende a la web y a las apps.
3. **La web** es lo que se ve en el navegador, y **la app para iPhone**, lo que se ve en el teléfono. La app para Android es el paso siguiente.

Todo se guarda en PostgreSQL, con TimescaleDB para el historial de posiciones.

## Documentos

| Documento | Contenido |
|---|---|
| [deploy/README.md](deploy/README.md) | Instalarla en un servidor, de la forma que le convenga: sus variables, actualizarla, restaurar una copia y mudarla |
| [docs/API.md](docs/API.md) | Contrato de la API para la web y las apps |
| [docs/adr/](docs/adr/) | Las decisiones de arquitectura, una por archivo |
| [AGENTS.md](AGENTS.md) y [CONTRIBUTING.md](CONTRIBUTING.md) | La forma de trabajo y cómo contribuir |

## Estado

Están construidos el núcleo (mapa en vivo, historial, alertas, avisos, reportes, cuentas y administración), los nueve módulos opcionales y la app para iPhone, que todavía no está en la App Store. La app para Android es el paso siguiente.

## Estructura

| Carpeta | Para qué sirve |
|---|---|
| `apps/server/` | La plataforma (backend, Fastify). Ver la tabla de abajo |
| `apps/web/` | La web (React + Vite). Contiene las pantallas (`src/app`), las páginas de entrada, registro y textos legales (`src/routes`), esos textos legales (`src/legal`), los textos en español e inglés (`src/locales`) y el ícono (`public`) |
| `apps/mobile/` | La app para iPhone (Expo). Contiene las pantallas (`src/app`), sus partes (`src/components`), el mapa (`src/map`), la conexión con la plataforma (`src/lib`), los textos en español e inglés (`src/locales`) y las imágenes (`assets`) |
| `packages/shared/` | Lo que comparten la plataforma, la web y la app: las reglas de cada dato y los textos comunes, para que todas validen igual |
| `db/migrations/` | Los pasos que crean y actualizan la base, en orden: `core` para el núcleo y una carpeta por módulo (`a_antitheft` … `i_integrations`) |
| `deploy/` | Las formas de instalarla, una carpeta por cada una (`docker-compose/`, `caddy/`, `cloudflare/`, `dokploy/`, `coolify/`), las recetas de las imágenes de la plataforma, de la base y del ayudante, y las variables. Ver [deploy/README.md](deploy/README.md) |
| `docs/` | Los documentos |

Dentro de `apps/server/`:

| Carpeta | Qué contiene |
|---|---|
| `src/core` | El núcleo: vehículos, equipos, alertas, avisos, copias de seguridad y ajustes |
| `src/modules` | Los nueve módulos opcionales |
| `src/api` | Las direcciones de la API y el canal en vivo |
| `src/ingest` | La lectura de posiciones desde Traccar |
| `src/simulator` | El simulador de equipos de la administración |
| `src/locales` | Los textos de los correos y los reportes |
| `test` | Las pruebas automáticas |

En la raíz:

- `package.json`, `pnpm-lock.yaml` y `pnpm-workspace.yaml`: las librerías que usa cada parte, con su versión exacta.
- `tsconfig.base.json`: las reglas comunes de TypeScript.
- `.gitignore`: lo que no se sube a GitHub.
- `.dockerignore`: lo que no entra en las imágenes.
- `.editorconfig`: el formato del editor.

**Lo que no se sube a GitHub** se regenera en cada computadora:

- `node_modules`: las librerías, que `pnpm install` descarga según `pnpm-lock.yaml`. Hay una carpeta por cada parte del proyecto, pero la de la raíz guarda cada librería una sola vez y las demás solo apuntan a ella.
- `dist`: lo compilado.
- `apps/mobile/ios`: el proyecto de Xcode de la app, que Expo genera al compilarla.
- Los archivos de variables con valores reales: `apps/server/.env.local` en desarrollo y `deploy/docker-compose/.env` al levantar la plataforma desde el código. Un servidor instalado con la guía no tiene el repositorio: su `.env` está en `/opt/opengps`.

## Requisitos

Node 26 y pnpm 12. Docker solo hace falta para desplegar.

```bash
pnpm install
```

## Desarrollo y pruebas

La plataforma y sus pruebas usan una base de pruebas: Postgres con TimescaleDB en `127.0.0.1:5434`, preparada con `deploy/postgres-init.sh`. Se levanta en cualquier máquina con Docker:

```bash
docker run -d --name gps-test-pg -p 127.0.0.1:5434:5432 -e POSTGRES_PASSWORD=postgres-local -e POSTGRES_DB=opengps -v "$PWD/deploy/postgres-init.sh:/docker-entrypoint-initdb.d/010-traccar.sh:ro" timescale/timescaledb:2.32.1-pg18
```

Si va en otro servidor, se levanta sin `-p` y se llega a ella por un túnel SSH:

```bash
ssh -f -N -L 5434:IP-DEL-CONTENEDOR:5432 usuario@servidor
```

Las variables del backend, con valores de prueba:

```bash
cp apps/server/.env.example apps/server/.env.local
```

Las pruebas crean sus propias cuentas y las borran al terminar. Traccar y el correo se simulan.

```bash
pnpm test
```

Si la base está lejos, por túnel, con más tiempo por prueba:

```bash
pnpm --filter @opengps/server exec vitest run --testTimeout 180000 --hookTimeout 300000
```

Revisión de tipos y de estilo:

```bash
pnpm typecheck
```

```bash
pnpm lint
```

Backend y web, cada uno en su terminal. Con `DISABLE_BACKGROUND=1` el backend no espera a Traccar.

```bash
pnpm --filter @opengps/server dev
```

```bash
pnpm --filter @opengps/web dev
```

| Servicio | Dirección local |
|---|---|
| Web | http://localhost:5173 |
| API | http://localhost:3000/api |

## App para iPhone

Se compila en una Mac con Xcode 26.3 y CocoaPods, en el simulador de iPhone. La app usa Expo SDK 55, la última que compila ese Xcode (ADR-0015).

```bash
pnpm --filter @opengps/mobile ios
```

La primera vez genera `apps/mobile/ios`, compila la app, la instala en el simulador y deja Metro en marcha. Las siguientes veces basta con Metro:

```bash
pnpm --filter @opengps/mobile start
```

Al abrirla pide la dirección de la plataforma, con `app.opengps.dev` ya escrita. Para una plataforma local, `http://localhost:3000`: el simulador llega a la computadora en `localhost`.

## Simulador

Para probar sin equipos, la plataforma trae un simulador en **Administración → Sistema → Simulador**, que solo ve su dueño. Cada equipo simulado se conecta al receptor igual que un GPS real y le envía las tramas de su marca, así que recorre el mismo camino: el receptor lo decodifica, la plataforma lo guarda y sus reglas, alertas y avisos se disparan.

1. En el simulador, crea un equipo: su marca, un identificador (el botón «Generar» da uno válido), el servidor y el puerto a los que se conecta, cada cuántos segundos reporta y qué ruta recorre.
2. Agrega ese GPS a una cuenta con «Agregar GPS», con el mismo identificador y la misma marca. El receptor rechaza a los equipos que no conoce, y el simulador lo dice.
3. Inícialo. El vehículo se mueve en el mapa; el panel del simulador muestra lo enviado, si la plataforma lo recibió y cuánto tardó.

- **Marcas:** Teltonika y H02 (SinoTrack, MiCODUS).
- **Rutas:** en la pestaña «Rutas» se arman en el mapa. Se busca una dirección o se toca el mapa para marcar por dónde pasa, los puntos se arrastran, y el camino se traza por calles, con el tiempo de manejo de cada una, o con líneas rectas. También se puede tomar el trazo de un recorrido real de un vehículo propio. Cada ruta se guarda y sirve para cualquier equipo simulado.
- **Opciones de la ruta:** lo que le pasa al vehículo en el camino, para ver cómo responde la plataforma: paradas con el motor encendido o apagado, carga y descarga de combustible, exceso de velocidad, arranque desactivado, movimiento con el motor apagado, alarmas del equipo, pérdida de señal (guarda sus reportes y los sube al volver), cambio de conductor y códigos de falla. Solo se ofrece lo que cada marca transporta. Hay escenarios listos: viaje con paradas, robo, combustible, exceso de velocidad y pérdida de señal.
- **Control en vivo:** con el equipo en marcha, su panel provoca al momento una alarma, el arranque desactivado, un robo, una carga o descarga de combustible o una desconexión. «Enviar la ruta como viaje pasado» sube una vuelta completa con las horas de otro día, como un equipo que descarga su memoria: el viaje queda en el historial sin esperar a que lo recorra.
- **A dónde se conecta:** como en un GPS real, se escriben el servidor y el puerto. Vienen llenos con la dirección pública de la plataforma y el puerto de la marca, y se pueden cambiar para enviar a otro servidor.
- **Órdenes:** el equipo simulado obedece las que recibe. Si la plataforma le corta el arranque, se detiene y lo reporta hasta que se lo devuelvan.
- **Al reiniciar el servidor,** lo que estaba en marcha sigue donde iba.

## Despliegue

Se instala con Docker, desde la carpeta `deploy/`, que trae una carpeta por cada forma de hacerlo: en un puerto del servidor, con Caddy, con un túnel de Cloudflare, con Dokploy o con Coolify. El paso a paso, desde un servidor recién creado, está en [deploy/README.md](deploy/README.md).

## Licencia

[Apache License 2.0](LICENSE).
