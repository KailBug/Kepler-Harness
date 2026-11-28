import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as agentSpine from '@kepler/agent-spine'
import LlmRuntime from '@kepler/llm'
import * as deepseek from '@kepler/llm-deepseek'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { LeaseSchema, WorkerTaskSchema } from '@kepler/protocol/connect'
import RemoteSessionStore, { fromProtoEvent, toProtoEvent } from '@kepler/session-remote'
import SessionStore from '@kepler/session'
import SystemPrompt from '@kepler/system-prompt'
import ToolRuntime from '@kepler/tools'
import McpTools from '@kepler/tools-mcp'
import * as webserver from '@kepler/webserver'
import KeplerWorker from '@kepler/worker'

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
    it('查找会话、转换消息、递增 seq 与广播事件', async t => {
        const app = createContext(t)
        await app.plugin(SessionStore)
        const observed = []
        app.on('session/created', session => observed.push(`created:${session.id}`))
        app.on('session/event', (session, entry) => observed.push(`${session.id}:${entry.seq}:${entry.type}`))

        const session = app.sessions.create('demo')
        assert.equal(app.sessions.get('demo')?.id, 'demo')
        const e1 = await session.append({ type: 'user', text: '2 + 3 等于多少？' }, 'turn-1')
        const e2 = await session.append({ type: 'assistant', text: '', toolCalls: [addCall] }, 'turn-1')
        const e3 = await session.append({ type: 'tool-result', toolCallId: addCall.id, name: addCall.name, content: '5' }, 'turn-1')

        assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3])
        assert.equal(e1.turnId, 'turn-1')
        assert.equal(e2.sessionId, 'demo')
        assert.ok(e1.id && e2.id && e1.id !== e2.id)
        assert.deepEqual(session.eventsSince(1).map(e => e.seq), [2, 3])
        assert.deepEqual(session.deriveMessages(), [
            { role: 'user', content: '2 + 3 等于多少？' },
            { role: 'assistant', content: '', toolCalls: [addCall] },
            { role: 'tool', content: '5', toolCallId: addCall.id },
        ])
        assert.deepEqual(observed, ['created:demo', 'demo:1:user', 'demo:2:assistant', 'demo:3:tool-result'])
    })

    it('从已有事件日志恢复会话并校验 seq 单调性', async t => {
        const app = createContext(t)
        await app.plugin(SessionStore)
        const original = app.sessions.create('s-1')
        await original.append({ type: 'user', text: 'hi' }, 't-1')
        await original.append({ type: 'assistant', text: 'hello' }, 't-1')

        const restored = app.sessions.restore('s-1', original.log)
        assert.equal(restored.lastSeq, 2)
        const e3 = await restored.append({ type: 'user', text: 'next' }, 't-2')
        assert.equal(e3.seq, 3)
        assert.equal(restored.deriveMessages().length, 3)
        assert.throws(() => app.sessions.restore('s-1', [e3, original.log[0]]), /invalid session event seq/)
        assert.throws(() => app.sessions.restore('other', [original.log[0]]), /does not match/)
    })

    it('Write-Ahead：持久化失败时不修改内存日志也不广播事件', async t => {
        const app = createContext(t)
        await app.plugin(SessionStore)
        const session = app.sessions.create('wa')
        let emitted = 0
        app.on('session/event', () => emitted++)
        app.on('session/persist', () => { throw new Error('disk full') })

        await assert.rejects(session.append({ type: 'user', text: 'hello' }, 't-1'), /disk full/)
        assert.equal(session.log.length, 0)
        assert.equal(session.lastSeq, 0)
        assert.equal(emitted, 0)
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
        assert.deepEqual(session.log.map(entry => entry.type), ['user', 'assistant', 'tool-result', 'assistant', 'turn-ended'])
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

    it('Write-Ahead：assistant 落盘失败时不执行有副作用的工具', async t => {
        const app = await createAgent(t)
        let executed = 0
        app.tools.register({ ...addSchema, execute: ({ a, b }) => { executed++; return String(a + b) } })
        app.llm.registerAdapter('tool-once', {
            async *stream() { yield { type: 'tool-call', call: addCall } },
        })
        app.on('session/persist', (_session, event, next) => {
            if (event.type === 'assistant') throw new Error('stale epoch')
            return next()
        })
        const session = app.sessions.create()
        await assert.rejects(app.agentLoop.submit(session, '2 + 3'), /stale epoch/)
        assert.equal(executed, 0)
    })

    it('断点恢复：从已落盘的 assistant(toolCalls) 恢复执行，不重复调用首次 LLM', async t => {
        const app = await createAgent(t)
        let toolRuns = 0
        let llmRuns = 0
        app.tools.register({ ...addSchema, execute: ({ a, b }) => { toolRuns++; return String(a + b) } })
        app.llm.registerAdapter('after-tool', {
            async *stream({ messages }) {
                llmRuns++
                assert.equal(messages.at(-1).role, 'tool')
                yield { type: 'text', text: `答案是 ${messages.at(-1).content}` }
            },
        })
        // 模拟 Worker 在落盘 assistant(toolCalls) 后宕机，新进程通过 restore + resume 接管
        const restored = app.sessions.restore('crash-1', [
            { id: 'e1', seq: 1, sessionId: 'crash-1', turnId: 't1', ts: 1, type: 'user', text: '2 + 3' },
            { id: 'e2', seq: 2, sessionId: 'crash-1', turnId: 't1', ts: 2, type: 'assistant', text: '', toolCalls: [addCall] },
        ])
        const result = await app.agentLoop.resume(restored)
        assert.equal(result.status, 'completed')
        assert.equal(result.text, '答案是 5')
        assert.equal(toolRuns, 1)
        assert.equal(llmRuns, 1)
    })

    it('HITL 审批：挂起、批准后恢复执行，以及拒绝后回传错误结果', async t => {
        const app = await createAgent(t)
        let toolRuns = 0
        app.tools.register({
            ...addSchema,
            requireApproval: true,
            execute: ({ a, b }) => { toolRuns++; return String(a + b) },
        })
        app.llm.registerAdapter('scripted', {
            async *stream({ messages }) {
                const last = messages.at(-1)
                if (last.role === 'user') return yield { type: 'tool-call', call: addCall }
                yield { type: 'text', text: `收到工具反馈：${last.content}` }
            },
        })

        // 分支 1：批准
        const s1 = app.sessions.create('approve')
        const suspended = await app.agentLoop.submit(s1, '算一下')
        assert.equal(suspended.status, 'suspended')
        assert.equal(toolRuns, 0)
        assert.equal(s1.pendingApprovals().length, 1)

        await s1.append({ type: 'approval-resolved', toolCallId: addCall.id, approved: true }, suspended.turnId)
        const resumed = await app.agentLoop.resume(s1)
        assert.equal(resumed.status, 'completed')
        assert.equal(resumed.text, '收到工具反馈：5')
        assert.equal(toolRuns, 1)

        // 分支 2：拒绝
        const s2 = app.sessions.create('deny')
        const suspended2 = await app.agentLoop.submit(s2, '再算一下')
        assert.equal(suspended2.status, 'suspended')
        await s2.append({ type: 'approval-resolved', toolCallId: addCall.id, approved: false, reason: '高危' }, suspended2.turnId)
        const denied = await app.agentLoop.resume(s2)
        assert.equal(denied.status, 'completed')
        assert.match(denied.text, /审批未通过：高危/)
        assert.equal(toolRuns, 1)
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
        assert.deepEqual(session.log.map(entry => entry.type), ['user', 'turn-ended', 'user', 'turn-ended'])
        assert.ok(session.log.filter(e => e.type === 'turn-ended').every(e => e.status === 'failed'))
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

describe('WebServer', () => {
    async function readSseUntil(url, stopWhen, headers = {}) {
        const abort = new AbortController()
        const response = await fetch(url, { headers, signal: abort.signal })
        assert.equal(response.status, 200)
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        const frames = []
        let buffer = ''
        try {
            while (true) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += value
                const parts = buffer.split('\n\n')
                buffer = parts.pop()
                for (const part of parts) {
                    const event = /^event: (.*)$/m.exec(part)?.[1]
                    const dataRaw = /^data: (.*)$/m.exec(part)?.[1]
                    const id = /^id: (.*)$/m.exec(part)?.[1]
                    if (!event || !dataRaw) continue
                    const frame = { id: id ? Number(id) : undefined, event, data: JSON.parse(dataRaw) }
                    frames.push(frame)
                    if (stopWhen(frame, frames)) {
                        abort.abort()
                        return frames
                    }
                }
            }
        } catch (error) {
            if (!abort.signal.aborted) throw error
        }
        return frames
    }

    it('命令与 SSE 事件流分离：提交消息、按 since 补发、HTTP 审批并恢复', async t => {
        const app = await createAgent(t)
        let executed = 0
        app.tools.register({
            ...addSchema,
            requireApproval: true,
            execute: ({ a, b }) => { executed++; return String(a + b) },
        })
        app.llm.registerAdapter('scripted', {
            async *stream({ messages }) {
                const last = messages.at(-1)
                if (last.role === 'user') return yield { type: 'tool-call', call: addCall }
                yield { type: 'text', text: `结果=${last.content}` }
            },
        })

        let baseUrl = ''
        await app.plugin(webserver, { port: 0, onListen: ({ url }) => { baseUrl = url } })

        // 1. 创建会话
        const created = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', body: '{}' })
        assert.equal(created.status, 201)
        const { session } = await created.json()

        // 2. 先订阅 SSE，再提交消息（验证实时推送直到挂起等待审批）
        const streamPromise = readSseUntil(
            `${baseUrl}/api/sessions/${session.id}/events`,
            frame => frame.event === 'event' && frame.data.type === 'turn-ended' && frame.data.status === 'suspended',
        )
        const sent = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '算 2 + 3' }),
        })
        assert.equal(sent.status, 202)
        const { turnId } = await sent.json()
        assert.ok(turnId)

        const firstFrames = await streamPromise
        const firstEvents = firstFrames.filter(f => f.event === 'event').map(f => f.data)
        assert.deepEqual(firstEvents.map(e => e.type), ['user', 'assistant', 'approval-requested', 'turn-ended'])
        const lastSeq = firstEvents.at(-1).seq
        assert.equal(executed, 0)

        // 3. 通过 Last-Event-ID 断线续传，批准工具后收到后续事件直到完成
        const resumePromise = readSseUntil(
            `${baseUrl}/api/sessions/${session.id}/events`,
            frame => frame.event === 'event' && frame.data.type === 'turn-ended' && frame.data.status === 'completed',
            { 'Last-Event-ID': String(lastSeq) },
        )
        const approved = await fetch(`${baseUrl}/api/sessions/${session.id}/approvals/${addCall.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approved: true }),
        })
        assert.equal(approved.status, 202)

        const resumedFrames = await resumePromise
        const resumedEvents = resumedFrames.filter(f => f.event === 'event').map(f => f.data)
        assert.ok(resumedEvents.every(e => e.seq > lastSeq))
        assert.deepEqual(resumedEvents.map(e => e.type), ['approval-resolved', 'tool-result', 'assistant', 'turn-ended'])
        assert.equal(resumedEvents.find(e => e.type === 'assistant').text, '结果=5')
        assert.equal(executed, 1)
    })
})

describe('KeplerWorker', () => {
    it('SessionEvent 与 Protobuf 双向转换无损', () => {
        const samples = [
            { id: 'e1', seq: 1, sessionId: 's1', turnId: 't1', ts: 100, type: 'user', text: 'hi' },
            { id: 'e2', seq: 2, sessionId: 's1', turnId: 't1', ts: 101, type: 'assistant', text: '', toolCalls: [addCall] },
            { id: 'e3', seq: 3, sessionId: 's1', turnId: 't1', ts: 102, type: 'approval-requested', toolCallId: 'call-1', name: 'add', arguments: '{"a":2,"b":3}', reason: '需审批' },
            { id: 'e4', seq: 4, sessionId: 's1', turnId: 't1', ts: 103, type: 'approval-resolved', toolCallId: 'call-1', approved: true, reason: 'ok' },
            { id: 'e5', seq: 5, sessionId: 's1', turnId: 't1', ts: 104, type: 'tool-result', toolCallId: 'call-1', name: 'add', content: '5' },
            { id: 'e6', seq: 6, sessionId: 's1', turnId: 't1', ts: 105, type: 'turn-ended', status: 'completed' },
        ]
        for (const ev of samples) {
            const roundTrip = fromProtoEvent(toProtoEvent(ev))
            assert.deepEqual(roundTrip, ev)
        }
    })

    it('拉取任务、Write-Ahead 远端落盘、处理审批挂起与僵尸 epoch 退出', async t => {
        const app = await createAgent(t)
        let toolRuns = 0
        app.tools.register({
            ...addSchema,
            execute: ({ a, b }) => { toolRuns++; return String(a + b) },
        })
        app.llm.registerAdapter('scripted', {
            async *stream({ messages }) {
                const last = messages.at(-1)
                if (last.role === 'user') return yield { type: 'tool-call', call: addCall }
                yield { type: 'text', text: `答案=${last.content}` }
            },
        })

        let seq = 1
        const appended = []
        const completed = []
        const failed = []
        let rejectAppend = false

        const mockClient = {
            async acquireTask() {
                return {
                    task: create(WorkerTaskSchema, {
                        taskId: 'task-1',
                        sessionId: 'sess-remote-1',
                        turnId: 'turn-1',
                        agentId: 'default',
                        lease: create(LeaseSchema, { leaseId: 'lease-1', epoch: 1n, expiresAtMs: BigInt(Date.now() + 30_000) }),
                        events: [toProtoEvent({ id: 'u1', seq: 1, sessionId: 'sess-remote-1', turnId: 'turn-1', ts: 1, type: 'user', text: '2+3' })],
                    }),
                }
            },
            async appendEvents(req) {
                if (rejectAppend) throw new ConnectError('stale lease epoch', Code.FailedPrecondition)
                assert.equal(req.leaseId, 'lease-1')
                assert.equal(req.epoch, 1n)
                for (const pb of req.events) {
                    seq++
                    appended.push(fromProtoEvent(pb))
                }
                return { lastSeq: BigInt(seq) }
            },
            async renewLease() { return {} },
            async completeTask(req) { completed.push(req); return {} },
            async suspendTask() { return {} },
            async failTask(req) { failed.push(req); return {} },
        }

        await app.plugin(RemoteSessionStore, { client: mockClient, strict: true })
        await app.plugin(KeplerWorker, { workerId: 'w-test', autoStart: false })

        // 1. 正常完成：Write-Ahead 远端落盘 4 条事件并 completeTask
        assert.equal(await app.worker.runOnce(), true)
        assert.deepEqual(appended.map(e => e.type), ['assistant', 'tool-result', 'assistant', 'turn-ended'])
        assert.equal(toolRuns, 1)
        assert.equal(completed.length, 1)
        assert.equal(failed.length, 0)

        // 2. 僵尸 epoch：appendEvents 报 FailedPrecondition -> 不执行工具，也不调用 failTask
        rejectAppend = true
        seq = 1
        assert.equal(await app.worker.runOnce(), true)
        assert.equal(toolRuns, 1)
        assert.equal(failed.length, 0)
    })
})

describe('McpTools', () => {
    it('Zod 校验非法配置、自动发现 MCP 工具、透传幂等 _meta 并触发 HITL 审批与卸载清理', async t => {
        const app = await createAgent(t)

        // 1. Zod 运行时校验拒绝非法 URL
        await assert.rejects(async () => { await app.plugin(McpTools, { url: 'ftp://invalid.local/mcp' }) }, /http:\/\/ or https:\/\//)

        // 2. 启动最小 MCP Streamable HTTP 桩服务（模拟 keplerd /mcp）
        const receivedCalls = []
        const server = createServer(async (req, res) => {
            if (req.method === 'DELETE') {
                res.writeHead(204)
                return res.end()
            }
            if (req.method !== 'POST') {
                res.writeHead(405)
                return res.end()
            }
            let raw = ''
            for await (const chunk of req) raw += chunk
            const rpc = JSON.parse(raw)
            if (rpc.id === undefined) {
                res.writeHead(202)
                return res.end()
            }
            let result
            if (rpc.method === 'initialize') {
                res.setHeader('Mcp-Session-Id', 'mcp-test-session')
                result = {
                    protocolVersion: rpc.params?.protocolVersion ?? '2025-03-26',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'mock-kepler-mcp', version: '0.1.0' },
                }
            } else if (rpc.method === 'tools/list') {
                result = {
                    tools: [
                        {
                            name: 'remote_echo',
                            description: '远端回显工具',
                            inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
                        },
                        {
                            name: 'remote_danger',
                            description: '需要审批的远端高危工具',
                            inputSchema: { type: 'object', properties: {} },
                            annotations: { destructiveHint: true },
                            _meta: { requireApproval: true },
                        },
                    ],
                }
            } else if (rpc.method === 'tools/call') {
                receivedCalls.push(rpc.params)
                result = {
                    content: [{ type: 'text', text: `echo:${rpc.params.arguments?.msg ?? 'ok'}` }],
                    isError: false,
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
        })
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
        const { port } = server.address()

        // 3. 挂载 McpTools：自动发现 2 个工具并注册进 ctx.tools
        const mcpPlugin = await app.plugin(McpTools, { url: `http://127.0.0.1:${port}/mcp` })
        assert.deepEqual(app.tools.list().map(tool => tool.name), ['remote_echo', 'remote_danger'])

        // 4. 经 AgentLoop 调用普通工具：透传 _meta（idempotencyKey = sessionId:toolCallId）
        const echoCall = { id: 'call-echo-1', name: 'remote_echo', arguments: '{"msg":"hello-mcp"}' }
        const dangerCall = { id: 'call-danger-1', name: 'remote_danger', arguments: '{}' }
        app.llm.registerAdapter('mcp-scripted', {
            async *stream({ messages }) {
                const last = messages.at(-1)
                if (last.role === 'user' && last.content === 'echo') return yield { type: 'tool-call', call: echoCall }
                if (last.role === 'user' && last.content === 'danger') return yield { type: 'tool-call', call: dangerCall }
                yield { type: 'text', text: `done:${last.content}` }
            },
        })

        const s1 = app.sessions.create('sess-mcp-1')
        const r1 = await app.agentLoop.submit(s1, 'echo')
        assert.equal(r1.status, 'completed')
        assert.equal(r1.text, 'done:echo:hello-mcp')
        assert.equal(receivedCalls.length, 1)
        assert.equal(receivedCalls[0]._meta.idempotencyKey, 'sess-mcp-1:call-echo-1')
        assert.equal(receivedCalls[0]._meta.sessionId, 'sess-mcp-1')
        assert.equal(receivedCalls[0]._meta.toolCallId, 'call-echo-1')
        assert.equal(receivedCalls[0]._meta.turnId, r1.turnId)

        // 5. 经 AgentLoop 调用带 requireApproval 元数据的远端工具 -> 自动挂起等待审批，未发往远端
        const s2 = app.sessions.create('sess-mcp-2')
        const r2 = await app.agentLoop.submit(s2, 'danger')
        assert.equal(r2.status, 'suspended')
        assert.equal(receivedCalls.length, 1)

        await s2.append({ type: 'approval-resolved', toolCallId: 'call-danger-1', approved: true }, r2.turnId)
        const r2Done = await app.agentLoop.resume(s2)
        assert.equal(r2Done.status, 'completed')
        assert.equal(receivedCalls.length, 2)
        assert.equal(receivedCalls[1]._meta.idempotencyKey, 'sess-mcp-2:call-danger-1')

        // 6. 卸载插件后自动从 ctx.tools 注销所有远端工具
        await mcpPlugin.dispose()
        assert.deepEqual(app.tools.list(), [])
    })
})
