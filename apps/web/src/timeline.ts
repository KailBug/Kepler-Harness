// 把扁平的事件日志整理成界面上的条目：用户消息、模型回答、工具卡片、Turn 结束标记。

import type { SessionEvent, ToolCall, TurnStatus } from '@kepler/protocol'

type Of<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>

export interface ToolView {
    call: ToolCall
    approval?: Of<'approval-requested'>
    resolution?: Of<'approval-resolved'>
    result?: Of<'tool-result'>
}

export type ToolState = 'pending' | 'waiting' | 'denied' | 'done' | 'error'

export type TimelineItem =
    | { kind: 'user'; key: string; text: string }
    | { kind: 'assistant'; key: string; text: string }
    | { kind: 'tool'; key: string; tool: ToolView }
    | { kind: 'turn-ended'; key: string; status: TurnStatus; error?: string; last: boolean }

export function toolState(tool: ToolView): ToolState {
    if (tool.result) return tool.result.isError ? 'error' : 'done'
    if (tool.resolution && !tool.resolution.approved) return 'denied'
    if (tool.approval && !tool.resolution) return 'waiting'
    return 'pending'
}

export function buildTimeline(events: SessionEvent[]): TimelineItem[] {
    const items: TimelineItem[] = []
    const tools = new Map<string, ToolView>()
    let lastEnded = -1
    for (const event of events) {
        const key = String(event.seq)
        switch (event.type) {
            case 'user':
                items.push({ kind: 'user', key, text: event.text })
                break
            case 'assistant':
                if (event.text) items.push({ kind: 'assistant', key, text: event.text })
                for (const call of event.toolCalls ?? []) {
                    const tool: ToolView = { call }
                    tools.set(call.id, tool)
                    items.push({ kind: 'tool', key: `${key}:${call.id}`, tool })
                }
                break
            case 'approval-requested':
            case 'approval-resolved':
            case 'tool-result': {
                const tool = tools.get(event.toolCallId)
                if (!tool) break
                if (event.type === 'approval-requested') tool.approval = event
                else if (event.type === 'approval-resolved') tool.resolution = event
                else tool.result = event
                break
            }
            case 'turn-ended':
                lastEnded = items.length
                items.push({ kind: 'turn-ended', key, status: event.status, error: event.error, last: false })
                break
        }
    }
    // 只有最后一条 Turn 结束标记可能需要操作按钮（例如失败后重试）
    const last = items[lastEnded]
    if (last?.kind === 'turn-ended' && lastEnded === items.length - 1) last.last = true
    return items
}

export function formatArgs(raw: string) {
    try {
        return JSON.stringify(JSON.parse(raw || '{}'), null, 2)
    } catch {
        return raw
    }
}
