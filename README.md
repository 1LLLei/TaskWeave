# TaskWeave

在 VS Code 中审查可编辑的任务计划，再由 Codex 逐项执行，以验收证据追踪进度。

**当前版本：0.1.0，开发预览。** 已实现本地 Managed Mode 主流程，仍需在真实 VS Code Extension Host 和可用模型连接下完成发布前验收。不是已发布的完整 V2.0 产品。

## 开始使用

需要 Node.js 22+、VS Code 1.95+，以及支持 `app-server` 的 Codex CLI。协议基线为 `codex-cli 0.159.2`。先在自己的机器上完成 Codex 登录；TaskWeave 复用 CLI 的认证，不读取或保存密钥。

```sh
npm ci
npm run build
npm run package
```

在 VS Code 扩展菜单选择 **Install from VSIX**，安装根目录生成的 `taskweave-0.1.0.vsix`。打开一个已信任的本地项目文件夹，运行命令 **TaskWeave: Open Task Workspace**。

1. 输入需求并生成计划。规划通过只读 Codex 会话完成。
2. 浏览计划；点击 **Modify** 后增删、改名、上下移动任务，编辑执行指令和验收条件。
3. **Save** 生成新计划版本；**Cancel** 丢弃本次编辑。未保存的草稿不能执行。
4. 点击 **GO**。计划冻结，Codex 按列表顺序执行，每步使用独立 Thread/Turn。
5. 右侧显示任务状态，主区域显示公开消息、命令、文件活动和可用的推理摘要。
6. 自动检查全部通过才完成；有人工验收要求时，必须检查交付物并点击确认。失败后停止派发后续步骤。

任务进度同时可在活动栏的 TaskWeave 视图查看。可用 VS Code 的 **Move View** 将该视图移至 Secondary Sidebar；主工作区本身也包含可收起的右侧列表。关闭视图不会取消运行。关闭整个 VS Code 会中断连接；重新打开时，未确认的活动运行显示 Unknown，必须检查旧执行器和副作用后归档，不能盲目重跑。

## 验收与权限

生成计划默认使用**人工验收**，不会把模型说的“完成”直接变成绿色对勾。可在编辑计划时选择：

- **人工确认**：用户检查交付物、测试与结果后确认。
- **文件存在**：检查工作区内的普通文件；拒绝绝对路径、越界路径和指向外部的符号链接。此检查只证明文件存在，不证明内容正确。
- **注册命令**：引用设置中的命令 ID，使用 executable + args 启动，不经过 Shell。每次执行前单独询问授权，退出码为 0 才通过。

用户设置示例：

```json
{
  "taskweave.codexPath": "codex",
  "taskweave.model": "",
  "taskweave.verificationCommands": {
    "unit-tests": {
      "executable": "npm",
      "args": ["test"],
      "timeoutMs": 120000
    }
  }
}
```

Windows 上建议注册实际可执行程序（例如 `node.exe` + 测试入口），不依赖 Shell 的 `.cmd` 启动行为。更改 Codex 路径、模型或命令注册表后，重新加载 VS Code 窗口。

GO 只批准当前计划。Codex 命令/文件变更的权限请求仍通过确认对话框处理，额外权限类型默认不授予。当前不支持的交互请求会明确拒绝，不自动代答。规划器不能获得额外命令审批。工作区需要信任，首版仅支持单文件夹、本地文件系统。

## 开发与验证

```sh
npm run typecheck
npm test
npm run test:ui
npm run smoke:codex
npm run smoke:codex -- --execute
npm run package
```

- `npm test`：核心与 JSONL 协议适配测试，使用受控执行器/协议 fixture，不调用模型。
- `npm run test:ui`：Chromium 下的 Webview UI + 真实 Controller 集成，Codex 执行结果由 fixture 提供。不是 VS Code Extension Host E2E。默认使用系统 Chromium（存在时），否则使用 Playwright 浏览器；可设置 `TASKWEAVE_CHROMIUM_PATH`。无浏览器时先运行 `npx playwright install chromium`。
- `smoke:codex`：真实 CLI 初始化和只读 Thread 创建。`--execute` 额外调用真实模型，90 秒无结果会请求中断；需要网络和可用 Codex 认证，不能用 fixture 测试结果代替。
- VS Code 调试：在本仓库按 F5，选择 **TaskWeave Extension**。调试宿主中打开一个测试项目，执行完整工作流。详细发布前检查见 [验证记录](docs/VALIDATION.md)。

本地检查不自动提交或推送 Git。每个 cloud task 已隔离，直接使用 `/workspace/TaskWeave`，不创建额外 worktree。

## 结构

```text
packages/core       计划版本、状态机、串行调度、验收与原子快照
packages/adapters   Codex app-server JSONL transport、规划与执行适配
packages/ui         React Plan Card、编辑器、活动区和任务列表
apps/vscode         扩展激活、Webview IPC、授权、宿主存储
scripts             构建与真实 Codex smoke
 tests              核心、协议 fixture 和浏览器交互测试
```

## 数据与能力边界

计划版本、运行、尝试、证据和最近 1000 条活动保存在 VS Code `globalStorageUri/<workspace-hash>/state.json`，采用串行写入和临时文件原子替换；`writer.lock` 防止多个窗口同时管理同一工作区。损坏记录不会被静默清空。旧的未确认执行不会自动恢复派发。

活动记录有长度上限，并对常见令牌/凭据样式做尽力脱敏。脱敏无法识别所有敏感内容，切勿在任务或工具输出中放入密钥。TaskWeave 无遥测、无额外云同步服务；任务和规划上下文经 Codex 发送至用户配置的模型服务。API Key 不由本插件管理。

此版本不包含原生 CLI Hooks、自动输入拦截、ChatGPT 插件、多模型配置界面、跨端同步、执行中 Replan、DAG/并行调度或任务边界 Pause 按钮。它们仍是后续阶段；请勿把界面或 fixture 验证理解为这些能力已实现。详见 [架构与范围](docs/ARCHITECTURE.md)。
