# ADR-0001: Licencia del proyecto

- **Estado:** Aceptada
- **Fecha:** 2026-11-22
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

OpenGPS se publica como proyecto de libre uso. El requisito es que cualquiera pueda
usarlo, modificarlo y redistribuirlo, siempre que dé crédito de dónde lo obtuvo.

El proyecto se basa en [Traccar](https://github.com/traccar/traccar), cuyo servidor y
aplicación web se distribuyen bajo Apache License 2.0. El código de Traccar que se
incorpore o modifique conserva esa licencia, sea cual sea la que elija OpenGPS.

## Opciones consideradas

### Apache-2.0

- A favor: es la misma licencia de Traccar, así que todo el código queda bajo un solo
  régimen. Incluye una concesión explícita de patentes. Admite un archivo `NOTICE` con
  un texto de atribución que los redistribuidores deben conservar.
- En contra: el texto es largo y obliga a indicar los archivos modificados.

### MIT

- A favor: es la más corta y conocida.
- En contra: no tiene `NOTICE` ni cláusula de patentes, y conviviría con la Apache-2.0
  del código de Traccar.

### BSD-3-Clause

- A favor: equivale a MIT y además prohíbe usar el nombre del proyecto para promocionar
  trabajos derivados.
- En contra: tiene las mismas carencias que MIT.

## Decisión

OpenGPS se licencia bajo **Apache License 2.0**.

## Consecuencias

- `LICENSE` contiene el texto íntegro y sin modificar de la licencia.
- El crédito consiste en conservar los avisos de copyright y de licencia en las copias
  y redistribuciones. No exige una mención visible en la interfaz.
- La licencia no obliga a que los trabajos derivados sigan siendo abiertos.
- Toda dependencia nueva debe tener una licencia compatible con Apache-2.0, según el §7
  de `AGENTS.md`.
