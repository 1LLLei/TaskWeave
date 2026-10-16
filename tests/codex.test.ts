import { it, expect } from 'vitest';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexExecutor, generatePlan } from '../packages/adapters/src/codex';
import type { ExecutionEvent } from '../packages/core/src/controller';
const options = {
  executable: resolve('tests/fake-codex.mjs'),
  workspace: process.cwd(),
  approve: async () => false,
};
const task = (instruction = 'Test') => ({
  id: randomUUID(),
  orderIndex: 0,
  title: 'Test',
  instruction,
  acceptanceCriteria: [{ type: 'manual' as const, description: 'Inspect' }],
});
it('maps real JSONL transport, correlates threads and only exposes reasoning summary', async () => {
  const executor = new CodexExecutor(options);
  const events: ExecutionEvent[] = [];
  for await (const event of executor.execute(
    task(),
    new AbortController().signal,
  ))
    events.push(event);
  expect(events.some((e) => e.type === 'succeeded')).toBe(true);
  expect(
    events.some((e) => e.type === 'reference' && e.turnId === 'turn-1'),
  ).toBe(true);
  expect(JSON.stringify(events)).toContain('Public summary');
  expect(JSON.stringify(events)).not.toContain('HIDDEN_CONTENT');
  expect(JSON.stringify(events)).not.toContain('SHOULD_NOT_APPEAR');
});
it('interrupts the active turn and waits for confirmed interrupted status', async () => {
  const executor = new CodexExecutor(options),
    abort = new AbortController(),
    events: ExecutionEvent[] = [];
  for await (const event of executor.execute(
    task('WAIT_FOR_CANCEL'),
    abort.signal,
  )) {
    events.push(event);
    if (event.type === 'reference' && event.turnId) abort.abort();
  }
  expect(events.at(-1)?.type).toBe('cancelled');
});
it('does not grant command approval when the host declines', async () => {
  let approvals = 0;
  const executor = new CodexExecutor({
    ...options,
    approve: async () => {
      approvals++;
      return false;
    },
  });
  const events: ExecutionEvent[] = [];
  for await (const event of executor.execute(
    task('REQUEST_APPROVAL'),
    new AbortController().signal,
  ))
    events.push(event);
  expect(approvals).toBe(1);
  expect(events.at(-1)?.type).toBe('failed');
});
it('generates validated structured plans with manual criteria by default', async () => {
  const tasks = await generatePlan(
    options,
    'Build an API',
    new AbortController().signal,
  );
  expect(tasks).toHaveLength(1);
  expect(tasks[0].title).toBe('Inspect requirements');
  expect(tasks[0].acceptanceCriteria[0].type).toBe('manual');
  expect(tasks[0].id).toMatch(/^[a-f0-9-]{36}$/);
});
