import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { TaskDefinition, Evidence } from './model';
export interface CommandSpec {
  executable: string;
  args: string[];
  timeoutMs?: number;
}
export type CommandRegistry = Record<string, CommandSpec>;
export type CommandApproval = (
  id: string,
  spec: CommandSpec,
) => Promise<boolean>;
export class AcceptanceEngine {
  constructor(
    private workspace: string,
    private registry: CommandRegistry = {},
    private approve: CommandApproval = async () => false,
  ) {}
  async verify(
    task: TaskDefinition,
    signal: AbortSignal,
  ): Promise<{ evidence: Evidence[]; manual: boolean }> {
    const evidence: Evidence[] = [];
    let manual = false;
    for (const c of task.acceptanceCriteria) {
      if (signal.aborted) throw new Error('验收已取消');
      if (c.type === 'manual') {
        manual = true;
        continue;
      }
      let passed = false,
        description = '';
      try {
        if (c.type === 'file_exists') {
          if (isAbsolute(c.path)) throw new Error('产物必须使用工作区相对路径');
          const root = await realpath(this.workspace),
            path = await realpath(resolve(root, c.path));
          const rel = relative(root, path);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            throw new Error('产物路径超出工作区');
          passed = (await stat(path)).isFile();
          description = `文件检查：${c.path}`;
        } else {
          const spec = this.registry[c.commandId];
          if (!spec) throw new Error(`未注册的验收命令：${c.commandId}`);
          if (!(await this.approve(c.commandId, spec)))
            throw new Error('验收命令未获授权');
          if (signal.aborted) throw new Error('验收已取消');
          const result = await runCommand(spec, this.workspace, signal);
          passed = result.code === 0;
          description = `命令 ${c.commandId}，退出码 ${result.code}\n${result.output}`;
        }
      } catch (e) {
        description = e instanceof Error ? e.message : String(e);
      }
      evidence.push({
        source: 'verification',
        description,
        passed,
        at: new Date().toISOString(),
      });
      if (!passed) break;
    }
    return { evidence, manual };
  }
}
function runCommand(
  spec: CommandSpec,
  cwd: string,
  signal: AbortSignal,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('验收已取消'));
      return;
    }
    const child = spawn(spec.executable, spec.args, {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      timedOut = false;
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.min(spec.timeoutMs ?? 120000, 600000),
    );
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (b) => (output = (output + b).slice(-12000)));
    child.stderr.on('data', (b) => (output = (output + b).slice(-12000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (timedOut || signal.aborted)
        reject(new Error(timedOut ? '验收命令超时' : '验收已取消'));
      else resolve({ code, output });
    });
  });
}
