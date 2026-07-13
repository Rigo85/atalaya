import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { StateStore } from './state.js';

type Write = (line: string) => void;
type Confirm = (question: string) => Promise<boolean>;

export async function runInventory(
  args: string[],
  state: StateStore,
  write: Write,
  confirm: Confirm,
): Promise<number> {
  const [command, name, ...flags] = args;
  if (command === 'list') {
    if (state.data.expectedContainers.length === 0) write('(inventario vacío)');
    else for (const container of state.data.expectedContainers) write(container);
    return 0;
  }
  if (command !== 'add' && command !== 'forget') {
    write('Uso: npm run inventory -- list | add <contenedor> | forget <contenedor> [--yes]');
    return 2;
  }
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    write('Nombre de contenedor inválido');
    return 2;
  }
  if (command === 'add') {
    const added = state.addExpectedContainer(name);
    write(added ? `${name}: agregado al inventario esperado` : `${name}: ya estaba en el inventario`);
    return 0;
  }

  if (!state.data.expectedContainers.includes(name)) {
    write(`${name}: no está en el inventario esperado`);
    return 1;
  }
  const accepted = flags.includes('--yes') || await confirm(
    `¿Olvidar ${name}? Si vuelve a arrancar, Atalaya lo agregará otra vez.`,
  );
  if (!accepted) {
    write('Operación cancelada');
    return 1;
  }
  state.removeExpectedContainer(name);
  write(`${name}: eliminado del inventario esperado`);
  return 0;
}

async function main(): Promise<void> {
  const state = new StateStore(process.env.STATE_PATH ?? 'state.json');
  const confirm: Confirm = async (question) => {
    if (!stdin.isTTY) return false;
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(`${question} [s/N] `);
      return /^s(i)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
  process.exitCode = await runInventory(
    process.argv.slice(2),
    state,
    (line) => console.log(line),
    confirm,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
