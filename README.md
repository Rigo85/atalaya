# atalaya

Observador de infraestructura. Escucha docker y pm2, clasifica eventos y los envía
al [notification-gateway](https://github.com/Rigo85/notification-gateway) como SMS.

## Clases de evento

| Clase | Acción |
|---|---|
| crítico | SMS inmediato (contenedor caído >90 s, OOM, proceso pm2 errored, bucle de reinicios) |
| advertencia | SMS con dedup (reinicio solo, unhealthy) — el gateway agrupa repeticiones |
| info | contador local → digest diario |

El **digest diario** (hora configurable) se envía siempre, aunque diga "sin novedades":
hace de heartbeat — si un día no llega, el host está mal.

## Adapters (F1)

- **docker-events**: stream del socket de Docker. `die` con exit ≠ 0 abre una gracia de
  90 s: si el contenedor no vuelve → crítico; si vuelve → advertencia. Stop ordenado
  (exit 0) solo cuenta en el digest. Mantiene un inventario de contenedores esperados.
- **pm2-bus**: eventos del daemon PM2 local. Restart suelto → advertencia; ≥3 en
  10 min → crítico (bucle); `errored`/`restart overlimit` → crítico.

## Uso

```bash
cp .env.example .env   # api key del gateway, destinatarios, hora del digest
npm ci && npm run build
pm2 start ecosystem.config.cjs && pm2 save
```

Estado local en `state.json` (contadores del digest, inventario docker). Sin base de datos.

```bash
npm test   # 13 tests (reglas de adapters, dispatcher, digest)
```
