import { type Context, Service } from '@deepseek-ai/cordis'
import type { Message, ToolCall } from '@kepler/llm'
import type { TurnStatus } from '@kepler/protocol'
import type { Session, SessionEvent } from '@kepler/session'
import type {} from '@kepler/system-prompt'
import type {} from '@kepler/tools'

declare module '@deepseek-ai/cordis' {
    interface Context {
        agentLoop: AgentLoop
    }
    interface Events {
        'agent/status'(session: Session, status: 'busy' | 'idle'): void
        'agent/request'(session: Session, step: number): void
        'agent/text-delta'(session: Session, text: string, turnId?: string): void
        'agent/tool-call'(session: Session, call: ToolCall): void
    }
}

export interface Config {
    provider?: string
    model?: string
    maxSteps?: number
}

export interface TurnResult {
    turnId: string
    status: TurnStatus
    text: string
}

type ApprovalResolution = Extract<SessionEvent, { type: 'approval-resolved' }>

export class AgentLoop extends Service {
    static inject = ['llm', 'tools', 'sessions', 'systemPrompt']
    config: Config

    constructor(ctx: Context, config: Config = {}) {
        super(ctx, 'agentLoop')
        this.config = { maxSteps: 8, ...config }
    }

    // 提交新的用户输入并开始一个新 Turn
    async submit(session: Session, input: string, signal?: AbortSignal): Promise<TurnResult> {
        const turnId = crypto.randomUUID()
        await session.append({ type: 'user', text: input }, turnId)
        return this.resume(session, signal)
    }

    // 兼容旧接口：提交输入并返回最终文本
    async run(session: Session, input: string, signal?: AbortSignal): Promise<string> {
        const result = await this.submit(session, input, signal)
        return result.text
    }

