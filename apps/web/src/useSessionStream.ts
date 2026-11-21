// 订阅一个会话的事件流。状态完全由事件推导：events 按 seq 去重排序，delta 只是临时预览。

import { useEffect, useReducer } from 'react'
import type { SessionEvent, SessionStatus, StreamFrames } from '@kepler/protocol'
import { api } from './api.ts'

export interface StreamState {
    events: SessionEvent[]
    status: SessionStatus
    // 当前 Turn 正在流式输出、还没落成 assistant 事件的文本
    draft: { turnId: string; text: string } | null
    error: string | null
    connected: boolean
}

type Action =
    | { type: 'reset' }
    | { type: 'open' }
    | { type: 'disconnect' }
    | { type: 'event'; event: SessionEvent }
    | { type: 'delta'; delta: StreamFrames['delta'] }
    | { type: 'status'; status: StreamFrames['status'] }

const initial: StreamState = { events: [], status: 'idle', draft: null, error: null, connected: false }

function reducer(state: StreamState, action: Action): StreamState {
    switch (action.type) {
        case 'reset':
            return initial
        case 'open':
            return { ...state, connected: true }
        case 'disconnect':
            return { ...state, connected: false }
        case 'event': {
            const { event } = action
            if (state.events.length && event.seq <= state.events.at(-1)!.seq) return state
            // 模型的一步结束了：草稿由正式的 assistant 事件取代
            const draft = event.type === 'assistant' || event.type === 'turn-ended' ? null : state.draft
            const error = event.type === 'user' ? null : state.error
            return { ...state, events: [...state.events, event], draft, error }
        }
        case 'delta': {
            const { turnId, text } = action.delta
            const prev = state.draft?.turnId === turnId ? state.draft.text : ''
            return { ...state, draft: { turnId, text: prev + text } }
        }
        case 'status':
            return { ...state, status: action.status.status, error: action.status.error ?? state.error }
    }
}

export function useSessionStream(sessionId: string | null) {
    const [state, dispatch] = useReducer(reducer, initial)

    useEffect(() => {
        dispatch({ type: 'reset' })
        if (!sessionId) return
        // EventSource 断线后会自动重连，并带上 Last-Event-ID，服务端据此补发
        const source = new EventSource(api.eventsUrl(sessionId))
        const parse = <K extends keyof StreamFrames>(raw: MessageEvent) => JSON.parse(raw.data) as StreamFrames[K]
        source.onopen = () => dispatch({ type: 'open' })
        source.onerror = () => dispatch({ type: 'disconnect' })
        source.addEventListener('event', raw => dispatch({ type: 'event', event: parse<'event'>(raw as MessageEvent) }))
        source.addEventListener('delta', raw => dispatch({ type: 'delta', delta: parse<'delta'>(raw as MessageEvent) }))
        source.addEventListener('status', raw => dispatch({ type: 'status', status: parse<'status'>(raw as MessageEvent) }))
        return () => source.close()
    }, [sessionId])

    return state
}
