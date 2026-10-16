import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  State,
  TaskDefinition,
  Run,
  PlanRevision,
  Criterion,
} from '../../core/src/model';
import './style.css';
declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
  getState: () => any;
  setState: (state: unknown) => void;
};
const host = acquireVsCodeApi();
const labels: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  verifying: '验收中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态待确认',
  paused: '等待人工验收',
};
const symbols: Record<string, string> = {
  pending: '○',
  running: '◌',
  verifying: '◈',
  completed: '✓',
  failed: '!',
  cancelled: '−',
  unknown: '?',
};
type Snapshot = {
  state: State;
  workspace?: string;
  planning?: boolean;
  fatalError?: string;
  commandIds: string[];
};
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [requirement, setRequirement] = useState(
      host.getState()?.requirement ?? '',
    ),
    [editing, setEditing] = useState(false),
    [draft, setDraft] = useState<TaskDefinition[]>([]),
    [selected, setSelected] = useState(''),
    [showTasks, setShowTasks] = useState(true);
  const requests = useRef(
    new Map<string, { resolve: () => void; reject: (error: Error) => void }>(),
  );
  const key = useRef(crypto.randomUUID());
  const mounted = useRef(true);
  function send(type: string, payload?: unknown): Promise<void> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      requests.current.set(requestId, { resolve, reject });
      host.postMessage({
        type,
        requestId,
        ...(payload === undefined ? {} : { payload }),
      });
    });
  }
  async function action(fn: () => Promise<void>) {
    setPending(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const m = event.data;
      if (m.type === 'state') setSnapshot(m);
      if (m.type === 'response') {
        const p = requests.current.get(m.requestId);
        if (p) {
          requests.current.delete(m.requestId);
          m.error ? p.reject(new Error(m.error)) : p.resolve();
        }
      }
    };
    window.addEventListener('message', listener);
    void action(() => send('ready'));
    return () => {
      mounted.current = false;
      window.removeEventListener('message', listener);
    };
  }, []);
  useEffect(() => {
    host.setState({ requirement });
  }, [requirement]);
  const state = snapshot?.state;
  const plan = state?.revisions.at(-1);
  const run = state?.runs.find((r) => r.id === selected) ?? state?.runs.at(-1);
  const currentPlanRun = [...(state?.runs ?? [])]
    .reverse()
    .find((r) => r.revisionId === plan?.id);
  const runPlan = state?.revisions.find((p) => p.id === run?.revisionId);
  const active = state?.runs.some((r) =>
    ['running', 'paused', 'unknown'].includes(r.status),
  );
  const disabled =
    pending || snapshot?.planning || Boolean(snapshot?.fatalError);
  const narrow = document.body.dataset.view === 'tasks';
  function patch(id: string, change: Partial<TaskDefinition>) {
    setDraft((tasks) =>
      tasks.map((t) => (t.id === id ? { ...t, ...change } : t)),
    );
  }
  function insert(index: number) {
    const task: TaskDefinition = {
      id: crypto.randomUUID(),
      orderIndex: index,
      title: '新任务',
      instruction: '',
      acceptanceCriteria: [
        { type: 'manual', description: '检查本步交付物和验证结果' },
      ],
    };
    setDraft((tasks) => [
      ...tasks.slice(0, index),
      task,
      ...tasks.slice(index),
    ]);
  }
  function move(index: number, direction: number) {
    setDraft((tasks) => {
      const next = [...tasks];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      return next;
    });
  }
  const events = state?.events.filter((e) => e.runId === run?.id) ?? [];
  return (
    <div className={narrow ? 'app sidebar-only' : 'app'}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">✣</span>
          <strong>TaskWeave</strong>
          <span className="subtitle">轻量任务规划</span>
        </div>
        <span className="badge">本地 · Codex Managed</span>
      </header>
      {(error || snapshot?.fatalError) && (
        <div role="alert" className="error-banner">
          {snapshot?.fatalError ?? error}
          <button
            className="icon"
            aria-label="关闭提示"
            onClick={() => setError('')}
          >
            ×
          </button>
        </div>
      )}
      {!state && (
        <div className="empty">
          <p>正在读取工作区任务…</p>
          <button onClick={() => void action(() => send('ready'))}>
            重新连接
          </button>
        </div>
      )}
      {state && narrow && (
        <>
          <button
            className="wide"
            onClick={() => void action(() => send('open'))}
          >
            打开任务工作区 ↗
          </button>
          <TaskList
            run={run}
            plan={runPlan}
            disabled={disabled}
            send={(type, payload) => void action(() => send(type, payload))}
          />
        </>
      )}
      {state && !narrow && (
        <div className={showTasks ? 'layout' : 'layout no-sidebar'}>
          <main>
            <div className="project-line">
              <span>⌂ {snapshot?.workspace ?? '当前工作区'}</span>
              <button className="quiet" onClick={() => setShowTasks((v) => !v)}>
                {showTasks ? '收起任务栏' : '显示任务栏'}
              </button>
            </div>
            <section className="intro">
              <span className="eyebrow">PLAN BEFORE EXECUTION</span>
              <h1>先理清计划，再开始行动。</h1>
              <p>审查每一步，让执行过程和验收结果清晰可见。</p>
            </section>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  await send('generate', { requirement });
                  key.current = crypto.randomUUID();
                });
              }}
            >
              <label htmlFor="requirement">你想完成什么？</label>
              <textarea
                id="requirement"
                placeholder="例如：为项目增加登录功能，并补充测试和使用说明。"
                value={requirement}
                onChange={(e) => setRequirement(e.target.value)}
                maxLength={12000}
                rows={3}
                disabled={Boolean(active) || disabled}
              />
              <div className="composer-footer">
                <span>只读规划 · 执行前由你确认</span>
                <button
                  className="primary"
                  disabled={
                    disabled ||
                    Boolean(active) ||
                    editing ||
                    !requirement.trim()
                  }
                >
                  {snapshot?.planning ? '正在分析需求…' : '生成计划 ↗'}
                </button>
              </div>
            </form>
            {plan && (
              <section className="plan-card" aria-label="任务计划">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">
                      EXECUTION PLAN · V{plan.version}
                    </span>
                    <h2>{active ? '当前计划' : '审查任务计划'}</h2>
                  </div>
                  <span className="count">{plan.tasks.length} 个步骤</span>
                </div>
                <p className="muted">{plan.requirement}</p>
                {(active || currentPlanRun) && !editing ? (
                  <div className="collapsed-plan">
                    <p>
                      计划版本已冻结。执行活动与验收结果显示在下方和任务栏中。
                    </p>
                    {!active && (
                      <button
                        className="quiet"
                        disabled={disabled}
                        onClick={() =>
                          void action(async () => {
                            await send('edit');
                            setDraft(structuredClone(plan.tasks));
                            setEditing(true);
                          })
                        }
                      >
                        修改并创建新版本
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    {(editing ? draft : plan.tasks).map((task, index) => (
                      <React.Fragment key={task.id}>
                        {editing && (
                          <button
                            className="insert"
                            aria-label={`在第 ${index + 1} 项前插入任务`}
                            onClick={() => insert(index)}
                          >
                            ＋
                          </button>
                        )}
                        <div className="task-row">
                          <span className="number">{index + 1}</span>
                          <div className="task-content">
                            {editing ? (
                              <>
                                <input
                                  aria-label={`任务 ${index + 1} 名称`}
                                  value={task.title}
                                  maxLength={160}
                                  onChange={(e) =>
                                    patch(task.id, { title: e.target.value })
                                  }
                                />
                                <label className="field-label">
                                  执行指令
                                  <textarea
                                    aria-label={`任务 ${index + 1} 指令`}
                                    value={task.instruction}
                                    rows={3}
                                    maxLength={12000}
                                    onChange={(e) =>
                                      patch(task.id, {
                                        instruction: e.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <CriteriaEditor
                                  criteria={task.acceptanceCriteria}
                                  commandIds={snapshot?.commandIds ?? []}
                                  change={(criteria) =>
                                    patch(task.id, {
                                      acceptanceCriteria: criteria,
                                    })
                                  }
                                />
                              </>
                            ) : (
                              <details>
                                <summary>{task.title}</summary>
                                <p className="instruction">
                                  {task.instruction}
                                </p>
                                <div className="criteria-label">验收要求</div>
                                {task.acceptanceCriteria.map((c, i) => (
                                  <p className="criterion" key={i}>
                                    {criterionText(c)}
                                  </p>
                                ))}
                              </details>
                            )}
                          </div>
                          {editing && (
                            <div className="row-tools">
                              <button
                                className="icon"
                                aria-label="上移"
                                disabled={index === 0}
                                onClick={() => move(index, -1)}
                              >
                                ↑
                              </button>
                              <button
                                className="icon"
                                aria-label="下移"
                                disabled={index === draft.length - 1}
                                onClick={() => move(index, 1)}
                              >
                                ↓
                              </button>
                              <button
                                className="icon danger"
                                aria-label="删除任务"
                                disabled={draft.length === 1}
                                onClick={() =>
                                  setDraft((tasks) =>
                                    tasks.filter((t) => t.id !== task.id),
                                  )
                                }
                              >
                                ×
                              </button>
                            </div>
                          )}
                        </div>
                      </React.Fragment>
                    ))}
                    {editing && (
                      <button
                        className="insert"
                        aria-label="在末尾插入任务"
                        onClick={() => insert(draft.length)}
                      >
                        ＋
                      </button>
                    )}
                    <div className="plan-footer">
                      <span className="muted">
                        {editing
                          ? '保存后生成新版本，GO 暂不可用。'
                          : '确认计划后，将按顺序执行并逐项验收。'}
                      </span>
                      <div className="actions">
                        {editing ? (
                          <>
                            <button
                              disabled={disabled}
                              onClick={() =>
                                void action(async () => {
                                  await send('discard');
                                  setEditing(false);
                                })
                              }
                            >
                              Cancel
                            </button>
                            <button
                              className="primary"
                              disabled={disabled}
                              onClick={() =>
                                void action(async () => {
                                  await send('save', {
                                    tasks: draft.map((t, i) => ({
                                      ...t,
                                      orderIndex: i,
                                    })),
                                    expectedRevisionId: plan.id,
                                  });
                                  setEditing(false);
                                  key.current = crypto.randomUUID();
                                })
                              }
                            >
                              Save
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              disabled={disabled}
                              onClick={() =>
                                void action(async () => {
                                  await send('edit');
                                  setDraft(structuredClone(plan.tasks));
                                  setEditing(true);
                                })
                              }
                            >
                              ✎ Modify
                            </button>
                            <button
                              className="primary"
                              disabled={disabled}
                              onClick={() =>
                                void action(async () => {
                                  await send('start', {
                                    revisionId: plan.id,
                                    key: key.current,
                                  });
                                  setSelected('');
                                  setShowTasks(true);
                                })
                              }
                            >
                              ▶ GO
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </section>
            )}
            {run && (
              <section className="activity">
                <div className="section-heading">
                  <h2>执行活动</h2>
                  <select
                    aria-label="查看运行历史"
                    value={run.id}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {[...state.runs].reverse().map((r) => (
                      <option key={r.id} value={r.id}>
                        {new Date(r.createdAt).toLocaleString()} ·{' '}
                        {labels[r.status]}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="muted">
                  仅展示公开消息、工具活动和推理摘要。任务以验收结果为准。
                </p>
                {events.length === 0 ? (
                  <p className="muted">等待执行事件…</p>
                ) : (
                  events.slice(-150).map((event) => (
                    <article className="event" key={event.id}>
                      <div className="event-meta">
                        <span>
                          {runPlan?.tasks.find((t) => t.id === event.taskId)
                            ?.title ?? '运行记录'}{' '}
                          · {event.kind}
                        </span>
                        <time>{new Date(event.at).toLocaleTimeString()}</time>
                      </div>
                      <pre>{event.text}</pre>
                    </article>
                  ))
                )}
              </section>
            )}
            {!plan && (
              <div className="empty-guide">
                <div>① 审查与修改计划</div>
                <div>② 点击 GO 启动</div>
                <div>③ 依据验收追踪完成</div>
              </div>
            )}
            <footer className="footnote">
              GO
              审批当前计划；命令及额外权限仍需单独授权。首版通过显式入口规划，不拦截原生
              Codex 输入。
            </footer>
          </main>
          {showTasks && (
            <aside>
              <TaskList
                run={run}
                plan={runPlan}
                disabled={disabled}
                send={(type, payload) => void action(() => send(type, payload))}
              />
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
function criterionText(c: Criterion) {
  return c.type === 'manual'
    ? `人工确认：${c.description}`
    : c.type === 'file_exists'
      ? `文件检查：${c.path}`
      : `注册命令：${c.commandId}`;
}
function CriteriaEditor({
  criteria,
  commandIds,
  change,
}: {
  criteria: Criterion[];
  commandIds: string[];
  change: (criteria: Criterion[]) => void;
}) {
  const update = (index: number, c: Criterion) =>
    change(criteria.map((old, i) => (i === index ? c : old)));
  return (
    <div className="criteria-editor">
      <span className="field-label">验收要求（全部通过才可完成）</span>
      {criteria.map((c, i) => (
        <div className="criterion-input" key={i}>
          <select
            aria-label="验收类型"
            value={c.type}
            onChange={(e) =>
              update(
                i,
                e.target.value === 'manual'
                  ? { type: 'manual', description: '检查交付物与验证结果' }
                  : e.target.value === 'file_exists'
                    ? { type: 'file_exists', path: '' }
                    : { type: 'command', commandId: commandIds[0] ?? '' },
              )
            }
          >
            <option value="manual">人工确认</option>
            <option value="file_exists">文件存在</option>
            <option value="command" disabled={!commandIds.length}>
              注册命令
            </option>
          </select>
          {c.type === 'command' ? (
            <select
              aria-label="验收命令"
              value={c.commandId}
              onChange={(e) =>
                update(i, { type: 'command', commandId: e.target.value })
              }
            >
              {commandIds.map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          ) : (
            <input
              aria-label="验收内容"
              value={c.type === 'manual' ? c.description : c.path}
              placeholder={c.type === 'file_exists' ? '工作区相对文件路径' : ''}
              onChange={(e) =>
                update(
                  i,
                  c.type === 'manual'
                    ? { type: 'manual', description: e.target.value }
                    : { type: 'file_exists', path: e.target.value },
                )
              }
            />
          )}
          <button
            className="icon"
            aria-label="删除验收条件"
            disabled={criteria.length === 1}
            onClick={() => change(criteria.filter((_, n) => n !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="quiet"
        disabled={criteria.length >= 20}
        onClick={() =>
          change([...criteria, { type: 'manual', description: '检查交付物' }])
        }
      >
        ＋ 添加验收条件
      </button>
    </div>
  );
}
function TaskList({
  run,
  plan,
  disabled,
  send,
}: {
  run?: Run;
  plan?: PlanRevision;
  disabled?: boolean;
  send: (type: string, payload: unknown) => void;
}) {
  const completed =
      run?.tasks.filter((t) => t.status === 'completed').length ?? 0,
    total = run?.tasks.length ?? 0;
  return (
    <section className="task-list">
      <div className="section-heading">
        <h2>执行计划</h2>
        <span className="live-dot" />
      </div>
      <p className="muted">
        {run
          ? `${total} 个任务 · ${labels[run.status]}`
          : '确认计划后，在这里追踪进展'}
      </p>
      <div className="progress-line">
        <progress
          value={completed}
          max={total || 1}
          aria-label="已验收任务进度"
        />
        <span>
          {completed}/{total}
        </span>
      </div>
      {!run && (
        <div className="empty">
          <span className="empty-symbol">☷</span>
          <p>让每一步都有迹可循</p>
          <small>完成状态依据真实执行与验收记录。</small>
        </div>
      )}
      {run?.tasks.map((task, i) => {
        const definition = plan?.tasks.find((t) => t.id === task.taskId),
          attempt = task.attempts.at(-1);
        return (
          <article key={task.taskId} className={`run-task ${task.status}`}>
            <div className="run-task-heading">
              <span className={`status-icon ${task.status}`} aria-hidden="true">
                {symbols[task.status]}
              </span>
              <span className="small-number">{i + 1}</span>
              <strong>{definition?.title ?? '任务'}</strong>
            </div>
            <p className="status-description">
              {labels[task.status]}
              {attempt ? ` · 第 ${attempt.attemptNo} 次尝试` : ''}
            </p>
            {attempt?.error && <p className="task-error">{attempt.error}</p>}
            {task.status === 'verifying' && run.status === 'paused' && (
              <>
                <p className="muted">请检查交付物及以下人工验收要求：</p>
                {definition?.acceptanceCriteria
                  .filter((c) => c.type === 'manual')
                  .map((c, i) => (
                    <p className="criterion" key={i}>
                      {criterionText(c)}
                    </p>
                  ))}
                <div className="actions">
                  <button
                    disabled={disabled}
                    onClick={() =>
                      send('confirm', {
                        runId: run.id,
                        taskId: task.taskId,
                        passed: false,
                      })
                    }
                  >
                    未通过
                  </button>
                  <button
                    className="primary"
                    disabled={disabled}
                    onClick={() =>
                      send('confirm', {
                        runId: run.id,
                        taskId: task.taskId,
                        passed: true,
                      })
                    }
                  >
                    确认通过
                  </button>
                </div>
              </>
            )}
            {attempt && (
              <details className="evidence">
                <summary>验收证据与执行引用</summary>
                <small>
                  Thread: {attempt.threadId ?? '—'}
                  <br />
                  Turn: {attempt.turnId ?? '—'}
                </small>
                {attempt.evidence.map((e, i) => (
                  <pre key={i}>
                    {e.passed ? '✓' : '!'}{' '}
                    {e.source === 'manual' ? '人工确认' : '自动检查'} ·{' '}
                    {e.description}
                  </pre>
                ))}
                {task.attempts.length > 1 && (
                  <p>保留 {task.attempts.length} 次执行记录</p>
                )}
              </details>
            )}
          </article>
        );
      })}
      {run && (
        <div className="run-controls">
          {run.status === 'failed' && (
            <button
              disabled={disabled}
              onClick={() => send('retry', { runId: run.id })}
            >
              ↻ 重试失败步骤
            </button>
          )}
          {['running', 'paused'].includes(run.status) && (
            <button
              disabled={disabled || run.cancelRequested}
              onClick={() => send('cancel', { runId: run.id })}
            >
              {run.cancelRequested ? '取消请求中…' : '取消运行'}
            </button>
          )}
          {run.status === 'unknown' && (
            <>
              <p className="task-error">
                无法确认执行器状态。不会自动重跑或标记完成。
              </p>
              <button
                disabled={disabled}
                onClick={() => send('resolveUnknown', { runId: run.id })}
              >
                检查后归档
              </button>
            </>
          )}
          {run.status === 'completed' && (
            <div className="success-note">✓ 所有任务均已通过验收</div>
          )}
          <small className="run-id">Run {run.id.slice(0, 8)}</small>
        </div>
      )}
    </section>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
