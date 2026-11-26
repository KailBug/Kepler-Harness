// Kepler 托管模式 Worker 插件：
// 主动从 keplerd 拉取任务 -> 恢复 Session -> 绑定租约并定时续约 -> 驱动 AgentLoop.resume -> 回报任务终态。
// 全程不修改 Harness 内核代码，只通过插件组合完成从“独立模式”到“被 Kepler 托管”的切换。

import { type Context, Service } from '@deepseek-ai/cordis'
import { Code, ConnectError } from '@connectrpc/connect'
import { hostname } from 'node:os'
import type {} from '@kepler/agent-loop'
import type {} from '@kepler/session'
import { fromProtoEvent, type WorkerRpcClient } from '@kepler/session-remote'
import type { WorkerTask } from '@kepler/protocol/connect'

export interface Config {
    workerId?: string
    runtime?: string
    version?: string
    capabilities?: string[]
    // 长轮询等待时长（毫秒）
    waitTimeoutMs?: number
    // 租约续期间隔（毫秒）
    renewIntervalMs?: number
    // 轮询出错后的退避时长（毫秒）
    errorBackoffMs?: number
    // 为 false 时不自动启动后台轮询循环（单测可直接调用 ctx.worker.runOnce()）
    autoStart?: boolean
}

declare module '@deepseek-ai/cordis' {
    interface Context {
        worker: KeplerWorker
    }
}

function isStaleEpochError(error: unknown): boolean {
    return error instanceof ConnectError && error.code === Code.FailedPrecondition
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
    }, { once: true })
})

export class KeplerWorker extends Service {
    static inject = ['agentLoop', 'sessions', 'remoteSession']

    readonly workerId: string
    private runtime: string
    private version: string
    private capabilities: string[]
    private waitTimeoutMs: number
    private renewIntervalMs: number
    private errorBackoffMs: number
    private activeTasks = 0
    private loopAbort = new AbortController()
    private loopDone: Promise<void> = Promise.resolve()

    constructor(ctx: Context, config: Config = {}) {
        super(ctx, 'worker')
        this.workerId = config.workerId ?? `harness-${hostname()}-${process.pid}`
        this.runtime = config.runtime ?? 'kepler-harness-ts'
        this.version = config.version ?? '0.1.0'
        this.capabilities = config.capabilities ?? ['default']
        this.waitTimeoutMs = config.waitTimeoutMs ?? 15_000
        this.renewIntervalMs = config.renewIntervalMs ?? 5_000
        this.errorBackoffMs = config.errorBackoffMs ?? 1_000

        if (config.autoStart !== false) {
            ctx.effect(() => {
                this.loopAbort = new AbortController()
                this.loopDone = this.runLoop(this.loopAbort.signal)
                return async () => {
                    this.loopAbort.abort()
                    await this.loopDone
                }
            })
        }
    }

    private get client(): WorkerRpcClient {
        return this.ctx.remoteSession.client
    }

    async register(): Promise<number> {
        const resp = await this.client.registerWorker({
            workerId: this.workerId,
            runtime: this.runtime,
            version: this.version,
            capabilities: this.capabilities,
        })
        return Number(resp.heartbeatIntervalMs) || 10_000
    }

    // 拉取并执行单个任务；没有任务返回 false，执行了一个任务返回 true。
    async runOnce(signal?: AbortSignal): Promise<boolean> {
        const resp = await this.client.acquireTask({
            workerId: this.workerId,
            capabilities: this.capabilities,
            waitTimeoutMs: this.waitTimeoutMs,
        }, { signal })
        if (!resp.task) return false
        await this.executeTask(resp.task, signal)
        return true
    }

    async executeTask(task: WorkerTask, parentSignal?: AbortSignal): Promise<void> {
        const logger = this.ctx.logger('worker')
        if (!task.lease) throw new Error(`task "${task.taskId}" missing lease`)
        const { leaseId, epoch } = task.lease

        const taskAbort = new AbortController()
        const onParentAbort = () => taskAbort.abort(parentSignal?.reason)
        parentSignal?.addEventListener('abort', onParentAbort, { once: true })

        const unbindLease = this.ctx.remoteSession.bindLease(task.sessionId, { leaseId, epoch })
        let leaseLost = false
        const renewTimer = setInterval(async () => {
            if (taskAbort.signal.aborted) return
            try {
                await this.client.renewLease({ taskId: task.taskId, leaseId, epoch })
            } catch (error) {
                if (isStaleEpochError(error)) {
                    leaseLost = true
                    logger.warn('lease lost for task %s (epoch=%s), aborting', task.taskId, epoch.toString())
                    taskAbort.abort(error)
                } else {
                    logger.warn('renewLease failed for task %s: %s', task.taskId, error instanceof Error ? error.message : String(error))
                }
            }
        }, this.renewIntervalMs)
        renewTimer.unref?.()

        this.activeTasks++
        try {
            const localEvents = task.events.map(fromProtoEvent)
            const session = this.ctx.sessions.restore(task.sessionId, localEvents)
            logger.info('executing task %s (session=%s, epoch=%s, events=%d)', task.taskId, task.sessionId, epoch.toString(), localEvents.length)

            const result = await this.ctx.agentLoop.resume(session, taskAbort.signal)
            if (leaseLost) return

            if (result.status === 'suspended') {
                const pending = session.pendingApprovals().at(-1)
                await this.client.suspendTask({
                    taskId: task.taskId,
                    leaseId,
                    epoch,
                    reason: pending?.reason ?? 'waiting for approval',
                })
            } else if (result.status === 'cancelled') {
                await this.client.failTask({
                    taskId: task.taskId,
                    leaseId,
                    epoch,
                    error: 'cancelled',
                    retryable: false,
                }).catch(() => {})
            } else {
                await this.client.completeTask({ taskId: task.taskId, leaseId, epoch })
            }
        } catch (error) {
            if (leaseLost || isStaleEpochError(error)) {
                logger.warn('task %s aborted due to stale lease epoch', task.taskId)
                return
            }
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('task %s failed: %s', task.taskId, message)
            await this.client.failTask({
                taskId: task.taskId,
                leaseId,
                epoch,
                error: message,
                retryable: false,
            }).catch(() => {})
        } finally {
            this.activeTasks--
            clearInterval(renewTimer)
            unbindLease()
            parentSignal?.removeEventListener('abort', onParentAbort)
        }
    }

    private async runLoop(signal: AbortSignal): Promise<void> {
        const logger = this.ctx.logger('worker')
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined

        while (!signal.aborted) {
            try {
                const intervalMs = await this.register()
                logger.info('registered worker %s with Kepler (heartbeat=%dms)', this.workerId, intervalMs)
                heartbeatTimer = setInterval(() => {
                    this.client.heartbeat({ workerId: this.workerId, activeTasks: this.activeTasks }).catch(() => {})
                }, intervalMs)
                heartbeatTimer.unref?.()
                break
            } catch (error) {
                if (signal.aborted) return
                logger.warn('registerWorker failed, retrying: %s', error instanceof Error ? error.message : String(error))
                await sleep(this.errorBackoffMs, signal)
            }
        }

        try {
            while (!signal.aborted) {
                try {
                    await this.runOnce(signal)
                } catch (error) {
                    if (signal.aborted) return
                    logger.warn('worker poll error, backing off: %s', error instanceof Error ? error.message : String(error))
                    await sleep(this.errorBackoffMs, signal)
                }
            }
        } finally {
            if (heartbeatTimer) clearInterval(heartbeatTimer)
        }
    }
}

export default KeplerWorker
