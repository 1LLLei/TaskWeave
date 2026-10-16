# 验证记录与发布前检查

记录日期：2026-10-15。当前产物为 **0.1.0 开发预览**，不代表 PRD 全部完成或正式发布。

## 已验证

- Node.js 24.19.0 / npm 11.9.0 环境安装依赖，锁文件已生成。
- TypeScript 严格类型检查和 esbuild Node/Webview 两个产物构建。
- 核心/协议测试：计划版本及稳定 ID、三步串行调度、验收失败阻断、重试历史、人工验收、未保存草稿阻断、Unknown 恢复、取消确认、存储失败关闭执行、路径越界、命令授权和存储单写者。
- JSONL 子进程 fixture：初始化、Thread/Turn 关联、公开摘要、跨会话事件过滤、结构化计划、拒绝授权和取消协议。**fixture 不是真实模型测试。**
- Chromium：React Webview + 真实 Controller 的编辑、插入、保存、GO、三步验收、刷新恢复，以及 560px 宽度无横向溢出；执行器使用 fixture。完整截图由测试写入 `test-results/workspace-completed.png`。
- VSIX 打包成功，包含扩展 Host、Webview JS/CSS、图标及说明。
- 真实 codex-cli 0.159.2：app-server initialize 与 read-only Thread 创建通过；复用现有 ChatGPT 登录，没有索取或复制认证值。

## 当前真实模型阻塞

`npm run smoke:codex -- --execute` 发起只读 Turn 后，服务持续返回 Reconnecting / waiting for network，90 秒后由测试请求中断；未收到成功终态或预期回答，**不得计为通过**。

非破坏性网络检查：`https://chatgpt.com/backend-api/codex/models` 的 HTTPS CONNECT 被代理以 403 拒绝；默认 ChatGPT Codex 路由所需的 `chatgpt.com` 不在原网络允许列表中。配置草稿已添加该域名，保留 package-manager 预设，不包含新增凭据。保存草稿不代表运行时网络已更新。

请在环境设置中审查、保存配置并发布；网络更新后再运行真实模型 smoke 和以下真实三步执行测试。

另外，cloud 沙箱内默认不能写 Codex 自己的 runtime SQLite 目录；本次真实协议检查通过受支持的权限提升流程完成。未改动 CODEX_HOME，未禁用 sandbox、TLS 或凭据验证。

## 尚未验证的发布门槛

- 桌面 VS Code 内安装 VSIX、命令激活、WebviewView 移动、宿主主题、高对比度和键盘/读屏体验。
- 正常模型连接下，三个真实开发步骤修改临时项目并通过自动验收。
- 真实第二步验收失败时，第三步没有产生文件修改。
- Codex 的真实命令/文件变更授权 UI、拒绝权限、断线与取消。
- Extension Host 重启、异常退出和锁恢复的桌面集成。
- Windows/macOS 与最低 VS Code 版本兼容。

可复现的本地命令见根 README。以上检查未执行的部分不以模拟测试代替，也不标记为已通过。
