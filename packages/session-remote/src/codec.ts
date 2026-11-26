// Harness 本地 SessionEvent 与 Kepler Protobuf SessionEvent 的双向转换。

import { create } from '@bufbuild/protobuf'
import type { SessionEvent, TurnStatus as LocalTurnStatus } from '@kepler/protocol'
import {
    ApprovalRequestedEventSchema,
    ApprovalResolvedEventSchema,
    AssistantEventSchema,
    SessionEventSchema,
    ToolCallSchema,
    ToolResultEventSchema,
    TurnEndedEventSchema,
    TurnStatus as ProtoTurnStatus,
    UserEventSchema,
    type SessionEvent as ProtoSessionEvent,
} from '@kepler/protocol/connect'

function toProtoTurnStatus(status: LocalTurnStatus): ProtoTurnStatus {
    switch (status) {
        case 'completed': return ProtoTurnStatus.COMPLETED
        case 'max-steps': return ProtoTurnStatus.MAX_STEPS
        case 'suspended': return ProtoTurnStatus.SUSPENDED
        case 'failed': return ProtoTurnStatus.FAILED
        case 'cancelled': return ProtoTurnStatus.CANCELLED
    }
}

function fromProtoTurnStatus(status: ProtoTurnStatus): LocalTurnStatus {
    switch (status) {
        case ProtoTurnStatus.COMPLETED: return 'completed'
        case ProtoTurnStatus.MAX_STEPS: return 'max-steps'
        case ProtoTurnStatus.SUSPENDED: return 'suspended'
        case ProtoTurnStatus.CANCELLED: return 'cancelled'
        case ProtoTurnStatus.FAILED:
        default:
            return 'failed'
    }
}

export function toProtoEvent(event: SessionEvent): ProtoSessionEvent {
    const base = {
        id: event.id,
        seq: BigInt(event.seq),
        sessionId: event.sessionId,
        turnId: event.turnId,
        tsMs: BigInt(event.ts),
    }

    switch (event.type) {
        case 'user':
            return create(SessionEventSchema, {
                ...base,
                payload: { case: 'user', value: create(UserEventSchema, { text: event.text }) },
            })
        case 'assistant':
            return create(SessionEventSchema, {
                ...base,
                payload: {
                    case: 'assistant',
                    value: create(AssistantEventSchema, {
                        text: event.text,
                        toolCalls: (event.toolCalls ?? []).map(call => create(ToolCallSchema, {
                            id: call.id,
                            name: call.name,
                            arguments: call.arguments,
                        })),
                    }),
                },
            })
        case 'tool-result':
            return create(SessionEventSchema, {
                ...base,
                payload: {
                    case: 'toolResult',
                    value: create(ToolResultEventSchema, {
                        toolCallId: event.toolCallId,
                        name: event.name,
                        content: event.content,
                        isError: Boolean(event.isError),
                    }),
                },
            })
        case 'approval-requested':
            return create(SessionEventSchema, {
                ...base,
                payload: {
                    case: 'approvalRequested',
                    value: create(ApprovalRequestedEventSchema, {
                        toolCallId: event.toolCallId,
                        name: event.name,
                        arguments: event.arguments,
                        reason: event.reason ?? '',
                    }),
                },
            })
        case 'approval-resolved':
            return create(SessionEventSchema, {
                ...base,
                payload: {
                    case: 'approvalResolved',
                    value: create(ApprovalResolvedEventSchema, {
                        toolCallId: event.toolCallId,
                        approved: event.approved,
                        reason: event.reason ?? '',
                    }),
                },
            })
        case 'turn-ended':
            return create(SessionEventSchema, {
                ...base,
                payload: {
                    case: 'turnEnded',
                    value: create(TurnEndedEventSchema, {
                        status: toProtoTurnStatus(event.status),
                        error: event.error ?? '',
                    }),
                },
            })
    }
}

export function fromProtoEvent(pb: ProtoSessionEvent): SessionEvent {
    const base = {
        id: pb.id,
        seq: Number(pb.seq),
        sessionId: pb.sessionId,
        turnId: pb.turnId,
        ts: Number(pb.tsMs),
    }

    switch (pb.payload.case) {
        case 'user':
            return { ...base, type: 'user', text: pb.payload.value.text }
        case 'assistant': {
            const event: Extract<SessionEvent, { type: 'assistant' }> = { ...base, type: 'assistant', text: pb.payload.value.text }
            if (pb.payload.value.toolCalls.length) {
                event.toolCalls = pb.payload.value.toolCalls.map(call => ({
                    id: call.id,
                    name: call.name,
                    arguments: call.arguments,
                }))
            }
            return event
        }
        case 'toolResult': {
            const event: Extract<SessionEvent, { type: 'tool-result' }> = {
                ...base,
                type: 'tool-result',
                toolCallId: pb.payload.value.toolCallId,
                name: pb.payload.value.name,
                content: pb.payload.value.content,
            }
            if (pb.payload.value.isError) event.isError = true
            return event
        }
        case 'approvalRequested': {
            const event: Extract<SessionEvent, { type: 'approval-requested' }> = {
                ...base,
                type: 'approval-requested',
                toolCallId: pb.payload.value.toolCallId,
                name: pb.payload.value.name,
                arguments: pb.payload.value.arguments,
            }
            if (pb.payload.value.reason) event.reason = pb.payload.value.reason
            return event
        }
        case 'approvalResolved': {
            const event: Extract<SessionEvent, { type: 'approval-resolved' }> = {
                ...base,
                type: 'approval-resolved',
                toolCallId: pb.payload.value.toolCallId,
                approved: pb.payload.value.approved,
            }
            if (pb.payload.value.reason) event.reason = pb.payload.value.reason
            return event
        }
        case 'turnEnded': {
            const event: Extract<SessionEvent, { type: 'turn-ended' }> = {
                ...base,
                type: 'turn-ended',
                status: fromProtoTurnStatus(pb.payload.value.status),
            }
            if (pb.payload.value.error) event.error = pb.payload.value.error
            return event
        }
        default:
            throw new Error(`unsupported proto session event payload: ${String(pb.payload.case)}`)
    }
}
