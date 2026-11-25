# ADR-0002: Importar el código existente de la plataforma

- **Estado:** Aceptada
- **Fecha:** 2026-11-24
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

La plataforma se construyó antes de este repositorio, en uno privado: el núcleo (mapa
en vivo, historial, alertas, avisos, reportes, cuentas y administración), los nueve
módulos opcionales y la instalación con Docker Compose o Dokploy. Ese trabajo ya fija
el stack, el almacenamiento y la estructura de carpetas que las fases 2 a 5 de
`AGENTS.md` iban a proponer desde cero.

La historia del repositorio privado menciona datos de una instalación concreta
(dominio, dirección IP y organización), que no son parte del producto.

## Opciones consideradas

### Importar con la historia completa

- A favor: se conserva cada commit y su mensaje.
- En contra: publica los datos de esa instalación, que quedan en la historia aunque se
  borren del árbol.

### Importar el árbol limpio en un solo commit

- A favor: el repositorio empieza sin datos de ninguna instalación. La historia
  completa queda en el repositorio privado.
- En contra: se pierde aquí el detalle de cómo se llegó a cada parte.

### Reescribir la plataforma por fases

- A favor: sigue al pie de la letra las fases de `AGENTS.md`.
- En contra: rehace lo que ya funciona.

## Decisión

Se importa el árbol limpio en un solo commit, sobre los commits de gobernanza. Quedan
fuera los documentos internos de la instalación (plan, seguimiento, servidor y
revisión legal).

Stack y estructura que se adoptan tal como están:

| Parte | Tecnología | Carpeta |
|---|---|---|
| Plataforma (API, ingesta, tareas) | Node 26, Fastify 5, better-auth, zod | `apps/server/` |
| Web | React 19, Vite, Tailwind, TanStack Query, i18next, MapLibre | `apps/web/` |
| Apps móviles (siguiente paso) | Expo | `apps/mobile/` |
| Tipos, reglas y textos compartidos | TypeScript | `packages/shared/` |
| Base de datos | PostgreSQL 18 con TimescaleDB, migraciones SQL propias | `db/migrations/` |
| Receptor de equipos GPS | Traccar | imagen oficial |
| Instalación | Docker Compose y Dokploy | `deploy/` |

Gestor de paquetes: pnpm 12, con espacios de trabajo.

## Consecuencias

- El PR de importación supera el límite de 400 líneas del §2: es la excepción de la
  importación inicial.
- Los choques entre `AGENTS.md` y lo importado se resuelven cada uno en su propio
  issue `decision`: la estructura del §10 (`services/`, `migrations/`), el
  aprovisionamiento del §5 (`infra/bootstrap/`, Makefile, devcontainer), las
  migraciones reversibles del §4 y los checks del §6 que piden herramientas nuevas.
- Las pruebas de la plataforma necesitan PostgreSQL con TimescaleDB en
  `127.0.0.1:5434`, como explica el `README.md`.
