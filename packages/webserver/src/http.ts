// 极简 HTTP 工具：路由匹配、JSON 读写、静态文件。只依赖 node:http，不引第三方框架。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { ErrorCode, ErrorResponse } from '@kepler/protocol'

export class HttpError extends Error {
    status: number
    code: ErrorCode

    constructor(status: number, code: ErrorCode, message: string) {
        super(message)
        this.status = status
        this.code = code
    }
}

const MAX_BODY = 1024 * 1024

export async function readJson(req: IncomingMessage): Promise<any> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) throw new HttpError(413, 'bad_request', 'request body too large')
        chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) return {}
    try {
        const value = JSON.parse(text)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
        return value
    } catch {
        throw new HttpError(400, 'bad_request', 'request body must be a JSON object')
    }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
}

export function sendError(res: ServerResponse, error: unknown) {
    const http = error instanceof HttpError ? error : new HttpError(500, 'internal', error instanceof Error ? error.message : String(error))
    if (res.headersSent) return void res.end()
    const body: ErrorResponse = { error: { code: http.code, message: http.message } }
    sendJson(res, http.status, body)
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => unknown

export class Router {
    private routes: { method: string; pattern: RegExp; handler: Handler }[] = []

    // pattern 里的 :name 段会被捕获，按顺序作为 params 传给 handler
    add(method: string, path: string, handler: Handler) {
        const source = path.replace(/:[a-zA-Z]+/g, '([^/]+)')
        this.routes.push({ method, pattern: new RegExp(`^${source}$`), handler })
        return this
    }

    // 返回 false 表示没有匹配的 API 路由
    async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
        let pathMatched = false
        for (const route of this.routes) {
            const match = route.pattern.exec(url.pathname)
            if (!match) continue
            pathMatched = true
            if (route.method !== req.method) continue
            const params = match.slice(1).map(decodeURIComponent)
            await route.handler(req, res, params, url)
            return true
        }
        if (pathMatched) throw new HttpError(405, 'bad_request', `method ${req.method} not allowed`)
        return false
    }
}

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
}

// 单页应用的静态文件服务：找不到的路径一律回退到 index.html，交给前端路由。
export async function serveStatic(res: ServerResponse, root: string, pathname: string) {
    const base = resolve(root)
    let file = resolve(join(base, normalize(decodeURIComponent(pathname))))
    if (file !== base && !file.startsWith(base + sep)) throw new HttpError(404, 'not_found', 'not found')
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile()) file = join(base, 'index.html')
    const body = await readFile(file).catch(() => undefined)
    if (!body) throw new HttpError(404, 'not_found', 'frontend not built, run `npm run build -w @kepler/web`')
    const immutable = file.includes(`${sep}assets${sep}`)
    res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(body)
}
