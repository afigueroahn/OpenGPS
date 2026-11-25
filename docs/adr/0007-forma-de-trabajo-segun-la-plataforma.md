# ADR-0007: Forma de trabajo según la plataforma que hay

- **Estado:** Aceptada
- **Fecha:** 2026-11-25
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

`AGENTS.md` se escribió antes de importar la plataforma (ADR-0002). Describe un servidor
preparado con `infra/bootstrap/`, un `Makefile` como punto de entrada, devcontainer o
`mise.toml` y carpetas que no existen. ADR-0002 dejó esos choques para resolverlos por
separado.

También pide cosas que el proyecto no tiene: imágenes fijadas por digest, `HEALTHCHECK`
en los Dockerfile, un formateador, hooks de pre-commit, límites entre capas comprobados
en la CI, umbral de cobertura, Renovate o Dependabot y `docs/architecture.md`.

## Opciones consideradas

### Construir lo que falta

- A favor: se cumple `AGENTS.md` tal como está.
- En contra: rehace de otra manera lo que ya funciona (`deploy/`, los scripts de pnpm),
  suma dependencias nuevas y reformatear todo el código sería un PR enorme.

### Ajustar el texto y dejar cada regla sin cumplir como pendiente

- A favor: el documento no esconde lo que falta.
- En contra: se llena de pendientes que nadie pidió.

### Ajustar `AGENTS.md` a la plataforma y quitar lo que no hace falta

- A favor: el documento dice lo que de verdad pasa y no pide nada que nadie vaya a
  hacer.
- En contra: se pierden comprobaciones, aunque hoy no existen.

## Decisión

Se ajusta `AGENTS.md` a la plataforma y se quita lo que no hace falta:

| Sección | Antes | Ahora |
|---|---|---|
| §5 Servidor | Ubuntu 26.04 preparado con `infra/bootstrap/` | Ubuntu 24.04 o 26.04 con Docker, preparado e instalado con `deploy/README.md` y una carpeta de `deploy/` (ADR-0005). Descarga las imágenes de la release (ADR-0003) y se actualiza desde la consola (ADR-0004) |
| §5 Imágenes | Fijadas por versión y digest; `HEALTHCHECK` en cada Dockerfile | Fijadas por versión. Los healthchecks van en los compose |
| §5 Herramientas | devcontainer o `mise.toml`, formateador | `packageManager` y `engines` del `package.json` raíz, `.editorconfig` |
| §5 Punto de entrada | `Makefile` | Los scripts de pnpm. Las migraciones las aplica la plataforma al arrancar |
| §6 Checks | Incluía formato, límites de arquitectura y umbral de cobertura | Los que corre la CI. Se quitan pre-commit y Renovate o Dependabot. Se mantiene la protección de `main` |
| §10 Estructura | `services/`, `migrations/`, `infra/`, `tools/`, `Makefile` | `apps/`, `packages/shared/`, `db/migrations/`, `deploy/` |
| §12 Documentación | Guía rápida en `README.md`, `docs/architecture.md` | La instalación en `deploy/README.md`, más `docs/API.md` |
| §3 Commits | Autoría, firma y atribución | Conventional Commits y lo prohibido. La Fase 0 pide solo identidad git |
| §13 y §14 | Fase 2 con `Makefile`; §14 «ejecuta únicamente la Fase 0» | Fase 2 con `deploy/` y pnpm; sin §14 |

`CONTRIBUTING.md` acompaña estos cambios.

## Consecuencias

- Un formateador, hooks de pre-commit, límites entre capas, cobertura o Dependabot
  vuelven solo con su propio issue, porque cada uno es una dependencia nueva (§7).
- Los commits ya no tienen que llevar `Signed-off-by` ni `Co-Authored-By`.
- La protección de `main` sigue pendiente: es un ajuste de GitHub que hace el dueño.
- Las descripciones de los milestones «Fase 2 — Entorno» y «Fase 4 — ADRs» en GitHub
  se alinean con este cambio.
