# Panel inmobiliario v19 — PostgreSQL + autenticación

## Instalación en Railway

1. Creá un **nuevo servicio de prueba** desde este repositorio (no reemplaces v18 todavía).
2. Conectá el servicio PostgreSQL y configurá `DATABASE_URL=${{Postgres.DATABASE_URL}}` (ajustá `Postgres` al nombre real).
3. Configurá el correo saliente con `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` y `MAIL_FROM`. El proveedor debe autorizar el remitente; Railway no ofrece por sí mismo envío SMTP. Sin SMTP, el registro devuelve un error explícito y no se crean cuentas.
4. Desplegá con `npm start`. Verificá `/api/health` (debe devolver `{"status":"ok"}`).
5. Probá registro, recepción de código, verificación, inicio de sesión y propiedades en dos dispositivos.

## Advertencias importantes

- Base de datos nueva, sin migración desde v18. Los datos antiguos del navegador no se importan.
- Sesiones del servidor con cookie `HttpOnly; Secure; SameSite=Lax`; contraseña con `scrypt` y salt de aplicación. **Antes de producción** mejorar a Argon2id con salt individual por usuario y añadir recuperación de contraseña, rotación de sesiones y protección CSRF específica.
- El frontend v18 usa una sincronización por **documento completo** con revisión optimista. Ante cambios concurrentes no fusiona ediciones: muestra aviso y exige recarga. No es todavía una API por entidad ni colaboración simultánea.
- Los archivos PDF/Word de contratos siguen guardándose en IndexedDB del dispositivo. **No se sincronizan entre dispositivos**. No cargar contratos reales hasta implementar almacenamiento privado de adjuntos en servidor.
- El backend guarda metadatos y estado en JSONB por inmobiliaria; los datos son accesibles desde distintos dispositivos mediante el mismo usuario. Para un despliegue comercial es necesario migrar a tablas normalizadas, permisos por usuario, copias de seguridad verificadas y auditoría inmutable.
- No usar para información sensible de clientes hasta completar una revisión de seguridad, autorización, pruebas de concurrencia y respaldo.

## Calculadora de alquileres — revisión de precisión
- Inspirada metodológicamente en la calculadora de Chequeado (https://chequeado.com/calculadoradealquileres/), con atribución y sin afiliación.
- Selección de periodicidad de 1 a 12 meses; fechas de actualización calculadas sin desbordes de fin de mes.
- Los índices del registro local solo se usan cuando existen valores para **ambas fechas exactas**; no se interpolan, extrapolan ni inventan valores.
- La fórmula aplica la razón de índices sin redondeos intermedios y redondea el importe final a centavos.
- El resultado diferencia los valores coincidentes con el registro local de los ingresados manualmente. Ninguno se presenta como certificado por una fuente oficial.
- **Pendiente para uso productivo**: integración y verificación automatizada de series oficiales y tratamiento específico de Casa Propia, IPC por períodos mensuales y dólar según cláusula contractual. No utilizar esta beta como liquidación definitiva sin verificar las series y el contrato.


## Calculadora ARquiler / BCRA
Interfaz inspirada en ARquiler (atribución visible), con 12 botones de meses y sin «Próximo ajuste». ICL, CER y UVA consultan la API oficial BCRA v4 mediante el servidor. La API descubre la variable por su descripción; si no existe coincidencia única o falta un valor exacto, rechaza el cálculo. IPC, Casa Propia y otros índices **no están habilitados** hasta implementar y verificar sus fuentes oficiales y metodologías propias. Se requiere sesión iniciada. Las llamadas a BCRA necesitan conectividad externa desde Railway.
