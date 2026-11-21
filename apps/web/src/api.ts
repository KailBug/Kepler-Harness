// 用户面 API 客户端。只依赖 @kepler/protocol 的类型，换成 Kepler 的地址也能用。

import type {
    CreateSessionResponse, ErrorResponse, GetSessionResponse, ListSessionsResponse,
    ResolveApprovalRequest, SendMessageResponse,
} from '@kepler/protocol'

export const API_BASE = '/api'

export class ApiError extends Error {
    status: number

    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(API_BASE + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : {}
    if (!response.ok) {
        const message = (data as ErrorResponse).error?.message ?? `${response.status} ${response.statusText}`
        throw new ApiError(response.status, message)
    }
    return data as T
}

const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}`

export const api = {
    listSessions: () => request<ListSessionsResponse>('GET', '/sessions'),
    createSession: () => request<CreateSessionResponse>('POST', '/sessions', {}),
    getSession: (id: string) => request<GetSessionResponse>('GET', sessionPath(id)),
    sendMessage: (id: string, text: string) => request<SendMessageResponse>('POST', `${sessionPath(id)}/messages`, { text }),
    resolveApproval: (id: string, toolCallId: string, body: ResolveApprovalRequest) =>
        request<{}>('POST', `${sessionPath(id)}/approvals/${encodeURIComponent(toolCallId)}`, body),
    resume: (id: string) => request<{}>('POST', `${sessionPath(id)}/resume`, {}),
    cancel: (id: string) => request<{}>('POST', `${sessionPath(id)}/cancel`, {}),
    eventsUrl: (id: string) => `${API_BASE}${sessionPath(id)}/events`,
}
