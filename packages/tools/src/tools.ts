import { type Context, Service } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@kepler/llm'

export interface ToolExecution {
    name: string
    args: any
    sessionId?: string
}

export interface ToolDefinition extends ToolSchema {
    execute(args: any, exec: ToolExecution): string | Promise<string>
}

export interface ToolResult {
    content: string
    isError?: boolean
}

export interface ToolDecision {
    allow: boolean
    reason?: string
}

type Awaitable<T> = T | Promise<T>

declare module '@deepseek-ai/cordis' {
    interface Context {
        tools: ToolRuntime
    }

    interface Events {
        'tools/change'(): void
        'tools/pre-execute'(exec: ToolExecution, next: () => Awaitable<ToolDecision>): Awaitable<ToolDecision>
        'tools/execute'(exec: ToolExecution, next: () => Awaitable<ToolResult>): Awaitable<ToolResult>
        'tools/post-execute'(exec: ToolExecution, result: ToolResult, next: () => Awaitable<ToolResult>): Awaitable<ToolResult>
        'tools/result'(exec: ToolExecution, result: ToolResult): void
    }
}

export class ToolRuntime extends Service {
    private tools = new Map<string, ToolDefinition>()

    constructor(ctx: Context) {
        super(ctx, 'tools')
    }

    // 返回的撤销函数可以交给 ctx.effect，在提供工具的插件卸载时调用。
    register(tool: ToolDefinition) {
        const name = tool.name
        if (this.tools.has(name)) throw new Error(`tool "${name}" already registered`)
        this.tools.set(name, tool)
        this.ctx.emit('tools/change')

        let registered = true
        return () => {
            if (!registered) return
            registered = false
            this.tools.delete(name)
            this.ctx.emit('tools/change')
        }
    }

    list(): ToolSchema[] {
        return [...this.tools.values()].map(({ name, description, parameters }) => ({
            name, description, parameters,
        }))
    }

    async execute(exec: ToolExecution): Promise<ToolResult> {
        const decision = await this.ctx.waterfall('tools/pre-execute', exec, () => ({ allow: true }))
        let result: ToolResult
        if (!decision.allow) {
            result = { content: `已拦截：${decision.reason ?? '不允许调用'} ${exec.name}`, isError: true }
        } else {
            result = await this.ctx.waterfall('tools/execute', exec, async () => {
                const tool = this.tools.get(exec.name)
                if (!tool) return { content: `没有这个工具：${exec.name}`, isError: true }
                try {
                    return { content: await tool.execute(exec.args, exec) }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    return { content: `工具出错：${message}`, isError: true }
                }
            })
        }

        result = await this.ctx.waterfall('tools/post-execute', exec, result, () => result)
        this.ctx.emit('tools/result', exec, result)
        return result
    }
}

export default ToolRuntime
