// Harness 托管模式无头入口：不启动本地网页，而是作为无状态 Worker 连接 keplerd。
//
//   npm run start:worker
//
// 环境变量：KEPLER_URL（默认 http://127.0.0.1:8080）、KEPLER_WORKER_ID、
//           DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL、DEEPSEEK_MODEL

import { Context } from '@deepseek-ai/cordis'
import * as agentSpine from '@kepler/agent-spine'
import * as deepseek from '@kepler/llm-deepseek'
import RemoteSessionStore from '@kepler/session-remote'
import McpTools from '@kepler/tools-mcp'
import KeplerWorker from '@kepler/worker'

const env = process.env
const app = new Context()

app.logger.exporter({
    export: ({ type, name, args }) => {
        const [format = '', ...rest] = args
        const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${type.toUpperCase()} ${name}`
        console[type === 'debug' ? 'log' : type](line, format, ...rest)
    },
})

const keplerUrl = env.KEPLER_URL ?? 'http://127.0.0.1:8080'
const apiKey = env.DEEPSEEK_API_KEY?.trim()

// 1. 核心套件（与独立模式完全一致，内核代码一行不改）
await app.plugin(agentSpine, {
    agent: apiKey ? { provider: 'deepseek' } : {},
})

// 2. 模型适配器
if (apiKey) {
    await app.plugin(deepseek, { apiKey, baseURL: env.DEEPSEEK_BASE_URL, model: env.DEEPSEEK_MODEL })
} else {
    app.logger('worker-app').warn('未设置 DEEPSEEK_API_KEY，收到任务时将缺少模型适配器')
}

// 3. 托管模式插件：MCP 工具发现 + 远端持久化 + Worker 拉任务循环
if (env.KEPLER_MCP_ENABLED !== 'false') {
    const mcpUrl = env.KEPLER_MCP_URL ?? `${keplerUrl.replace(/\/+$/, '')}/mcp`
    await app.plugin(McpTools, { url: mcpUrl })
}
await app.plugin(RemoteSessionStore, { baseUrl: keplerUrl, strict: true })
await app.plugin(KeplerWorker, {
    workerId: env.KEPLER_WORKER_ID,
    capabilities: (env.KEPLER_CAPABILITIES ?? 'default').split(',').filter(Boolean),
})

app.logger('worker-app').info('Kepler Harness Worker 已启动，目标底座：%s', keplerUrl)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
        await app.fiber.dispose()
        process.exit(0)
    })
}
