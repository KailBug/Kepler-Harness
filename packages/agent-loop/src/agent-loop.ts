import { type Context, Service } from '@deepseek-ai/cordis'
import type { Message, ToolCall } from '@kepler/llm'
import type { Session } from '@kepler/session'
import type {} from '@kepler/system-prompt'
import type {} from '@kepler/tools'

declare module '@deepseek-ai/cordis' {
    interface Context {
        agentLoop: AgentLoop
    }
    interface Events {
        'agent/status'(session: Session, status: 'busy' | 'idle'): void
        'agent/request'(session: Session, step: number): void
        'agent/text-delta'(session: Session, text: string): void
        'agent/tool-call'(session: Session, call: ToolCall): void
    }
}

export interface Config {
    provider?: string
    model?: string
    maxSteps?: number
}

export class AgentLoop extends Service {
    static inject = ['llm', 'tools', 'sessions', 'systemPrompt']
    config: Config

    constructor(ctx: Context, config: Config = {}) {
        super(ctx, 'agentLoop')
        this.config = { maxSteps: 8, ...config }
    }

    async run(session: Session, input: string, signal?: AbortSignal): Promise<string> {
        const { llm, tools, systemPrompt } = this.ctx
        const { provider, model, maxSteps = 8 } = this.config
        session.append({ type: 'user', text: input })
        this.ctx.emit('agent/status', session, 'busy')
        try {
            for (let step = 1; step <= maxSteps; step++) {
                this.ctx.emit('agent/request', session, step)
                const messages: Message[] = [
                    { role: 'system', content: systemPrompt.build() },
                    ...session.deriveMessages(),
                ]

                let text = ''
                const calls: ToolCall[] = []
                for await (const chunk of llm.stream({ messages, tools: tools.list(), provider, model, signal })) {
                    if (chunk.type === 'text') {
                        text += chunk.text
                        this.ctx.emit('agent/text-delta', session, chunk.text)
                    } else {
                        calls.push(chunk.call)
                    }
                }
                session.append({ type: 'assistant', text, toolCalls: calls.length ? calls : undefined })
                if (!calls.length) return text

                for (const call of calls) {
                    let args = {}
                    try {
                        args = JSON.parse(call.arguments || '{}')
                    } catch {
                        // 与 NamiDSH 一致，参数不是有效 JSON 时传入空对象。
                    }
                    this.ctx.emit('agent/tool-call', session, call)
                    const result = await tools.execute({ name: call.name, args, sessionId: session.id })
                    session.append({ type: 'tool-result', toolCallId: call.id, name: call.name, content: result.content })
                }
            }
            return '（达到最大步数，已停止）'
        } finally {
            this.ctx.emit('agent/status', session, 'idle')
        }
    }
}

export default AgentLoop
