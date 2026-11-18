import { readFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { KeyedSerialQueue } from './keyed-queue.js';
import { writeFileAtomicSync } from './atomic-file.js';
import { replyText, withReplyLocale } from './command-locale.js';
import { readLiveSessionHistory } from './session-history.js';

/** 文件交付失败：rejected 表示平台明确拒绝，unknown 表示超时/断连等结果未知。 */
export class FileDeliveryError extends Error {
    constructor(status, message, options) {
        super(message, options);
        this.status = status;
    }
}

/** 与 Chat 的成功文件变更规则保持一致；不从助手回复中猜路径。 */
function mutationPath(name, raw) {
    if (typeof raw !== 'string')
        return;
    let args;
    try {
        args = JSON.parse(raw);
    }
    catch {
        return;
    }
    if (!args || typeof args !== 'object')
        return;
    const path = name === 'str_replace_editor' ? args.path : args.file_path;
    if (typeof path !== 'string' || !path.trim())
        return;
    if (name === 'write' && typeof args.content === 'string')
        return path;
    if (name === 'edit' && typeof args.old_string === 'string' && args.old_string.length > 0
        && typeof args.new_string === 'string' && args.old_string !== args.new_string
        && (args.replace_all === undefined || typeof args.replace_all === 'boolean'))
        return path;
    if (name !== 'str_replace_editor')
        return;
    if (args.command === 'create' && typeof args.file_text === 'string')
        return path;
    if (args.command === 'str_replace' && typeof args.old_str === 'string' && args.old_str.length > 0
        && (args.new_str === undefined || typeof args.new_str === 'string'))
        return path;
    if (args.command === 'insert' && Number.isInteger(args.insert_line) && args.insert_line >= 0 && typeof args.new_str === 'string')
        return path;
}
/** 只选当前回复所在回合、已成功产生或明确 present 的文件。 */
export function filesForReply(events, closing) {
    let end = events.findIndex(event => event === closing || (closing.seq !== undefined && event.seq === closing.seq));
    if (end < 0)
        end = events.length;
    if (closing.surfaceOp !== 'append' || closing.data?.interrupted
        || closing.data?.message?.content?.some((part) => part.type === 'tool-call'))
        return;
    const prefix = events.slice(0, end);
    const turn = closing.data?.turn;
    if (!Number.isSafeInteger(turn))
        return;
    const calls = new Map();
    const paths = new Set();
    for (const event of prefix) {
        const data = event.data;
        if (event.type === 'tool/call' && data?.turn === turn) {
            const path = mutationPath(data.name, data.arguments);
            if (path && typeof data.callId === 'string')
                calls.set(data.callId, path);
        }
        else if (event.type === 'tool/result' && data?.turn === turn && event.surfaceOp === 'append') {
            const path = calls.get(data?.message?.source?.callId);
            if (path && !toolResultFailed(data))
                paths.add(path);
        }
        else if (event.type === 'deliverables/presented' && data?.turn === turn && Array.isArray(data.files)) {
            for (const file of data.files)
                if (typeof file?.path === 'string' && file.path.trim())
                    paths.add(file.path);
        }
    }
    return { turn, paths: [...paths] };
}
/** V4 把 isError 放到 message 上；旧日志仍在 tool-result 内容块上。 */
export function toolResultFailed(data) {
    if (data?.message?.isError === true)
        return true;
    return data?.message?.content?.[0]?.isError === true;
}
/** 文件在投递前已被删除（例如同一回合写入后又被清理）不是投递失败：静默跳过，不打扰用户。 */
export function missingFileError(error) {
    const code = error?.code;
    if (typeof code === 'string') {
        const tail = code.slice(code.lastIndexOf('/') + 1).toLowerCase();
        if (tail === 'not-found' || tail === 'fs_not_found' || tail === 'enoent')
            return true;
    }
    const message = error instanceof Error ? error.message : '';
    return message === 'file-not-found';
}
/** 仅按文件头识别；识别不了的按普通文件发送，不猜扩展名。 */
export function imageTypeOf(data) {
    if (!data || data.length < 12)
        return undefined;
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return 'image/png';
    if (data[0] === 255 && data[1] === 216 && data[2] === 255)
        return 'image/jpeg';
    const head = data.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a')
        return 'image/gif';
    if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP')
        return 'image/webp';
    if (data[0] === 66 && data[1] === 77)
        return 'image/bmp';
    if ((data[0] === 73 && data[1] === 73 && data[2] === 42) || (data[0] === 77 && data[1] === 77 && data[2] === 0))
        return 'image/tiff';
    return undefined;
}
/** 复用 Chat 完整文件读取服务，宿主负责路径、文件类型和大小限制。 */
export class FileDelivery {
    host;
    log;
    queue = new KeyedSerialQueue();
    sent = new Map();
    records = new Map();
    lifetime = new AbortController();
    ledgerFile;
    constructor(host, log, ledgerFile) {
        this.host = host;
        this.log = log;
        this.ledgerFile = ledgerFile;
        this.loadLedger();
    }
    dispose() { this.lifetime.abort(); this.sent.clear(); this.records.clear(); }
    /** 供显式交付工具与自动回传共用；同一回合同一文件只发送一次。 */
    delivered(sessionId, turn, channelId, chatId, identity) {
        return this.sent.get(this.sentKey(sessionId, turn, channelId, chatId))?.has(identity) === true;
    }
    remember(sessionId, turn, channelId, chatId, identity) {
        const key = this.sentKey(sessionId, turn, channelId, chatId);
        const set = this.sent.get(key) ?? new Set();
        this.sent.set(key, set);
        if (this.sent.size > 256)
            this.sent.delete(this.sent.keys().next().value);
        set.add(identity);
    }
    sentKey(sessionId, turn, channelId, chatId) {
        return `${sessionId}:${turn ?? '-'}:${channelId}:${chatId}`;
    }
    record(channelId, chatId, name, status, stage) {
        const key = `${channelId}:${chatId}:${name}:${Date.now()}`;
        this.records.set(key, { channelId, chatId, name, status, ...(stage ? { stage } : {}), at: new Date().toISOString() });
        if (this.records.size > 256)
            this.records.delete(this.records.keys().next().value);
        this.flushLedger();
    }
    deliveries() { return [...this.records.values()]; }
    loadLedger() {
        if (!this.ledgerFile)
            return;
        try {
            const parsed = JSON.parse(readFileSync(this.ledgerFile, 'utf8'));
            const entries = Array.isArray(parsed?.records) ? parsed.records : [];
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string')
                    continue;
                const key = `${entry.channelId ?? ''}:${entry.chatId ?? ''}:${entry.name}:${entry.at ?? ''}`;
                this.records.set(key, entry);
            }
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                this.log('[file-delivery] 交付记录无法读取，保留为空并在下次发送时重建');
        }
    }
    flushLedger() {
        if (!this.ledgerFile)
            return;
        try {
            writeFileAtomicSync(this.ledgerFile, JSON.stringify({ version: 1, records: this.deliveries() }), 0o600);
        }
        catch {
            this.log('[file-delivery] 交付记录落盘失败，本次结果仍按内存状态报告');
        }
    }
    deliver(session, closing, target, onContent) {
        let ok = true;
        const initial = target();
        return this.queue.run(String(session.id), async () => {
            if (this.lifetime.signal.aborted) {
                ok = false;
                return;
            }
            const selected = filesForReply(readLiveSessionHistory(session) ?? [], closing);
            if (!selected?.paths.length)
                return;
            onContent?.();
            if (!initial) {
                ok = false;
                return;
            }
            for (const path of selected.paths) {
                if (this.lifetime.signal.aborted) {
                    ok = false;
                    return;
                }
                const current = target();
                if (!current || current.channel !== initial.channel || current.chatId !== initial.chatId) {
                    ok = false;
                    return;
                }
                const result = await this.deliverPath({
                    sessionId: String(session.id),
                    session,
                    channel: current.channel,
                    chatId: current.chatId,
                    messageId: current.messageId,
                    path,
                    turn: selected.turn,
                    signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120_000)]),
                });
                if (result.status === 'failed' || result.status === 'unknown')
                    ok = false;
            }
        }).then(() => ok).catch(error => { this.log(`[file-delivery] ${error instanceof Error ? error.message : String(error)}`); return false; });
    }
    /**
     * 读取并发送一个工作区文件。图片走图片消息，其余走文件消息。
     * @returns {Promise<{status:'sent'|'skipped'|'missing'|'failed'|'unknown'}>}
     */
    async deliverPath({ sessionId, session, channel, chatId, messageId, path, turn, signal, announceFailure = true }) {
        const cwd = session?.header?.cwd ?? this.host.get('sandboxPolicy')?.workspaceRoot;
        if (!cwd || (!channel.sendFile && !channel.sendImage)) {
            this.log(`[${channel.id}] 文件交付不可用`);
            return { status: 'failed' };
        }
        // 同一文件可能同时以 write 的绝对路径和 present 的相对路径出现。
        // 先做工作区边界检查，实际读取仍由 Chat 服务校验原始路径。
        const identity = resolve(cwd, path);
        const inside = relative(cwd, identity);
        if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
            this.log(`[${channel.id}] 拒绝发送工作区外的文件`);
            return { status: 'failed' };
        }
        if (this.delivered(sessionId, turn, channel.id, chatId, identity))
            return { status: 'skipped' };
        const name = basename(path.replace(/\\/g, '/'));
        try {
            const result = await readFileForDelivery(this.host, sessionId, cwd, path, signal);
            signal?.throwIfAborted();
            if (!result.eof || result.offset !== 0 || typeof result.data !== 'string')
                throw new Error('incomplete-file');
            const data = Buffer.from(result.data, 'base64');
            const contentType = imageTypeOf(data);
            if (contentType && channel.sendImage)
                await channel.sendImage(chatId, { name, data, mediaType: contentType }, signal, messageId ? { messageId } : undefined);
            else
                await channel.sendFile(chatId, { name, data }, signal, messageId ? { messageId } : undefined);
            this.remember(sessionId, turn, channel.id, chatId, identity);
            this.record(channel.id, chatId, name, 'sent');
            return { status: 'sent' };
        }
        catch (error) {
            if (missingFileError(error))
                return { status: 'missing' };
            const status = error instanceof FileDeliveryError ? error.status : 'unknown';
            const outcome = status === 'rejected' ? 'failed' : 'unknown';
            this.record(channel.id, chatId, name, status, error instanceof FileDeliveryError ? error.message : 'unknown');
            const code = typeof error?.code === 'string' ? ` code=${error.code}` : '';
            this.log(`[${channel.id}] 文件回传失败（${error instanceof Error ? error.name : 'Error'}${code}；status=${status}；敏感详情已隐藏）`);
            if (!announceFailure)
                return { status: outcome };
            const text = withReplyLocale(this.host, () => status === 'rejected'
                ? replyText('文件“{0}”未能发送，请在网页 Chat 中打开该文件；也可让助手重新交付。', name)
                : replyText('文件“{0}”的发送结果未知，请先确认是否收到，避免重复发送；也可在网页 Chat 查看。', name));
            await channel.send(chatId, text).catch(() => undefined);
            return { status: outcome };
        }
    }
}
/** `readBytes(scope, path, {}, signal)` 不带 range：要么整文件，要么 too-large 抛错，不返回分片。0.1.7-alpha.1、alpha.2 和 rc.1 该分支写的是 `offset: 0, eof: true`。缺字段按完整文件处理；显式 `eof: false` 或非零 offset 仍拒绝。 */
function encodeFileBytes(result) {
    const offset = result.offset ?? 0;
    const eof = result.eof !== false;
    if (typeof result.data === 'string')
        return { data: result.data, eof, offset };
    if (result.data instanceof Uint8Array)
        return { data: Buffer.from(result.data).toString('base64'), eof, offset };
    throw new Error('incomplete-file');
}
/** 0.1.5 用 readAll；0.1.7 起改为 readBytes({}, 完整文件)；0.1.2-rc.1 没有该服务，走本机 fs。0.1.6 已不在 peer 里，不再单独分支。 */
export async function readFileForDelivery(host, sessionId, cwd, path, signal) {
    const files = host.get('workspaceFiles');
    if (typeof files?.readAll === 'function') {
        return encodeFileBytes(await files.readAll({ sessionId, workspaceRoot: cwd }, path, signal));
    }
    if (typeof files?.readBytes === 'function') {
        return encodeFileBytes(await files.readBytes({ sessionId, workspaceRoot: cwd }, path, {}, signal));
    }
    return readLegacyFile(host, cwd, path, signal);
}
/** 旧 Chat 只有本机路径打开；使用宿主 fs，沿用新版完整下载默认 32 MiB 上限。 */
async function readLegacyFile(host, cwd, path, signal) {
    const fs = host.get('fs');
    if (!fs?.readBytes)
        throw new Error('file-service-unavailable');
    const limit = 32 * 1024 * 1024;
    if ((await fs.lstat(path, { cwd }, signal))?.type !== 'file')
        throw new Error('not-regular-file');
    const target = await fs.resolve(path, { cwd, signal });
    const info = await fs.stat(target, signal);
    if (info?.type !== 'file')
        throw new Error('not-regular-file');
    if (info.size !== undefined && info.size > limit)
        throw new Error('file-too-large');
    const bytes = await fs.readBytes(target, signal, limit);
    if (bytes.byteLength > limit)
        throw new Error('file-too-large');
    return { data: Buffer.from(bytes).toString('base64'), offset: 0, eof: true };
}