    // 从事件日志的当前位置恢复执行：支持断点续跑、失败重试和人工审批后继续。
    async resume(session: Session, signal?: AbortSignal): Promise<TurnResult> {
        const last = session.log.at(-1)
        if (!last) return { turnId: '', status: 'completed', text: '' }

        const turnId = last.turnId
        const turnEvents = session.log.filter(event => event.turnId === turnId)
        const lastAssistant = turnEvents.findLast(
            (event): event is Extract<SessionEvent, { type: 'assistant' }> => event.type === 'assistant',
        )

        // 已经明确终结的 Turn 不再重复执行（failed 允许重试；approval-resolved 会落在 turn-ended(suspended) 之后）
        if (last.type === 'turn-ended' && last.status !== 'failed') {
            return { turnId, status: last.status, text: lastAssistant?.text ?? '' }
        }

        const { llm, systemPrompt } = this.ctx
        const { provider, model, maxSteps = 8 } = this.config
        this.ctx.emit('agent/status', session, 'busy')
        try {
            // 1. 先检查最后一次 assistant 输出是否还有未完成的工具调用（断点恢复 / 审批恢复）
            if (lastAssistant) {
                const afterAssistant = turnEvents.slice(turnEvents.lastIndexOf(lastAssistant) + 1)
                if (!lastAssistant.toolCalls?.length) {
                    // 崩溃发生在 assistant 已落盘、但 turn-ended 尚未写入的窗口
                    await session.append({ type: 'turn-ended', status: 'completed' }, turnId)
                    return { turnId, status: 'completed', text: lastAssistant.text }
                }
                const doneIds = new Set(
                    afterAssistant.filter(e => e.type === 'tool-result').map(e => e.toolCallId),
                )
                const pendingCalls = lastAssistant.toolCalls.filter(call => !doneIds.has(call.id))
                if (pendingCalls.length) {
                    const approvals = new Map<string, ApprovalResolution>()
                    const requested = new Set<string>()
                    for (const event of afterAssistant) {
                        if (event.type === 'approval-requested') requested.add(event.toolCallId)
                        else if (event.type === 'approval-resolved') approvals.set(event.toolCallId, event)
                    }
                    const outcome = await this.executeToolCalls(session, turnId, pendingCalls, approvals, requested, signal)
                    if (outcome === 'suspended') return { turnId, status: 'suspended', text: '' }
                }
            }

            // 2. 进入推理循环，从已完成的 LLM 步数之后继续
            const completedSteps = turnEvents.filter(event => event.type === 'assistant').length
            for (let step = completedSteps + 1; step <= maxSteps; step++) {
                signal?.throwIfAborted()
                this.ctx.emit('agent/request', session, step)
                const messages: Message[] = [
                    { role: 'system', content: systemPrompt.build() },
                    ...session.deriveMessages(),
                ]

                let text = ''
                const calls: ToolCall[] = []
                for await (const chunk of llm.stream({ messages, tools: this.ctx.tools.list(), provider, model, signal })) {
                    if (chunk.type === 'text') {
                        text += chunk.text
                        this.ctx.emit('agent/text-delta', session, chunk.text, turnId)
                    } else {
                        calls.push(chunk.call)
                    }
                }

                // Write-Ahead：带 toolCalls 的 assistant 事件必须先持久化成功，再执行任何工具
                await session.append({ type: 'assistant', text, toolCalls: calls.length ? calls : undefined }, turnId)
                if (!calls.length) {
                    await session.append({ type: 'turn-ended', status: 'completed' }, turnId)
                    return { turnId, status: 'completed', text }
                }

                const outcome = await this.executeToolCalls(session, turnId, calls, new Map(), new Set(), signal)
                if (outcome === 'suspended') return { turnId, status: 'suspended', text }
            }

            await session.append({ type: 'turn-ended', status: 'max-steps' }, turnId)
            return { turnId, status: 'max-steps', text: '（达到最大步数，已停止）' }
        } catch (error) {
            if (signal?.aborted) {
                await session.append({ type: 'turn-ended', status: 'cancelled' }, turnId).catch(() => {})
                return { turnId, status: 'cancelled', text: '' }
            }
            const message = error instanceof Error ? error.message : String(error)
            await session.append({ type: 'turn-ended', status: 'failed', error: message }, turnId).catch(() => {})
            throw error
        } finally {
            this.ctx.emit('agent/status', session, 'idle')
        }
    }

    private async executeToolCalls(
        session: Session,
        turnId: string,
        calls: ToolCall[],
        approvals: Map<string, ApprovalResolution>,
        requested: Set<string>,
        signal?: AbortSignal,
    ): Promise<'done' | 'suspended'> {
        for (const call of calls) {
            signal?.throwIfAborted()
            const resolution = approvals.get(call.id)
            if (resolution && !resolution.approved) {
                const reason = resolution.reason ? `：${resolution.reason}` : ''
                await session.append({
                    type: 'tool-result',
                    toolCallId: call.id,
                    name: call.name,
                    content: `审批未通过${reason}`,
                    isError: true,
                }, turnId)
                continue
            }
            if (!resolution && requested.has(call.id)) {
                return 'suspended'
            }

            let args = {}
            try {
                args = JSON.parse(call.arguments || '{}')
            } catch {
                // 参数不是有效 JSON 时传入空对象
            }
            this.ctx.emit('agent/tool-call', session, call)
            const result = await this.ctx.tools.execute({
                name: call.name,
                args,
                sessionId: session.id,
                toolCallId: call.id,
                turnId,
                approved: Boolean(resolution?.approved),
            })
            if (result.suspended) {
                await session.append({
                    type: 'approval-requested',
                    toolCallId: call.id,
                    name: call.name,
                    arguments: call.arguments,
                    reason: result.reason,
                }, turnId)
                await session.append({ type: 'turn-ended', status: 'suspended' }, turnId)
                return 'suspended'
            }
            await session.append({
                type: 'tool-result',
                toolCallId: call.id,
                name: call.name,
                content: result.content,
                isError: result.isError,
            }, turnId)
        }
        return 'done'
    }
}

export default AgentLoop
