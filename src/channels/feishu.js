import { channelNotice } from '../engine/command-locale.js';
import { choiceSendError, ChoiceSendError } from '../engine/choice-delivery.js';
import { afterPartialDelivery, DeliveryRejected } from '../engine/deferred-delivery.js';
import { DiagnosticError, diagnosticJson, platformResult, probe, requireDiagnostic } from './diagnostics.js';
import { fileOperation } from '../engine/abort.js';
import { quietSdkLogger } from '../engine/quiet-logger.js';
import { KeyedSerialQueue } from '../engine/keyed-queue.js';
import { timeoutSignal } from '../engine/abort.js';
import { markdownTableOffsets } from '../engine/split.js';
import { FileDeliveryError } from '../engine/file-delivery.js';
import { normalizeFeishuMessage } from './feishu-message.js';
/** 飞书一张卡片最多 5 个 table 元素，超了整个写入会被拒（230099 / ErrCode 11310），旧卡片内容会卡住。 */
export const FEISHU_CARD_MAX_TABLES = 5;
/** 按表格数量拆正文，保证每张卡不超上限，且不会把表格切一半。 */
export function splitByTableLimit(text, maxTables = FEISHU_CARD_MAX_TABLES) {
    const value = text ?? '';
    const starts = markdownTableOffsets(value);
    if (starts.length <= maxTables)
        return value ? [value] : [];
    const parts = [];
    let from = 0;
    for (let index = maxTables; index < starts.length; index += maxTables) {
        parts.push(value.slice(from, starts[index]));
        from = starts[index];
    }
    parts.push(value.slice(from));
    return parts.filter((part) => part.trim() !== '');
}
/** 飞书限流：消息接口 230020 / 11232，通用频控 99991400（HTTP 429，旧接口为 400）。 */
const FEISHU_THROTTLE_CODES = new Set([230020, 11232, 99991400]);
function isThrottleCode(code) {
    return FEISHU_THROTTLE_CODES.has(Number(code));
}
/** SDK 在 HTTP 非 2xx 时抛 AxiosError：429，或响应体带限流码，说明请求被限流、未被受理。 */
function throttledResponse(error) {
    const response = error?.response;
    return response?.status === 429 || isThrottleCode(response?.data?.code);
}
/** 诊断只保留受限长度的数字状态码，禁止输出响应正文、请求配置或凭据。 */
function httpFailureSummary(error) {
    const response = error?.response;
    const status = response?.status;
    const code = response?.data?.code;
    const safeStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'unknown';
    const safeCode = typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 && code <= 999_999_999
        ? code : typeof code === 'string' && /^\d{1,9}$/.test(code) ? code : 'unknown';
    return `http=${safeStatus} code=${safeCode}`;
}
// 沿用 SDK 允许缺省业务码的响应，同时兼容数字和字符串零码。
function isRejectedCode(code) {
    return code !== undefined && code !== 0 && code !== '0';
}
/** 单条消息累计下载上限；与附件存储共用同一 20 MiB 预算。 */
const MAX_RESOURCE_BYTES = 20 * 1024 * 1024;
/** 飞书图片消息上传上限为 10 MB；超过时按普通文件发送。 */
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
/** 读取引用或历史消息的时限；失败只记录原因，不影响当前请求。 */
const CONTEXT_TIMEOUT_MS = 15_000;
/** 群消息只有明确 mention 当前机器人本身才算 addressed；@ 其他成员不触发。 */
export function isFeishuBotMentioned(mentions, botOpenId) {
    if (!botOpenId || !Array.isArray(mentions))
        return false;
    return mentions.some((mention) => mention.id?.open_id === botOpenId);
}
/** 引用读取失败只暴露稳定分类，不透传上游原文。 */
function readFailureReason(error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
        return 'timeout';
    const response = error?.response;
    const code = Number(response?.data?.code ?? error?.platformCode);
    const status = Number(response?.status);
    if (code === 99991672 || status === 403)
        return 'permission';
    if (code === 230002 || status === 404)
        return 'not-found';
    if (isThrottleCode(code) || status === 429)
        return 'throttled';
    return 'unavailable';
}
/** 下载一个资源并按上限累计字节；返回完整 Buffer，失败不返回部分结果。 */
async function readResource(client, { messageId, fileKey, type }, signal, limit = MAX_RESOURCE_BYTES) {
    if (!messageId || !fileKey)
        throw new Error('resource-missing');
    let stream;
    let abort = () => { };
    const aborted = new Promise((_, reject) => {
        abort = () => {
            stream?.destroy(new Error('resource-aborted'));
            reject(signal.reason ?? new Error('resource-aborted'));
        };
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        const resource = await Promise.race([
            client.im.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type } }).then(value => {
                stream = value.getReadableStream();
                if (signal.aborted) {
                    stream.destroy();
                    throw signal.reason ?? new Error('resource-aborted');
                }
                return value;
            }),
            aborted,
        ]);
        const declared = Number(resource?.headers?.['content-length']);
        if (Number.isFinite(declared) && declared > limit)
            throw new Error('resource-too-large');
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > limit)
                throw new Error('resource-too-large');
            chunks.push(bytes);
        }
        if (size === 0)
            throw new Error('resource-empty');
        return Buffer.concat(chunks);
    }
    finally {
        signal.removeEventListener('abort', abort);
        stream?.destroy();
    }
}
function messageItems(result) {
    const data = result?.data;
    const items = data?.items ?? (Array.isArray(data) ? data : data?.message ? [data.message] : []);
    return Array.isArray(items) ? items : [];
}
function assertResult(result, stage) {
    const code = result?.code;
    if (isRejectedCode(code))
        throw Object.assign(new Error(`${stage}-rejected`), { platformCode: Number(code) });
    return result;
}
function deliveryFailure(error, stage) {
    if (error instanceof FileDeliveryError)
        return error;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
        return new FileDeliveryError('unknown', `${stage}-timeout`, { cause: error });
    const response = error?.response;
    const status = Number(response?.status);
    const code = Number(response?.data?.code ?? error?.platformCode);
    if (isThrottleCode(code) || status === 429)
        return new FileDeliveryError('rejected', `${stage}-throttled`, { cause: error });
    if (status >= 400 && status < 500)
        return new FileDeliveryError('rejected', `${stage}-rejected`, { cause: error });
    return new FileDeliveryError('unknown', `${stage}-unknown`, { cause: error });
}
export function createFeishuChannel(id, config, log, loadSdk) {
    const appId = config.appId?.trim();
    const appSecret = config.appSecret?.trim();
    if (!appId || !appSecret)
        return undefined;
    let handler;
    let client;
    let ws;
    let statusText = '未连接';
    let lifecycle;
    const label = '飞书';
    /** 群/API 读取的单条消息；事件处理与工具共用。 */
    async function readMessage(messageId, signal) {
        if (!client)
            throw new Error(`${id}: 尚未连接`);
        const scope = AbortSignal.any([timeoutSignal(30_000, lifecycle?.signal), ...(signal ? [signal] : [])]);
        scope.throwIfAborted();
        const result = await fileOperation(client.im.message.get({ path: { message_id: messageId } }), scope);
        assertResult(result, 'message-read');
        const item = messageItems(result)[0];
        if (!item)
            throw Object.assign(new Error('message-not-found'), { platformCode: 230002 });
        return normalizeFeishuMessage(item, { source: 'api' });
    }
    async function listMessages({ chatId, threadId, startTime, endTime, pageSize = DEFAULT_PAGE_SIZE, pageToken }, signal) {
        if (!client)
            throw new Error(`${id}: 尚未连接`);
        if (!chatId)
            throw new Error('message-list-scope-missing');
        const scope = AbortSignal.any([timeoutSignal(30_000, lifecycle?.signal), ...(signal ? [signal] : [])]);
        scope.throwIfAborted();
        const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isSafeInteger(pageSize) ? pageSize : DEFAULT_PAGE_SIZE));
        const result = await fileOperation(client.im.message.list({ params: {
                container_id_type: threadId ? 'thread' : 'chat',
                container_id: threadId || chatId,
                sort_type: 'ByCreateTimeDesc',
                page_size: String(size),
                ...(startTime ? { start_time: String(startTime) } : {}),
                ...(endTime ? { end_time: String(endTime) } : {}),
                ...(pageToken ? { page_token: pageToken } : {}),
            } }), scope);
        assertResult(result, 'message-list');
        const data = result?.data ?? {};
        return {
            messages: messageItems(result).map(item => normalizeFeishuMessage(item, { source: 'api' })),
            hasMore: data.has_more === true || data.has_more === 1,
            pageToken: typeof data.page_token === 'string' ? data.page_token : '',
        };
    }
    async function downloadAttachment(attachment, signal, limit = MAX_RESOURCE_BYTES) {
        if (!attachment?.sourceMessageId)
            throw new Error('attachment-source-missing');
        const key = attachment.kind === 'image' ? attachment.imageKey ?? attachment.fileKey : attachment.fileKey ?? attachment.imageKey;
        const scope = AbortSignal.any([timeoutSignal(60_000, lifecycle?.signal), ...(signal ? [signal] : [])]);
        scope.throwIfAborted();
        return readResource(client, { messageId: attachment.sourceMessageId, fileKey: key, type: attachment.kind === 'image' ? 'image' : 'file' }, scope, limit);
    }
    /** 工作数据只读接口共用同一套超时、取消与业务码校验。 */
    async function requestData(operation, stage, signal) {
        if (!client)
            throw new Error(`${id}: 尚未连接`);
        const scope = AbortSignal.any([timeoutSignal(30_000, lifecycle?.signal), ...(signal ? [signal] : [])]);
        scope.throwIfAborted();
        const result = await fileOperation(operation(), scope);
        assertResult(result, stage);
        return result?.data ?? {};
    }
    function pageOf(data) {
        return {
            items: Array.isArray(data?.items) ? data.items : [],
            hasMore: data?.has_more === true || data?.has_more === 1,
            pageToken: typeof data?.page_token === 'string' ? data.page_token : '',
        };
    }
    /** 应用身份读取多维表格；文档权限由飞书 Base 协作者设置决定。 */
    async function bitableGet(appToken, signal) {
        const data = await requestData(() => client.bitable.app.get({ path: { app_token: appToken } }), 'bitable-app', signal);
        return data?.app ?? data;
    }
    async function bitableListTables(appToken, { pageSize = 50, pageToken } = {}, signal) {
        const data = await requestData(() => client.bitable.appTable.list({ path: { app_token: appToken }, params: {
                page_size: pageSize,
                ...(pageToken ? { page_token: pageToken } : {}),
            } }), 'bitable-tables', signal);
        return pageOf(data);
    }
    async function bitableListFields(appToken, tableId, { viewId, pageSize = 50, pageToken } = {}, signal) {
        const data = await requestData(() => client.bitable.appTableField.list({ path: { app_token: appToken, table_id: tableId }, params: {
                ...(viewId ? { view_id: viewId } : {}),
                page_size: pageSize,
                ...(pageToken ? { page_token: pageToken } : {}),
            } }), 'bitable-fields', signal);
        return pageOf(data);
    }
    async function bitableSearchRecords(appToken, tableId, { viewId, fieldNames, filter, sort, pageSize = 50, pageToken } = {}, signal) {
        const data = await requestData(() => client.bitable.appTableRecord.search({ path: { app_token: appToken, table_id: tableId }, params: {
                user_id_type: 'open_id',
                page_size: pageSize,
                ...(pageToken ? { page_token: pageToken } : {}),
            }, data: {
                ...(viewId ? { view_id: viewId } : {}),
                ...(fieldNames?.length ? { field_names: fieldNames } : {}),
                ...(filter ? { filter } : {}),
                ...(sort?.length ? { sort } : {}),
            } }), 'bitable-records', signal);
        return { ...pageOf(data), ...(Number.isSafeInteger(data?.total) ? { total: data.total } : {}) };
    }
    /** 任务接口按调用身份返回可见数据；应用身份不会获得用户个人任务。 */
    async function taskList({ completed, pageSize = 50, pageToken } = {}, signal) {
        const data = await requestData(() => client.task.v2.task.list({ params: {
                user_id_type: 'open_id',
                page_size: pageSize,
                page_token: pageToken,
                ...(typeof completed === 'boolean' ? { completed } : {}),
            } }), 'task-list', signal);
        return pageOf(data);
    }
    async function taskGet(taskGuid, signal) {
        const data = await requestData(() => client.task.v2.task.get({ path: { task_guid: taskGuid }, params: { user_id_type: 'open_id' } }), 'task-get', signal);
        return data?.task;
    }
    async function tasklistList({ pageSize = 50, pageToken } = {}, signal) {
        const data = await requestData(() => client.task.v2.tasklist.list({ params: {
                user_id_type: 'open_id',
                page_size: pageSize,
                page_token: pageToken,
            } }), 'tasklist-list', signal);
        return pageOf(data);
    }
    async function tasklistTasks(tasklistGuid, { completed, pageSize = 50, pageToken } = {}, signal) {
        const data = await requestData(() => client.task.v2.tasklist.tasks({ path: { tasklist_guid: tasklistGuid }, params: {
                user_id_type: 'open_id',
                page_size: pageSize,
                page_token: pageToken,
                ...(typeof completed === 'boolean' ? { completed } : {}),
            } }), 'tasklist-tasks', signal);
        return pageOf(data);
    }
    function sendPayload(chatId, target, payload, sender = client) {
        if (!sender)
            throw new Error(`${id}: 尚未连接`);
        if (target?.messageId) {
            if (typeof sender.im.message.reply !== 'function')
                throw new Error('reply-unsupported');
            return sender.im.message.reply({ path: { message_id: target.messageId }, data: payload });
        }
        return sender.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, ...payload } });
    }
    async function sendFile(chatId, file, signal, target) {
        if (!client || !lifecycle)
            throw new Error(`${id}: 尚未连接`);
        const active = client;
        const scope = AbortSignal.any([timeoutSignal(120_000, lifecycle.signal), ...(signal ? [signal] : [])]);
        scope.throwIfAborted();
        let uploaded;
        try {
            uploaded = await fileOperation(active.im.file.create({ data: { file_type: 'stream', file_name: file.name, file: Buffer.from(file.data) } }), scope);
        }
        catch (error) {
            throw deliveryFailure(error, 'file-upload');
        }
        scope.throwIfAborted();
        const key = uploaded?.file_key ?? uploaded?.data?.file_key;
        if (isRejectedCode(uploaded?.code) || !key)
            throw new FileDeliveryError('rejected', `file-upload-rejected code=${String(uploaded?.code)}`);
        const sent = await sendPayload(chatId, target, { msg_type: 'file', content: JSON.stringify({ file_key: key }) }, active).catch(error => { throw deliveryFailure(error, 'file-send') });
        if (isRejectedCode(sent?.code))
            throw new FileDeliveryError('rejected', `file-send-rejected code=${String(sent?.code)}`);
        return { status: 'sent' };
    }
    async function sendImage(chatId, image, signal, target) {
        if (!client || !lifecycle)
            throw new Error(`${id}: 尚未连接`);
        const data = Buffer.from(image.data ?? []);
        if (!data.length)
            throw new FileDeliveryError('rejected', 'image-empty');
        if (data.length > MAX_IMAGE_UPLOAD_BYTES) {
            log(`[${id}] 图片超过 10 MB，改按文件发送`);
            return sendFile(chatId, image, signal, target);
        }
        const active = client;
        const scope = AbortSignal.any([timeoutSignal(120_000, lifecycle.signal), ...(signal ? [signal] : [])]);
        scope.throwIfAborted();
        let uploaded;
        try {
            uploaded = await fileOperation(active.im.image.create({ data: { image_type: 'message', image: data } }), scope);
        }
        catch (error) {
            const failure = deliveryFailure(error, 'image-upload');
            if (failure.status === 'rejected') {
                log(`[${id}] 图片上传被拒，改按文件发送`);
                return sendFile(chatId, image, signal, target);
            }
            throw failure;
        }
        scope.throwIfAborted();
        const key = uploaded?.image_key ?? uploaded?.data?.image_key;
        if (isRejectedCode(uploaded?.code) || !key) {
            log(`[${id}] 图片上传被拒，改按文件发送`);
            return sendFile(chatId, image, signal, target);
        }
        const sent = await sendPayload(chatId, target, { msg_type: 'image', content: JSON.stringify({ image_key: key }) }, active).catch(error => { throw deliveryFailure(error, 'image-send') });
        if (isRejectedCode(sent?.code))
            throw new FileDeliveryError('rejected', `image-send-rejected code=${String(sent?.code)}`);
        return { status: 'sent' };
    }
    async function sendText(chatId, text, target) {
        if (!client)
            throw new Error(`${id}: 尚未连接`);
        const sender = client;
        // 普通回复也走卡片 markdown，标题、列表和表格才会被渲染；按表格数量拆卡。
        let delivered = false;
        for (const part of splitByTableLimit(text)) {
            try {
                // 仅明确业务拒绝或 HTTP 400 回退；网络结果未知时不重发，避免重复投递。
                // 飞书要渲染 Markdown 表格，卡片必须是 Schema 2.0（body.elements）
                const card = await sendPayload(chatId, target, {
                    msg_type: 'interactive',
                    content: JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true }, body: { elements: [{ tag: 'markdown', content: part }] } }),
                }, sender).catch((error) => {
                    const response = error?.response;
                    // 旧接口也可能用 HTTP 400 返回限流，必须优先保留上层退避语义。
                    if (response?.status !== 400 || throttledResponse(error))
                        throw error;
                    log(`[${id}] 卡片发送被拒，回退纯文本 ${httpFailureSummary(error)}`);
                    return { code: 'http-400' };
                });
                if (!isRejectedCode(card?.code)) {
                    delivered = true;
                    continue;
                }
                // 被限流时改发纯文本只会再被限流，直接交给上层退避重试。
                if (isThrottleCode(card?.code))
                    throw new DeliveryRejected(`${id}: text-send-throttled code=${card?.code}`);
                const rejected = card?.code;
                // 卡片被拒（内容过大、接口不支持等）时退回纯文本，不丢正文。
                const plain = await sendPayload(chatId, target, { msg_type: 'text', content: JSON.stringify({ text: part }) }, sender).catch((error) => {
                    log(`[${id}] 纯文本回退发送失败 ${httpFailureSummary(error)}`);
                    throw error;
                });
                if (isThrottleCode(plain?.code))
                    throw new DeliveryRejected(`${id}: text-send-throttled code=${plain?.code}`);
                if (isRejectedCode(plain?.code))
                    throw new Error(`${id}: text-send-rejected code=${plain?.code} card=${String(rejected)}`);
                delivered = true;
            }
            catch (error) {
                const normalized = error instanceof DeliveryRejected || !throttledResponse(error)
                    ? error : new DeliveryRejected(`${id}: text-send-throttled http=${error.response?.status}`);
                throw delivered ? afterPartialDelivery(normalized) : normalized;
            }
        }
    }
    return {
        id,
        label,
        maxMessageLength: 4000,
        async start() {
            lifecycle?.abort();
            const generation = new AbortController();
            lifecycle = generation;
            const current = () => lifecycle === generation && !generation.signal.aborted;
            const incoming = new KeyedSerialQueue();
            let sdk;
            try {
                sdk = await (loadSdk ? loadSdk() : import('@larksuiteoapi/node-sdk'));
            }
            catch {
                throw new Error('缺少依赖 @larksuiteoapi/node-sdk');
            }
            const logger = quietSdkLogger(() => log(`[${id}] SDK 请求或连接异常（敏感详情已隐藏）`), id);
            const loggerLevel = sdk.LoggerLevel?.error ?? 1;
            const httpInstance = Object.create(sdk.defaultHttpInstance);
            httpInstance.request = (opts) => sdk.defaultHttpInstance.request({ ...opts, timeout: 30_000, maxRedirects: 0 });
            client = new sdk.Client({ appId, appSecret, logger, loggerLevel, httpInstance });
            const identity = await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' });
            const botOpenId = identity.bot?.open_id?.trim() ?? '';
            if (!botOpenId)
                throw new Error(`${id}: 无法获取机器人 open_id`);
            const dispatcher = new sdk.EventDispatcher({}).register({
                'card.action.trigger': async (data) => {
                    const token = data.action?.value?.token;
                    const chatId = data.context?.open_chat_id;
                    if (current() && token && chatId && data.operator?.open_id)
                        void Promise.resolve(handler?.({ chatId, userId: data.operator.open_id,
                            text: '', actionToken: token, kind: data.action?.value?.group ? 'group' : 'dm', addressed: true,
                        })).catch(() => log(`[${id}] 按钮操作失败`));
                    return {};
                },
                'im.message.receive_v1': async (data) => {
                    const message = data.message;
                    if (!message)
                        return;
                    const normalized = normalizeFeishuMessage(message, { source: 'event' });
                    const group = message.chat_type === 'group';
                    const addressed = !group || isFeishuBotMentioned(message.mentions, botOpenId);
                    if (!addressed || !normalized.chatId || !current())
                        return;
                    const chatId = normalized.chatId;
                    return incoming.run(chatId, async () => {
                        if (!current())
                            return;
                        if (!normalized.supported) {
                            await noticeTo(chatId, '暂不支持该消息类型，请发送文字、图片或文件。');
                            return;
                        }
                        if (!normalized.text && !normalized.attachments.length) {
                            if (normalized.messageType !== 'text')
                                await noticeTo(chatId, '图片或消息读取失败，请重发图片或发送文字。');
                            return;
                        }
                        let quoted;
                        let quotedError;
                        const quoteId = normalized.parentId || normalized.rootId;
                        if (quoteId && !normalized.text.trim().startsWith('/')) {
                            try {
                                const item = await readMessage(quoteId, timeoutSignal(CONTEXT_TIMEOUT_MS, generation.signal));
                                if (item.deleted)
                                    quotedError = 'withdrawn';
                                else if (!item.supported && !item.text && !item.attachments.length)
                                    quotedError = 'unsupported';
                                else if (item.chatId && item.chatId !== normalized.chatId)
                                    quotedError = 'not-found';
                                else
                                    quoted = { ...item, isRoot: !normalized.parentId && normalized.rootId === quoteId };
                            }
                            catch (error) {
                                if (!current())
                                    return;
                                quotedError = readFailureReason(error);
                                log(`[${id}] 引用消息读取失败 reason=${quotedError}`);
                            }
                        }
                        if (!current())
                            return;
                        await handler?.({
                            chatId,
                            userId: normalized.userId || data.sender?.sender_id?.open_id,
                            text: normalized.text,
                            messageId: normalized.messageId,
                            parentId: normalized.parentId,
                            rootId: normalized.rootId,
                            threadId: normalized.threadId,
                            createTime: normalized.createTime,
                            mentions: normalized.mentions,
                            links: normalized.links,
                            attachments: normalized.attachments,
                            attachmentsTruncated: normalized.attachmentsTruncated,
                            ...(quoted ? { quoted } : {}),
                            ...(quotedError ? { quotedError } : {}),
                            kind: group ? 'group' : 'dm',
                            addressed,
                        });
                    }).catch(() => { if (current())
                        log(`[${id}] 消息处理失败`); });
                },
            });
            async function noticeTo(chatId, key) {
                const sent = await client?.im.message.create({
                    params: { receive_id_type: 'chat_id' },
                    data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: channelNotice(config.host, key) }) },
                }).catch(() => {
                    log(`[${id}] 消息提示发送失败`);
                    return undefined;
                });
                if (isRejectedCode(sent?.code))
                    log(`[${id}] 消息提示发送失败 ${httpFailureSummary({ response: { data: { code: sent.code } } })}`);
            }
            const wsClient = new sdk.WSClient({ appId, appSecret, logger, loggerLevel });
            ws = wsClient;
            await wsClient.start({ eventDispatcher: dispatcher });
            statusText = '长连接已建立';
            log(`[${id}] WebSocket 长连接已启动`);
        },
        async stop() {
            lifecycle?.abort();
            lifecycle = undefined;
            ws?.close({ force: true });
            ws = undefined;
            statusText = '已停止';
        },
        canDeliverDeferred() { return statusText === '长连接已建立'; },
        send: sendText,
        sendFile,
        sendImage,
        readMessage,
        listMessages,
        downloadAttachment,
        bitableGet,
        bitableListTables,
        bitableListFields,
        bitableSearchRecords,
        taskList,
        taskGet,
        tasklistList,
        tasklistTasks,
        async sendChoices(message, text, buttons) {
            if (!client)
                throw new Error('channel-unavailable');
            const result = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
                    receive_id: message.chatId, msg_type: 'interactive', content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [
                            { tag: 'markdown', content: text },
                            ...buttons.map(button => ({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: button.label.slice(0, 60) },
                                        type: 'default', value: { token: button.token, group: message.kind === 'group' } }] })),
                        ] }),
                } }).catch(error => { throw choiceSendError(error); });
            if (isRejectedCode(result?.code))
                throw new ChoiceSendError('rejected');
            const messageId = result?.data?.message_id;
            const sender = client;
            if (!messageId)
                return;
            return { close: async (status) => {
                    const updated = await sender.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [
                                    { tag: 'markdown', content: text }, { tag: 'div', text: { tag: 'plain_text', content: status } },
                                ] }) } });
                    if (isRejectedCode(updated?.code))
                        throw new Error('card-update-failed');
                } };
        },
        async addStatusReaction(message, state, _label, signal) {
            if (!client || !message.messageId || state === 'cancelled')
                return;
            const emoji = (state === 'success' || state === 'ended') ? 'DONE' : state === 'error' ? 'ERROR' : 'OnIt';
            signal.throwIfAborted();
            const result = await fileOperation(client.im.messageReaction.create({
                path: { message_id: message.messageId }, data: { reaction_type: { emoji_type: emoji } },
            }), signal);
            if (isRejectedCode(result.code) || !result.data?.reaction_id)
                throw new Error('reaction-rejected');
            return result.data.reaction_id;
        },
        async removeStatusReaction(message, reaction, signal) {
            if (!client)
                return;
            signal.throwIfAborted();
            const result = await fileOperation(client.im.messageReaction.delete({ path: { message_id: message.messageId, reaction_id: reaction } }), signal);
            if (isRejectedCode(result.code))
                throw new Error('reaction-rejected');
        },
        setMessageHandler(h) { handler = h; },
        async diagnose(signal) {
            const domain = 'https://open.feishu.cn';
            let token;
            const auth = await probe('credentials', signal, async () => {
                const data = await diagnosticJson(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, signal, { app_id: appId, app_secret: appSecret });
                platformResult(data.code, [10003, 10014]);
                requireDiagnostic(typeof data.tenant_access_token === 'string' && data.tenant_access_token);
                token = data.tenant_access_token;
            });
            if (auth.status !== 'passed')
                return [auth];
            const bot = await probe('bot', signal, async () => {
                const data = await diagnosticJson(`${domain}/open-apis/bot/v3/info`, signal, undefined, { Authorization: `Bearer ${token}` });
                platformResult(data.code);
                const bot = data.bot;
                requireDiagnostic(typeof bot?.open_id === 'string' && bot.open_id);
            });
            if (bot.status !== 'passed')
                return [auth, bot];
            // 读取应用自身信息核对历史消息与资源权限是否实际生效；不返回 scope 原文。
            const scopes = await probe('scopes', signal, async () => {
                let data;
                try {
                    data = await diagnosticJson(`${domain}/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`, signal, undefined, { Authorization: `Bearer ${token}` });
                    platformResult(data.code);
                }
                catch (error) {
                    // 没有应用配置读取权限时无法核对，但不把连接诊断判成失败。
                    if (error?.reason === 'permission' || error?.platformCode === 99991672)
                        throw new DiagnosticError('unsupported');
                    throw error;
                }
                const present = new Set((data?.data?.app?.scopes ?? data?.app?.scopes ?? []).map(item => String(item?.scope ?? '')).filter(Boolean));
                for (const scope of ['im:message:readonly', 'im:message.group_msg', 'im:resource', 'bitable:app:readonly', 'task:task:readonly', 'task:tasklist:readonly']) {
                    if (!present.has(scope))
                        throw new DiagnosticError('permission');
                }
            });
            return [auth, bot, scopes];
        },
        status() { return statusText; },
    };
}