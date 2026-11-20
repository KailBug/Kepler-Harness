import type { Context } from '@deepseek-ai/cordis'
import AgentLoop, { type Config as AgentLoopConfig } from '@kepler/agent-loop'
import LlmRuntime from '@kepler/llm'
import SessionStore from '@kepler/session'
import SystemPrompt from '@kepler/system-prompt'
import ToolRuntime from '@kepler/tools'

export interface Config {
    persona?: string
    agent?: AgentLoopConfig
}

export const name = 'agent-spine'

// 子插件都挂在当前作用域，卸载 spine 时 Cordis 会一并清理。
export async function apply(ctx: Context, config: Config = {}) {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt, { persona: config.persona })
    await ctx.plugin(AgentLoop, config.agent)
}
