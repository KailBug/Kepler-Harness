// Harness 的本地网页入口。
//
// 命令与事件流分离，语义与 Kepler 用户面一致（见 @kepler/protocol）：
//   - GET  /api/sessions
//   - POST /api/sessions
//   - GET  /api/sessions/:id
//   - GET  /api/sessions/:id/events?since=seq   (SSE，支持 Last-Event-ID 断线续传)
//   - POST /api/sessions/:id/messages           (提交输入，202 立即返回 turnId)
//   - POST /api/sessions/:id/approvals/:toolCallId (HITL 审批，202 恢复执行)
//   - POST /api/sessions/:id/resume             (失败后重试 / 恢复执行)
//   - POST /api/sessions/:id/cancel             (取消当前 Turn)

import type { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
    CreateSessionResponse, GetSessionResponse, ListSessionsResponse, SendMessageResponse,
    SessionInfo, SessionStatus, StreamFrameName, StreamFrames,
} from '@kepler/protocol'
import type {} from '@kepler/agent-loop'
import type { Session } from '@kepler/session'
import { HttpError, readJson, Router, sendError, sendJson, serveStatic } from './http.ts'

export interface ListenInfo {
    host: string
    port: number
    url: string
}

export interface Config {
    port?: number
    host?: string
    // 前端构建产物目录（里面要有 index.html）。不配置则只提供 API。
    staticDir?: string
    // SSE 心跳间隔，防止代理断开空闲连接
    heartbeatMs?: number
    // 服务开始监听后的回调（测试使用 port: 0 时可拿到实际地址）
    onListen?: (info: ListenInfo) => void
}

export const name = 'webserver'
export const inject = ['agentLoop', 'sessions']

