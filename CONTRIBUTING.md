# Contribuir a OpenGPS

La fuente de verdad de la forma de trabajo es [AGENTS.md](AGENTS.md). Este documento
resume lo que necesita una persona para contribuir. Si ambos difieren, manda `AGENTS.md`.

## Flujo por cambio

`issue → rama → commits → PR → CI verde → revisión humana → squash merge → issue cerrado`

- Todo cambio parte de un issue. Si no está en un issue, no se hace.
- Un PR resuelve un issue y trata un solo tema.
- Las ramas se nombran `tipo/N-descripcion`, donde `N` es el número del issue y `tipo`
  es `feat`, `fix`, `chore`, `docs` o `refactor`. Ejemplo: `feat/42-descripcion`.
- El diff objetivo por PR es de 400 líneas o menos. Las excepciones (lockfiles, código
  generado, migraciones) se marcan y se justifican en el PR.
- Los cambios triviales (typos, formato) van como `chore:` en un PR directo con el
  label `trivial`.
- Las decisiones de arquitectura se registran en `docs/adr/NNNN-titulo.md`. Los ADR son
  inmutables: se marcan `Superseded by`, nunca se reescriben.
- `main` solo recibe cambios por squash merge de un PR revisado.

## Commits

Los mensajes siguen [Conventional Commits](https://www.conventionalcommits.org/es/v1.0.0/)
con los tipos `feat`, `fix`, `chore`, `docs`, `refactor` y `test`.

```
feat(ingest): describir el cambio en imperativo

Cuerpo: qué y por qué, no cómo.

Closes #42
Signed-off-by: Nombre Humano <email>
Co-Authored-By: Claude <noreply@anthropic.com>
```

- El autor git es siempre una persona.
- Cada commit lleva el trailer `Signed-off-by:` de esa persona. Con él certifica el
  [Developer Certificate of Origin](https://developercertificate.org/).
- Si una herramienta de IA participó en el cambio, el commit lleva además un trailer
  `Co-Authored-By:` que la identifica.
- No se firma criptográficamente a nombre de una herramienta de IA ni se usan
  identidades ficticias.
- Está prohibido usar `--no-verify`, hacer force-push a `main` y reescribir historia
  publicada.

## Definition of Done

Cada PR debe cumplir este checklist, que también está en la plantilla de PR:

- `Closes #N` y criterios de aceptación del issue cumplidos.
- Tests derivados de los criterios de aceptación, no de la implementación.
- CI verde en todos los checks.
- Sin dependencias nuevas no aprobadas.
- `CHANGELOG.md` actualizado.
- Docs y ADR actualizados si aplica.
- Migración reversible y plan de rollback si aplica.
- Sin secretos, sin código muerto y sin TODOs huérfanos.
- Diff dentro del límite o justificado.

## Labels

| Label | Uso |
|---|---|
| `bug` | Algo no funciona como debería. |
| `feature` | Unidad de valor nueva con criterios de aceptación. |
| `tech-debt` | Duplicación, código muerto o consolidación pendiente. |
| `decision` | Decisión pendiente de aprobación. Al aprobarse se registra como ADR. |
| `trivial` | Cambio trivial (typos, formato) que va en PR directo. |

Las plantillas de issue asignan su label automáticamente.

## Milestones

Hay un milestone por fase de arranque. Cada issue se asigna al de su fase.

| Milestone | Alcance |
|---|---|
| Fase 1 — Gobernanza | Licencia, documentos base, plantillas y política de commits. |
| Fase 2 — Entorno | Bootstrap del host, contenedores, Makefile y pre-commit. |
| Fase 3 — CI | Checks obligatorios bloqueando merges y branch protection. |
| Fase 4 — ADRs | Propuestas de stack, almacenamiento, tenancy y límites de capas. |
| Fase 5 — MVP | Alcance cerrado definido por el mantenedor. |

## Publicar una versión

Las versiones siguen el versionado semántico y salen del `version` del `package.json`
raíz (ADR-0003).

1. Un PR `chore(release): vX.Y.Z` sube ese número y convierte la sección
   `## [Sin publicar]` del `CHANGELOG.md` en `## [X.Y.Z] - AAAA-MM-DD`, con una
   sección `## [Sin publicar]` nueva y vacía encima.
2. Al hacer merge, el flujo `Release` arma las imágenes `opengps`, `opengps-postgres` y
   `opengps-helper` para amd64 y arm64 y las sube a `ghcr.io/afigueroahn/` con el tag
   `X.Y.Z`.
3. Solo entonces crea el tag `vX.Y.Z` y la release de GitHub, con la sección del
   CHANGELOG como notas.

Si una corrida falla a la mitad, se arregla la causa y se vuelve a correr `Release`
desde la pestaña *Actions*. Una versión ya publicada no se vuelve a publicar.

## Uso de IA

Este proyecto se desarrolla con asistencia de IA y lo declara de forma explícita:

- Un agente de IA (Claude, de Anthropic) actúa como implementador: redacta código,
  documentación, issues y PRs bajo la dirección del mantenedor.
- Las decisiones de arquitectura, stack y alcance las toma una persona.
- Ningún PR se mergea sin revisión humana ni con código que el mantenedor no pueda
  explicar.
- Los commits asistidos por IA se identifican con el trailer `Co-Authored-By:`.
- Quien contribuya usando herramientas de IA debe declararlo con ese mismo trailer y
  responde por el contenido que envía, igual que si lo hubiera escrito a mano.
