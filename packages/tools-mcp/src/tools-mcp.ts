// MCP 工具桥接插件：依赖 @kepler/tools（非继承），通过官方 @modelcontextprotocol/sdk
// 连接远端 MCP Gateway（Streamable HTTP），自动发现工具并注册到 ctx.tools。
// 调用时通过 JSON-RPC _meta 透传 idempotencyKey / sessionId / turnId / toolCallId，
// 并把网关声明的 requireApproval / destructiveHint 元数据映射到 Harness 的 HITL 审批挂起机制。

import { type Context, Service } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {} from '@kepler/tools'
import { z } from 'zod'

export const ConfigSchema = z.object({
    url: z.string().url().refine(
        value => value.startsWith('http://') || value.startsWith('https://'),
        'MCP server URL must start with http:// or https://',
    ),
    clientName: z.string().min(1).default('kepler-harness'),
    clientVersion: z.string().min(1).default('0.1.0'),
    headers: z.record(z.string()).optional(),
    toolPrefix: z.string().default(''),
})

export type Config = z.input<typeof ConfigSchema>
export type ResolvedConfig = z.output<typeof ConfigSchema>

const ToolMetaSchema = z.object({
    requireApproval: z.boolean().optional(),
}).passthrough()

const TextContentSchema = z.object({
    type: z.literal('text'),
    text: z.string(),
})

declare module '@deepseek-ai/cordis' {
    interface Context {
        mcpTools: McpTools
    }
}

export class McpTools extends Service {
    static inject = ['tools']

    readonly config: ResolvedConfig
    private client: Client | null = null
    private transport: StreamableHTTPClientTransport | null = null
    private unregisterFns: (() => void)[] = []
    private toolNames: string[] = []

    constructor(ctx: Context, rawConfig: Config) {
        super(ctx, 'mcpTools')
        this.config = ConfigSchema.parse(rawConfig)
    }

    async [Service.init]() {
        const logger = this.ctx.logger('tools-mcp')
        const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
            requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
        })
        const client = new Client(
            { name: this.config.clientName, version: this.config.clientVersion },
            { capabilities: {} },
        )

        await client.connect(transport)
        this.transport = transport
        this.client = client

        this.ctx.effect(() => async () => {
            this.clearRegistered()
            const activeClient = this.client
            this.client = null
            this.transport = null
            if (activeClient) await activeClient.close().catch(() => {})
        })

        const names = await this.refresh()
        logger.info('connected to MCP Gateway %s, registered tools: %s', this.config.url, names.join(', ') || '(none)')
    }

    registeredTools(): string[] {
        return [...this.toolNames]
    }

    // 重新从远端 MCP 服务端拉取工具清单并同步到 ctx.tools。
    async refresh(): Promise<string[]> {
        if (!this.client) throw new Error('MCP client is not connected')
        const { tools } = await this.client.listTools()
        this.clearRegistered()

        for (const remote of tools) {
            const localName = `${this.config.toolPrefix}${remote.name}`
            const meta = ToolMetaSchema.safeParse(remote._meta).data
            const requireApproval = Boolean(meta?.requireApproval || remote.annotations?.destructiveHint)
            const parameters = (remote.inputSchema && typeof remote.inputSchema === 'object')
                ? remote.inputSchema
                : { type: 'object', properties: {} }

            const unregister = this.ctx.tools.register({
                name: localName,
                description: remote.description ?? '',
                parameters,
                requireApproval,
                execute: async (args, exec) => {
                    if (!this.client) throw new Error('MCP client disconnected')
                    const idempotencyKey = exec.sessionId && exec.toolCallId
                        ? `${exec.sessionId}:${exec.toolCallId}`
                        : undefined
                    const metaPayload: Record<string, unknown> = {}
                    if (idempotencyKey) metaPayload.idempotencyKey = idempotencyKey
                    if (exec.sessionId) metaPayload.sessionId = exec.sessionId
                    if (exec.turnId) metaPayload.turnId = exec.turnId
                    if (exec.toolCallId) metaPayload.toolCallId = exec.toolCallId

                    const result = await this.client.callTool({
                        name: remote.name,
                        arguments: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {},
                        ...(Object.keys(metaPayload).length ? { _meta: metaPayload } : {}),
                    })

                    const text = extractToolText(result)
                    if ('isError' in result && result.isError) {
                        throw new Error(text || `MCP tool "${remote.name}" failed`)
                    }
                    return text
                },
            })
            this.unregisterFns.push(unregister)
            this.toolNames.push(localName)
        }
        return this.registeredTools()
    }

    private clearRegistered() {
        for (const unregister of this.unregisterFns) unregister()
        this.unregisterFns = []
        this.toolNames = []
    }
}

function extractToolText(result: Record<string, unknown>): string {
    if (Array.isArray(result.content)) {
        const parts: string[] = []
        for (const block of result.content) {
            const parsed = TextContentSchema.safeParse(block)
            if (parsed.success) parts.push(parsed.data.text)
            else parts.push(JSON.stringify(block))
        }
        return parts.join('\n')
    }
    if ('toolResult' in result) {
        return typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult)
    }
    return ''
}

export default McpTools
