# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/).

## [Sin publicar]

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
