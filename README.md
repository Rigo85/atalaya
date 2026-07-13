# atalaya

Observador de infraestructura. Escucha docker y pm2, clasifica eventos y los envía
al [notification-gateway](https://github.com/Rigo85/notification-gateway) como SMS.

## Clases de evento

| Clase | Acción |
|---|---|
| crítico | SMS inmediato (contenedor caído >90 s, OOM, proceso pm2 errored, bucle de reinicios) |
| advertencia | SMS con dedup (reinicio solo, unhealthy); el gateway suprime repeticiones y las contabiliza |
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
- **pm2-bus**: eventos del daemon PM2 local. Restart suelto → advertencia; ≥3 en
  10 min → crítico (bucle); `errored`/`restart overlimit` → crítico. Instrumenta la
  reconexión nativa del socket PM2 sin abrir una segunda suscripción.

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
