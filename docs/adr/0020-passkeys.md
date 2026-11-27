# ADR-0020: Passkeys en la web y las apps, con el complemento de better-auth

- **Estado:** Aceptada
- **Fecha:** 2026-11-27
- **Decide:** Angel Figueroa (@afigueroahn)

## Contexto

Se quiere entrar con passkeys (FIDO2/WebAuthn) en la web y en las apps: Face ID, Touch ID,
Windows Hello, huella o una llave física, y también desde otro teléfono con un código QR.
Tienen que convivir con correo y contraseña, Google y Apple, y funcionar en instalaciones
propias, cada una con su dominio (#122).

Lo que piden las passkeys de cada instalación:

- Una passkey queda atada al RP ID, el dominio de la plataforma. WebAuthn exige HTTPS y un
  nombre de dominio; `localhost` vale para desarrollo.
- En iOS, las passkeys nativas exigen el dominio en los Associated Domains de la app, escritos
  al compilarla. Una sola app no puede listar los dominios de todas las instalaciones.
- El navegador del sistema (`ASWebAuthenticationSession`, Custom Tabs) hace WebAuthn con el
  origen de la propia plataforma, en cualquier dominio con HTTPS.

## Opciones consideradas

### Complemento de passkeys de better-auth, y el navegador del sistema en las apps

- A favor: la sesión que abre una passkey es la misma de siempre, con la misma vigencia y el
  mismo cierre. El complemento va en la misma versión que la librería de sesión y se apoya en
  SimpleWebAuthn, sin criptografía propia. En las apps sirve con cualquier dominio, reusando
  el pase de un solo uso de ADR-0013 y ADR-0014.
- En contra: en la app se abre una hoja del navegador en vez de un botón del sistema. Suma
  dos dependencias.

### El mismo complemento, con passkeys nativas en las apps

- A favor: en la app se ve nativo.
- En contra: en iOS solo sirve con dominios escritos en la app y pide la cuenta de pago de
  Apple. Hace falta la primera opción igual para los demás dominios.

### SimpleWebAuthn directo, sin el complemento

- A favor: control total de la tabla y las rutas.
- En contra: crear la sesión a mano y mantener lo que el complemento ya hace y prueba.

## Decisión

El complemento `@better-auth/passkey`, en la versión de la librería de sesión, y el
navegador del sistema en las apps.

- **Dónde hay passkeys** (`apps/server/src/core/passkeys.ts`): el RP ID es el dominio de
  `PUBLIC_URL` y el origen, `PUBLIC_URL`. Con HTTP o una IP no hay: `GET /api/config` dice
  `passkeys: false` y la API no deja pasar `/api/auth/passkey/*`.
- **Interruptor:** las passkeys vienen encendidas, y la consola las puede apagar
  (`passkeysEnabled` en los ajustes generales).
- **Qué pide cada passkey:** tiene que poder encontrarse sola, para entrar sin escribir el
  correo, y pide Face ID, huella o PIN cada vez: reemplaza a la contraseña.
- **Qué se guarda:** en la tabla `auth.passkey`, solo la clave pública y sus datos. Se borran
  con la cuenta.
- **Registrar una passkey:** pide una sesión de menos de un día, como borrar la cuenta.
- **Cómo entró cada persona:** la consola lo muestra como `passkey`.
- **Web:** usa `@simplewebauthn/browser` (segunda entrega, #124).
- **Apps:** entran por el navegador del sistema (tercera entrega, #125).

## Consecuencias

- Una instalación que cambia de dominio deja sin servir las passkeys de su gente. Entran con
  su contraseña o con otro servicio y crean otras.
- Las passkeys nativas en las apps pueden sumarse después solo para el dominio oficial, con
  su propia decisión.
- Licencias MIT: `@better-auth/passkey` (better-auth) y SimpleWebAuthn.
