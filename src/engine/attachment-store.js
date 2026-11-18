/**
 * 飞书附件的工作区落盘与下载记录。
 *
 * 目录固定为 <工作区>/.feishu/attachments/<来源消息ID>/<附件ID>/<文件名>：
 * - 来源消息与附件都有独立目录，同名文件不会互相覆盖；
 * - 先写临时文件、完整落盘后再改名，失败不会留下半截文件；
 * - 记录写在同目录的 records.json，重复下载先核对文件仍然存在；
 * - 下载失败只返回原因，不返回看似可用的路径。
 */
import { randomBytes } from 'node:crypto'
import { open, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { KeyedSerialQueue } from './keyed-queue.js'
import { backupCorruptFileSync, writeFileAtomicSync } from './atomic-file.js'
import { imageTypeOf } from './file-delivery.js'
import { sanitizeAttachmentName } from '../channels/feishu-message.js'

const IMAGE_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tif',
}

function namedWithType(name, bytes) {
    if (/\.[a-z0-9]{1,8}$/i.test(name))
        return name
    const extension = IMAGE_EXTENSIONS[imageTypeOf(bytes) ?? '']
    return extension ? `${name}${extension}` : name
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const RECORDS_VERSION = 1
const RECORDS_NAME = 'records.json'

export class AttachmentSaveError extends Error {
    /** @param {'too-large'|'empty'|'cancelled'|'download-failed'|'write-failed'|'workspace-unavailable'} reason */
    constructor(reason, options) {
        super(reason, options)
        this.reason = reason
    }
}

function safeSegment(value, fallback) {
    const cleaned = String(value ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80)
    return cleaned || fallback
}

function failureReason(error, signal) {
    if (signal?.aborted)
        return 'cancelled'
    if (error instanceof AttachmentSaveError)
        return error.reason
    if (error?.message === 'resource-too-large')
        return 'too-large'
    if (error?.message === 'resource-empty')
        return 'empty'
    return 'download-failed'
}

export class AttachmentStore {
    log;
    queue = new KeyedSerialQueue();
    cache = new Map();

    constructor(log = () => { }) {
        this.log = log;
    }

    rootOf(cwd) {
        return join(resolve(cwd), '.feishu', 'attachments');
    }

    recordsPath(cwd) {
        return join(this.rootOf(cwd), RECORDS_NAME);
    }

    async recordsFor(cwd) {
        const key = resolve(cwd);
        const cached = this.cache.get(key);
        if (cached)
            return cached;
        const file = this.recordsPath(key);
        let records = {};
        try {
            const text = await readFile(file, 'utf8');
            const parsed = JSON.parse(text);
            if (parsed?.version === RECORDS_VERSION && parsed.records && typeof parsed.records === 'object')
                records = parsed.records;
            else
                throw new Error('invalid-records');
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                try {
                    const backup = backupCorruptFileSync(file);
                    this.log(`[attachment] 下载记录无法解析，已备份为 ${backup ?? '(未创建)'}`);
                }
                catch {
                    this.log('[attachment] 下载记录无法解析，且备份失败');
                }
            }
        }
        this.cache.set(key, records);
        return records;
    }

    writeRecords(cwd, records) {
        writeFileAtomicSync(this.recordsPath(cwd), JSON.stringify({ version: RECORDS_VERSION, records }, null, 2));
    }

    /** 已完成且文件仍在的记录；文件被移走时视为未下载。 */
    async verified(cwd, attachmentId) {
        const records = await this.recordsFor(cwd);
        const record = records[attachmentId];
        if (!record || record.status !== 'done' || typeof record.path !== 'string')
            return undefined;
        try {
            const info = await stat(join(resolve(cwd), record.path));
            return info.isFile() ? record : undefined;
        }
        catch {
            return undefined;
        }
    }

    relativePath(cwd, absolute) {
        return relative(resolve(cwd), absolute).split(sep).join('/');
    }

    /**
     * 下载并保存一个附件。
     * @param {object} options
     * @param {string} options.cwd 当前会话工作区
     * @param {string} options.channelId
     * @param {string} options.chatId
     * @param {string} options.sourceMessageId
     * @param {{ id: string, kind: string, name?: string, fileKey?: string, imageKey?: string }} options.attachment
     * @param {(signal: AbortSignal) => Promise<Buffer|Uint8Array>} options.download
     * @param {AbortSignal} options.signal
     * @param {number} [options.maxBytes] 本次允许写入的字节上限
     */
    async save({ cwd, channelId, chatId, sourceMessageId, attachment, download, signal, maxBytes = MAX_ATTACHMENT_BYTES }) {
        if (!cwd || typeof cwd !== 'string')
            throw new AttachmentSaveError('workspace-unavailable');
        const root = this.rootOf(cwd);
        const attachmentId = safeSegment(attachment.id, 'attachment');
        return this.queue.run(resolve(cwd), async () => {
            const records = await this.recordsFor(cwd);
            const reusable = await this.verified(cwd, attachmentId);
            if (reusable)
                return reusable;
            // 记录还在但文件已被移走：清掉旧记录，失败时才能如实写入失败状态。
            if (records[attachmentId]?.status === 'done' && reusable === undefined)
                delete records[attachmentId];
            const dir = join(root, safeSegment(sourceMessageId, 'message'), attachmentId);
            try {
                await mkdir(dir, { recursive: true });
            }
            catch (error) {
                throw new AttachmentSaveError('write-failed', { cause: error });
            }
            const initialName = sanitizeAttachmentName(attachment.name, `attachment-${attachmentId}`);
            const base = {
                attachmentId, channelId, chatId, messageId: sourceMessageId,
                kind: attachment.kind, fileKey: attachment.fileKey, imageKey: attachment.imageKey,
                name: initialName, downloadedAt: new Date().toISOString(),
            };
            let fd;
            let temp;
            try {
                signal?.throwIfAborted();
                const data = await download(signal);
                const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
                if (bytes.length === 0)
                    throw new AttachmentSaveError('empty');
                if (bytes.length > maxBytes)
                    throw new AttachmentSaveError('too-large');
                // 图片消息没有文件名，按实际字节补扩展名，便于后续文件与图片工具识别。
                const name = namedWithType(initialName, bytes);
                const absolute = join(dir, name);
                temp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
                fd = await open(temp, 'wx');
                await fd.writeFile(bytes);
                await fd.sync();
                await fd.close();
                fd = undefined;
                await rename(temp, absolute);
                const record = { ...base, name, path: this.relativePath(cwd, absolute), bytes: bytes.length, status: 'done' };
                records[attachmentId] = record;
                try {
                    this.writeRecords(cwd, records);
                }
                catch {
                    // 文件已经完整落盘，索引失败不影响本次使用；下次启动会重新下载。
                    this.log('[attachment] 下载记录落盘失败，文件已保存');
                }
                return record;
            }
            catch (error) {
                const reason = failureReason(error, signal);
                if (records[attachmentId]?.status !== 'done') {
                    records[attachmentId] = { ...base, bytes: 0, status: 'failed', error: reason };
                    try {
                        this.writeRecords(cwd, records);
                    }
                    catch {
                        this.log('[attachment] 下载失败记录落盘失败');
                    }
                }
                throw error instanceof AttachmentSaveError ? error : new AttachmentSaveError(reason, { cause: error });
            }
            finally {
                if (fd !== undefined) {
                    try {
                        await fd.close();
                    }
                    catch { /* 已关闭 */ }
                }
                if (temp)
                    await unlink(temp).catch(() => undefined);
            }
        });
    }
}