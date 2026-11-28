# Datos de la app

Las respuestas para «Privacidad de la app» (App Store Connect) y «Seguridad de los datos» (Play Console). Salen de lo que la app hace hoy: si cambia lo que envía a la plataforma, hay que cambiarlas.

Lo que la app envía a la plataforma: el correo y la contraseña al entrar o crear la cuenta; el nombre y, si la persona quiere, su teléfono y su foto de perfil; y lo que hace en ella (agregar un GPS, reportar un incidente, bloquear un motor). No usa publicidad, analítica, rastreo ni informes de errores de terceros. No usa ni pide la ubicación del teléfono: las posiciones del mapa las mandan los equipos GPS a la plataforma, no la app.

Permisos: Internet y estado de la red; cámara y fotos, solo para la foto de perfil; almacenamiento, solo en Android 12 o anterior, para elegir esa foto.

## App Store Connect — Privacidad de la app

¿Recopilas datos de esta app? **Sí.**

| Tipo de dato | ¿Vinculado a la persona? | ¿Para rastrear? | Uso |
|---|---|---|---|
| Información de contacto → Nombre | Sí | No | Funcionalidad de la app |
| Información de contacto → Correo electrónico | Sí | No | Funcionalidad de la app |
| Información de contacto → Número de teléfono (si lo agrega) | Sí | No | Funcionalidad de la app |
| Contenido del usuario → Fotos o videos (foto de perfil) | Sí | No | Funcionalidad de la app |
| Identificadores → ID de usuario | Sí | No | Funcionalidad de la app |

No marcar: Ubicación (la app no envía la del teléfono), Datos de uso, Diagnóstico, Compras, Datos financieros, Salud, Contactos, Navegación, Búsquedas.

## Play Console — Seguridad de los datos

- ¿Tu app recopila o comparte alguno de los tipos de datos del usuario requeridos? **Sí.**
- ¿Todos los datos del usuario que recopila tu app están encriptados en tránsito? **No.** La app también se conecta por `http://` a las plataformas instaladas en una IP sin dominio (ADR-0026). En `app.opengps.dev` todo va por HTTPS.
- ¿Ofreces una forma de que los usuarios soliciten que se borren sus datos? **Sí:** desde la app (Cuenta → Eliminar mi cuenta) y desde el perfil en la web. Dirección: `https://app.opengps.dev/privacy`.

| Categoría → tipo | Recopilado | Compartido | ¿Opcional? | Para qué |
|---|---|---|---|---|
| Información personal → Nombre | Sí | No | No | Funcionalidad de la app, Administración de la cuenta |
| Información personal → Dirección de correo electrónico | Sí | No | No | Funcionalidad de la app, Administración de la cuenta |
| Información personal → Números de teléfono | Sí | No | Sí | Funcionalidad de la app |
| Información personal → ID de usuario | Sí | No | No | Funcionalidad de la app, Administración de la cuenta |
| Fotos y videos → Fotos | Sí | No | Sí | Funcionalidad de la app |

Los datos se tratan de forma efímera: **No** (se guardan en la plataforma).

## Otras preguntas de Play Console

- **Anuncios:** la app no contiene anuncios.
- **Público objetivo:** 18 años o más. No está dirigida a niños.
- **Clasificación de contenido (IARC):** categoría «Utilidad, productividad, comunicación u otra». Sin violencia, sexo, lenguaje, drogas ni apuestas. ¿Los usuarios interactúan o intercambian contenido? No. ¿Comparte la ubicación física actual del usuario con otros? No: comparte la de un vehículo, con un enlace que vence.
- **Apps gubernamentales, financieras o de salud:** no aplica.
