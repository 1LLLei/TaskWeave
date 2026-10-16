# 架构与范围

## 主流程

React Webview → 严格校验的 VS Code IPC → 本地 Controller → Codex app-server → 验收 → 持久化快照 → 两个视图同步。

- `PlanRevision` 不可变，保留稳定 Task ID、顺序与内容哈希。
- `Run` 绑定审批版本及幂等键；每次重试新建 `Attempt`。
- 完成条件：执行器明确成功，并且全部验收通过（含需要的人工确认）。
- `succeeded` 只是 Turn 结束，不是业务完成。没有明确终态、断线和重启后的活动任务都置 Unknown。
- 一次运行只派发一个任务；失败停止后续。人工验收使用 `paused + verifying`，确认后才继续。
- 快照串行原子替换，包含顺序事件和尝试历史。0.1.0 暂未引入独立 JSONL 事件日志或 SQLite；快照是恢复依据，Webview 重新连接获取完整快照，不依赖浏览器缓存。

## Codex 适配

针对 0.159.2 使用已安装 CLI 的 `app-server generate-ts` 生成协议进行核对。当前实现 JSONL stdio RPC，连接初始化一次；每个执行任务创建独立临时 Thread，始终以同一工作区文件为上下文。前一步摘要不会自动注入后一步，执行指令应自包含。

规划器使用只读 sandbox 与结构化 outputSchema。模型只生成名称和执行指令；稳定 ID、验收要求和计划版本由 Host 创建，不接受模型提供的任意 Shell 验收命令。

通过 Thread/Turn 关联公开活动。展示 `reasoning.summary`，不读取 `reasoning.content`。取消请求通过 `turn/interrupt`，等待真实终态；连接丢失显示 Unknown。额外权限不默认批准，不支持的用户问答/工具交互会拒绝，因此复杂交互任务可能需要原生客户端。

规划与执行的模型凭据由 Codex 管理。未知协议响应不能被当作成功。RPC 请求 30 秒超时、执行 30 分钟超时会关闭该连接并将任务保守标为 Unknown；关闭连接不证明外部副作用已终止。

## VS Code 与 UI

首发采用 TaskWeave 自有 WebviewPanel，不注入第三方扩展私有 DOM。主区域呈现输入、卡片与活动，内部右侧呈现 Task List；额外 WebviewView 允许用户移到宿主右侧栏。

IPC 带请求 ID，Host 校验消息、版本与状态。编辑态由 Host 维护，不只依赖按钮置灰。CSP 禁止任意网络/内联脚本，模型文字以 React 文本节点呈现，不插入 HTML。计划保存、启动、取消等操作必须经 Host。

## 后续工作

1. 在桌面 VS Code 内完成扩展激活、布局、权限对话框、窗口重载与 VSIX 安装的真实验证。
2. 在正常可用的 Codex 模型连接下完成三步真实文件修改与自动验收，以及第二步失败阻断第三步。
3. 验证原生 Hooks 的公开能力，设计显式开关与卸载回滚；不承诺任意 CLI Turn 接管。
4. 验证 ChatGPT MCP UI/Conversation Panel 的目标客户端可用性，再实现 P1。
5. 历史导出/清除、活动流更细的增量显示、Planner 失败的有限重试、更多协议交互和跨平台验收。

当前版本以每个完成事件的文本/图标变化呈现反馈，尚无专门的完成弹窗和打勾动画；已支持减少动态效果、键盘原生控件及窄窗口布局。
