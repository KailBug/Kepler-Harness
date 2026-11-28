// W3 端到端功能与安全验收测试：
// 真实 PostgreSQL 16 + 真实 Go keplerd（Runtime + MCP Gateway + gVisor runsc 沙箱）
// + 真实 TS Kepler-Harness Worker（@kepler/tools-mcp 官方 MCP SDK）。
//
// 运行前提：
//   1. wsl -e docker compose -f /mnt/d/Kepler/deploy/compose.yaml --profile core up -d
//   2. go build -o D:\Kepler\bin\keplerd.exe ./cmd/keplerd
// 运行方式：
//   npm run test:e2e:w3

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as agentSpine from '@kepler/agent-spine'
import RemoteSessionStore from '@kepler/session-remote'
import McpTools from '@kepler/tools-mcp'
import KeplerWorker from '@kepler/worker'

const KEPLERD_BIN = process.env.KEPLERD_BIN ?? resolve('..', 'Kepler', 'bin', process.platform === 'win32' ? 'keplerd.exe' : 'keplerd')
const DATABASE_URL = process.env.KEPLER_DATABASE_URL ?? 'postgres://kepler:kepler_dev_password@127.0.0.1:5432/kepler?sslmode=disable'
const DOCKER_CMD = process.env.KEPLER_DOCKER_CMD ?? (process.platform === 'win32' ? 'wsl -e docker' : 'docker')
const SANDBOX_RUNTIME = process.env.KEPLER_SANDBOX_RUNTIME ?? 'runsc'
const HTTP_ADDR = process.env.KEPLER_W3_ADDR ?? '127.0.0.1:18081'
const BASE_URL = `http://${HTTP_ADDR}`
const TOP_SECRET = 'kepler-w3-top-secret-9527'

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
    const timeout = setTimeout(() => abort.abort(new Error('SSE read timeout')), 45_000)
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

