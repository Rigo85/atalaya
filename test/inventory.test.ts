import { describe, expect, it } from 'vitest';
import { runInventory } from '../src/inventory-cli.js';
import { tempState } from './helpers.js';

describe('inventory CLI', () => {
  it('list/add son idempotentes y ordenados', async () => {
    const state = tempState();
    const lines: string[] = [];
    const confirm = async () => true;
    expect(await runInventory(['add', 'zeta'], state, (line) => lines.push(line), confirm)).toBe(0);
    expect(await runInventory(['add', 'alpha'], state, (line) => lines.push(line), confirm)).toBe(0);
    expect(await runInventory(['add', 'zeta'], state, (line) => lines.push(line), confirm)).toBe(0);
    lines.length = 0;
    expect(await runInventory(['list'], state, (line) => lines.push(line), confirm)).toBe(0);
    expect(lines).toEqual(['alpha', 'zeta']);
  });

  it('forget exige confirmación y no modifica al cancelar', async () => {
    const state = tempState();
    state.addExpectedContainer('jellyfin');
    const lines: string[] = [];
    expect(await runInventory(['forget', 'jellyfin'], state, (line) => lines.push(line), async () => false)).toBe(1);
    expect(state.data.expectedContainers).toContain('jellyfin');
    expect(await runInventory(['forget', 'jellyfin', '--yes'], state, (line) => lines.push(line), async () => false)).toBe(0);
    expect(state.data.expectedContainers).not.toContain('jellyfin');
  });
});
