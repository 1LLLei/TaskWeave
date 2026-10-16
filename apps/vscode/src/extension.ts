import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Controller } from '../../../packages/core/src/controller';
import { FileStore } from '../../../packages/core/src/store';
import {
  AcceptanceEngine,
  type CommandRegistry,
} from '../../../packages/core/src/acceptance';
import {
  CodexExecutor,
  generatePlan,
  type CodexOptions,
} from '../../../packages/adapters/src/codex';
import {
  TaskSchema,
  errorText,
  redactLog,
} from '../../../packages/core/src/model';
const Request = z
  .object({
    requestId: z.string().uuid(),
    type: z.enum([
      'ready',
      'generate',
      'edit',
      'discard',
      'save',
      'start',
      'retry',
      'cancel',
      'confirm',
      'resolveUnknown',
      'open',
    ]),
    payload: z.unknown().optional(),
  })
  .strict();
const Id = z.object({ runId: z.string().uuid() }).strict();
export async function activate(context: vscode.ExtensionContext) {
  let panel: vscode.WebviewPanel | undefined,
    sidebar: vscode.WebviewView | undefined,
    controller: Controller | undefined,
    store: FileStore | undefined;
  let initializing: Promise<Controller> | undefined,
    planning = false,
    planningAbort: AbortController | undefined,
    disposed = false;
  const config = () => vscode.workspace.getConfiguration('taskweave');
  const options = async (): Promise<CodexOptions> => {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区');
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error('请先打开本地项目文件夹');
    if (folders.length !== 1)
      throw new Error('首版支持单文件夹工作区，请单独打开目标项目');
    if (folders[0].uri.scheme !== 'file')
      throw new Error('需要本地文件系统工作区');
    return {
      workspace: await realpath(folders[0].uri.fsPath),
      executable: config().get<string>('codexPath', 'codex'),
      model: config().get<string>('model', ''),
      approve: async (request) => {
        const detail = redactLog(JSON.stringify(request.params, null, 2)).slice(
          0,
          12000,
        );
        return (
          (await vscode.window.showWarningMessage(
            `Codex 请求${request.method.includes('fileChange') ? '修改文件' : '执行命令'}`,
            { modal: true, detail },
            '允许本次',
          )) === '允许本次'
        );
      },
    };
  };
  async function getController() {
    if (controller) return controller;
    if (!initializing)
      initializing = (async () => {
        const opts = await options();
        const hash = createHash('sha256')
          .update(opts.workspace)
          .digest('hex')
          .slice(0, 24);
        const localStore = new FileStore(
          join(context.globalStorageUri.fsPath, hash),
        );
        await localStore.acquire();
        try {
          const registry = z
            .record(
              z
                .object({
                  executable: z.string().min(1),
                  args: z.array(z.string()),
                  timeoutMs: z.number().int().min(1000).max(600000).optional(),
                })
                .strict(),
            )
            .parse(config().get<CommandRegistry>('verificationCommands', {}));
          const acceptance = new AcceptanceEngine(
            opts.workspace,
            registry,
            async (id, spec) =>
              (await vscode.window.showWarningMessage(
                `运行验收命令「${id}」？`,
                {
                  modal: true,
                  detail: `${spec.executable} ${spec.args.join(' ')}\n工作区：${opts.workspace}\nGO 不代替本次命令授权。`,
                },
                '运行验收',
              )) === '运行验收',
          );
          const local = new Controller(
            localStore,
            new CodexExecutor(opts),
            acceptance,
          );
          await local.initialize();
          if (disposed) {
            local.dispose();
            await localStore.release();
            throw new Error('插件已关闭');
          }
          store = localStore;
          controller = local;
          local.subscribe(broadcast);
          return local;
        } catch (e) {
          await localStore.release();
          throw e;
        }
      })().catch((e) => {
        initializing = undefined;
        throw e;
      });
    return initializing;
  }
  function broadcast() {
    if (!controller) return;
    const state = structuredClone(controller.state);
    const message = {
      type: 'state',
      state,
      planning,
      fatalError: controller.fatalError,
      workspace: vscode.workspace.workspaceFolders?.[0]?.name,
      commandIds: Object.keys(config().get('verificationCommands', {})),
    };
    void panel?.webview.postMessage(message);
    void sidebar?.webview.postMessage(message);
  }
  async function receive(webview: vscode.Webview, raw: unknown) {
    let requestId: string | undefined;
    try {
      const message = Request.parse(raw);
      requestId = message.requestId;
      if (message.type === 'open') {
        await open();
        void webview.postMessage({ type: 'response', requestId });
        return;
      }
      const c = await getController();
      const p = message.payload;
      if (planning && !['ready'].includes(message.type))
        throw new Error('正在生成计划，请等待完成');
      switch (message.type) {
        case 'ready':
          break;
        case 'generate': {
          const { requirement } = z
            .object({ requirement: z.string().trim().min(1).max(12000) })
            .strict()
            .parse(p);
          if (
            c.state.runs.some((r) =>
              ['running', 'paused', 'unknown'].includes(r.status),
            )
          )
            throw new Error('请先处理当前运行');
          planning = true;
          planningAbort = new AbortController();
          broadcast();
          try {
            const tasks = await generatePlan(
              await options(),
              requirement,
              planningAbort.signal,
            );
            await c.savePlan(tasks, requirement);
          } finally {
            planning = false;
            planningAbort = undefined;
            broadcast();
          }
          break;
        }
        case 'edit':
          c.setEditing(true);
          break;
        case 'discard':
          c.setEditing(false);
          break;
        case 'save': {
          const data = z
            .object({
              tasks: z.array(TaskSchema),
              expectedRevisionId: z.string().uuid(),
            })
            .strict()
            .parse(p);
          const previous = c.state.revisions.at(-1);
          await c.savePlan(
            data.tasks,
            previous?.requirement ?? '',
            data.expectedRevisionId,
          );
          break;
        }
        case 'start': {
          const data = z
            .object({ revisionId: z.string().uuid(), key: z.string().uuid() })
            .strict()
            .parse(p);
          await c.start(data.revisionId, data.key);
          break;
        }
        case 'retry': {
          const { runId } = Id.parse(p);
          if (
            (await vscode.window.showWarningMessage(
              '重试会再次执行失败步骤，请先检查上次产生的文件与外部副作用。',
              { modal: true },
              '确认重试',
            )) === '确认重试'
          )
            await c.retry(runId);
          break;
        }
        case 'cancel':
          await c.cancel(Id.parse(p).runId);
          break;
        case 'confirm': {
          const { runId, taskId, passed } = z
            .object({
              runId: z.string().uuid(),
              taskId: z.string().uuid(),
              passed: z.boolean(),
            })
            .strict()
            .parse(p);
          if (
            (await vscode.window.showWarningMessage(
              passed
                ? '确认已检查本步交付物并通过验收？'
                : '确认本步验收未通过？',
              { modal: true },
              '确认',
            )) === '确认'
          )
            await c.confirm(runId, taskId, passed);
          break;
        }
        case 'resolveUnknown': {
          const { runId } = Id.parse(p);
          if (
            (await vscode.window.showWarningMessage(
              '请确认旧 Codex 执行器已经停止，并已检查文件和外部副作用。归档不会把未验证任务标为完成。',
              { modal: true },
              '已检查，归档',
            )) === '已检查，归档'
          )
            await c.resolveUnknown(runId);
          break;
        }
      }
      broadcast();
      void webview.postMessage({ type: 'response', requestId });
    } catch (e) {
      void webview.postMessage({
        type: 'response',
        requestId,
        error: redactLog(errorText(e)),
      });
      broadcast();
    }
  }
  function html(webview: vscode.Webview, view: 'workspace' | 'tasks') {
    const nonce = randomUUID().replaceAll('-', '');
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js'),
    );
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.css'),
    );
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};"><link rel="stylesheet" href="${css}"><title>TaskWeave</title></head><body data-view="${view}"><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
  function setup(webview: vscode.Webview, view: 'workspace' | 'tasks') {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    };
    webview.onDidReceiveMessage(
      (raw) => void receive(webview, raw),
      undefined,
      context.subscriptions,
    );
    webview.html = html(webview, view);
  }
  async function open() {
    if (panel) {
      panel.reveal();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      'taskweave.workspace',
      'TaskWeave',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    setup(panel.webview, 'workspace');
    panel.onDidDispose(
      () => {
        panel = undefined;
        try {
          controller?.setEditing(false);
        } catch {}
      },
      undefined,
      context.subscriptions,
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('taskweave.open', open),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('taskweave.tasks', {
      resolveWebviewView(view) {
        sidebar = view;
        setup(view.webview, 'tasks');
        view.onDidDispose(() => (sidebar = undefined));
      },
    }),
  );
  context.subscriptions.push({
    dispose() {
      disposed = true;
      planningAbort?.abort();
      controller?.dispose();
      void controller?.settled().finally(() => store?.release());
    },
  });
}
