import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { SessionInfo, SessionStatus, TurnStatus } from '@kepler/protocol'
import { api } from './api.ts'
import { buildTimeline, formatArgs, toolState, type ToolState, type ToolView } from './timeline.ts'
import { useSessionStream } from './useSessionStream.ts'

const STATUS_TEXT: Record<SessionStatus, string> = {
    idle: '空闲',
    running: '运行中',
    waiting_approval: '等待审批',
}

const TURN_TEXT: Record<TurnStatus, string> = {
    completed: '',
    'max-steps': '达到最大步数，已停止',
    suspended: '已挂起，等待审批',
    failed: '执行失败',
    cancelled: '已取消',
}

const TOOL_TEXT: Record<ToolState, string> = {
    pending: '执行中',
    waiting: '等待审批',
    denied: '已拒绝',
    done: '完成',
    error: '出错',
}

function readHash() {
    return /^#\/s\/(.+)$/.exec(location.hash)?.[1] ?? null
}

export function App() {
    const [sessions, setSessions] = useState<SessionInfo[]>([])
    const [current, setCurrent] = useState<string | null>(readHash)
    const [notice, setNotice] = useState<string | null>(null)
    const stream = useSessionStream(current)

    const refresh = useCallback(() => {
        api.listSessions().then(({ sessions }) => setSessions(sessions)).catch(error => setNotice(error.message))
    }, [])

    useEffect(refresh, [refresh, stream.status, stream.events.length === 0])
    useEffect(() => {
        const onHash = () => setCurrent(readHash())
        addEventListener('hashchange', onHash)
        return () => removeEventListener('hashchange', onHash)
    }, [])

    const open = (id: string) => {
        location.hash = `#/s/${id}`
    }

    const run = async (action: () => Promise<unknown>) => {
        setNotice(null)
        try {
            await action()
        } catch (error) {
            setNotice(error instanceof Error ? error.message : String(error))
        }
    }

    const create = () => run(async () => {
        const { session } = await api.createSession()
        setSessions(list => [session, ...list])
        open(session.id)
    })

    const send = (text: string) => run(async () => {
        let id = current
        if (!id) {
            const { session } = await api.createSession()
            id = session.id
            open(id)
        }
        await api.sendMessage(id, text)
    })

    return (
        <div className="layout">
            <aside className="sidebar">
                <div className="brand">
                    <strong>Kepler Harness</strong>
                    <span>Harness Kernel · 本地模式</span>
                </div>
                <button className="new" onClick={create}>＋ 新会话</button>
                <nav>
                    {sessions.map(session => (
                        <a
                            key={session.id}
                            href={`#/s/${session.id}`}
                            className={session.id === current ? 'active' : ''}
                        >
                            <span className="title">{session.title || '新会话'}</span>
                            {session.status !== 'idle' && <span className={`dot ${session.status}`} title={STATUS_TEXT[session.status]} />}
                        </a>
                    ))}
                </nav>
            </aside>

            <main>
                <header className="topbar">
                    <span>{sessions.find(session => session.id === current)?.title || (current ? '新会话' : '开始一个新会话')}</span>
                    {current && (
                        <span className={`badge ${stream.status}`}>
                            {stream.connected ? STATUS_TEXT[stream.status] : '连接中…'}
                        </span>
                    )}
                </header>
                <Conversation
                    sessionId={current}
                    stream={stream}
                    onAction={run}
                />
                {(notice || stream.error) && <div className="notice">{notice ?? stream.error}</div>}
                <Composer
                    busy={stream.status !== 'idle'}
                    onSend={send}
                    onCancel={() => current && run(() => api.cancel(current))}
                />
            </main>
        </div>
    )
}

