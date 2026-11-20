import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as agentSpine from '@kepler/agent-spine'
import LlmRuntime from '@kepler/llm'
import * as deepseek from '@kepler/llm-deepseek'
import SessionStore from '@kepler/session'
import SystemPrompt from '@kepler/system-prompt'
import ToolRuntime from '@kepler/tools'

const persona = '你是 Kepler 助手。'
const addSchema = {
    name: 'add',
    description: '计算两个数的和',
    parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
    },
}
const addCall = { id: 'call-1', name: 'add', arguments: '{"a":2,"b":3}' }
const echo = {
    async *stream({ messages }) {
        const user = messages.findLast(message => message.role === 'user')
        yield { type: 'text', text: user.content }
    },
}

function createContext(t) {
    const app = new Context()
    t.after(() => app.fiber.dispose())
    return app
}

async function createAgent(t, config = {}) {
    const app = createContext(t)
    await app.plugin(agentSpine, { persona, agent: config })
    return app
}

describe('SystemPrompt', () => {
    it('构建指定人设', async t => {
        const app = createContext(t)
        await app.plugin(SystemPrompt, { persona })
        assert.equal(app.systemPrompt.build(), persona)
    })
})

describe('LLM', () => {
    it('注册、流式读取和注销适配器', async t => {
        const app = createContext(t)
        await app.plugin(LlmRuntime)
        assert.deepEqual(app.llm.providers(), [])
        const unregister = app.llm.registerAdapter('echo', echo)
        assert.deepEqual(app.llm.providers(), ['echo'])
        const messages = [{ role: 'user', content: '你好，Kepler' }]
        const chunks = []
        for await (const chunk of app.llm.stream({ provider: 'echo', messages })) {
            chunks.push(chunk)
        }
        assert.deepEqual(chunks, [{ type: 'text', text: '你好，Kepler' }])
        unregister()
        assert.deepEqual(app.llm.providers(), [])
    })
})

describe('Session', () => {
    it('查找会话、转换消息和广播事件', async t => {
        const app = createContext(t)
        await app.plugin(SessionStore)
        const observed = []
        app.on('session/created', session => observed.push(`created:${session.id}`))
        app.on('session/event', (session, entry) => observed.push(`${session.id}:${entry.type}`))

        const session = app.sessions.create('demo')
        assert.equal(app.sessions.get('demo')?.id, 'demo')
        session.append({ type: 'user', text: '2 + 3 等于多少？' })
        session.append({ type: 'assistant', text: '', toolCalls: [addCall] })
        session.append({ type: 'tool-result', toolCallId: addCall.id, name: addCall.name, content: '5' })

        assert.deepEqual(session.deriveMessages(), [
            { role: 'user', content: '2 + 3 等于多少？' },
            { role: 'assistant', content: '', toolCalls: [addCall] },
            { role: 'tool', content: '5', toolCallId: addCall.id },
        ])
        assert.deepEqual(observed, ['created:demo', 'demo:user', 'demo:assistant', 'demo:tool-result'])
    })
})

describe('Tools', () => {
    it('注册、执行、拦截和注销工具', async t => {
        const app = createContext(t)
        await app.plugin(ToolRuntime)
        let calls = 0
        const tool = {
            ...addSchema,
            async execute({ a, b }) {
                calls++
                return String(a + b)
            },
        }
        const unregister = app.tools.register(tool)
        assert.deepEqual(app.tools.list(), [addSchema])
        assert.throws(() => app.tools.register(tool), /already registered/)
        const request = { name: 'add', args: { a: 2, b: 3 } }
        assert.deepEqual(await app.tools.execute(request), { content: '5' })

        app.on('tools/pre-execute', (exec, next) => {
            if (exec.sessionId === 'read-only') return { allow: false, reason: '只读会话' }
            return next()
        })
        assert.deepEqual(await app.tools.execute({ ...request, sessionId: 'read-only' }), {
            content: '已拦截：只读会话 add', isError: true,
        })
        assert.equal(calls, 1)
        unregister()
        assert.deepEqual(app.tools.list(), [])
        assert.deepEqual(await app.tools.execute(request), { content: '没有这个工具：add', isError: true })
    })
})

