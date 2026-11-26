// W2 端到端跨语言验收测试：
// 真实 PostgreSQL + 真实 Go keplerd（Connect-RPC + HTTP/SSE）+ 真实 TS Kepler-Harness Worker。
//
// 运行前提：
//   1. docker compose -f D:\Kepler\deploy\compose.yaml --profile core up -d
//   2. go build -o D:\Kepler\bin\keplerd.exe ./cmd/keplerd
// 运行方式：
//   npm run test:e2e

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Code, ConnectError } from '@connectrpc/connect'
import * as agentSpine from '@kepler/agent-spine'
import RemoteSessionStore, { createWorkerClient, toProtoEvent } from '@kepler/session-remote'
import KeplerWorker from '@kepler/worker'

const KEPLERD_BIN = process.env.KEPLERD_BIN ?? resolve('..', 'Kepler', 'bin', process.platform === 'win32' ? 'keplerd.exe' : 'keplerd')
const DATABASE_URL = process.env.KEPLER_DATABASE_URL ?? 'postgres://kepler:kepler_dev_password@127.0.0.1:5432/kepler?sslmode=disable'
const HTTP_ADDR = process.env.KEPLER_E2E_ADDR ?? '127.0.0.1:18080'
const BASE_URL = `http://${HTTP_ADDR}`

