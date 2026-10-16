import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Controller,
  type Executor,
  type ExecutionEvent,
} from '../packages/core/src/controller';
import { AcceptanceEngine } from '../packages/core/src/acceptance';
import {
  emptyState,
  revision,
  type State,
  type TaskDefinition,
} from '../packages/core/src/model';
import { FileStore, type Store } from '../packages/core/src/store';
class MemoryStore implements Store {
  state = emptyState();
  async load() {
    return structuredClone(this.state);
  }
  async save(s: State) {
    this.state = structuredClone(s);
  }
}
function task(
  title: string,
  criteria: TaskDefinition['acceptanceCriteria'] = [
    { type: 'file_exists', path: 'result.txt' },
  ],
): TaskDefinition {
  return {
    id: randomUUID(),
    orderIndex: 0,
    title,
    instruction: `Execute ${title}`,
    acceptanceCriteria: criteria,
  };
}
function executor(
  outcome: 'succeeded' | 'failed' | 'unknown' = 'succeeded',
  seen: string[] = [],
): Executor {
  return {
    async *execute(t) {
      seen.push(t.id);
      yield { type: 'reference', threadId: 'thread', turnId: 'turn' };
      yield { type: outcome, text: 'model says complete' };
    },
  };
}
async function fixture(exec = executor()) {
  const directory = await mkdtemp(join(tmpdir(), 'taskweave-test-'));
  await writeFile(join(directory, 'result.txt'), 'ok');
  const store = new MemoryStore();
  const controller = new Controller(
    store,
    exec,
    new AcceptanceEngine(directory),
  );
  await controller.initialize();
  return { directory, store, controller };
}
describe('plan revisions', () => {
  it('normalizes order, retains stable IDs and rejects empty/duplicate tasks', () => {
    const a = task('A'),
      b = task('B');
    const p = revision([a, b], 'request');
    const next = revision([b, a], 'request', p);
    expect(next.tasks.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(next.tasks.map((t) => t.orderIndex)).toEqual([0, 1]);
    expect(next.planId).toBe(p.planId);
    expect(next.version).toBe(2);
    expect(next.contentHash).not.toBe(p.contentHash);
    expect(p.tasks[0].id).toBe(a.id);
    expect(() => revision([], '')).toThrow();
    expect(() => revision([a, a], '')).toThrow();
    expect(() => revision([{ ...a, instruction: ' ' }], '')).toThrow();
  });
});
describe('verified serial execution', () => {
  it('runs three real file checks sequentially and deduplicates GO', async () => {
    const seen: string[] = [];
    const { controller: c, directory } = await fixture(
      executor('succeeded', seen),
    );
    try {
      const tasks = [task('A'), task('B'), task('C')],
        p = await c.savePlan(tasks, 'requirement'),
        key = randomUUID();
      const r = await c.start(p.id, key);
      await c.settled();
      expect((await c.start(p.id, key)).id).toBe(r.id);
      expect(c.state.runs).toHaveLength(1);
      expect(seen).toEqual(tasks.map((t) => t.id));
      expect(r.status).toBe('completed');
      expect(r.tasks.every((t) => t.status === 'completed')).toBe(true);
      expect(r.tasks[0].attempts[0].turnId).toBe('turn');
      expect(r.tasks[0].attempts[0].evidence[0].source).toBe('verification');
      expect(new Set(c.state.events.map((e) => e.sequence)).size).toBe(
        c.state.events.length,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('does not mark model success as complete when verification fails; stops C', async () => {
    const seen: string[] = [];
    const { controller: c, directory } = await fixture(
      executor('succeeded', seen),
    );
    try {
      const a = task('A'),
        b = task('B', [{ type: 'file_exists', path: 'missing.txt' }]),
        last = task('C');
      const p = await c.savePlan([a, b, last], 'test');
      const r = await c.start(p.id, randomUUID());
      await c.settled();
      expect(r.status).toBe('failed');
      expect(r.tasks.map((t) => t.status)).toEqual([
        'completed',
        'failed',
        'pending',
      ]);
      expect(seen).toEqual([a.id, b.id]);
      expect(r.tasks[1].attempts[0].evidence[0].passed).toBe(false);
      await writeFile(join(directory, 'missing.txt'), 'fixed');
      await c.retry(r.id);
      await c.settled();
      expect(r.status).toBe('completed');
      expect(r.tasks[1].attempts).toHaveLength(2);
      expect(r.tasks[0].attempts).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('requires manual confirmation before dispatching the next task', async () => {
    const { controller: c, directory } = await fixture();
    try {
      const a = task('Manual', [
        { type: 'manual', description: 'Inspect result' },
      ]);
      const p = await c.savePlan([a, task('B')], 'test');
      const r = await c.start(p.id, randomUUID());
      await c.settled();
      expect(r.status).toBe('paused');
      expect(r.tasks[0].status).toBe('verifying');
      expect(r.tasks[1].attempts).toHaveLength(0);
      await expect(c.savePlan([task('X')], 'test')).rejects.toThrow();
      await c.confirm(r.id, a.id, true);
      await c.settled();
      expect(r.status).toBe('completed');
      expect(r.tasks[0].attempts[0].evidence[0].source).toBe('manual');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('blocks unsaved edits and stale revisions', async () => {
    const { controller: c, directory } = await fixture();
    try {
      const p = await c.savePlan([task('A')], 'test');
      c.setEditing(true);
      await expect(c.start(p.id, randomUUID())).rejects.toThrow('保存');
      const p2 = await c.savePlan(p.tasks, 'test', p.id);
      await expect(c.start(p.id, randomUUID())).rejects.toThrow('过期');
      await expect(c.savePlan(p2.tasks, 'test', p2.id)).rejects.toThrow(
        '编辑模式',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('does not retry unknown execution; restart never greens an active task', async () => {
    const {
      controller: c,
      store,
      directory,
    } = await fixture(executor('unknown'));
    try {
      const p = await c.savePlan([task('A')], 'test');
      const r = await c.start(p.id, randomUUID());
      await c.settled();
      expect(r.status).toBe('unknown');
      await expect(c.retry(r.id)).rejects.toThrow();
      await expect(c.start(p.id, randomUUID())).rejects.toThrow();
      await c.resolveUnknown(r.id);
      expect(r.tasks[0].status).toBe('unknown');
      store.state.runs[0].status = 'running';
      store.state.runs[0].tasks[0].status = 'running';
      const restored = new Controller(
        store,
        executor(),
        new AcceptanceEngine(directory),
      );
      await restored.initialize();
      expect(restored.state.runs[0].status).toBe('unknown');
      expect(restored.state.runs[0].tasks[0].status).toBe('unknown');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('waits for the executor to confirm cancellation', async () => {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const exec: Executor = {
      async *execute(_t, signal): AsyncIterable<ExecutionEvent> {
        started();
        await new Promise<void>((r) =>
          signal.addEventListener('abort', () => r(), { once: true }),
        );
        yield { type: 'cancelled', text: 'interrupted' };
      },
    };
    const { controller: c, directory } = await fixture(exec);
    try {
      const p = await c.savePlan([task('A'), task('B')], 'test');
      const r = await c.start(p.id, randomUUID());
      await ready;
      await c.cancel(r.id);
      expect(r.cancelRequested).toBe(true);
      await c.settled();
      expect(r.status).toBe('cancelled');
      expect(r.tasks[1].attempts).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('fails closed on persistence failure', async () => {
    const store = new MemoryStore();
    const c = new Controller(store, executor(), new AcceptanceEngine(tmpdir()));
    await c.initialize();
    store.save = async () => {
      throw new Error('disk full');
    };
    await expect(c.savePlan([task('A')], 'x')).rejects.toThrow('disk full');
    expect(c.fatalError).toContain('disk full');
    await expect(
      c.start(c.state.revisions[0].id, randomUUID()),
    ).rejects.toThrow('保存');
  });
});
describe('acceptance boundaries', () => {
  it('rejects symlink escapes and directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskweave-path-')),
      outside = await mkdtemp(join(tmpdir(), 'taskweave-out-'));
    try {
      await writeFile(join(outside, 'secret'), 'no');
      await symlink(join(outside, 'secret'), join(root, 'escape'));
      const engine = new AcceptanceEngine(root);
      const r = await engine.verify(
        task('unsafe', [{ type: 'file_exists', path: 'escape' }]),
        new AbortController().signal,
      );
      expect(r.evidence[0].passed).toBe(false);
      expect(r.evidence[0].description).toContain('超出');
      const d = await engine.verify(
        task('dir', [{ type: 'file_exists', path: '.' }]),
        new AbortController().signal,
      );
      expect(d.evidence[0].passed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it('runs registered commands only after explicit approval and preserves failure exit code', async () => {
    const engine = new AcceptanceEngine(
      tmpdir(),
      {
        test: { executable: process.execPath, args: ['-e', 'process.exit(7)'] },
      },
      async () => true,
    );
    const r = await engine.verify(
      task('command', [{ type: 'command', commandId: 'test' }]),
      new AbortController().signal,
    );
    expect(r.evidence[0].passed).toBe(false);
    expect(r.evidence[0].description).toContain('7');
    const deny = new AcceptanceEngine(tmpdir(), {
      test: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
    });
    expect(
      (
        await deny.verify(
          task('deny', [{ type: 'command', commandId: 'test' }]),
          new AbortController().signal,
        )
      ).evidence[0].passed,
    ).toBe(false);
  });
});
describe('disk persistence', () => {
  it('atomically saves and restores state and prevents a second writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskweave-store-'));
    const first = new FileStore(dir),
      second = new FileStore(dir);
    try {
      await first.acquire();
      await expect(second.acquire()).rejects.toThrow('已有');
      const state = emptyState();
      state.revisions.push(revision([task('A')], 'req'));
      await Promise.all([
        first.save(state),
        first.save({ ...state, sequence: 1 }),
      ]);
      expect((await first.load()).sequence).toBe(1);
      expect(
        JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).revisions[0]
          .tasks[0].title,
      ).toBe('A');
      await first.release();
      await second.acquire();
      await second.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('redacts credential-shaped output before persisting logs and evidence', async () => {
  const secret = 'sk-' + 'a'.repeat(24);
  const exec: Executor = {
    async *execute() {
      yield { type: 'activity', text: `token=${secret}` };
      yield { type: 'succeeded', text: 'done' };
    },
  };
  const { controller: c, store, directory } = await fixture(exec);
  try {
    const p = await c.savePlan([task('Check')], 'request');
    await c.start(p.id, randomUUID());
    await c.settled();
    expect(JSON.stringify(store.state.events)).not.toContain(secret);
    expect(store.state.events.some((e) => e.text.includes('[已隐藏]'))).toBe(
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
