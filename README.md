# Gestion_inmobiliaria
panel de gestion para inmobiliarias
# Panel inmobiliario v18 — Railway

Esta versión conserva **sin cambios** los archivos `index.html`, `styles.css` y `app.js` de la v18. `server.js` usa el servidor HTTP nativo de Node.js, sin dependencias que instalar.

## Publicar

1. Descomprimí este ZIP y subí **los archivos de su interior** a la raíz de un repositorio nuevo de GitHub (no subas solamente el ZIP).
2. En Railway: **New Project → Deploy from GitHub Repo**, seleccioná el repositorio y desplegá.
3. Railway detecta `package.json` y ejecuta `npm start` (si pide Start Command, ingresá `npm start`). No se necesitan variables de entorno; Railway proporciona `PORT`.
4. En el servicio: **Settings → Networking → Public Networking → Generate Domain**. Abrí la URL asignada.
5. Verificá inicio de sesión, alta de propiedad, pagos, contratos, calendario y exportaciones.

## Prueba local

Requiere Node.js 20 o superior:

```bash
npm start
```

Abrí http://localhost:3000

## Limitaciones importantes

Los datos de la aplicación siguen almacenándose en el `localStorage` de cada navegador. Railway publica la interfaz, **pero no comparte ni sincroniza datos entre equipos**. No usar con datos reales o sensibles de clientes sin implementar autenticación y almacenamiento seguro en servidor, control de accesos y copias de seguridad centralizadas. Las bibliotecas de Excel, PDF y documentos y las fuentes se cargan desde CDNs externos, por lo que requieren conexión a Internet.
