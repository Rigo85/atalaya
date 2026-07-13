import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

const recipients = (process.env.ALERT_RECIPIENTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (recipients.length === 0) throw new Error('ALERT_RECIPIENTS vacío: al menos un número');

export const config = {
  gatewayUrl: (process.env.GATEWAY_URL ?? 'http://localhost:8090').replace(/\/+$/, ''),
  apiKey: required('ATALAYA_API_KEY'),
  recipients,
  digestHour: Number(process.env.DIGEST_HOUR ?? 21),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  statePath: process.env.STATE_PATH ?? 'state.json',

  // reglas (constantes de diseño; a settings/env solo si hiciera falta ajustarlas)
  dockerSock: '/var/run/docker.sock',
  /** gracia antes de declarar caído un contenedor que murió con exit != 0 */
  downGraceMs: 90_000,
  /** tormenta de reinicios pm2: N reinicios en la ventana → crítico */
  stormCount: 3,
  stormWindowMs: 10 * 60_000,
  /** contenedores a ignorar (por subcadena del nombre) */
  dockerIgnore: (process.env.DOCKER_IGNORE ?? 'buildx').split(',').map((s) => s.trim()).filter(Boolean),
};
