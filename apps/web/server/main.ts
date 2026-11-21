// Harness 独立运行入口：创建根 ctx，把插件挂上去。整个 Agent 就是一棵插件树。
// npm run build:web && npm start
// 环境变量：DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL、DEEPSEEK_MODEL、PORT、HOST

import { Context } from '@deepseek-ai/cordis'
import * as agentSpine from '@kepler/agent-spine'
import * as deepseek from '@kepler/llm-deepseek'
import * as webserver from '@kepler/webserver'
import { fileURLToPath } from 'node:url'

const env = process.env
const app = new Context()

// Cordis 的 logger 默认只写缓冲区，这里把日志打到控制台
app.logger.exporter({
    export: ({ type, name, args }) => {
        const [format = '', ...rest] = args
        const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${type.toUpperCase()} ${name}`
        console[type === 'debug' ? 'log' : type](line, format, ...rest)
    },
})

const apiKey = env.DEEPSEEK_API_KEY?.trim()

// 1. 核心套件：llm、sessions、tools、systemPrompt、agentLoop
await app.plugin(agentSpine, {
    agent: apiKey ? { provider: 'deepseek' } : {},
})

// 2. 模型适配器
if (apiKey) {
    await app.plugin(deepseek, { apiKey, baseURL: env.DEEPSEEK_BASE_URL, model: env.DEEPSEEK_MODEL })
} else {
    app.logger('web').warn('未设置 DEEPSEEK_API_KEY，请在 .env 中配置后重启')
}

// 3. 入口：网页服务
await app.plugin(webserver, {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '127.0.0.1',
    staticDir: fileURLToPath(new URL('../dist', import.meta.url)),
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
        await app.fiber.dispose()
        process.exit(0)
    })
}