function Conversation({ sessionId, stream, onAction }: {
    sessionId: string | null
    stream: ReturnType<typeof useSessionStream>
    onAction: (action: () => Promise<unknown>) => void
}) {
    const items = useMemo(() => buildTimeline(stream.events), [stream.events])
    const bottom = useRef<HTMLDivElement>(null)
    useEffect(() => {
        bottom.current?.scrollIntoView({ block: 'end' })
    }, [items, stream.draft])

    if (!sessionId) {
        return (
            <section className="conversation empty">
                <p>输入问题开始对话，左侧可以切换或新建会话。</p>
            </section>
        )
    }

    return (
        <section className="conversation">
            {items.map(item => {
                switch (item.kind) {
                    case 'user':
                        return <div key={item.key} className="msg user">{item.text}</div>
                    case 'assistant':
                        return <div key={item.key} className="msg assistant">{item.text}</div>
                    case 'tool':
                        return (
                            <ToolCard
                                key={item.key}
                                tool={item.tool}
                                onResolve={(approved) => onAction(() => api.resolveApproval(sessionId, item.tool.call.id, { approved }))}
                            />
                        )
                    case 'turn-ended':
                        if (item.status === 'completed' || item.status === 'suspended') return null
                        return (
                            <div key={item.key} className={`turn-ended ${item.status}`}>
                                <span>{TURN_TEXT[item.status]}{item.error ? `：${item.error}` : ''}</span>
                                {item.last && item.status === 'failed' && stream.status === 'idle' && (
                                    <button onClick={() => onAction(() => api.resume(sessionId))}>重试</button>
                                )}
                            </div>
                        )
                }
            })}
            {stream.draft?.text && <div className="msg assistant streaming">{stream.draft.text}</div>}
            {stream.status === 'running' && !stream.draft?.text && <div className="thinking">思考中…</div>}
            <div ref={bottom} />
        </section>
    )
}

function ToolCard({ tool, onResolve }: { tool: ToolView; onResolve: (approved: boolean) => void }) {
    const state = toolState(tool)
    const [open, setOpen] = useState(state === 'waiting')
    useEffect(() => {
        if (state === 'waiting') setOpen(true)
    }, [state])

    return (
        <div className={`tool ${state}`}>
            <button className="tool-head" onClick={() => setOpen(!open)}>
                <span className="tool-name">⚙ {tool.call.name}</span>
                <span className="tool-state">{TOOL_TEXT[state]}</span>
            </button>
            {open && (
                <div className="tool-body">
                    <pre>{formatArgs(tool.call.arguments)}</pre>
                    {tool.result && <pre className="result">{tool.result.content}</pre>}
                    {tool.resolution?.reason && <p className="reason">审批意见：{tool.resolution.reason}</p>}
                </div>
            )}
            {state === 'waiting' && (
                <div className="approval">
                    <span>{tool.approval?.reason ?? '该工具需要人工审批'}</span>
                    <button className="deny" onClick={() => onResolve(false)}>拒绝</button>
                    <button className="approve" onClick={() => onResolve(true)}>批准</button>
                </div>
            )}
        </div>
    )
}

function Composer({ busy, onSend, onCancel }: { busy: boolean; onSend: (text: string) => void; onCancel: () => void }) {
    const [text, setText] = useState('')
    const input = useRef<HTMLTextAreaElement>(null)

    const submit = (event?: FormEvent) => {
        event?.preventDefault()
        const value = text.trim()
        if (!value || busy) return
        setText('')
        onSend(value)
    }

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
    }

    useEffect(() => {
        const el = input.current
        if (!el) return
        el.style.height = ''
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    }, [text])

    return (
        <form className="composer" onSubmit={submit}>
            <textarea
                ref={input}
                rows={1}
                value={text}
                placeholder="输入问题，Enter 发送，Shift+Enter 换行"
                onChange={event => setText(event.target.value)}
                onKeyDown={onKeyDown}
                autoFocus
            />
            {busy
                ? <button type="button" className="cancel" onClick={onCancel}>停止</button>
                : <button type="submit" disabled={!text.trim()}>发送</button>}
        </form>
    )
}
