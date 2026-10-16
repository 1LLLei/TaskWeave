import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  unlink,
  realpath,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, type State, TasksSchema } from './model';
export interface Store {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}
export class FileStore implements Store {
  private queue: Promise<void> = Promise.resolve();
  private lock?: Awaited<ReturnType<typeof open>>;
  constructor(readonly directory: string) {}
  async acquire(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, 'writer.lock');
    try {
      this.lock = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Serialize stale-lock recovery so two recovering hosts cannot unlink each other's lock.
      const recoveryPath = join(this.directory, 'recovery.lock');
      let recovery;
      try {
        recovery = await open(recoveryPath, 'wx', 0o600);
      } catch {
        throw new Error(
          '另一个实例正在恢复存储锁；若持续出现，请检查 recovery.lock',
        );
      }
      try {
        const pid = Number(await readFile(path, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error(
            '任务存储锁无法识别，请先确认没有其他 TaskWeave 实例',
          );
        let dead = false;
        try {
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') dead = true;
          else throw e;
        }
        if (!dead)
          throw new Error('该工作区已有 TaskWeave 实例，请先关闭另一窗口');
        await unlink(path);
        this.lock = await open(path, 'wx', 0o600);
      } finally {
        await recovery.close();
        await unlink(recoveryPath);
      }
    }
    try {
      await this.lock.writeFile(String(process.pid));
    } catch (e) {
      await this.lock.close();
      this.lock = undefined;
      await unlink(path);
      throw e;
    }
  }
  async release() {
    await this.queue.catch(() => {});
    if (this.lock) {
      await this.lock.close();
      await unlink(join(this.directory, 'writer.lock'));
      this.lock = undefined;
    }
  }
  async load(): Promise<State> {
    let value: string;
    try {
      value = await readFile(join(this.directory, 'state.json'), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw e;
    }
    const s = JSON.parse(value) as State;
    if (
      s.schemaVersion !== 1 ||
      !Array.isArray(s.revisions) ||
      !Array.isArray(s.runs) ||
      !Array.isArray(s.events) ||
      !Number.isSafeInteger(s.sequence)
    )
      throw new Error('任务记录格式不受支持，请保留文件并检查');
    for (const r of s.revisions) TasksSchema.parse(r.tasks);
    return s;
  }
  save(state: State): Promise<void> {
    const data = JSON.stringify(state, null, 2);
    const write = async () => {
      await mkdir(this.directory, { recursive: true });
      const temp = join(this.directory, `state.${randomUUID()}.tmp`);
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, join(this.directory, 'state.json'));
    };
    const next = this.queue.then(write);
    this.queue = next.catch(() => {});
    return next;
  }
}
export async function workspaceIdentity(path: string) {
  return realpath(path);
}