async function waitHealthy(url, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${url}/healthz`)
            if (res.ok) return
        } catch {
            // 等待服务拉起
        }
        await new Promise(r => setTimeout(r, 100))
    }
    throw new Error(`keplerd at ${url} did not become healthy within ${timeoutMs}ms`)
}

async function readSseUntil(url, stopWhen, headers = {}) {
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(new Error('SSE read timeout')), 15_000)
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
        if (abort.signal.reason instanceof Error && abort.signal.reason.message === 'SSE read timeout') {
            throw abort.signal.reason
        }
    } finally {
        clearTimeout(timeout)
    }
    return frames
}

describe('Kepler W2 跨语言端到端联调 (PG + keplerd + TS Worker)', () => {
    it('完整主链路：建会话 -> 发消息 -> TS Worker 调工具并 Write-Ahead 落盘 -> SSE 实时收回复与断线续传 -> HITL 审批 -> 僵尸 epoch 拒绝', async t => {
        assert.ok(existsSync(KEPLERD_BIN), `未找到 keplerd 二进制：${KEPLERD_BIN}`)

        // 1. 启动真实 keplerd（连接真实 PostgreSQL）
        const logs = []
        const keplerd = spawn(KEPLERD_BIN, [], {
            env: {
                ...process.env,
                KEPLER_HTTP_ADDR: HTTP_ADDR,
                KEPLER_STORE: 'postgres',
                KEPLER_DATABASE_URL: DATABASE_URL,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        keplerd.stdout.on('data', chunk => logs.push(chunk.toString()))
        keplerd.stderr.on('data', chunk => logs.push(chunk.toString()))
        t.after(() => {
            if (!keplerd.killed) keplerd.kill()
        })

        await waitHealthy(BASE_URL)
        const statusRes = await fetch(`${BASE_URL}/api/v1/status`)
        const statusBody = await statusRes.json()
        assert.deepEqual(statusBody.modules, ['runtime', 'api'])

        // 2. 启动真实 TS Kepler-Harness Worker（内核零改动，通过插件接入 keplerd）
        const app = new Context()
        t.after(() => app.fiber.dispose())

        let addRuns = 0
        let dangerRuns = 0
        await app.plugin(agentSpine, { persona: '你是 Kepler 助手。' })
        app.tools.register({
            name: 'add',
            description: '计算两个数的和',
            parameters: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
                required: ['a', 'b'],
            },
            execute: ({ a, b }) => {
                addRuns++
                return String(a + b)
            },
        })
        app.tools.register({
            name: 'danger_op',
            description: '需要人工审批的高危操作',
            parameters: {
                type: 'object',
                properties: { target: { type: 'string' } },
                required: ['target'],
            },
            requireApproval: true,
            execute: ({ target }) => {
                dangerRuns++
                return `已执行:${target}`
            },
        })
        app.llm.registerAdapter('scripted', {
            async *stream({ messages }) {
                const last = messages.at(-1)
                if (last.role === 'user' && last.content.includes('2 + 3')) {
                    yield { type: 'tool-call', call: { id: 'call-add-1', name: 'add', arguments: '{"a":2,"b":3}' } }
                    return
                }
                if (last.role === 'user' && last.content.includes('高危')) {
                    yield { type: 'tool-call', call: { id: 'call-danger-1', name: 'danger_op', arguments: '{"target":"prod"}' } }
                    return
                }
                if (last.role === 'tool') {
                    yield { type: 'text', text: `结果：${last.content}` }
                    return
                }
                yield { type: 'text', text: '收到' }
            },
        })

        const workerId = `e2e-worker-${Date.now()}`
        await app.plugin(RemoteSessionStore, { baseUrl: BASE_URL, strict: true })
        await app.plugin(KeplerWorker, {
            workerId,
            waitTimeoutMs: 5_000,
            renewIntervalMs: 3_000,
        })

        // 3. 创建会话 -> 订阅 SSE -> 发送消息
        const createRes = await fetch(`${BASE_URL}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'kepler-e2e' }),
        })
        assert.equal(createRes.status, 201)
        const { session } = await createRes.json()
        assert.ok(session.id)

        const turn1Promise = readSseUntil(
            `${BASE_URL}/api/sessions/${session.id}/events`,
            (_frame, all) => {
                const ended = all.some(f => f.event === 'event' && f.data.type === 'turn-ended' && f.data.status === 'completed')
                return ended && all.at(-1)?.event === 'status' && all.at(-1)?.data.status === 'idle'
            },
        )

        const msgRes = await fetch(`${BASE_URL}/api/sessions/${session.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '请计算 2 + 3' }),
        })
        assert.equal(msgRes.status, 202)
        const { turnId } = await msgRes.json()
        assert.ok(turnId)

        const turn1Frames = await turn1Promise
        const turn1Events = turn1Frames.filter(f => f.event === 'event').map(f => f.data)
        assert.deepEqual(turn1Events.map(e => [e.seq, e.type]), [
            [1, 'user'],
            [2, 'assistant'],
            [3, 'tool-result'],
            [4, 'assistant'],
            [5, 'turn-ended'],
        ])
        assert.equal(turn1Events[3].text, '结果：5')
        assert.equal(addRuns, 1)

        // 4. 验证 SSE Last-Event-ID 断线续传：只补发 seq > 3 的事件
        const replayFrames = await readSseUntil(
            `${BASE_URL}/api/sessions/${session.id}/events`,
            frame => frame.event === 'status' && frame.data.status === 'idle',
            { 'Last-Event-ID': '3' },
        )
        const replayEvents = replayFrames.filter(f => f.event === 'event').map(f => f.data)
        assert.deepEqual(replayEvents.map(e => e.seq), [4, 5])

        // 5. 跨语言 HITL 审批闭环：挂起 -> 批准 -> 从 PG 恢复继续执行
        const suspendPromise = readSseUntil(
            `${BASE_URL}/api/sessions/${session.id}/events`,
            frame => frame.event === 'status' && frame.data.status === 'waiting_approval',
            { 'Last-Event-ID': '5' },
        )
        const msg2Res = await fetch(`${BASE_URL}/api/sessions/${session.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '执行高危操作' }),
        })
        assert.equal(msg2Res.status, 202)

        const suspendFrames = await suspendPromise
        const suspendEvents = suspendFrames.filter(f => f.event === 'event').map(f => f.data)
        assert.deepEqual(suspendEvents.map(e => [e.seq, e.type]), [
            [6, 'user'],
            [7, 'assistant'],
            [8, 'approval-requested'],
            [9, 'turn-ended'],
        ])
        assert.equal(dangerRuns, 0)

        const resumePromise = readSseUntil(
            `${BASE_URL}/api/sessions/${session.id}/events`,
            (_frame, all) => {
                const ended = all.some(f => f.event === 'event' && f.data.seq > 9 && f.data.type === 'turn-ended' && f.data.status === 'completed')
                return ended && all.at(-1)?.event === 'status' && all.at(-1)?.data.status === 'idle'
            },
            { 'Last-Event-ID': '9' },
        )
        const approveRes = await fetch(`${BASE_URL}/api/sessions/${session.id}/approvals/call-danger-1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approved: true, reason: 'E2E 批准' }),
        })
        assert.equal(approveRes.status, 202)

        const resumeFrames = await resumePromise
        const resumeEvents = resumeFrames.filter(f => f.event === 'event').map(f => f.data)
        assert.deepEqual(resumeEvents.map(e => [e.seq, e.type]), [
            [10, 'approval-resolved'],
            [11, 'tool-result'],
            [12, 'assistant'],
            [13, 'turn-ended'],
        ])
        assert.equal(resumeEvents[2].text, '结果：已执行:prod')
        assert.equal(dangerRuns, 1)

        // 6. 僵尸 epoch 写入被真实 keplerd + PostgreSQL 拒绝（FailedPrecondition）
        const rawClient = createWorkerClient(BASE_URL)
        await assert.rejects(
            rawClient.appendEvents({
                sessionId: session.id,
                leaseId: 'stale-lease',
                epoch: 1n,
                events: [toProtoEvent({
                    id: 'zombie-1',
                    seq: 14,
                    sessionId: session.id,
                    turnId,
                    ts: Date.now(),
                    type: 'assistant',
                    text: 'zombie write',
                })],
            }),
            (err) => err instanceof ConnectError && err.code === Code.FailedPrecondition,
        )

        // 7. 核对 GET /api/sessions/{id} 完整事件序列仍为 1..13（僵尸写入未落盘）
        const detailRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`)
        assert.equal(detailRes.status, 200)
        const detail = await detailRes.json()
        assert.equal(detail.session.status, 'idle')
        assert.equal(detail.session.lastSeq, 13)
        assert.equal(detail.events.length, 13)
        assert.deepEqual(detail.events.map(e => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    })
})
