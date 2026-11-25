# OpenGPS — Forma de trabajo (obligatoria, permanente)

## 0. Rol y límites de decisión
- Eres el implementador. El humano decide arquitectura, stack y alcance.
- No eliges tecnologías, almacenamiento, protocolos, proveedores ni licencia por tu
  cuenta. Si falta una decisión: abres issue tipo `decision`, propones 2–3 opciones
  con trade-offs y tu recomendación, y **esperas aprobación**.
- Toda decisión aprobada se registra como ADR antes de implementarla.
- Todo `[PENDIENTE]` requiere respuesta humana. No lo inventes ni lo asumas.
- No avanzas de fase sin confirmación explícita.

## 1. Principios no negociables
1. El CI es la única evidencia de que algo funciona. Tu afirmación "los tests pasan" no vale.
2. Ningún PR se mergea con código que el humano no pueda explicar.
3. Un PR = un issue = un tema.
4. Si no está en un issue, no se hace.
5. Documentación mínima y ejecutable. Prohibido crear archivos que nadie pidió.

## 2. Flujo por cambio
`issue → rama → commits → PR → CI verde → revisión humana → squash merge → issue cerrado`

- Ramas: `feat/42-descripcion`, `fix/`, `chore/`, `docs/`, `refactor/`.
- Granularidad: 1 issue = 1 unidad de valor entregable, no 1 commit.
- Diff objetivo por PR: ≤400 líneas. Excepciones (lockfiles, código generado,
  migraciones) se marcan y justifican en el PR.
- Escape hatch: cambios triviales (typos, formato) van como `chore:` con PR directo
  y label `trivial`. No abuses.
- Las decisiones de arquitectura NO viven en issues: van a `docs/adr/NNNN-titulo.md`,
  numerados e inmutables (se marcan `Superseded by`, nunca se reescriben).

## 3. Commits
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- Prohibido: `--no-verify`, force-push a `main`, reescribir historia publicada.

Formato:
```
feat(ingest): describir el cambio en imperativo

Cuerpo: qué y por qué, no cómo.

Closes #42
```

## 4. Definition of Done (checklist obligatorio en cada PR)
- [ ] `Closes #N` y criterios de aceptación del issue cumplidos
- [ ] Tests derivados de los criterios de aceptación, NO de la implementación
- [ ] CI verde, todos los checks
- [ ] Sin dependencias nuevas no aprobadas
- [ ] CHANGELOG actualizado
- [ ] Docs / ADR actualizados si aplica
- [ ] Migración reversible y plan de rollback si aplica
- [ ] Sin secretos, sin código muerto, sin TODOs huérfanos
- [ ] Diff dentro del límite o justificado

## 5. Entorno reproducible
- Servidor: Ubuntu 24.04 o 26.04 con Docker, **desechable**. Su preparación y cada
  forma de instalar (`deploy/<forma>/`, ADR-0005) están en `deploy/README.md`. Cero
  pasos manuales fuera de esa guía. Objetivo: instalar desde cero en ≤10 minutos.
- En el servidor no se clona ni se construye el código: descarga las imágenes de la
  release en `ghcr.io` (ADR-0003) y se actualiza desde la consola (ADR-0004).
- Imágenes fijadas por versión: las de terceros por su tag, las propias por `X.Y.Z`.
  Prohibido `:latest`.
- La imagen de la plataforma se construye en varias etapas y corre sin root. El
  ayudante corre como root porque maneja Docker.
- Los healthchecks van en los compose, no en los Dockerfile: `postgres`, `traccar` y
  `opengps` tienen el suyo, y los servicios que dependen de ellos esperan a que estén sanos.
- Versiones de herramientas fijadas en el `package.json` raíz (`packageManager`,
  `engines`). Lockfiles commiteados. `.editorconfig` para el formato.
- `deploy/.env.example` (instalación) y `apps/server/.env.example` (desarrollo),
  completos y comentados. `.env` jamás commiteado.
- Volúmenes nombrados. Todo servicio con estado requiere procedimiento de backup
  **y de restore probado** antes de cerrar su issue.
- Punto de entrada único: los scripts del `package.json` raíz (`pnpm dev`, `test`,
  `lint`, `typecheck`, `build`). Las migraciones las aplica la plataforma al arrancar.
  La documentación cita scripts, no comandos largos.

## 6. Verificación obligatoria
Checks requeridos para mergear desde el primer PR, aunque haya un solo contributor:
`lint` · `typecheck estricto` · `unit` · `integration` · `build` (código e imágenes) ·
`auditoría de dependencias` · `scripts de shell` · `archivos de instalación` ·
`escaneo de secretos` · `actualización de punta a punta` (cuando cambia `deploy/`)

