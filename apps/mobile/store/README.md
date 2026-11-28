# Fichas de las tiendas

Lo que piden App Store Connect y Play Console para publicar las apps, en español e inglés (ADR-0030). Compilar y firmar está en el README principal, «Publicar las apps».

| Archivo | Dónde va |
|---|---|
| `app-store/es.md`, `app-store/en.md` | App Store Connect → la app → la versión, en «Español (México)» e «Inglés (EE. UU.)»: nombre, subtítulo, texto promocional, descripción, palabras clave, novedades, soporte y privacidad. La categoría está en «Información de la app». |
| `app-store/capturas/es`, `app-store/capturas/en` | La versión → «Vista previa y capturas de pantalla» → iPhone de 6,9", en cada idioma. Son de 1320 × 2868. |
| `google-play/es.md`, `google-play/en.md` | Play Console → Ficha de Play Store principal, en «es-419» y «en-US»: nombre, descripción breve, descripción completa. Las novedades van en cada versión. |
| `google-play/graficos/icono-512.png` | Ficha → Ícono de la app (512 × 512). |
| `google-play/graficos/grafico-destacado-es.png`, `-en.png` | Ficha → Gráfico de funciones (1024 × 500), en cada idioma. |
| `google-play/capturas/es`, `google-play/capturas/en` | Ficha → Capturas de pantalla del teléfono, en cada idioma. |
| `revision.md` | Las notas y la cuenta para la revisión, en las dos consolas. |
| `datos.md` | «Privacidad de la app» en App Store Connect y «Seguridad de los datos», anuncios, público objetivo y clasificación en Play Console. |

La App Store usa el ícono de 1024 px de la app (`assets/icon.png`), que va dentro de la compilación.

## Capturas

Se tomaron con la app compilada en Release contra `app.opengps.dev`, con dos vehículos de demostración en movimiento y la barra de estado fija (9:41, batería llena):

- **iPhone:** simulador de iPhone 17 Pro Max (iOS 26.3) y `xcrun simctl io <simulador> screenshot`, con `xcrun simctl status_bar <simulador> override`.
- **Android:** emulador de Android 17 (API 37) con la pantalla en 1080 × 2160 (`adb shell wm size 1080x2160`), porque Google Play acepta como mucho la proporción 2:1; `adb exec-out screencap -p` y el modo demostración de la barra de estado.

Si cambian las pantallas de la app, hay que tomarlas de nuevo con los mismos nombres.
