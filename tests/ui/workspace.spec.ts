import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller, type Executor } from '../../packages/core/src/controller';
import { AcceptanceEngine } from '../../packages/core/src/acceptance';
import {
  emptyState,
  type State,
  type TaskDefinition,
} from '../../packages/core/src/model';
let server: Server, url: string;
test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/webview.js' || req.url === '/webview.css') {
      res.setHeader(
        'Content-Type',
        req.url.endsWith('.js') ? 'text/javascript' : 'text/css',
      );
      res.end(await readFile(`apps/vscode/dist${req.url}`));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/webview.css"></head><body data-view="workspace"><div id="root"></div><script src="/webview.js"></script></body></html>',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
test('edit, save, GO, manual acceptance and restore with the real controller', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'taskweave-ui-'));
  await writeFile(join(root, 'result.txt'), 'ok');
  let saved = emptyState();
  const exec: Executor = {
    async *execute(task) {
      yield {
        type: 'reference',
        threadId: 'test-thread',
        turnId: `test-${task.orderIndex}`,
      };
      yield {
        type: 'activity',
        kind: 'message',
        text: `Completed work for ${task.title}`,
      };
      yield { type: 'succeeded', text: 'Turn completed' };
    },
  };
  const c = new Controller(
    {
      async load() {
        return saved;
      },
      async save(s: State) {
        saved = structuredClone(s);
      },
    },
    exec,
    new AcceptanceEngine(root),
  );
  await c.initialize();
  const publish = async () => {
    await page.evaluate(
      (state) =>
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'state',
              state,
              workspace: 'taskweave-demo',
              commandIds: [],
            },
          }),
        ),
      c.state,
    );
  };
  c.subscribe(() => {
    void publish().catch(() => {});
  });
  await page.exposeFunction('taskweaveRequest', async (message: any) => {
    try {
      switch (message.type) {
        case 'generate': {
          const tasks: TaskDefinition[] = [
            {
              id: randomUUID(),
              orderIndex: 0,
              title: '分析需求',
              instruction: 'Review requirements',
              acceptanceCriteria: [{ type: 'file_exists', path: 'result.txt' }],
            },
            {
              id: randomUUID(),
              orderIndex: 1,
              title: '检查交付',
              instruction: 'Inspect changes',
              acceptanceCriteria: [
                { type: 'manual', description: '检查交付物' },
              ],
            },
          ];
          await c.savePlan(tasks, message.payload.requirement);
          break;
        }
        case 'edit':
          c.setEditing(true);
          break;
        case 'discard':
          c.setEditing(false);
          break;
        case 'save':
          await c.savePlan(
            message.payload.tasks,
            c.state.revisions.at(-1)!.requirement,
            message.payload.expectedRevisionId,
          );
          break;
        case 'start':
          await c.start(message.payload.revisionId, message.payload.key);
          break;
        case 'confirm':
          await c.confirm(
            message.payload.runId,
            message.payload.taskId,
            message.payload.passed,
          );
          break;
      }
      await publish();
      await page.evaluate(
        (requestId) =>
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { type: 'response', requestId },
            }),
          ),
        message.requestId,
      );
    } catch (e) {
      await page.evaluate(
        ({ requestId, error }) =>
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { type: 'response', requestId, error },
            }),
          ),
        { requestId: message.requestId, error: String(e) },
      );
    }
  });
  await page.addInitScript(() => {
    (window as any).acquireVsCodeApi = () => ({
      postMessage: (m: any) => (window as any).taskweaveRequest(m),
      getState: () => null,
      setState: () => {},
    });
  });
  try {
    await page.goto(url);
    await page.getByLabel('你想完成什么？').fill('实现并验证任务流程');
    await page.getByRole('button', { name: '生成计划' }).click();
    await expect(page.getByText('审查任务计划')).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: '任务 1 名称', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Modify' }).click();
    await page
      .getByRole('textbox', { name: '任务 1 名称', exact: true })
      .fill('明确需求');
    await page.getByRole('button', { name: '在第 2 项前插入任务' }).click();
    await page
      .getByRole('textbox', { name: '任务 2 名称', exact: true })
      .fill('新增步骤');
    await page
      .getByRole('textbox', { name: '任务 2 指令', exact: true })
      .fill('Check implementation');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('新增步骤', { exact: true })).toBeVisible();
    expect(c.state.revisions).toHaveLength(2);
    expect(c.state.revisions[1].tasks).toHaveLength(3);
    await page.getByRole('button', { name: 'GO' }).click();
    await expect(
      page.getByText('3 个任务 · 等待人工验收', { exact: true }),
    ).toBeVisible();
    await c.settled();
    expect(c.state.runs[0].tasks.map((t) => t.status)).toEqual([
      'completed',
      'verifying',
      'pending',
    ]);
    await page.getByRole('button', { name: '确认通过' }).click();
    await expect.poll(() => c.state.runs[0].tasks[2].status).toBe('verifying');
    await c.settled();
    await page.getByRole('button', { name: '确认通过' }).click();
    await expect(page.getByText('所有任务均已通过验收')).toBeVisible();
    await page.reload();
    await expect(page.getByText('所有任务均已通过验收')).toBeVisible();
    expect(saved.runs[0].status).toBe('completed');
    await page.screenshot({
      path: 'test-results/workspace-completed.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 560, height: 850 });
    await expect(
      page.getByRole('heading', { name: '执行计划', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    c.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