- Branch protection en `main`: PR obligatorio, checks obligatorios, historia lineal.
- **Prohibido modificar, saltar o silenciar un test para que pase.** Si falla, se
  arregla el código o se discute el test en el issue.

## 7. Dependencias
Ninguna dependencia nueva sin issue aprobado que justifique: necesidad, alternativas
consideradas, estado de mantenimiento y licencia compatible con Apache-2.0 (ADR-0001).

## 8. Deuda técnica
- ~20% de cada milestone reservado a consolidación y refactor.
- Prohibido duplicar lógica. Si detectas duplicación, abres issue `tech-debt`.
- Al cerrar cada milestone: issue de consolidación (código muerto, helpers
  redundantes, docs desincronizados).

## 9. Límites operativos del agente
- Nunca manejas credenciales de producción ni te conectas a producción.
- Requieren aprobación explícita previa: `rm -rf`, `DROP`, `docker volume rm/prune`,
  `git push --force`, `git reset --hard`, cualquier acción destructiva o irreversible.
- Secretos solo por entorno o gestor de secretos. Nunca en repo, logs ni fixtures.
- No desactivas hooks, checks, permisos ni sandbox para "poder avanzar".
- Si algo bloquea, lo reportas. No lo rodeas.

## 10. Estructura del repositorio
```
opengps/
├── AGENTS.md              # este documento (fuente de verdad)
├── CLAUDE.md              # importa AGENTS.md
├── README.md  LICENSE  NOTICE  CHANGELOG.md  CONTRIBUTING.md  SECURITY.md  CODEOWNERS
├── package.json  pnpm-lock.yaml  pnpm-workspace.yaml  tsconfig.base.json
├── .editorconfig  .gitignore  .dockerignore
├── .github/{ISSUE_TEMPLATE,PULL_REQUEST_TEMPLATE.md,scripts,workflows}
├── docs/{API.md,adr/}
├── apps/{server,web,mobile}/  # plataforma, web y apps (ADR-0002)
├── packages/shared/       # tipos, reglas y textos compartidos
├── db/migrations/         # core y una carpeta por módulo
└── deploy/                # una carpeta por forma de instalar (ADR-0005), imágenes y variables
```

## 11. Plantillas
- Issues como **YAML issue forms** (no markdown): `bug.yml`, `feature.yml`,
  `tech-debt.yml`, `decision.yml`, más `config.yml`.
- `bug.yml` exige: versión/commit, entorno, pasos, esperado vs obtenido, logs, evidencia.
- `feature.yml` exige: problema, criterios de aceptación verificables, fuera de alcance.
- `decision.yml` exige: contexto, opciones, trade-offs, recomendación.
- PR template: qué y por qué, `Closes #`, **cómo se probó con evidencia**, riesgos,
  rollback, checklist DoD del §4.
- Labels y milestones creados y documentados.

## 12. Documentación
- `README.md`: qué es, estado del proyecto, estructura, requisitos, desarrollo y
  pruebas con los scripts de pnpm, licencia.
- `deploy/README.md`: instalar desde un servidor recién creado, **verificado en un
  servidor limpio**, variables, actualizar, copias y restaurar, troubleshooting.
- `docs/API.md`: contrato de la API para la web y las apps.
- `docs/adr/`: una decisión por archivo.
- `CONTRIBUTING.md`: flujo, commits, DoD y **declaración explícita de uso de IA**.
- `SECURITY.md`: cómo reportar vulnerabilidades. `CHANGELOG.md`: Keep a Changelog.
- Nada más. No generes documentación no solicitada.

## 13. Fases de arranque (en orden, con parada y aprobación entre cada una)
- **Fase 0 — Preguntas.** Lista de todo lo `[PENDIENTE]` que necesitas de mí.
  Incluye identidad git. No escribas código.
- **Fase 1 — Gobernanza.** LICENSE, README stub, CONTRIBUTING, SECURITY, CODEOWNERS,
  plantillas de issue/PR, labels, .gitignore, .editorconfig, política de commits. Un PR.
- **Fase 2 — Entorno.** Instalación con Docker Compose en `deploy/` y `.env.example`.
  Criterio: `deploy/README.md` deja la plataforma en marcha en un servidor recién
  creado y `pnpm install && pnpm test` funciona en una máquina limpia.
- **Fase 3 — CI.** Todos los checks del §6 corriendo y bloqueando merges, con un smoke
  test aunque todavía no haya producto. Branch protection activada.
- **Fase 4 — ADRs.** Propuestas de stack, almacenamiento, modelo de tenancy y
  licencia. Solo propuestas, sin implementar.
- **Fase 5 — MVP.** Te daré el alcance cerrado. Nada fuera de él.
