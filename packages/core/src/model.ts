import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
export const CriterionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('manual'),
      description: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal('file_exists'),
      path: z.string().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      commandId: z.string().min(1).max(100),
    })
    .strict(),
]);
export const TaskSchema = z
  .object({
    id: z.string().uuid(),
    orderIndex: z.number().int().min(0),
    title: z.string().trim().min(1).max(160),
    description: z.string().max(2000).optional(),
    instruction: z.string().trim().min(1).max(12000),
    acceptanceCriteria: z.array(CriterionSchema).min(1).max(20),
  })
  .strict();
export const TasksSchema = z
  .array(TaskSchema)
  .min(1)
  .max(50)
  .superRefine((tasks, ctx) => {
    if (new Set(tasks.map((t) => t.id)).size !== tasks.length)
      ctx.addIssue({ code: 'custom', message: '任务 ID 不可重复' });
  });
export type TaskDefinition = z.infer<typeof TaskSchema>;
export type Criterion = z.infer<typeof CriterionSchema>;
export interface PlanRevision {
  id: string;
  planId: string;
  version: number;
  contentHash: string;
  createdAt: string;
  tasks: TaskDefinition[];
  requirement: string;
}
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';
export interface Evidence {
  source: 'verification' | 'manual';
  description: string;
  passed: boolean;
  at: string;
}
export interface Attempt {
  id: string;
  attemptNo: number;
  status: TaskStatus;
  threadId?: string;
  turnId?: string;
  error?: string;
  evidence: Evidence[];
}
export interface TaskRun {
  taskId: string;
  status: TaskStatus;
  attempts: Attempt[];
}
export interface Run {
  id: string;
  revisionId: string;
  idempotencyKey: string;
  status:
    'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  createdAt: string;
  tasks: TaskRun[];
  cancelRequested?: boolean;
}
export interface Activity {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  sequence: number;
  at: string;
  kind: string;
  text: string;
}
export interface State {
  schemaVersion: 1;
  revisions: PlanRevision[];
  runs: Run[];
  events: Activity[];
  sequence: number;
}
export const emptyState = (): State => ({
  schemaVersion: 1,
  revisions: [],
  runs: [],
  events: [],
  sequence: 0,
});
export function revision(
  tasks: unknown,
  requirement: string,
  previous?: PlanRevision,
): PlanRevision {
  const checked = TasksSchema.parse(tasks).map((t, i) => ({
    ...t,
    orderIndex: i,
  }));
  return {
    id: randomUUID(),
    planId: previous?.planId ?? randomUUID(),
    version: (previous?.version ?? 0) + 1,
    createdAt: new Date().toISOString(),
    tasks: checked,
    requirement,
    contentHash: createHash('sha256')
      .update(JSON.stringify(checked))
      .digest('hex'),
  };
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Best-effort log redaction. Credentials must still never be included in task content. */
export function redactLog(text: string): string {
  return text
    .replace(/\b(sk-[\w-]{12,}|gh[pousr]_[\w]{12,})\b/g, '[已隐藏凭据]')
    .replace(
      /((?:api[_-]?key|authorization|token|password)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      '$1[已隐藏]',
    );
}
