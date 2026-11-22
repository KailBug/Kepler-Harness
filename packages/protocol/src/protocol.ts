// Kepler 用户面协议 v0。
//
// 这是 Harness 本地 webserver 与 Kepler（keplerd）用户面接口共用的语义：
// 同样的资源（Session / Event）、同样的命令（提交消息 / 审批 / 取消）、同样的事件流（SSE + seq 续传）。
// 后续会以 Kepler 仓库 proto/kepler/v1 中的 protobuf 定义为准，这里的字段名与之一一对应。
// 本包只有类型，没有运行时代码，前端和服务端都可以 `import type`。

export const PROTOCOL_VERSION = 'v0'

// ---------- 资源 ----------

export type SessionStatus = 'idle' | 'running' | 'waiting_approval'

export interface SessionInfo {
    id: string
    // 由第一条用户消息推导，没有消息时为空字符串
    title: string
    status: SessionStatus
    createdAt: number
    updatedAt: number
    // 已持久化的最后一条事件序号，没有事件时为 0
    lastSeq: number
}

export interface ToolCall {
    id: string
    name: string
    // JSON 字符串
    arguments: string
}

// Turn 的结束状态：
// - completed：模型给出了最终回答
// - max-steps：达到最大步数被截停
// - suspended：等待人工审批（可恢复）
// - failed：执行出错（可恢复/重试）
// - cancelled：被用户取消或被新输入取代
export type TurnStatus = 'completed' | 'max-steps' | 'suspended' | 'failed' | 'cancelled'

// 持久化事件的载荷。会话 = 这些事件组成的只追加日志。
export type SessionEventPayload =
    | { type: 'user'; text: string }
    | { type: 'assistant'; text: string; toolCalls?: ToolCall[] }
    | { type: 'tool-result'; toolCallId: string; name: string; content: string; isError?: boolean }
    | { type: 'approval-requested'; toolCallId: string; name: string; arguments: string; reason?: string }
    | { type: 'approval-resolved'; toolCallId: string; approved: boolean; reason?: string }
    | { type: 'turn-ended'; status: TurnStatus; error?: string }

export type SessionEventType = SessionEventPayload['type']

// 事件信封：每条持久化事件都带有全局唯一 id、会话内单调递增的 seq 和所属 turnId。
export type SessionEvent = SessionEventPayload & {
    id: string
    seq: number
    sessionId: string
    turnId: string
    ts: number
}

// ---------- 事件流（GET /api/sessions/:id/events，SSE） ----------
//
// SSE 的 event 字段取下面的键名，data 字段是对应值的 JSON。
// 只有 `event` 帧带 SSE id（= seq），断线重连时浏览器会自动带上 Last-Event-ID，
// 服务端据此补发 seq 更大的事件；`delta` / `status` 是瞬时帧，不补发。
export interface StreamFrames {
    // 一条已持久化的事件
    event: SessionEvent
    // 模型流式输出的文本片段，最终文本以随后到达的 assistant 事件为准
    delta: { turnId: string; text: string }
    // 会话状态变化；error 用于报告无法写入事件日志的错误
    status: { status: SessionStatus; error?: string }
}

export type StreamFrameName = keyof StreamFrames

// ---------- 命令 ----------

// POST /api/sessions -> 201
export interface CreateSessionResponse {
    session: SessionInfo
}

// GET /api/sessions -> 200（按 updatedAt 倒序）
export interface ListSessionsResponse {
    sessions: SessionInfo[]
}

// GET /api/sessions/:id -> 200
export interface GetSessionResponse {
    session: SessionInfo
    events: SessionEvent[]
}

// POST /api/sessions/:id/messages -> 202（立即返回，不等待 Turn 结束）
export interface SendMessageRequest {
    text: string
}

export interface SendMessageResponse {
    turnId: string
}

// POST /api/sessions/:id/approvals/:toolCallId -> 202
export interface ResolveApprovalRequest {
    approved: boolean
    reason?: string
}

// POST /api/sessions/:id/cancel -> 202

// 所有 4xx / 5xx 的响应体
export type ErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'internal'

export interface ErrorResponse {
    error: { code: ErrorCode; message: string }
}
