# Notas para la revisión

Van en inglés, que es el idioma de los revisores. Se pegan en:

- **App Store Connect →** la versión → Información para la revisión de la app → **Notas**. El usuario y la contraseña van en sus propios campos («Se requiere iniciar sesión»).
- **Play Console →** Contenido de la app → **Acceso a la app** → «Todas o algunas funciones están restringidas»: usuario, contraseña y estas instrucciones.

La cuenta es `demo@opengps.dev` en `app.opengps.dev`. Su contraseña se escribe solo en esos campos, nunca en el repo. Antes de enviar, esa cuenta debe tener vehículos con posiciones recientes, por ejemplo con el simulador de la plataforma (README, «Simulador»): así los revisores ven el mapa en movimiento.

---

OpenGPS is a client for an OpenGPS tracking platform. People see the GPS tracking devices installed in their vehicles on a live map, with their history and alerts. The platform is open source and anyone can create a free account at app.opengps.dev or install their own.

How to review:

1. Open the app. The platform address field already says app.opengps.dev: tap Continue.
2. Sign in with the demo account provided in the sign-in fields.
3. Map: the demo vehicles and their live position. Tap a vehicle to open its sheet: status, address, history, sharing and, on devices that support it, remote engine lock.
4. Vehicles, Alerts and Incidents tabs: the lists for the account.
5. Account: profile, password, passkeys, language, theme and "Delete my account", which deletes the account and all its data.

Notes:

- The app does not use the phone's location and does not ask for it. The positions on the map come from the GPS devices installed in the vehicles, which send them to the platform.
- The camera and the photo library are used only to set a profile photo.
- There is no advertising, no analytics and no tracking.
