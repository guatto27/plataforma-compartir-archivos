# BusinessCool IA — Plataforma segura de diagnóstico y archivos

Plataforma web privada para la fase de **diagnóstico** con clientes: acceso por
usuario y contraseña, compartición segura de archivos en ambos sentidos
(plantillas/formatos hacia el cliente; documentos del cliente hacia ti) y
registro del **enlace de la entrevista** (Gem de Gemini).

## Características

- 🔐 **Login con usuario y contraseña** que tú provisionas (no hay registro público).
- 👥 **Dos roles**: administrador (tú) y cliente. Cada cliente solo ve su propio espacio.
- 📁 **Archivos bidireccionales** con control de acceso en cada descarga.
- 🧭 **Entrevista de diagnóstico**: el cliente pega el enlace de su conversación de Gemini.
- 🛡️ **Seguridad integrada**: hash bcrypt, sesiones httpOnly, CSRF, rate-limit en login,
  cabeceras con Helmet/CSP, validación de tipo y tamaño de archivo, registro de auditoría.
- 🎨 **Branding** de BusinessCool IA (editable en un solo archivo).

## Requisitos

- Node.js **≥ 22.5** (probado en v24). No requiere base de datos externa (usa SQLite nativo).

## Puesta en marcha

```bash
npm install
copy .env.example .env        # en Windows (cp en Linux/Mac)
# Edita .env y genera un SESSION_SECRET fuerte:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Crea tu usuario administrador:
node src/scripts/createUser.js admin TU_USUARIO "TuContraseñaSegura10+"

# Arranca:
npm start
```

Abre <http://localhost:3000> e inicia sesión.

> Para desarrollo con recarga automática: `npm run dev`.

## Uso

### Como administrador (tú)
1. **Clientes → Nuevo cliente**: crea el usuario. Si dejas la contraseña vacía, se genera
   una temporal que se muestra **una sola vez** — cópiala y compártela por un canal seguro.
2. Entra al detalle del cliente para **compartir plantillas/formatos** y **descargar** lo que envíe.
3. Revisa los **enlaces de entrevista** y el **registro de auditoría**.

### Como cliente
1. Inicia sesión y **cambia la contraseña** (obligatorio la primera vez).
2. Pega el **enlace de la entrevista** de Gemini.
3. **Descarga** las plantillas y **sube** los documentos solicitados.

## Configuración (.env)

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto del servidor (def. 3000) |
| `NODE_ENV` | `development` o `production` |
| `SESSION_SECRET` | Secreto para firmar cookies (obligatorio y fuerte en producción) |
| `MAX_FILE_MB` | Tamaño máximo por archivo |
| `ALLOWED_EXT` | Extensiones permitidas |

## Branding

Edita los colores en [`public/css/styles.css`](public/css/styles.css) (bloque `:root`)
y el nombre/tagline en [`src/config.js`](src/config.js) (`brand`).
Para usar tu logo en imagen, sustituye `.brand-mark` por un `<img>` en
[`src/views/partials/header.ejs`](src/views/partials/header.ejs).

## Estructura

```
src/
  server.js            App Express, sesión, seguridad, rutas
  config.js            Configuración y branding
  db.js                SQLite (esquema + auditoría)
  middleware/auth.js   Login, roles, CSRF
  lib/upload.js        Subida de archivos (multer)
  routes/              auth.js · client.js · admin.js
  scripts/createUser.js
  views/               Plantillas EJS
public/                CSS y JS estáticos
storage/uploads/       Archivos subidos (NO se versiona)
data/                  Base de datos SQLite (NO se versiona)
test/smoke.js          Prueba de humo del flujo principal
```

## Pruebas

Con el servidor corriendo en otra terminal:

```bash
node test/smoke.js
```

## Notas de seguridad / despliegue

- **HTTPS obligatorio en producción.** Las cookies se marcan `secure` cuando
  `NODE_ENV=production`. Despliega detrás de un proxy con TLS (Nginx, Caddy, Render, Railway…).
- Define un `SESSION_SECRET` largo y aleatorio; la app no arranca en producción con el valor por defecto.
- Haz **copias de seguridad** de `data/portal.db` y de `storage/uploads/`.
- El almacén de sesiones por defecto es en memoria (se pierde al reiniciar). Para producción
  considera un almacén persistente (p. ej. SQLite/Redis para `express-session`).
- Considera **cifrado en reposo** del disco/volumen donde viven `storage/` y `data/`.
```
