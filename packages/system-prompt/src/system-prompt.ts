// 系统提示词不是一个写死的字符串，是由多个插件各自贡献一部分拼起来的，build后形成最后的系统提示词。

import {type Context, Service} from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
    interface Context {
        systemPrompt: SystemPrompt
    }
}

export interface Config {
    //人设配置
    persona?: string
}

export interface PromptSection {
    id: string
    //越小越靠前
    order: number
    render(): string | undefined
}

export class SystemPrompt extends Service {
    private sections = new Map<string, PromptSection>()

    constructor(ctx: Context, config: Config = {}) {
        super(ctx, 'systemPrompt')
        const persona = config.persona ?? '你是一个 AI 助手。你的名字叫Kepler。需要时调用工具获取信息。'
        ctx.effect(() => this.section({id: 'persona', order: 0, render: () => persona}))
    }
    //其他插件调用它贡献一段提示词。返回撤销函数。
    section(section: PromptSection) {
        this.sections.set(section.id, section)
        return () => this.sections.delete(section.id)
    }

    //构建提示词
    build() {
        return [...this.sections.values()]
            .sort((a, b) => a.order - b.order)
            .map(s => s.render())
            .filter(Boolean)
            .join('\n\n')
    }
}

export default SystemPrompt
