import { randomUUID } from 'node:crypto';
import {
  type State,
  type TaskDefinition,
  type Attempt,
  type Run,
  revision,
  errorText,
  redactLog,
} from './model';
import type { Store } from './store';
import { AcceptanceEngine } from './acceptance';
export type ExecutionEvent =
  | { type: 'activity'; text: string; kind?: string }
  | { type: 'reference'; threadId: string; turnId?: string }
  | { type: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; text: string };
export interface Executor {
  execute(
    task: TaskDefinition,
    signal: AbortSignal,
  ): AsyncIterable<ExecutionEvent>;
  dispose?(): void;
}
export class Controller {
  state!: State;
  private busy = false;
  private driver?: Promise<void>;
  private abort?: AbortController;
  private listeners = new Set<() => void>();
  private editing = false;
  fatalError?: string;
  constructor(
    private store: Store,
    private executor: Executor,
    private acceptance: AcceptanceEngine,
  ) {}
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private async persist() {
    try {
      await this.store.save(this.state);
    } catch (e) {
      this.fatalError = `无法保存任务状态：${errorText(e)}`;
      this.abort?.abort();
      throw e;
    } finally {
      for (const fn of this.listeners) fn();
    }
  }
  async initialize() {
    this.state = await this.store.load();
    for (const run of this.state.runs) {
      if (run.status === 'running' || run.status === 'paused') {
        run.status = 'unknown';
        for (const t of run.tasks)
          if (t.status === 'running' || t.status === 'verifying') {
            t.status = 'unknown';
            const a = t.attempts.at(-1);
            if (a) a.status = 'unknown';
          }
      }
    }
    await this.persist();
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.busy) throw new Error('操作处理中，请稍候');
    if (this.fatalError) throw new Error(this.fatalError);
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  private assertIdle() {
    if (
      this.driver ||
      this.state.runs.some(
        (r) =>
          r.status === 'running' ||
          r.status === 'paused' ||
          r.status === 'unknown',
      )
    )
      throw new Error('已有运行中或状态待确认的任务，请先处理当前运行');
  }
  setEditing(value: boolean) {
    this.assertIdle();
    this.editing = value;
  }
  async savePlan(
    tasks: unknown,
    requirement: string,
    expectedRevisionId?: string,
  ) {
    return this.exclusive(async () => {
      this.assertIdle();
      if (expectedRevisionId && !this.editing)
        throw new Error('请先进入编辑模式');
      if (!expectedRevisionId && this.editing)
        throw new Error('请先保存或取消编辑');
      const old = this.state.revisions.at(-1);
      if (expectedRevisionId && old?.id !== expectedRevisionId)
        throw new Error('计划版本已变化，请刷新');
      const next = revision(
        tasks,
        requirement,
        expectedRevisionId ? old : undefined,
      );
      this.state.revisions.push(next);
      this.editing = false;
      await this.persist();
      return next;
    });
  }
  async start(revisionId: string, key: string): Promise<Run> {
    return this.exclusive(async () => {
      const existing = this.state.runs.find((r) => r.idempotencyKey === key);
      if (existing) {
        if (existing.revisionId !== revisionId)
          throw new Error('启动标识与计划版本冲突');
        return existing;
      }
      if (this.editing) throw new Error('请先保存或取消编辑');
      this.assertIdle();
      const plan = this.state.revisions.at(-1);
      if (!plan || plan.id !== revisionId) throw new Error('计划版本已过期');
      const run: Run = {
        id: randomUUID(),
        revisionId,
        idempotencyKey: key,
        status: 'running',
        createdAt: new Date().toISOString(),
        tasks: plan.tasks.map((t) => ({
          taskId: t.id,
          status: 'pending',
          attempts: [],
        })),
      };
      this.state.runs.push(run);
      await this.persist();
      this.launch(run);
      return run;
    });
  }
  private launch(run: Run) {
    this.abort = new AbortController();
    this.driver = this.drive(run, this.abort.signal)
      .catch(async (e) => {
        run.status = 'unknown';
        for (const t of run.tasks)
          if (t.status === 'running' || t.status === 'verifying') {
            t.status = 'unknown';
            const a = t.attempts.at(-1);
            if (a) {
              a.status = 'unknown';
              a.error = redactLog(errorText(e));
            }
          }
        try {
          await this.persist();
        } catch {
          /* fatalError is exposed to host */
        }
      })
      .finally(() => {
        this.driver = undefined;
        this.abort = undefined;
        for (const fn of this.listeners) fn();
      });
  }
  private log(
    run: Run,
    taskId: string,
    attempt: Attempt,
    kind: string,
    text: string,
  ) {
    this.state.events.push({
      id: randomUUID(),
      runId: run.id,
      taskId,
      attemptId: attempt.id,
      sequence: ++this.state.sequence,
      at: new Date().toISOString(),
      kind,
      text: redactLog(text).slice(-16000),
    });
    if (this.state.events.length > 1000)
      this.state.events.splice(0, this.state.events.length - 1000);
  }
  private async drive(run: Run, signal: AbortSignal) {
    const plan = this.state.revisions.find((p) => p.id === run.revisionId)!;
    for (const taskRun of run.tasks) {
      if (taskRun.status === 'completed') continue;
      if (signal.aborted) {
        run.status = 'cancelled';
        taskRun.status = 'cancelled';
        await this.persist();
        return;
      }
      const task = plan.tasks.find((t) => t.id === taskRun.taskId)!;
      const attempt: Attempt = {
        id: randomUUID(),
        attemptNo: taskRun.attempts.length + 1,
        status: 'running',
        evidence: [],
      };
      taskRun.attempts.push(attempt);
      taskRun.status = 'running';
      this.log(run, task.id, attempt, 'started', task.title);
      await this.persist();
      let outcome = 'unknown',
        message = '执行器未返回明确终态';
      for await (const event of this.executor.execute(task, signal)) {
        if (event.type === 'reference') {
          attempt.threadId = event.threadId;
          attempt.turnId = event.turnId;
        } else if (event.type === 'activity')
          this.log(run, task.id, attempt, event.kind ?? 'activity', event.text);
        else {
          outcome = event.type;
          message = event.text;
        }
        await this.persist();
      }
      if (outcome !== 'succeeded') {
        const status =
          outcome === 'failed'
            ? 'failed'
            : outcome === 'cancelled'
              ? 'cancelled'
              : 'unknown';
        attempt.status = taskRun.status = status;
        attempt.error = redactLog(message);
        run.status = status;
        this.log(run, task.id, attempt, status, message);
        await this.persist();
        return;
      }
      if (signal.aborted) {
        attempt.status = taskRun.status = 'cancelled';
        run.status = 'cancelled';
        await this.persist();
        return;
      }
      attempt.status = taskRun.status = 'verifying';
      await this.persist();
      const result = await this.acceptance.verify(task, signal);
      attempt.evidence = result.evidence.map((e) => ({
        ...e,
        description: redactLog(e.description),
      }));
      if (signal.aborted) {
        attempt.status = taskRun.status = 'cancelled';
        run.status = 'cancelled';
        await this.persist();
        return;
      }
      if (result.evidence.some((e) => !e.passed)) {
        attempt.status = taskRun.status = 'failed';
        run.status = 'failed';
        attempt.error = '验收未通过';
        this.log(run, task.id, attempt, 'failed', '执行结束，但验收未通过');
        await this.persist();
        return;
      }
      if (result.manual) {
        run.status = 'paused';
        this.log(run, task.id, attempt, 'verification', '等待人工验收确认');
        await this.persist();
        return;
      }
      attempt.status = taskRun.status = 'completed';
      this.log(run, task.id, attempt, 'completed', '验收通过');
      await this.persist();
    }
    run.status = 'completed';
    await this.persist();
  }
  async confirm(runId: string, taskId: string, passed: boolean) {
    return this.exclusive(async () => {
      if (this.driver) throw new Error('状态更新中，请稍候');
      const run = this.state.runs.find((r) => r.id === runId),
        t = run?.tasks.find((t) => t.taskId === taskId),
        a = t?.attempts.at(-1);
      if (
        !run ||
        run.status !== 'paused' ||
        !t ||
        t.status !== 'verifying' ||
        !a
      )
        throw new Error('当前任务无需人工确认');
      a.evidence.push({
        source: 'manual',
        description: passed ? '用户确认验收通过' : '用户拒绝验收',
        passed,
        at: new Date().toISOString(),
      });
      a.status = t.status = passed ? 'completed' : 'failed';
      run.status = passed ? 'running' : 'failed';
      this.log(run, t.taskId, a, passed ? 'completed' : 'failed', '人工验收');
      await this.persist();
      if (passed) this.launch(run);
    });
  }
  async retry(runId: string) {
    return this.exclusive(async () => {
      this.assertIdle();
      const run = this.state.runs.find((r) => r.id === runId);
      if (!run || run.status !== 'failed')
        throw new Error('仅可重试已明确失败的运行');
      run.status = 'running';
      run.cancelRequested = false;
      await this.persist();
      this.launch(run);
    });
  }
  async cancel(runId: string) {
    return this.exclusive(async () => {
      const run = this.state.runs.find((r) => r.id === runId);
      if (!run || !['running', 'paused'].includes(run.status))
        throw new Error('当前运行无法取消');
      if (this.driver) {
        run.cancelRequested = true;
        this.abort?.abort();
        await this.persist();
      } else {
        run.status = 'cancelled';
        for (const t of run.tasks)
          if (t.status === 'pending' || t.status === 'verifying') {
            t.status = 'cancelled';
            const a = t.attempts.at(-1);
            if (a) a.status = 'cancelled';
          }
        await this.persist();
      }
    });
  }
  async resolveUnknown(runId: string) {
    return this.exclusive(async () => {
      if (this.driver) throw new Error('执行器仍在运行');
      const run = this.state.runs.find((r) => r.id === runId);
      if (run?.status !== 'unknown') throw new Error('运行状态不是待确认');
      run.status = 'cancelled';
      this.state.events.push({
        id: randomUUID(),
        runId,
        taskId: '',
        attemptId: '',
        sequence: ++this.state.sequence,
        at: new Date().toISOString(),
        kind: 'manual',
        text: '用户确认执行器已停止，归档未知运行；未验证任务不标记完成',
      });
      await this.persist();
    });
  }
  async settled() {
    await this.driver;
  }
  dispose() {
    this.abort?.abort();
    this.executor.dispose?.();
  }
}