describe('AgentSpine', () => {
    it('装配核心服务，卸载后可重新挂载', async t => {
        const app = createContext(t)
        const spine = await app.plugin(agentSpine, { persona, agent: { maxSteps: 3 } })
        assert.equal(app.systemPrompt.build(), persona)
        assert.equal(app.agentLoop.config.maxSteps, 3)
        assert.deepEqual(app.llm.providers(), [])
        assert.deepEqual(app.tools.list(), [])
        app.sessions.create('first')

        await spine.dispose()
        for (const service of ['llm', 'sessions', 'tools', 'systemPrompt', 'agentLoop']) {
            assert.equal(app.get(service), undefined, service)
        }
        await app.plugin(agentSpine)
        assert.equal(app.sessions.get('first'), undefined)
        assert.equal(app.agentLoop.config.maxSteps, 8)
    })
})

describe('AgentLoop', () => {
    it('无工具时返回回答并保留多轮历史', async t => {
        const app = await createAgent(t)
        app.llm.registerAdapter('echo', echo)
        const session = app.sessions.create()
        for (const input of ['第一问', '第二问']) {
            assert.equal(await app.agentLoop.run(session, input), input)
        }
        assert.deepEqual(session.deriveMessages().map(({ role, content }) => [role, content]), [
            ['user', '第一问'], ['assistant', '第一问'], ['user', '第二问'], ['assistant', '第二问'],
        ])
    })

    it('执行工具，带回结果，再流式回答', async t => {
        const app = await createAgent(t, { provider: 'scripted', model: 'local' })
        const session = app.sessions.create()
        const { signal } = new AbortController()
        const events = []
        app.on('agent/status', (_, status) => events.push(status))
        app.on('agent/request', (_, step) => events.push(step))
        app.on('agent/tool-call', (_, call) => events.push(call.id))
        app.on('agent/text-delta', (_, text) => events.push(text))
        app.tools.register({ ...addSchema, execute: ({ a, b }) => String(a + b) })
        app.llm.registerAdapter('scripted', {
            async *stream(options) {
                const { messages } = options
                assert.deepEqual(messages[0], { role: 'system', content: persona })
                assert.deepEqual(options.tools, [addSchema])
                assert.equal(options.model, 'local')
                assert.equal(options.signal, signal)
                if (messages.at(-1).role === 'user') {
                    yield { type: 'tool-call', call: addCall }
                    return
                }
                assert.deepEqual(messages.at(-2).toolCalls, [addCall])
                const result = messages.at(-1)
                assert.deepEqual(result, { role: 'tool', content: '5', toolCallId: addCall.id })
                yield { type: 'text', text: '结果是' }
                yield { type: 'text', text: result.content }
            },
        })

        assert.equal(await app.agentLoop.run(session, '2 + 3 等于多少？', signal), '结果是5')
        assert.deepEqual(session.log.map(entry => entry.type), ['user', 'assistant', 'tool-result', 'assistant'])
        assert.deepEqual(events, ['busy', 1, 'call-1', 2, '结果是', '5', 'idle'])
    })

    it('连续请求工具时按 maxSteps 停止', async t => {
        const app = await createAgent(t, { maxSteps: 2 })
        app.tools.register({ ...addSchema, execute: ({ a, b }) => String(a + b) })
        app.llm.registerAdapter('repeat', {
            async *stream() { yield { type: 'tool-call', call: addCall } },
        })
        const steps = []
        app.on('agent/request', (_, step) => steps.push(step))
        const reply = await app.agentLoop.run(app.sessions.create(), '继续计算')
        assert.equal(reply, '（达到最大步数，已停止）')
        assert.deepEqual(steps, [1, 2])
    })

    it('适配器异常时传播错误并恢复 idle', async t => {
        const app = await createAgent(t)
        const statuses = []
        app.on('agent/status', (_, status) => statuses.push(status))
        await assert.rejects(app.agentLoop.run(app.sessions.create(), '你好'), /no llm adapter registered/)
        assert.deepEqual(statuses, ['busy', 'idle'])
    })
})