describe('Kepler W3 端到端安全与功能验收 (PG + keplerd + gVisor runsc + MCP Gateway + TS Worker)', () => {
    it('满足 4 项硬指标：沙箱执行、逃逸与断网拦截、凭证隔离与审批脱敏、幂等防重入', async t => {
        assert.ok(existsSync(KEPLERD_BIN), `未找到 keplerd 二进制：${KEPLERD_BIN}`)

        // 1. 启动受控上游业务 API 桩：校验网关注入的 Bearer 密钥并故意回显（测试脱敏防线）
        let upstreamHits = 0
        let lastAuthHeader = ''
        let lastIdemHeader = ''
        const upstream = createServer(async (req, res) => {
            upstreamHits++
            lastAuthHeader = String(req.headers.authorization ?? '')
            lastIdemHeader = String(req.headers['idempotency-key'] ?? '')
            let body = ''
            for await (const chunk of req) body += chunk
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                charged: true,
                body: body ? JSON.parse(body) : null,
                echoSecret: lastAuthHeader,
            }))
        })
        await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
        t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve) }))
        const upstreamPort = upstream.address().port

        const proxyTargets = JSON.stringify([{
            name: 'billing_api',
            baseUrl: `http://127.0.0.1:${upstreamPort}`,
            secret: TOP_SECRET,
            allowedMethods: ['POST'],
            requireApproval: true,
        }])

        // 2. 启动真实 Go keplerd（PG + MCP Gateway + gVisor runsc 沙箱）
        const keplerdLogs = []
        const keplerd = spawn(KEPLERD_BIN, [], {
            env: {
                ...process.env,
                KEPLER_HTTP_ADDR: HTTP_ADDR,
                KEPLER_STORE: 'postgres',
                KEPLER_DATABASE_URL: DATABASE_URL,
                KEPLER_DOCKER_CMD: DOCKER_CMD,
                KEPLER_SANDBOX_RUNTIME: SANDBOX_RUNTIME,
                KEPLER_PROXY_TARGETS: proxyTargets,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        keplerd.stdout.on('data', c => keplerdLogs.push(c.toString()))
        keplerd.stderr.on('data', c => keplerdLogs.push(c.toString()))
        t.after(() => {
            if (!keplerd.killed) keplerd.kill()
        })

        await waitHealthy(BASE_URL).catch(err => {
            throw new Error(`${err.message}\nkeplerd logs:\n${keplerdLogs.join('')}`)
        })
        const statusBody = await (await fetch(`${BASE_URL}/api/v1/status`)).json()
        assert.deepEqual(statusBody.modules, ['runtime', 'gateway', 'api'])

        // 3. 启动真实 TS Kepler-Harness Worker（通过 @kepler/tools-mcp 自动发现工具）
        const app = new Context()
        t.after(() => app.fiber.dispose())

        await app.plugin(agentSpine, { persona: '你是 Kepler 助手。' })
        await app.plugin(McpTools, { url: `${BASE_URL}/mcp` })
        assert.deepEqual(app.tools.list().map(tool => tool.name), ['http_proxy', 'python_exec'])

        const escapeProbeCode = [
            'import os, socket',
            'results = []',
            'try:',
            '    socket.create_connection(("1.1.1.1", 80), timeout=2)',
            '    results.append("NETWORK_LEAK")',
            'except OSError:',
            '    results.append("NETWORK_BLOCKED")',
            'try:',
            '    open("/etc/kepler_pwn", "w").write("x")',
            '    results.append("ROFS_LEAK")',
            'except OSError:',
            '    results.append("ROFS_BLOCKED")',
            'if os.environ.get("KEPLER_PROXY_TARGETS") or os.environ.get("DEEPSEEK_API_KEY"):',
            '    results.append("SECRET_LEAK")',
            'else:',
            '    results.append("NO_HOST_SECRETS")',
            'print("|".join(results))',
        ].join('\n')

        app.llm.registerAdapter('w3-scripted', {
            async *stream({ messages }) {
                const last = messages.at(-1)
                if (last.role === 'user' && last.content.includes('1 到 100')) {
                    yield {
                        type: 'tool-call',
                        call: { id: 'call-py-sum', name: 'python_exec', arguments: JSON.stringify({ code: 'print(sum(range(1, 101)))' }) },
                    }
                    return
                }
                if (last.role === 'user' && last.content.includes('安全隔离')) {
                    yield {
                        type: 'tool-call',
                        call: { id: 'call-py-sec', name: 'python_exec', arguments: JSON.stringify({ code: escapeProbeCode }) },
                    }
                    return
                }
                if (last.role === 'user' && last.content.includes('计费接口')) {
                    yield {
                        type: 'tool-call',
                        call: {
                            id: 'call-proxy-1',
                            name: 'http_proxy',
                            arguments: JSON.stringify({
                                target: 'billing_api',
                                method: 'POST',
                                path: '/v1/charges',
                                body: { amount: 88 },
                            }),
                        },
                    }
                    return
                }
                if (last.role === 'tool') {
                    yield { type: 'text', text: `工具返回：${last.content}` }
                    return
                }
                yield { type: 'text', text: 'ok' }
            },
        })

        await app.plugin(RemoteSessionStore, { baseUrl: BASE_URL, strict: true })
        await app.plugin(KeplerWorker, {
            workerId: `w3-worker-${Date.now()}`,
            waitTimeoutMs: 5_000,
            renewIntervalMs: 3_000,
        })

        // 创建会话
        const { session } = await (await fetch(`${BASE_URL}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'kepler-w3' }),
        })).json()

        // ---- 验收 1：Agent 经 MCP 在真实 gVisor 沙箱内跑通 python_exec ----
        const turn1Done = readSseUntil(
            `${BASE_URL}/api/sessions/${session.id}/events`,
            (_frame, all) => {
                const ended = all.some(f => f.event === 'event' && f.data.type === 'turn-ended' && f.data.status === 'completed')
                return ended && all.at(-1)?.event === 'status' && all.at(-1)?.data.status === 'idle'
            },
        )
        const m1 = await fetch(`${BASE_URL}/api/sessions/${session.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '用 Python 算 1 到 100 的和' }),
        })
        assert.equal(m1.status, 202)
        const turn1Frames = await turn1Done
        const turn1Events = turn1Frames.filter(f => f.event === 'event').map(f => f.data)
        const pySumResult = turn1Events.find(e => e.type === 'tool-result')
        assert.equal(pySumResult.content, '5050')
        let lastSeq = turn1Events.at(-1).seq

        // ---- 验收 2：沙箱内断网、只读根文件系统、宿主机密钥零泄露 ----
        const turn2Done = readSseUntil(
            `${BASE_URL}/api/sessions/${session.id}/events`,
            (_frame, all) => {
                const ended = all.some(f => f.event === 'event' && f.data.seq > lastSeq && f.data.type === 'turn-ended' && f.data.status === 'completed')
                return ended && all.at(-1)?.event === 'status' && all.at(-1)?.data.status === 'idle'
            },
            { 'Last-Event-ID': String(lastSeq) },
        )
        const m2 = await fetch(`${BASE_URL}/api/sessions/${session.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '测试沙箱安全隔离' }),
        })
        assert.equal(m2.status, 202)
        const turn2Frames = await turn2Done
        const turn2Events = turn2Frames.filter(f => f.event === 'event').map(f => f.data)
        const secResult = turn2Events.find(e => e.type === 'tool-result')
        assert.equal(secResult.content, 'NETWORK_BLOCKED|ROFS_BLOCKED|NO_HOST_SECRETS')
        lastSeq = turn2Events.at(-1).seq

        // ---- 验收 3：凭证代理注入 + 自动触发 HITL 审批 + Agent 返回与审计表零明文密钥 ----
        const suspendDone = readSseUntil(
            `${BASE_URL}/api/sessions/${session.id}/events`,
            frame => frame.event === 'status' && frame.data.status === 'waiting_approval',
            { 'Last-Event-ID': String(lastSeq) },
        )
        const m3 = await fetch(`${BASE_URL}/api/sessions/${session.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '调用外部计费接口' }),
        })
        assert.equal(m3.status, 202)
        const suspendFrames = await suspendDone
        const suspendEvents = suspendFrames.filter(f => f.event === 'event').map(f => f.data)
        assert.ok(suspendEvents.some(e => e.type === 'approval-requested' && e.name === 'http_proxy'))
        assert.equal(upstreamHits, 0, '审批前不应访问上游业务接口')
        lastSeq = suspendEvents.at(-1).seq

        const approveDone = readSseUntil(
            `${BASE_URL}/api/sessions/${session.id}/events`,
            (_frame, all) => {
                const ended = all.some(f => f.event === 'event' && f.data.seq > lastSeq && f.data.type === 'turn-ended' && f.data.status === 'completed')
                return ended && all.at(-1)?.event === 'status' && all.at(-1)?.data.status === 'idle'
            },
            { 'Last-Event-ID': String(lastSeq) },
        )
        const approveRes = await fetch(`${BASE_URL}/api/sessions/${session.id}/approvals/call-proxy-1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approved: true, reason: 'W3 验收批准' }),
        })
        assert.equal(approveRes.status, 202)
        const approveFrames = await approveDone
        const approveEvents = approveFrames.filter(f => f.event === 'event').map(f => f.data)
        const proxyResult = approveEvents.find(e => e.type === 'tool-result')

        assert.equal(upstreamHits, 1)
        assert.equal(lastAuthHeader, `Bearer ${TOP_SECRET}`)
        assert.equal(lastIdemHeader, `${session.id}:call-proxy-1`)
        assert.ok(proxyResult.content.includes('[REDACTED]'), `期望响应已脱敏，实际：${proxyResult.content}`)
        assert.ok(!proxyResult.content.includes(TOP_SECRET), 'Agent 返回中严禁出现明文密钥')

        // ---- 验收 4：相同 Idempotency-Key 重复调用 MCP tools/call 命中 PG 幂等缓存，副作用仍仅执行 1 次 ----
        const replayRpc = await fetch(`${BASE_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': `${session.id}:call-proxy-1`,
                'X-Kepler-Session-Id': session.id,
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 99,
                method: 'tools/call',
                params: {
                    name: 'http_proxy',
                    arguments: { target: 'billing_api', method: 'POST', path: '/v1/charges', body: { amount: 88 } },
                },
            }),
        })
        assert.equal(replayRpc.status, 200)
        const replayBody = await replayRpc.json()
        assert.equal(replayBody.result.content[0].text, proxyResult.content)
        assert.equal(upstreamHits, 1, '重复幂等键不应再次请求上游')

        // 核对审计 API：包含 python_exec (2) + http_proxy ok (1) + http_proxy cached (1)，且全程零明文密钥
        const auditRes = await fetch(`${BASE_URL}/api/v1/audit?sessionId=${encodeURIComponent(session.id)}`)
        assert.equal(auditRes.status, 200)
        const { entries } = await auditRes.json()
        assert.equal(entries.length, 4)
        assert.equal(entries[0].toolName, 'http_proxy')
        assert.equal(entries[0].status, 'cached')
        assert.equal(entries[1].toolName, 'http_proxy')
        assert.equal(entries[1].status, 'ok')
        for (const entry of entries) {
            const raw = JSON.stringify(entry)
            assert.ok(!raw.includes(TOP_SECRET), `审计日志不得泄露明文密钥: ${raw}`)
        }
    })
})
