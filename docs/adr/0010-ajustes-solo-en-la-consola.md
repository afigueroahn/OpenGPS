# ADR-0010: Lo que se ajusta en la consola no es variable de entorno

- **Estado:** Aceptada
- **Fecha:** 2026-11-25
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

El backend leía 39 variables de entorno. Veinte de ellas tenían además su ajuste en la
consola de administración: el correo saliente, el mapa, el servicio de direcciones y el
de rutas, los plazos y la retención de los equipos y del historial, los avisos al dueño
y los datos de los textos legales. La variable daba el valor de partida, y la consola lo
cambiaba y podía volver a él.

Ninguna forma de instalar pasa esas veinte variables al contenedor (ADR-0005), así que
en una instalación hecha con la guía nunca están definidas: vale el valor de fábrica o lo
que se escribió en la consola. Solo contaban en desarrollo y en las pruebas. El mismo
ajuste tenía dos orígenes, y mirando una instalación no se sabía de cuál salía un valor.

## Opciones consideradas

### Lo que se ajusta en la consola deja de ser variable

Los valores de fábrica quedan escritos en el código y la consola es el único lugar donde
se cambian. A favor: cada ajuste tiene un solo origen, y el archivo de variables de
desarrollo lista todo lo que se lee. En contra: no se pueden fijar esos valores desde
fuera con una variable, algo que ninguna forma de instalar hace.

### Dejarlas y documentarlas todas

A favor: no cambia código. En contra: mantiene los dos orígenes y suma diecisiete
variables al archivo de ejemplo de desarrollo.

### Dejarlo como está

En contra: las variables siguen funcionando sin que nadie sepa que existen, que es lo que
ADR-0006 descartó para las de instalación.

## Decisión

Las veinte dejan de leerse. Su valor de fábrica queda en `apps/server/src/config.ts`, con
los demás ajustes que ya eran solo de la consola:

| Variable | Valor de fábrica |
|---|---|
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` | Vacío: sin servidor de correo |
| `SMTP_PORT`, `SMTP_SECURITY` | 587, con STARTTLS |
| `MAIL_FROM` | El nombre de la plataforma y `no-reply@localhost` |
| `MAP_STYLE_URL` | El estilo Liberty de OpenFreeMap |
| `GEOCODER_URL` | El servicio público de OpenStreetMap (Nominatim) |
| `GEOCODER_USER_AGENT` | El nombre y la dirección de la plataforma |
| `GEOCODER_MIN_INTERVAL_MS` | 1100 |
| `ROUTING_URL` | El servicio público de OSRM |
| `CLAIM_WINDOW_MINUTES` | 60 |
| `MAX_PENDING_DEVICES` | 20 |
| `HISTORY_RETENTION_DAYS` | 0, sin límite |
| `TRACCAR_RETENTION_DAYS` | 14 |
| `ALERT_EMAIL` | Vacío |
| `DISK_ALERT_PERCENT` | 70 |
| `LEGAL_ENTITY`, `LEGAL_COUNTRY`, `LEGAL_CONTACT_EMAIL` | Vacíos |

Son los mismos valores que tenían las variables sin definir: una instalación no cambia.

## Consecuencias

- «Restablecer» una sección de la consola vuelve a los valores de fábrica, que es lo que
  el botón ya decía.
- El correo saliente solo existe si se configura en la consola. Con el servidor de correo
  propio apagado, la plataforma no envía correos; antes ese caso se describía como «el
  que trae el servidor».
- Quien pasara alguna de estas variables por su cuenta puede borrarla: ya no se lee, y su
  valor se escribe en la consola.
- En desarrollo, el correo, el mapa y lo demás se ajustan en la consola, como en una
  instalación. Las pruebas fijan en su arnés lo que necesitan distinto de fábrica: los
  servicios de direcciones y de rutas apagados y el titular de los textos legales.
- `apps/server/.env.example` lista todas las variables que el backend lee.
