import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmAdapter, Message, StreamChunk, ToolCall } from '@kepler/llm'

export interface Config {
    apiKey: string
    baseURL?: string
    model?: string
}

export const name = 'llm-deepseek'
export const inject = ['llm']

function toWireMessage(message: Message) {
    if (message.role === 'tool') {
        return { role: 'tool', content: message.content, tool_call_id: message.toolCallId }
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
            role: 'assistant',
            content: message.content,
            tool_calls: message.toolCalls.map(call => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
            })),
        }
    }
    return { role: message.role, content: message.content }
}

// DeepSeek 每条 data 行是一段 JSON，网络分块可能落在行内或 UTF-8 字符中间。
async function* readEvents(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
        while (true) {
            const { value, done } = await reader.read()
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = done ? '' : lines.pop()!
            for (const line of lines) {
                if (!line.startsWith('data:')) continue
                const data = line.slice(5).trim()
                if (data === '[DONE]') return
                if (data) yield JSON.parse(data)
            }
            if (done) throw new Error('DeepSeek stream ended before [DONE]')
        }
    } finally {
        try {
            await reader.cancel()
        } finally {
            reader.releaseLock()
        }
    }
}

export class DeepSeekAdapter implements LlmAdapter {
    config: Required<Config>

    constructor(config: Config) {
        if (!config?.apiKey?.trim()) throw new Error('DeepSeek API key is required')
        this.config = {
            apiKey: config.apiKey,
            baseURL: (config.baseURL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
            model: config.model ?? 'deepseek-flash',
        }
    }

    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const tools = options.tools?.length
            ? options.tools.map(tool => ({ type: 'function', function: tool }))
            : undefined
        const response = await fetch(`${this.config.baseURL}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
            signal: options.signal,
            body: JSON.stringify({
                model: options.model ?? this.config.model,
                stream: true,
                messages: options.messages.map(toWireMessage),
                tools,
                // Kepler 的工具调用历史只保存调用及结果，不保存 reasoning_content。
                thinking: tools ? { type: 'disabled' } : undefined,
            }),
        })
        if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${await response.text()}`)
        if (!response.body) throw new Error('DeepSeek API returned an empty response body')

        const calls = new Map<number, ToolCall>()
        for await (const event of readEvents(response.body)) {
            if (event.error) throw new Error(`DeepSeek stream: ${event.error.message ?? 'unknown error'}`)
            const choice = event.choices?.[0]
            const delta = choice?.delta
            if (delta?.content) yield { type: 'text', text: delta.content }
            for (const part of delta?.tool_calls ?? []) {
                if (!Number.isInteger(part.index) || part.index < 0) throw new Error('Invalid DeepSeek tool call index')
                const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' }
                if (part.id) call.id = part.id
                call.name += part.function?.name ?? ''
                call.arguments += part.function?.arguments ?? ''
                calls.set(part.index, call)
            }
            if (calls.size && choice.finish_reason && choice.finish_reason !== 'tool_calls') {
                throw new Error(`DeepSeek tool call interrupted: ${choice.finish_reason}`)
            }
        }
        for (const index of [...calls.keys()].sort((a, b) => a - b)) {
            const call = calls.get(index)!
            if (!call.id || !call.name) throw new Error('Incomplete DeepSeek tool call')
            yield { type: 'tool-call', call }
        }
    }
}

export function apply(ctx: Context, config: Config) {
    ctx.effect(() => ctx.llm.registerAdapter('deepseek', new DeepSeekAdapter(config)))
}
