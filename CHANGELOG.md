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

### Cambiado

- El menú de Administración ya no muestra «Gestión GPS» bajo el logo, y a su pie
  queda solo la versión, sin los datos de la persona.
- El §7 de `AGENTS.md` exige que las dependencias nuevas tengan licencia compatible con
  Apache-2.0 (#3).
- El §10 de `AGENTS.md` lista `NOTICE` en la estructura del repositorio (#5).