describe('DeepSeek', () => {
    // 按字节切分，覆盖 SSE 跨网络分块以及中文字符跨分块的情形。
    function deepSeekStream(deltas) {
        const lines = deltas.map(delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }))
        const bytes = new TextEncoder().encode([': keep-alive', ...lines, 'data: [DONE]'].join('\r\n\r\n'))
        return new Response(new ReadableStream({
            start(controller) {
                for (let i = 0; i < bytes.length; i += 5) controller.enqueue(bytes.subarray(i, i + 5))
                controller.close()
            },
        }))
    }

    it('经 AgentLoop 还原分片工具调用、回传结果并保存最终回答', async t => {
        const app = await createAgent(t, { provider: 'deepseek', model: 'request-model' })
        const plugin = await app.plugin(deepseek, { apiKey: 'test-key', baseURL: 'https://example.invalid/v1/' })
        app.tools.register({ ...addSchema, execute: ({ a, b }) => String(a + b) })
        const session = app.sessions.create()
        const { signal } = new AbortController()
        const chunks = []
        app.on('agent/text-delta', (_, text) => chunks.push(text))

        const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
            assert.equal(url, 'https://example.invalid/v1/chat/completions')
            assert.equal(init.method, 'POST')
            assert.equal(init.headers.Authorization, 'Bearer test-key')
            assert.equal(init.signal, signal)
            const body = JSON.parse(init.body)
            assert.equal(body.stream, true)
            assert.equal(body.model, 'request-model')
            assert.deepEqual(body.tools, [{ type: 'function', function: addSchema }])
            assert.deepEqual(body.thinking, { type: 'disabled' })
            assert.deepEqual(body.messages.slice(0, 2), [
                { role: 'system', content: persona },
                { role: 'user', content: '计算 2 + 3' },
            ])
            if (body.messages.length === 2) {
                return deepSeekStream([
                    { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'a', arguments: '{"a":2' } }] },
                    { tool_calls: [{ index: 0, function: { name: 'dd', arguments: ',"b":3}' } }] },
                ])
            }
            assert.deepEqual(body.messages.slice(2), [
                { role: 'assistant', content: '', tool_calls: [
                    { id: 'call-1', type: 'function', function: { name: 'add', arguments: addCall.arguments } },
                ] },
                { role: 'tool', content: '5', tool_call_id: 'call-1' },
            ])
            return deepSeekStream([{ content: '结果是' }, { content: '5' }])
        })

        assert.equal(await app.agentLoop.run(session, '计算 2 + 3', signal), '结果是5')
        assert.deepEqual(chunks, ['结果是', '5'])
        assert.equal(session.deriveMessages().at(-1).content, '结果是5')
        assert.equal(fetchMock.mock.callCount(), 2)
        await plugin.dispose()
        assert.deepEqual(app.llm.providers(), [])
    })

    it('无工具请求、HTTP 错误和流中断', async t => {
        const app = await createAgent(t)
        await app.plugin(deepseek, { apiKey: 'test-key' })
        const session = app.sessions.create()
        const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
            assert.equal(url, 'https://api.deepseek.com/chat/completions')
            const body = JSON.parse(init.body)
            assert.equal(body.model, 'deepseek-flash')
            assert.equal(body.tools, undefined)
            return new Response('rate limited', { status: 429 })
        })
        await assert.rejects(app.agentLoop.run(session, '你好'), /DeepSeek API 429/)
        fetchMock.mock.mockImplementation(async () => new Response('data: {"choices":[]}\n\n'))
        await assert.rejects(app.agentLoop.run(session, '重试'), /ended before \[DONE\]/)
        assert.ok(session.log.every(entry => entry.type === 'user'))
    })

    it('真实 API 流式对话', { skip: process.env.npm_lifecycle_event !== 'test:deepseek' && process.env.KEPLER_TEST_DEEPSEEK !== '1' }, async t => {
        assert.ok(process.env.DEEPSEEK_API_KEY, '请在项目根目录的 .env 中填写 DEEPSEEK_API_KEY')
        const app = await createAgent(t, { provider: 'deepseek' })
        await app.plugin(deepseek, { apiKey: process.env.DEEPSEEK_API_KEY })
        const session = app.sessions.create()
        const chunks = []
        app.on('agent/text-delta', (_, text) => {
            chunks.push(text)
            process.stdout.write(text)
        })
        const reply = await app.agentLoop.run(session, '请只回复：你好，Kepler。', AbortSignal.timeout(90000))
        process.stdout.write('\n')
        assert.ok(reply.trim())
        assert.equal(chunks.join(''), reply)
        assert.equal(session.deriveMessages().at(-1).content, reply)
    })
})
