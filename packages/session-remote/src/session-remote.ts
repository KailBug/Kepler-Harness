// 托管模式远端持久化插件：挂载在 session/persist waterfall 上，
// 在事件落入本地内存或执行任何工具前，先经 Connect-RPC AppendEvents（携带 leaseId + epoch）写入 Kepler。

import { type Context, Service } from '@deepseek-ai/cordis'
import { createClient, type Client } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { WorkerService } from '@kepler/protocol/connect'
import type {} from '@kepler/session'
import { toProtoEvent } from './codec.ts'

export type WorkerRpcClient = Client<typeof WorkerService>

export interface LeaseBinding {
    leaseId: string
    epoch: bigint
}

export interface Config {
    // Kepler 服务端地址，例如 http://127.0.0.1:8080（与 client 二选一）
    baseUrl?: string
    // 可直接注入 Connect-RPC 客户端（方便与 @kepler/worker 共用连接或在单测中 mock）
    client?: WorkerRpcClient
    // 为 true 时，没有绑定 lease 的会话写入将直接报错
    strict?: boolean
}

declare module '@deepseek-ai/cordis' {
    interface Context {
        remoteSession: RemoteSessionStore
    }
}

export function createWorkerClient(baseUrl: string): WorkerRpcClient {
    const transport = createConnectTransport({
        baseUrl: baseUrl.replace(/\/+$/, ''),
        httpVersion: '1.1',
    })
    return createClient(WorkerService, transport)
}

export class RemoteSessionStore extends Service {
    static inject = ['sessions']

    readonly client: WorkerRpcClient
    private leases = new Map<string, LeaseBinding>()
    private strict: boolean

    constructor(ctx: Context, config: Config = {}) {
        super(ctx, 'remoteSession')
        if (config.client) {
            this.client = config.client
        } else if (config.baseUrl) {
            this.client = createWorkerClient(config.baseUrl)
        } else {
            throw new Error('session-remote requires either config.baseUrl or config.client')
        }
        this.strict = Boolean(config.strict)

        ctx.on('session/persist', async (session, event, next) => {
            const lease = this.leases.get(session.id)
            if (!lease) {
                if (this.strict) throw new Error(`session "${session.id}" has no active Kepler lease`)
                return next()
            }
            const response = await this.client.appendEvents({
                sessionId: session.id,
                leaseId: lease.leaseId,
                epoch: lease.epoch,
                events: [toProtoEvent(event)],
            })
            event.seq = Number(response.lastSeq)
            return next()
        })

        ctx.effect(() => () => this.leases.clear())
    }

    // 为当前正在执行的会话绑定 Kepler 租约；返回解绑函数，任务结束时必须调用。
    bindLease(sessionId: string, lease: LeaseBinding): () => void {
        this.leases.set(sessionId, lease)
        return () => {
            if (this.leases.get(sessionId) === lease) {
                this.leases.delete(sessionId)
            }
        }
    }

    getLease(sessionId: string): LeaseBinding | undefined {
        return this.leases.get(sessionId)
    }
}

export default RemoteSessionStore
