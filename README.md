# atalaya

Observador de infraestructura. Escucha docker y pm2, clasifica eventos y los envía
al [notification-gateway](https://github.com/Rigo85/notification-gateway) como SMS.

## Clases de evento

| Clase | Acción |
|---|---|
| crítico | SMS inmediato (contenedor caído >90 s, OOM, proceso pm2 errored, bucle de reinicios) |
| advertencia | SMS con dedup (`unhealthy`); el gateway suprime repeticiones y las contabiliza |
| actividad | SMS inmediato normal y contador en digest (sesion/reproduccion relevante) |
| info | contador local → digest diario |

El **digest diario** (hora configurable) se envía siempre, aunque diga "sin novedades":
hace de heartbeat — si un día no llega, el host está mal.
Solo dice "sin novedades" cuando los adapters Docker y PM2 están conectados; en caso
contrario incluye `DEGRADADO docker`, `DEGRADADO pm2` o ambos. También diferencia eventos
detectados de notificaciones aceptadas, deduplicadas y rechazadas por el gateway.

## Adapters (F1)

- **docker-events**: stream del socket de Docker. `die` con exit ≠ 0 abre una gracia de
  90 s: si el contenedor no vuelve → crítico; si vuelve → advertencia. Stop ordenado
  (exit 0) solo cuenta en el digest. Mantiene un inventario de contenedores esperados.
- **pm2-bus**: eventos del daemon PM2 local. Todo restart → crítico; ≥3 en
  10 min añade una alerta de bucle; `errored`/`restart overlimit` → crítico. Instrumenta la
  reconexión nativa del socket PM2 sin abrir una segunda suscripción.

## Hosts

El monitoreo de hosts es opcional y se activa con `HOST_MONITOR_MODE`:

- `off`: no inicia los adapters de host;
- `dry-run`: evalúa y persiste incidentes, pero no envía sus SMS;
- `live`: envía aperturas, escalaciones y recuperaciones.

Incluye capacidad y presencia de montajes, inodos, RAM disponible, CPU, iowait,
temperatura, reloj, reinicios, SMART/ZFS, frescura/retención de backups, canaries HTTP,
certificados y un snapshot remoto restringido. Los valores altos deben sostenerse durante
la ventana configurada; disco ausente, solo lectura o SMART fallido son inmediatos.

Los canaries correlacionan fallos simultáneos para evitar un SMS por dominio cuando falla
la capa común. Una alerta aceptada produce recuperación después de dos lecturas sanas.
Los críticos abiertos se resumen en el digest sin repetir continuamente el SMS.

Los montajes, URLs, host remoto y rutas privadas viven solo en `.env`. El formato de
`CANARY_TARGETS` es `nombre|url|status;nombre2|url2|status`.

## Servicios funcionales

Los adapters funcionales se activan solo cuando tienen sus variables privadas en `.env`
y `HOST_MONITOR_MODE` no es `off`. Con `dry-run` establecen baseline e incidentes sin SMS;
con `live` notifican segun su regla.

- **Gluetun** comprueba el estado real del VPN mediante un rol API de lectura y cuenta
  cambios de salida en el digest, sin exponer la IP.
- **qBittorrent** usa su feed incremental: baseline inicial sin eventos retroactivos,
  altas en digest, finalizaciones por SMS inmediato normal y errores como advertencia.
- **Jellyfin** establece baseline de sesiones. En `live`, conexiones y cambios de
  reproduccion son actividad inmediata y tambien se resumen en el digest. La ubicacion
  aproximada se resuelve contra GeoLite2 City local, nunca mediante un tercero.
- **Aonsoku** valida la SPA servida por Nginx y su configuracion estatica; no intenta
  simular reproduccion porque es un cliente de Navidrome/Subsonic, no un backend propio.
  Sus errores Nginx se agrupan en el digest y tres o mas en un intervalo abren aviso.
- **Navidrome** comprueba `/ping`, consulta `Now Playing` con una cuenta tecnica y envia
  inicio/cambio de tema en `live`. Si se habilita la correlacion efimera del proxy,
  puede sumar ciudad/pais aproximados sin persistir IP. Las sesiones que terminan y los
  errores de log van al digest; tres o mas errores en un intervalo abren aviso. Si se
  configura, valida tambien el endpoint Prometheus protegido sin registrar su ruta ni
  sus credenciales.

Los nombres de usuario y media que Jellyfin/qBittorrent/Navidrome deban conservar para comparar
eventos quedan solamente en `state.json`, que esta ignorado por Git. Las notificaciones
no incluyen IP completa, rutas, tokens ni contenido de archivos.

### Privilegios mínimos

`scripts/atalaya-smart-snapshot.py` se instala como helper root fijo y Atalaya solo recibe
permiso `sudo` para esa ruta exacta. Los helpers `atalaya-vps-*` se instalan en el VPS y la
clave pública de bluetv se restringe con `command=...` y `restrict`: únicamente acepta los
comandos lógicos `host`, `egress` y `navidrome-clients`, nunca una shell remota.

El helper de egress usa OCI Monitoring con instance principal y entrega únicamente bytes
del día y del mes calendario en `America/Lima`; no copia una API key OCI al host local.

### Digest sin pérdida

El digest se conserva como un SMS mientras cabe. Si crece, genera partes semánticas de
máximo 160 caracteres con deduplicación independiente. El snapshot queda persistido hasta
que todas las partes sean aceptadas, sin truncar ni perder eventos posteriores.

## Uso

```bash
cp .env.example .env   # api key del gateway, destinatarios, hora del digest
npm ci && npm run build
pm2 start ecosystem.config.cjs && pm2 save
```

Estado local en `state.json` (contadores del digest, inventario docker). Sin base de datos.

Inventario de contenedores esperados:

```bash
npm run inventory -- list
npm run inventory -- add jellyfin
npm run inventory -- forget jellyfin  # pide confirmación; --yes para automatización
```

Los contenedores en ejecución se aprenden automáticamente al arrancar Atalaya y ante cada
evento Docker `start`. Un stop ordenado no los olvida; `forget` se usa solo para retiros
definitivos. Si un contenedor olvidado vuelve a arrancar, se agrega otra vez.

```bash
npm test   # reglas de adapters, dispatcher, digest y contrato con el gateway
```

## Respuestas del gateway

- `2xx queued` y una deduplicación legítima confirman aceptación.
- `2xx suppressed` sin deduplicación no se contabiliza como aceptación.
- `429` indica que la protección de capacidad rechazó una alerta no crítica; no se reintenta.
- `503` en una alerta crítica admite hasta tres intentos totales, respetando `Retry-After`
  con un máximo de cinco minutos por espera.

El gateway conserva las solicitudes y deliveries suprimidas o fallidas para auditoría;
"rechazada" en el digest significa que no fue aceptada para envío, no que el incidente se
haya borrado del registro.