export async function apply(ctx: Context, config: Config = {}) {
    const { port = 3000, host = '127.0.0.1', staticDir, heartbeatMs = 15_000, onListen } = config
    const logger = ctx.logger('webserver')

    const running = new Map<string, AbortController>()

    function getSession(id: string): Session {
        const session = ctx.sessions.get(id)
        if (!session) throw new HttpError(404, 'not_found', `session "${id}" not found`)
        return session
    }

    function sessionStatus(session: Session): SessionStatus {
        if (running.has(session.id)) return 'running'
        if (session.pendingApprovals().length) return 'waiting_approval'
        return 'idle'
    }

    function info(session: Session): SessionInfo {
        const first = session.log.find(entry => entry.type === 'user')
        return {
            id: session.id,
            title: first?.type === 'user' ? first.text.slice(0, 40) : '',
            status: sessionStatus(session),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            lastSeq: session.lastSeq,
        }
    }

    // 每个 SSE 连接一个订阅者
    type Send = <K extends StreamFrameName>(name: K, data: StreamFrames[K], id?: number) => void
    const subscribers = new Map<string, Set<Send>>()
    const broadcast = <K extends StreamFrameName>(sessionId: string, name: K, data: StreamFrames[K], id?: number) => {
        for (const send of subscribers.get(sessionId) ?? []) send(name, data, id)
    }

    ctx.on('session/event', (session, event) => {
        broadcast(session.id, 'event', event, event.seq)
    })
    ctx.on('agent/text-delta', (session, text, turnId) => {
        broadcast(session.id, 'delta', { turnId: turnId ?? session.currentTurnId ?? '', text })
    })
    ctx.on('agent/status', (session) => {
        if (ctx.sessions.get(session.id)) {
            broadcast(session.id, 'status', { status: sessionStatus(session) })
        }
    })

    function startResume(session: Session) {
        if (running.has(session.id)) throw new HttpError(409, 'conflict', 'session is busy')
        const abort = new AbortController()
        running.set(session.id, abort)
        broadcast(session.id, 'status', { status: 'running' })
        ctx.agentLoop.resume(session, abort.signal)
            .catch((error) => {
                if (abort.signal.aborted) return
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('turn failed: %s', message)
                broadcast(session.id, 'status', { status: sessionStatus(session), error: message })
            })
            .finally(() => {
                running.delete(session.id)
                if (ctx.sessions.get(session.id)) {
                    broadcast(session.id, 'status', { status: sessionStatus(session) })
                }
            })
    }

    function subscribe(req: IncomingMessage, res: ServerResponse, sessionId: string, url: URL) {
        const session = getSession(sessionId)
        const raw = url.searchParams.get('since') ?? req.headers['last-event-id'] ?? '0'
        const since = Number(raw)
        if (!Number.isInteger(since) || since < 0) {
            throw new HttpError(400, 'bad_request', 'since must be a non-negative integer')
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        })
        let lastSeq = since
        const send: Send = (name, data, id) => {
            if (id !== undefined) {
                if (id <= lastSeq) return
                lastSeq = id
            }
            res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        res.write('retry: 2000\n\n')
        // 补发和注册订阅在同一个同步块里完成，中间不会漏掉事件
        for (const event of session.eventsSince(since)) send('event', event, event.seq)
        send('status', { status: sessionStatus(session) })

        let set = subscribers.get(sessionId)
        if (!set) subscribers.set(sessionId, set = new Set())
        set.add(send)

        const timer = setInterval(() => res.write(': ping\n\n'), heartbeatMs)
        res.on('close', () => {
            clearInterval(timer)
            set.delete(send)
            if (!set.size) subscribers.delete(sessionId)
        })
    }

    const router = new Router()
        .add('GET', '/api/sessions', (_req, res) => {
            const sessions = ctx.sessions.list().map(info).sort((a, b) => b.updatedAt - a.updatedAt)
            sendJson(res, 200, { sessions } satisfies ListSessionsResponse)
        })
        .add('POST', '/api/sessions', async (req, res) => {
            await readJson(req)
            const session = ctx.sessions.create()
            sendJson(res, 201, { session: info(session) } satisfies CreateSessionResponse)
        })
        .add('GET', '/api/sessions/:id', (_req, res, [id]) => {
            const session = getSession(id)
            sendJson(res, 200, { session: info(session), events: session.log } satisfies GetSessionResponse)
        })
        .add('GET', '/api/sessions/:id/events', (req, res, [id], url) => subscribe(req, res, id, url))
        .add('POST', '/api/sessions/:id/messages', async (req, res, [id]) => {
            const { text } = await readJson(req)
            if (typeof text !== 'string' || !text.trim()) {
                throw new HttpError(400, 'bad_request', 'text must be a non-empty string')
            }
            const session = getSession(id)
            if (running.has(id)) throw new HttpError(409, 'conflict', 'session is busy')
            if (session.pendingApprovals().length) {
                throw new HttpError(409, 'conflict', 'session is waiting for approval')
            }

            const turnId = crypto.randomUUID()
            await session.append({ type: 'user', text }, turnId)
            startResume(session)
            sendJson(res, 202, { turnId } satisfies SendMessageResponse)
        })
        .add('POST', '/api/sessions/:id/approvals/:toolCallId', async (req, res, [id, toolCallId]) => {
            const { approved, reason } = await readJson(req)
            if (typeof approved !== 'boolean') {
                throw new HttpError(400, 'bad_request', 'approved must be a boolean')
            }
            if (reason !== undefined && typeof reason !== 'string') {
                throw new HttpError(400, 'bad_request', 'reason must be a string')
            }
            const session = getSession(id)
            if (running.has(id)) throw new HttpError(409, 'conflict', 'session is busy')
            const pending = session.pendingApprovals().find(item => item.toolCallId === toolCallId)
            if (!pending) {
                throw new HttpError(404, 'not_found', `no pending approval for toolCallId "${toolCallId}"`)
            }

            await session.append({ type: 'approval-resolved', toolCallId, approved, reason }, pending.turnId)
            startResume(session)
            sendJson(res, 202, {})
        })
        .add('POST', '/api/sessions/:id/resume', (_req, res, [id]) => {
            const session = getSession(id)
            startResume(session)
            sendJson(res, 202, {})
        })
        .add('POST', '/api/sessions/:id/cancel', (_req, res, [id]) => {
            getSession(id)
            running.get(id)?.abort()
            sendJson(res, 202, {})
        })

    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        try {
            if (await router.handle(req, res, url)) return
            if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', 'not found')
            if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'bad_request', 'method not allowed')
            if (!staticDir) throw new HttpError(404, 'not_found', 'static files are not configured')
            await serveStatic(res, staticDir, url.pathname)
        } catch (error) {
            if (!(error instanceof HttpError)) logger.error(error)
            sendError(res, error)
        }
    })

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
            server.off('error', reject)
            resolve()
        })
    })
    const addr = server.address() as AddressInfo
    const listenInfo: ListenInfo = { host: addr.address, port: addr.port, url: `http://${addr.address}:${addr.port}` }
    logger.info(`网页端已启动：${listenInfo.url}`)
    onListen?.(listenInfo)

    // 插件卸载时中止运行中的 Turn 并关闭所有连接
    ctx.effect(() => () => new Promise<void>((resolve) => {
        for (const abort of running.values()) abort.abort()
        server.closeAllConnections()
        server.close(() => resolve())
    }))
}
