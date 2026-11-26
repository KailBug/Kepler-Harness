# AGENT.md — Kepler-Harness 开发指南

本文档面向在本仓库工作的 AI 编程代理与开发者，概述 **Kepler-Harness** 的架构设计、模块边界、核心不变量与工程规范。

---

## 1. 项目定位与核心理念

**Kepler-Harness** 是 Kepler 体系中的 **Agent Harness 内核（执行器内核）**，基于 [`@deepseek-ai/cordis`](https://github.com/cordisjs/cordis) 构建：**整个 Agent 是一棵插件树**，所有能力通过 `Service` 依赖注入、生命周期作用域（Fiber）以及事件 / Waterfall 拦截管道装配而成。

同一套内核（`@kepler/agent-spine`，内核代码零改动）通过外围插件组合支持两种运行模式：

1. **独立模式（Standalone）**：`@kepler/agent-spine` + `@kepler/llm-deepseek` + `@kepler/webserver`（配合 `@kepler/web` 前端），单进程在本地提供 REST + SSE 接口与 Web 对话界面。
2. **托管模式（Managed Worker）**：`@kepler/agent-spine` + `@kepler/llm-deepseek` + `@kepler/session-remote` + `@kepler/worker`，作为无状态 Worker 经 ConnectRPC 连接 `keplerd` 控制面，主动拉取任务、维护租约心跳并将事件 Write-Ahead 落盘至远端。

---

## 2. 仓库结构与模块职责

本项目采用 **npm Workspaces**（`packages/*`、`apps/*`）管理，全仓启用 ESM（`"type": "module"`）。

### 核心内核包（`packages/`）

| 包名 | Cordis 服务 / 入口 | 职责说明 |
| :--- | :--- | :--- |
| `@kepler/agent-spine` | 插件组合入口 | 一键挂载 `llm`、`sessions`、`tools`、`systemPrompt`、`agentLoop` 五大核心服务；卸载时随作用域一并清理。 |
| `@kepler/protocol` | `.` / `./connect` | **默认入口 (`.`)**：前后端共用的用户面协议 `v0` 纯 TypeScript 类型（零运行时代码）。<br>**子入口 (`./connect`)**：重导出 `src/gen/kepler/v1/*_pb.js`（Protobuf + ConnectRPC 生成代码），仅供托管模式包导入。 |
| `@kepler/system-prompt` | `ctx.systemPrompt` | 动态系统提示词服务。各插件通过 `section({ id, order, render })` 贡献片段，`build()` 按 `order` 升序拼接。 |
| `@kepler/llm` | `ctx.llm` | 抽象流式模型运行时。管理 `LlmAdapter` 注册表，流式调用外包 `waterfall('llm/stream')` 以便扩展日志、重试或改写。 |
| `@kepler/tools` | `ctx.tools` | 工具注册表与三段式执行管道：`tools/pre-execute`（支持拦截或 `requireApproval` 挂起）→ `tools/execute` → `tools/post-execute`。 |
| `@kepler/session` | `ctx.sessions` | 只追加事件日志（Append-Only Event Log）会话存储。负责串行分配单调递增 `seq`、`waterfall('session/persist')` Write-Ahead 落盘、`restore()` 历史恢复及 `deriveMessages()` 模型上下文投影。 |
| `@kepler/agent-loop` | `ctx.agentLoop` | 核心推理与工具执行循环。拆分为 `submit()`（追加用户消息并启动新 Turn）与幂等可重入的 `resume()`（支持崩溃断点恢复、HITL 审批后继续、失败重试、`maxSteps` 截停与 `AbortSignal` 取消）。 |

### 适配器与运行模式扩展包（`packages/`）

| 包名 | Cordis 服务 / 入口 | 职责说明 |
| :--- | :--- | :--- |
| `@kepler/llm-deepseek` | 插件（注入 `llm`） | DeepSeek Chat Completions 流式适配器。基于原生 `fetch` 处理跨网络分块的 UTF-8 / SSE 解析与分片 `tool_calls` 还原；携带工具时自动设置 `thinking: { type: 'disabled' }`。 |
| `@kepler/webserver` | 插件（注入 `agentLoop`, `sessions`） | 仅依赖 `node:http` 的轻量级 HTTP 路由、静态 SPA 服务与 SSE 事件流推送服务，语义对齐 Kepler 用户面协议。 |
| `@kepler/session-remote` | `ctx.remoteSession` | 托管模式远端持久化服务。监听 `session/persist` waterfall，携带 `leaseId` 与 `epoch` 调用 `WorkerService.AppendEvents`；内置本地 `SessionEvent` 与 Protobuf 的双向无损编解码（`src/codec.ts`）。 |
| `@kepler/worker` | `ctx.worker` | 托管模式无状态 Worker 循环：`registerWorker` → 定时 `heartbeat` → `acquireTask` 长轮询 → `sessions.restore` → 定时 `renewLease` → `agentLoop.resume` → 上报 `completeTask` / `suspendTask` / `failTask`。 |

### 应用与测试（`apps/` & 根目录）

- `apps/web` (`@kepler/web`)：
  - `src/`：React 19 + Vite 单页应用，基于 `EventSource`（`useSessionStream.ts`）订阅会话流并由 `buildTimeline()` 投影消息与工具审批卡片。
  - `server/main.ts`：独立模式启动入口。
- `apps/worker` (`@kepler/worker-app`)：
  - `src/main.ts`：托管模式无头 Worker 启动入口。
- `test-cordis.mjs`：基于 `node:test` 的全仓单元与集成测试套件。

---

## 3. 常用命令与环境变量

### 运行环境要求

- **Node.js >= 23.6（推荐 Node 24+）**：后端与 `packages/*` 直接利用 Node.js **原生 TypeScript 类型擦除（Type Stripping）**运行 `.ts` 源码，无需后端编译构建步骤。

### 命令速查

```bash
# 运行单元与集成测试（默认跳过真实外部 API 调用）
npm test

# 运行真实 DeepSeek API 流式对话测试（需在根目录 .env 配置 DEEPSEEK_API_KEY）
npm run test:deepseek

# 构建前端静态产物（输出至 apps/web/dist）
npm run build:web

# 启动独立模式服务端（默认 http://127.0.0.1:3000，托管 API 与 apps/web/dist）
npm start

# 启动前端 Vite 开发服务器（http://localhost:5173，/api 自动代理至 127.0.0.1:${PORT ?? 3000}）
npm run dev:web

# 启动托管模式无头 Worker（连接 keplerd）
npm run start:worker
```

### 环境变量（根目录 `.env`）

> `.env` 已被 `.gitignore` 忽略，切勿将真实密钥硬编码进源码或提交到版本库。

| 变量名 | 适用范围 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `DEEPSEEK_API_KEY` | 全局 / 测试 | 无（必填以启用模型） | DeepSeek API 密钥 |
| `DEEPSEEK_BASE_URL` | 全局 | `https://api.deepseek.com` | 模型 API 基础地址 |
| `DEEPSEEK_MODEL` | 全局 | `deepseek-flash` | 默认推理模型名称 |
| `PORT` / `HOST` | `@kepler/web` | `3000` / `127.0.0.1` | 独立模式 HTTP 监听端口与地址 |
| `KEPLER_URL` | `@kepler/worker-app` | `http://127.0.0.1:8080` | `keplerd` ConnectRPC 服务地址 |
| `KEPLER_WORKER_ID` | `@kepler/worker-app` | `harness-<hostname>-<pid>` | Worker 实例唯一标识 |
| `KEPLER_CAPABILITIES` | `@kepler/worker-app` | `default` | 逗号分隔的 Worker 能力标签列表 |

---

## 4. 核心架构不变量（修改代码前必读）

1. **只追加事件日志是唯一状态源（Event Sourcing）**
   - 会话完整历史仅保存在 `Session.log` 中（事件类型：`user`、`assistant`、`tool-result`、`approval-requested`、`approval-resolved`、`turn-ended`）。
   - 发给 LLM 的消息列表必须通过 `session.deriveMessages()` 派生（审批与 `turn-ended` 控制事件不进入模型上下文）；前端 UI 状态必须由事件流经 `buildTimeline()` 派生。**禁止在事件日志之外维护平行的会话上下文状态。**

2. **严格的 Write-Ahead 持久化顺序**
   - `session.append()` 内部通过 Promise 链串行分配单调递增的 `seq`，**必须先经过 `ctx.waterfall('session/persist', ...)` 成功落盘**，随后才允许写入内存 `session.log` 并广播 `session/event`。
   - 在 `AgentLoop` 中，包含 `toolCalls` 的 `assistant` 事件**必须先 `append` 成功**，之后才能真正执行任何工具。若持久化失败（如磁盘满或租约过期），绝不能触发有副作用的工具调用。

3. **幂等可恢复的 `AgentLoop.resume()`**
   - 不要假设一个 Turn 总是在单次内存调用中跑完。`resume(session)` 必须支持从任意持久化事件边界恢复：
     - `assistant(toolCalls)` 已落盘但进程崩溃：恢复后直接补跑尚未生成 `tool-result` 的工具调用，**不得重复调用首次 LLM**。
     - 工具触发 HITL 审批挂起（写入 `approval-requested` + `turn-ended(suspended)`）：待外部追加 `approval-resolved` 后调用 `resume()` 继续执行或写入拒绝结果。
     - `turn-ended(failed)` 允许通过 `resume()` 重试；其余已终结状态（`completed` / `max-steps` / `cancelled`）调用 `resume()` 应直接幂等返回。

4. **租约代际隔离（Lease Epoch / Fencing Token）**
   - 托管模式下，所有远端写入（`appendEvents`、`renewLease`、`completeTask`、`suspendTask`、`failTask`）均携带 `leaseId` 与 `epoch: bigint`。
   - 一旦服务端返回 `ConnectError` 且状态码为 `Code.FailedPrecondition`（代表租约已被更高代际的新 Worker 接管），当前 Worker 必须立即中止本地 `AbortController` 并**静默退出**，严禁继续执行工具或调用 `failTask` 污染新租约状态。

5. **CQRS 命令与 SSE 事件流分离**
   - 用户面写接口（`POST /api/sessions/:id/{messages,approvals/:toolCallId,resume,cancel}`）均以 `202 Accepted` 异步立即返回，不阻塞等待模型完成。
   - 状态推进统一通过 `GET /api/sessions/:id/events` SSE 推送：持久化事件帧（`event`）携带 `id: <seq>`，支持 `?since=<seq>` 与浏览器 `Last-Event-ID` 断线重连无损补发（注意在同一个同步块内完成历史补发与订阅注册以防漏帧）；`delta` 与 `status` 为瞬时帧，不带 `id`、不补发。

6. **Cordis 插件作用域与干净卸载**
   - 所有注册行为（`llm.registerAdapter`、`tools.register`、`systemPrompt.section`、定时器、HTTP Server、后台轮询循环）必须绑定到 `ctx.effect(() => cleanup)`，确保 `app.fiber.dispose()` 时所有资源、连接与子服务可被彻底卸载且支持重新挂载。

---

## 5. 编码规范与扩展指南

### TypeScript 与模块导入约束（重要）

- **禁止使用不可擦除（Non-erasable）的 TypeScript 语法**：由于 Node.js 原生直接擦除类型运行 `.ts` 文件，手写源码中**禁止使用** `enum`（请改用字符串字面量联合类型）、构造函数参数属性（如 `constructor(private x: number)`，请改用显式类字段声明）以及带运行时产物的 `namespace`。
- **显式文件扩展名**：
  - 包内相对导入 `.ts` 源码时**必须携带 `.ts` 后缀**（例如 `import { Router } from './http.ts'`）。
  - 导入 `packages/protocol/src/gen/` 下的生成文件时使用 `.js` 后缀。
- **切勿手改生成代码**：`packages/protocol/src/gen/kepler/v1/*` 由 Kepler 主仓库 `buf.gen.ts.yaml` 生成，同步协议时应整体替换生成产物而非手工编辑。
- **类型导入与模块扩充**：纯类型引用统一使用 `import type`；若仅需引入某个包的 `declare module '@deepseek-ai/cordis'` 服务/事件类型声明而不产生运行时引用，使用 `import type {} from '@kepler/xxx'`。

### 代码风格与依赖原则

- **格式**：4 空格缩进（见 `.editorconfig`）、无分号、单引号字符串、UTF-8 编码。
- **极简依赖**：优先使用 Node.js 内置模块与 Web 标准 API（`fetch`、`ReadableStream`、`TextDecoder`、`AbortController`、`crypto.randomUUID`、`node:http`、`node:test`、`node:assert/strict`），非必要不引入第三方运行时库。
- **Cordis 事件命名**：按领域使用 `<domain>/<action>` 命名（如 `session/persist`、`session/event`、`llm/stream`、`tools/pre-execute`、`agent/text-delta`）。

### 常见扩展方式

- **接入新 LLM 提供商**：新建 `@kepler/llm-<provider>` 包，实现 `LlmAdapter` 接口，在 `apply(ctx, config)` 中调用 `ctx.effect(() => ctx.llm.registerAdapter('<provider>', adapter))`。
- **注册新工具或安全策略**：调用 `ctx.effect(() => ctx.tools.register({ name, description, parameters, requireApproval?, execute }))`；全局拦截、审计或动态审批策略挂载至 `ctx.on('tools/pre-execute', (exec, next) => ...)`。
- **扩展系统提示词**：调用 `ctx.effect(() => ctx.systemPrompt.section({ id, order, render }))`。
- **演进会话事件协议**：同步修改 `@kepler/protocol/src/protocol.ts`、更新 `packages/protocol/src/gen/` 生成代码、补齐 `@kepler/session-remote/src/codec.ts` 中的 `toProtoEvent` / `fromProtoEvent` 分支，并在 `test-cordis.mjs` 中补充 Protobuf 往返无损测试与前端 `timeline.ts` 渲染分支。

### 测试与提交规范

- 修改或新增功能后请运行 `npm test` 验证 `test-cordis.mjs`；编写新测试时使用 `t.after(() => app.fiber.dispose())` 清理上下文，外部网络请求使用 `t.mock.method(globalThis, 'fetch', ...)` 模拟。
- Git 提交信息遵循 Conventional Commits 格式（如 `feat(agent-loop): ...`、`fix(webserver): ...`、`build(protocol): ...`）。
