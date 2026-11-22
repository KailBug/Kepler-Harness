// 会话 = 一条只追加的事件日志。发给模型的消息列表，是从日志推导出来的。
// 每条事件带有全局 id、会话内单调递增的 seq 和所属 turnId；
// 写入前经过 session/persist waterfall（Write-Ahead），落盘失败不会污染内存日志。

import { type Context, Service } from '@deepseek-ai/cordis'
import type { Message } from '@kepler/llm'
import type { SessionEvent, SessionEventPayload } from '@kepler/protocol'

export type { SessionEvent, SessionEventPayload }

type Awaitable<T> = T | Promise<T>

declare module '@deepseek-ai/cordis' {
    interface Context {
        sessions: SessionStore
    }
    interface Events {
        'session/created'(session: Session): void
        'session/restored'(session: Session): void
        'session/persist'(session: Session, event: SessionEvent, next: () => Awaitable<SessionEvent>): Awaitable<SessionEvent>
        'session/event'(session: Session, entry: SessionEvent): void
    }
}

export class Session {
    id: string
    createdAt: number
    log: SessionEvent[] = []
    private ctx: Context
    private writeTail: Promise<unknown> = Promise.resolve()

    constructor(ctx: Context, id: string, initialEvents: SessionEvent[] = []) {
        this.ctx = ctx
        this.id = id
        if (initialEvents.length) {
            let prevSeq = 0
            for (const event of initialEvents) {
                if (!Number.isInteger(event.seq) || event.seq <= prevSeq) {
                    throw new Error(`invalid session event seq: ${event.seq} after ${prevSeq}`)
                }
                if (event.sessionId && event.sessionId !== id) {
                    throw new Error(`event sessionId "${event.sessionId}" does not match "${id}"`)
                }
                prevSeq = event.seq
            }
            this.log = initialEvents.map(event => ({ ...event, sessionId: id }))
            this.createdAt = this.log[0].ts
        } else {
            this.createdAt = Date.now()
        }
    }

    get lastSeq(): number {
        return this.log.at(-1)?.seq ?? 0
    }

    get updatedAt(): number {
        return this.log.at(-1)?.ts ?? this.createdAt
    }

    get currentTurnId(): string | undefined {
        return this.log.at(-1)?.turnId
    }

    // Write-Ahead 追加事件：串行分配 seq，先通过 session/persist 落盘，再写入内存并广播。
    append(payload: SessionEventPayload, turnId?: string): Promise<SessionEvent> {
        const task = this.writeTail.catch(() => {}).then(async () => {
            const resolvedTurnId = turnId ?? this.currentTurnId ?? crypto.randomUUID()
            const candidate = {
                ...payload,
                id: crypto.randomUUID(),
                seq: this.lastSeq + 1,
                sessionId: this.id,
                turnId: resolvedTurnId,
                ts: Date.now(),
            } as SessionEvent
            const persisted = await this.ctx.waterfall('session/persist', this, candidate, () => candidate)
            this.log.push(persisted)
            this.ctx.emit('session/event', this, persisted)
            return persisted
        })
        this.writeTail = task
        return task
    }

    eventsSince(sinceSeq = 0): SessionEvent[] {
        return this.log.filter(event => event.seq > sinceSeq)
    }

    // 返回当前尚未收到 approval-resolved 的审批请求
    pendingApprovals(): Extract<SessionEvent, { type: 'approval-requested' }>[] {
        const pending = new Map<string, Extract<SessionEvent, { type: 'approval-requested' }>>()
        for (const event of this.log) {
            if (event.type === 'approval-requested') pending.set(event.toolCallId, event)
            else if (event.type === 'approval-resolved') pending.delete(event.toolCallId)
        }
        return [...pending.values()]
    }

    // 从日志推导出发给模型的消息（审批与轮次控制事件不进入模型上下文）
    deriveMessages(): Message[] {
        const messages: Message[] = []
        for (const event of this.log) {
            if (event.type === 'user') messages.push({ role: 'user', content: event.text })
            else if (event.type === 'assistant') messages.push({ role: 'assistant', content: event.text, toolCalls: event.toolCalls })
            else if (event.type === 'tool-result') messages.push({ role: 'tool', content: event.content, toolCallId: event.toolCallId })
        }
        return messages
    }
}

export class SessionStore extends Service {
    private sessions = new Map<string, Session>()

    constructor(ctx: Context) {
        super(ctx, 'sessions')
        ctx.effect(() => () => this.sessions.clear())
    }

    create(id: string = crypto.randomUUID()) {
        const session = new Session(this.ctx, id)
        this.sessions.set(id, session)
        this.ctx.emit('session/created', session)
        return session
    }

    // 从已有事件日志恢复会话（用于进程重启后本地恢复或 Worker 接管任务）
    restore(id: string, events: SessionEvent[]) {
        const session = new Session(this.ctx, id, events)
        this.sessions.set(id, session)
        this.ctx.emit('session/restored', session)
        return session
    }

    get(id: string) {
        return this.sessions.get(id)
    }

    list() {
        return [...this.sessions.values()]
    }
}

export default SessionStore
