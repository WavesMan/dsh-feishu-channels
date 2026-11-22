import { dirname, join } from 'node:path';
import { DeferredDelivery, DeliveryRejected, DeliveryUnavailable } from './deferred-delivery.js';
import { sleepWithSignal, timeoutSignal } from './abort.js';
import { assistantText } from './assistant-text.js';
import { readDeliveryHistory } from './delivery-history.js';
import { AttachmentSaveError, AttachmentStore, MAX_ATTACHMENT_BYTES } from './attachment-store.js';
import { attachmentFailureLabel } from './file-input.js';
import { composeSubmission, deliveryTargetOf } from './feishu-submission.js';
import { createFeishuWorkTools } from './feishu-work-tools.js';
import { ChoiceStore } from './choices.js';
import { MessageProgress, ProgressTracker } from './message-progress.js';
import { notice, replyText, withReplyLocale } from './command-locale.js';
import { FileDelivery } from './file-delivery.js';
import { ChatCommands } from './chat-commands.js';
import { canExecuteCommand, normalizeCommandPermissions } from './command-permissions.js';
import { APPROVAL_WAIT_MS, ApprovalBroker } from './approval.js';
import { SessionMerger } from './merge.js';
import { KeyedSerialQueue } from './keyed-queue.js';
import { SessionRouter } from './router.js';
import { initialSessionTitle, readSessionTitle } from './session-title.js';
import { readSessionHistory } from './session-history.js';
import { decideAccess } from './access.js';
import { splitText } from './split.js';
import { ReplyStreamHub, isAssistantTextDelta } from './reply-stream.js';
import { QuestionBroker, formatUserQuestion, validUserQuestion, } from './question.js';
/** 分片发送的退避表（毫秒）：第一次立即，随后 1s/3s/8s/20s，累计约 32s。 */
const SEND_RETRY_DELAYS_MS = [0, 1_000, 3_000, 8_000, 20_000];
/**
 * 一条回复（含它的所有分片）允许用于等待重试的总时长。
 * 退避是按分片走的，没有这个上限时一条多分片回复能把回合拖到几分钟。
 */
const SEND_RETRY_BUDGET_MS = 30_000;
/**
 * 平台是否已经明确答复「本次发送没有送达」。
 *
 * 只认渠道显式抛出的 {@link DeliveryRejected}（例如部分渠道
 * `/ilink/bot/sendmessage ret=-2 … prepare failed`、HTTP 429/503）：
 * 这类响应说明请求到达平台但未被受理，重发不会让用户收到两条。
 *
 * 不按「是不是普通 Error」推断：渠道里的普通错误还可能来自本地校验、
 * 上传或媒体处理，也可能是平台已部分处理后的 5xx。超时与网络中断下
 * 请求可能已经落地。这些都保持「送达未知」，只由用户用 `/delivery retry` 决定。
 */
export function isDefiniteSendFailure(error) {
    return error instanceof DeliveryRejected;
}
const USER_QUESTION_WRAPPER = Symbol('dsh-feishu-channels.user-question-wrapper');
export class ImEngine {
    ctx;
    store;
    seen;
    config;
    log;
    onUnauthorized;
    resolveConfig;
    resolvePrivateAccess;
    resolveCommandPermissions;
    sendRetryDelaysMs;
    deferred;
    deferredTimer;
    recovering = false;
    recoveryCursor = 0;
    recoveryScope = new AbortController();
    observedTurns = new Map();
    channels = new Map();
    router;
    broker = new ApprovalBroker();
    questions = new QuestionBroker();
    merger;
    extraAllow = new Map();
    sessionActors = new Map();
    chatActors = new Map();
    interactionMessageIds = new Map();
    questionActors = new Map();
    questionDeliveries = new Map();
    questionPromptDelivered = new Set();
    queues = new Map();
    interactionQueues = new Map();
    streams = new ReplyStreamHub();
    disposeEvents = [];
    wrappedUserQuestionServices = new WeakSet();
    legacyServiceTimer;
    disposed = false;
    questionSelections = new Map();
    choices;
    progress = new ProgressTracker(result => {
        void this.notifyCompletion(result).catch(() => this.log('[im-progress] 完成通知发送失败，不重试任务'));
    }, (sessionId, turn, delivered, rejected) => {
        try {
            this.deferred.complete(sessionId, turn, delivered, rejected);
        }
        catch {
            this.log('[im-delivery] 交付确认落盘失败，保留未知状态');
        }
    });
    mergedMessages = new Map();
    fileDelivery;
    attachmentStore;
    chatCommands;
    commandScopes = new Map();
    inputScopes = new Map();
    chatScopes = new Map();
    activeScopes = new Map();
    turnScopes = new Map();
    pendingScopes = new Map();
    registeredAgents = new WeakSet();
    /**
     * @param sendRetryDelaysMs 分片发送退避表；测试可传 `[0]` 关闭等待。
     */
    constructor(ctx, store, seen, config, log, onUnauthorized, resolveConfig = () => config, resolvePrivateAccess = () => 'approved', resolveCommandPermissions = () => normalizeCommandPermissions(undefined), deliveryFile, sendRetryDelaysMs = SEND_RETRY_DELAYS_MS) {
        this.ctx = ctx;
        this.store = store;
        this.seen = seen;
        this.config = config;
        this.log = log;
        this.onUnauthorized = onUnauthorized;
        this.resolveConfig = resolveConfig;
        this.resolvePrivateAccess = resolvePrivateAccess;
        this.resolveCommandPermissions = resolveCommandPermissions;
        this.sendRetryDelaysMs = sendRetryDelaysMs;
        this.deferred = new DeferredDelivery(deliveryFile);
        if (deliveryFile) {
            this.deferredTimer = setInterval(() => { void this.recoverDeliveries(); }, 30_000);
            this.deferredTimer.unref();
        }
        this.choices = new ChoiceStore(log);
        // DSH 的真实 agents 类型比路由器所需的最小会话契约更严格，在此处完成边界适配。
        this.router = new SessionRouter(ctx, store, config, log, resolveConfig, {
            onDeliveryStopped: binding => this.streams.reset(`${binding.channelId}:${binding.chatId}`, binding.sessionId),
            registerAgentTools: (agentCtx, agent, channelId) => this.registerAgentTools(agentCtx, agent, channelId),
        });
        this.fileDelivery = new FileDelivery(ctx, log, deliveryFile ? join(dirname(deliveryFile), 'file-delivery.json') : undefined);
        this.attachmentStore = new AttachmentStore(log);
        this.chatCommands = new ChatCommands(ctx, this.router, id => this.questions.has(id) || this.broker.has(id), (id, msg) => { if (msg.userId)
            this.sessionActors.set(id, msg.userId); }, (channel, msg, text, choices, session, allowNumber = true) => this.choices.show(channel, msg, text, choices, session, undefined, allowNumber ? undefined : replyText('点击按钮或发送对应命令；按钮 15 分钟内有效，普通文字继续聊天。'), allowNumber));
        this.merger = new SessionMerger((config.mergeTimeoutSecs || 5) * 1000, (key, text) => {
            const sep = key.indexOf(':');
            const channelId = key.slice(0, sep);
            const rest = key.slice(sep + 1);
            const channel = this.channels.get(channelId);
            if (!channel)
                return;
            const sources = this.takeMergedMessages(key);
            const last = sources[sources.length - 1];
            const merged = { chatId: rest.split(':').slice(1).join(':') || rest, text, kind: rest.startsWith('group:') ? 'group' : 'dm',
                ...(last ? { userId: last.userId, messageId: last.messageId, threadId: last.threadId, createTime: last.createTime } : {}) };
            // 合并窗口回调不在任何请求链路里，必须自兜底，否则 rejection 无人接
            void this.inject(channel, merged, sources.length ? sources : [merged]).catch((error) => {
                const detail = error instanceof Error ? error.message : String(error);
                this.log(`[${channelId}] 合并投递失败: ${detail}`);
                channel.send(merged.chatId, notice(this.ctx, '消息处理失败，请查看本机日志。')).catch(() => undefined);
            });
        });
        const on = this.ctx.on;
        if (typeof on === 'function') {
            for (const kind of ['inserted', 'claimed', 'discarded']) {
                this.disposeEvents.push(on(`agent/inbox/${kind}`, (...args) => {
                    const payload = args[0];
                    if (kind === 'claimed' && Number.isSafeInteger(payload.turn)) {
                        const id = String(payload.agent?.session?.id ?? payload.agent?.id ?? '');
                        this.deferred.claim(id, payload.turn, payload.message?.source?.rpcId ?? payload.message?.id ?? '');
                    }
                    this.progress.inbox(kind, payload);
                }, { global: true }));
            }
            this.disposeEvents.push(on('session/event', (...args) => {
                void this.onSessionEvent(args[0], args[1]);
            }, { global: true }));
            // 新版宿主将增量移出持久化事件；复用同一投递入口的绑定、准入与冷回合检查。
            this.disposeEvents.push(on('agent/assistant-stream', (...args) => {
                const payload = args[0];
                if (!payload?.agent?.session?.id || payload.frame?.type !== 'chunk' || !isAssistantTextDelta(payload.frame.chunk))
                    return;
                void this.onSessionEvent(payload.agent.session, { type: 'assistant/chunk', data: { chunk: payload.frame.chunk } });
            }, { global: true }));
            this.disposeEvents.push(on('session/disposed', (...args) => {
                const id = String(args[0]?.id ?? '');
                if (id === '')
                    return;
                this.cancelSessionInteractions(id);
                void this.router.onHostDisposed(id);
            }, { global: true }));
            // 删除流程先卸载再移除日志；完成通知后重新校验，避免留下可见但打不开的索引。
            this.disposeEvents.push(on('api-session/removed', (...args) => {
                const id = args[0];
                if (typeof id !== 'string' || id === '')
                    return;
                return this.cleanupMissingSession(id).catch(error => {
                    this.log(`[im-session] 清理已删除会话索引失败: ${error instanceof Error ? error.message : String(error)}`);
                });
            }, { global: true }));
            this.disposeEvents.push(on('approval/request', (...args) => {
                const req = args[0];
                const next = args[1];
                return this.onApproval(req, next);
            }, { global: true, prepend: true }));
            this.disposeEvents.push(on('user-questions/request', (...args) => {
                const req = args[0];
                const next = args[1];
                return this.onUserQuestions(req, next);
            }, { global: true, prepend: true }));
            this.disposeEvents.push(on('internal/service', (...args) => {
                if (args[0] === 'userQuestions' && this.installLegacyUserQuestionService(args[1])) {
                    if (this.legacyServiceTimer)
                        clearTimeout(this.legacyServiceTimer);
                    this.legacyServiceTimer = undefined;
                }
            }, { global: true }));
        }
        if (!this.installLegacyUserQuestionService())
            this.scheduleLegacyUserQuestionService();
    }
    renameSession(sessionId, title) {
        return this.router.rename(sessionId, title);
    }
    async removeSession(sessionId) {
        return this.router.remove(sessionId);
    }
    async cleanupMissingSession(sessionId) {
        const removed = await this.router.cleanupMissing(sessionId);
        if (removed)
            this.cancelSessionInteractions(sessionId);
        return removed;
    }
    async ensureSession(sessionId) {
        return this.router.ensure(sessionId);
    }
    setModel(provider, model, reasoningEffort) {
        this.config.provider = provider;
        this.config.model = model;
        this.config.reasoningEffort = reasoningEffort;
        for (const channelId of this.inputScopes.keys())
            this.cancelInputs(channelId);
        void this.router.disposeAll();
    }
    setCwd(cwd) {
        this.config.cwd = cwd;
        for (const channelId of this.inputScopes.keys())
            this.cancelInputs(channelId);
        void this.router.disposeAll();
    }
    setPermission(permission) {
        this.config.permissionPreset = permission;
        for (const channelId of this.inputScopes.keys())
            this.cancelInputs(channelId);
        void this.router.disposeAll();
    }
    attachMappedSessions() {
        return this.router.attachMappedSessions(() => !this.disposed);
    }
    register(channel) {
        this.channels.set(channel.id, channel);
        channel.setMessageHandler((msg) => this.enqueue(channel.id, msg));
    }
    unregister(channelId) {
        this.cancelInputs(channelId);
        this.channels.delete(channelId);
    }
    addAllowed(channelId, userId) {
        const id = userId.trim();
        if (!id)
            return;
        let set = this.extraAllow.get(channelId);
        if (!set) {
            set = new Set();
            this.extraAllow.set(channelId, set);
        }
        set.add(id);
    }
    async reloadChannel(channelId, options = {}) {
        this.cancelInputs(channelId);
        for (const sessionId of this.router.sessionIdsForChannel(channelId)) {
            this.cancelSessionInteractions(sessionId, new Error('频道配置已更新'));
        }
        if (options.resetSessions)
            await this.router.resetChannelSessions(channelId);
        else
            await this.router.disposeChannel(channelId);
    }
    clearAllowed(channelId) {
        this.extraAllow.delete(channelId);
    }
    dispose() {
        this.disposed = true;
        if (this.deferredTimer)
            clearInterval(this.deferredTimer);
        this.recoveryScope.abort();
        this.choices.clear();
        this.progress.cancel();
        this.mergedMessages.clear();
        this.interactionMessageIds.clear();
        this.chatScopes.clear();
        this.activeScopes.clear();
        this.turnScopes.clear();
        this.pendingScopes.clear();
        this.chatCommands.clear();
        for (const scope of this.commandScopes.values())
            scope.abort();
        this.commandScopes.clear();
        for (const channelId of this.inputScopes.keys())
            this.cancelInputs(channelId);
        if (this.legacyServiceTimer)
            clearTimeout(this.legacyServiceTimer);
        for (const off of this.disposeEvents)
            off();
        this.fileDelivery.dispose();
        this.broker.dispose();
        this.questions.dispose();
        this.merger.dispose();
        void this.router.disposeAll();
    }
    enqueue(channelId, msg) {
        const key = `${channelId}:${msg.chatId}`;
        // 宿主命令可能等待交互；停止和审批回答不能排在该命令后面造成死锁。
        const binding = this.router.lookup(channelId, msg.kind === 'group' ? 'group' : 'dm', msg.chatId);
        if (this.commandScopes.has(key) && (/^\/stop(?:\s|$)/i.test(msg.text.trim()) || (binding && (this.questions.has(binding.sessionId) || this.broker.has(binding.sessionId)) && !msg.text.trim().startsWith('/')))) {
            void this.handleInbound(channelId, msg);
            return;
        }
        const prev = this.queues.get(key) ?? Promise.resolve();
        const current = prev.catch(() => undefined).then(() => this.handleInbound(channelId, msg));
        this.queues.set(key, current);
        void current.finally(() => {
            if (this.queues.get(key) === current)
                this.queues.delete(key);
        });
    }
    userAllowed(channelId, userId) {
        if (!userId)
            return false;
        return this.extraAllow.get(channelId)?.has(userId) === true;
    }
    cancelSessionInteractions(sessionId, reason) {
        this.progress.cancel(undefined, sessionId);
        this.deferred.release(sessionId);
        this.observedTurns.delete(sessionId);
        this.broker.cancel(sessionId);
        this.questionSelections.delete(sessionId);
        this.questions.cancel(sessionId, reason);
        this.sessionActors.delete(sessionId);
        this.interactionMessageIds.delete(sessionId);
        this.questionActors.delete(sessionId);
        this.questionDeliveries.delete(sessionId);
        this.questionPromptDelivered.delete(sessionId);
        this.activeScopes.delete(sessionId);
        this.chatScopes.delete(sessionId);
        for (const key of [...this.turnScopes.keys()])
            if (key.startsWith(`${sessionId}:`))
                this.turnScopes.delete(key);
        for (const [requestId, scope] of this.pendingScopes)
            if (scope.sessionId === sessionId)
                this.pendingScopes.delete(requestId);
    }
    isAuthorized(channelId, channel, msg) {
        if (msg.userId && this.resolvePrivateAccess(channelId) === 'all')
            return true;
        const local = channel.authorizes?.(msg.userId ?? '');
        if (local === false)
            return false;
        if (local === true)
            return true;
        return this.userAllowed(channelId, msg.userId);
    }
    async rejectUnauthorized(channelId, channel, msg) {
        this.log(`[${channelId}] 拒绝未授权用户 ${msg.userId || '(无 userId)'}`);
        const hint = withReplyLocale(this.ctx, () => this.onUnauthorized?.(channelId, msg) ?? replyText('未授权：请管理员在设置 → 飞书频道 中批准你的访问。'));
        if (msg.kind !== 'group') {
            await channel.send(msg.chatId, hint).catch(() => undefined);
        }
    }
    async handleInbound(channelId, msg) {
        const channel = this.channels.get(channelId);
        if (!channel)
            return;
        try {
            if (msg.messageId && this.seen.has(`${channelId}:${msg.messageId}`))
                return;
            if (msg.messageId)
                this.seen.add(`${channelId}:${msg.messageId}`);
            const decision = decideAccess({
                userAllowed: this.isAuthorized(channelId, channel, msg),
                kind: msg.kind === 'group' ? 'group' : 'dm',
                addressed: msg.addressed,
            });
            if (decision === 'ignore')
                return;
            if (msg.userId)
                this.chatActors.set(`${channelId}:${msg.kind === 'group' ? 'group' : 'dm'}:${msg.chatId}`, msg.userId);
            if (decision === 'deny') {
                if (!msg.attachments?.length && await this.answerApproval(channelId, msg, this.approvalVerdict(msg.text)))
                    return;
                await this.rejectUnauthorized(channelId, channel, msg);
                return;
            }
            if (!/^\/delivery(?:\s|$)/i.test(msg.text.trim()))
                void this.recoverDeliveries(channel, msg);
            let text = msg.text.trim();
            const kind = msg.kind === 'group' ? 'group' : 'dm';
            const binding = this.router.lookup(channelId, kind, msg.chatId);
            const selected = this.choices.resolve(channelId, msg, binding?.sessionId, !binding || (!this.questions.has(binding.sessionId) && !this.broker.has(binding.sessionId)));
            if (selected === '') {
                await this.deliver(channel, msg.chatId, withReplyLocale(this.ctx, () => replyText('选项已失效或不属于当前操作，请重新打开 /menu。')));
                return;
            }
            if (selected?.startsWith('#question:') && binding) {
                const current = this.questions.current(binding.sessionId);
                if (!current)
                    return;
                this.interactionMessageIds.set(binding.sessionId, msg.messageId);
                const index = Number(selected.slice('#question:'.length));
                const values = this.questionSelections.get(binding.sessionId) ?? new Set();
                if (values.has(index))
                    values.delete(index);
                else
                    values.add(index);
                this.questionSelections.set(binding.sessionId, values);
                await this.deliverQuestionInteraction(binding.sessionId, channel, msg.chatId, this.formatQuestion(current.question, current.index, current.total, { requiresMention: kind === 'group', selected: values }), this.questions.signal(binding.sessionId));
                return;
            }
            if (selected !== undefined) {
                text = selected;
                msg = { ...msg, text, actionToken: undefined };
            }
            if (text.startsWith('/') && !msg.attachments?.length) {
                if (!canExecuteCommand(this.resolveCommandPermissions(channelId), kind, msg.userId)) {
                    await this.deliver(channel, msg.chatId, withReplyLocale(this.ctx, () => replyText('当前聊天未开启命令权限，可以继续正常对话。')));
                    return;
                }
                const command = text.split(/\s+/, 1)[0]?.toLowerCase();
                const mergeKey = `${channelId}:${kind}:${msg.chatId}`;
                if (command === '/stop') {
                    this.merger.cancel(mergeKey);
                    this.mergedMessages.delete(mergeKey);
                }
                else if (this.merger.has(mergeKey)) {
                    await this.deliver(channel, msg.chatId, withReplyLocale(this.ctx, () => replyText('上一条消息正在合并，尚未执行本次命令。等待提交后再发 {0}。', command || '/help')));
                    return;
                }
                if ((command === '/new' || command === '/clear')
                    && binding
                    && (this.questions.has(binding.sessionId) || this.broker.has(binding.sessionId))) {
                    await this.deliver(channel, msg.chatId, withReplyLocale(this.ctx, () => replyText('请先完成当前问题或审批，再执行 /{0}。', command.slice(1))));
                    return;
                }
                const reply = await this.handleCommand(channel, msg);
                if (reply)
                    await this.deliver(channel, msg.chatId, reply);
                return;
            }
            if (binding && this.questions.has(binding.sessionId)) {
                const actor = this.questionActors.get(binding.sessionId) ?? this.sessionActors.get(binding.sessionId);
                if (actor && msg.userId !== actor) {
                    await this.deliver(channel, msg.chatId, notice(this.ctx, '只有发起当前任务的用户可以回答这个问题。'));
                    return;
                }
                if (!text || (msg.attachments?.length ?? 0) > 0) {
                    await this.deliver(channel, msg.chatId, notice(this.ctx, '请用文字回答当前问题。'));
                    return;
                }
                if (this.questions.isReady(binding.sessionId))
                    this.interactionMessageIds.set(binding.sessionId, msg.messageId);
                const result = this.questions.answer(binding.sessionId, text);
                if (result.handled) {
                    this.questionSelections.delete(binding.sessionId);
                    if (result.waitingPresentation) {
                        await this.deliver(channel, msg.chatId, notice(this.ctx, '问题详情仍在发送，请稍后再回答。'));
                        return;
                    }
                    if (result.next) {
                        const nextQuestion = result.next;
                        const signal = this.questions.signal(binding.sessionId);
                        const delivery = await this.retryInteraction(channel, () => this.deliverQuestionInteraction(binding.sessionId, channel, msg.chatId, this.formatQuestion(nextQuestion.question, nextQuestion.index, nextQuestion.total, { requiresMention: kind === 'group' }), signal));
                        if (delivery.status === 'aborted') {
                            this.questions.cancel(binding.sessionId, signal?.reason ?? new DOMException('Aborted', 'AbortError'));
                        }
                        else if (delivery.status === 'failed') {
                            this.questions.cancel(binding.sessionId, new Error('下一个交互问题发送失败'));
                        }
                        else
                            this.questions.activate(binding.sessionId);
                    }
                    return;
                }
            }
            if (!msg.attachments?.length && await this.answerApproval(channelId, msg, this.approvalVerdict(text)))
                return;
            if (binding && this.broker.has(binding.sessionId) && !msg.attachments?.length) {
                await this.deliver(channel, msg.chatId, notice(this.ctx, '还有未完成的审批，请回复批准或拒绝，或点按钮。'));
                return;
            }
            if (msg.attachments?.length || (!text && (msg.quoted || msg.quotedError))) {
                await this.inject(channel, msg, [msg]);
                return;
            }
            if (!text)
                return;
            if (channel.skipMerge) {
                await this.inject(channel, { ...msg, text });
                return;
            }
            const mergeKey = `${channelId}:${msg.kind === 'group' ? 'group' : 'dm'}:${msg.chatId}`;
            this.mergedMessages.set(mergeKey, [...(this.mergedMessages.get(mergeKey) ?? []), msg]);
            const merged = this.merger.ingest(mergeKey, text);
            if (merged.kind === 'flushed' && merged.text) {
                await this.inject(channel, { ...msg, text: merged.text }, this.takeMergedMessages(mergeKey));
            }
        }
        catch (error) {
            this.log(`[${channelId}] 处理失败: ${error instanceof Error ? error.message : String(error)}`);
            await channel.send(msg.chatId, notice(this.ctx, '消息处理失败，请查看本机日志。')).catch(() => undefined);
        }
    }
    validDelivery(entry) {
        const channel = this.channels.get(entry.channelId);
        if (this.disposed || !channel)
            return false;
        const binding = this.router.lookup(entry.channelId, entry.message.kind ?? 'dm', entry.message.chatId);
        return binding?.sessionId === entry.sessionId && decideAccess({ userAllowed: this.isAuthorized(entry.channelId, channel, entry.message), kind: entry.message.kind, addressed: true }) === 'allow';
    }
    async recoverDelivery(entry, fresh = false, explicit = false) {
        return this.deferred.recover(entry.id, async (current) => {
            const signal = AbortSignal.any([this.recoveryScope.signal, AbortSignal.timeout(30_000)]);
            const result = await readDeliveryHistory(this.ctx, current.sessionId, current.id, signal, this.channels.get(current.channelId)?.skipInterimText);
            if (!result)
                return undefined;
            return withReplyLocale(this.ctx, () => ({ turn: result.turn, text: [result.text ? replyText('补发此前任务的结果（不会重新执行任务）：') : '', result.text,
                    result.kind === 'completed' ? replyText('此前任务已完成。文件请在原会话查看。') : result.kind === 'error' ? replyText('此前任务失败，已生成的内容保留。') : replyText('此前任务已停止，已生成的内容保留。')].filter(Boolean).join('\n\n') }));
        }, current => this.validDelivery(current), async (current, text) => {
            const channel = this.channels.get(current.channelId);
            if (!channel || (!fresh && !channel.canDeliverDeferred?.()))
                throw new DeliveryUnavailable();
            await channel.send(current.message.chatId, text);
        }, text => splitText(text, Math.max(1, (this.channels.get(entry.channelId)?.maxMessageLength ?? 2000) - 32)), explicit);
    }
    async recoverDeliveries(channel, message) {
        if (this.recovering || this.disposed)
            return;
        this.recovering = true;
        try {
            const pending = this.deferred.list(channel?.id, message).filter(entry => ['waiting', 'ready'].includes(entry.status));
            const start = message ? 0 : this.recoveryCursor % Math.max(1, pending.length);
            const batch = [...pending.slice(start), ...pending.slice(0, start)].slice(0, 20);
            this.recoveryCursor = start + batch.length;
            for (const entry of batch) {
                if (this.disposed)
                    break;
                try {
                    await this.recoverDelivery(entry, !!message);
                }
                catch (error) {
                    this.log(`[im-delivery] 单条记录暂时无法恢复: ${error instanceof Error ? error.name : 'Error'}`);
                }
            }
        }
        catch (error) {
            this.log(`[im-delivery] 补发检查失败: ${error instanceof Error ? error.name : 'Error'}`);
        }
        finally {
            this.recovering = false;
        }
    }
    async deliveryCommand(channel, message) {
        return withReplyLocale(this.ctx, async () => {
            const args = message.text.trim().split(/\s+/).slice(1);
            const entries = this.deferred.list(channel.id, message);
            if (args.length) {
                const entry = entries.find(item => item.id === args[1]);
                if (args.length !== 2 || args[0] !== 'retry' || !entry)
                    return replyText('用法：/delivery；补发指定结果：/delivery retry 记录ID。记录仅属于当前聊天和发起人。');
                if (!this.validDelivery(entry))
                    return replyText('无法补发：请先恢复原会话绑定及访问权限。不会发送到其他会话。');
                const result = await this.recoverDelivery(entry, true, true);
                if (result)
                    return replyText('暂未找到可补发的结果，本次未发送，自动补发状态未改变。可稍后重试，或在网页查看原会话。');
            }
            const current = this.deferred.list(channel.id, message).slice(-10).reverse();
            if (!current.length)
                return replyText('没有近期交付记录。直接发送消息开始任务；查看最近记录：/history。');
            const states = {
                rejected: replyText('未提交任务，不需要补发'), waiting: replyText('等待原任务结果'), ready: replyText('等待渠道可发送'), sending: replyText('正在补发'), sent: replyText('已发送'),
                unknown: replyText('送达未知，自动补发已暂停'), blocked: replyText('绑定或权限已变化，补发已暂停'), expired: replyText('已过期，请在网页查看原会话'),
            };
            return [replyText('最近交付记录（最多 10 条，保留 7 天）：'), ...current.map(entry => `${entry.id} — ${states[entry.status]}`), '',
                replyText('补发：/delivery retry 记录ID。送达未知的结果可能重复；只补发文字，不重新执行任务，文件请在网页查看。')].join('\n');
        });
    }
    async handleCommand(channel, msg) {
        const key = `${channel.id}:${msg.chatId}`;
        if (/^\/stop(?:\s|$)/i.test(msg.text.trim()))
            this.commandScopes.get(key)?.abort();
        const scope = new AbortController();
        this.commandScopes.set(key, scope);
        try {
            if (/^\/delivery(?:\s|$)/i.test(msg.text.trim()))
                return await this.deliveryCommand(channel, msg);
            return await this.chatCommands.execute(channel, msg, scope.signal);
        }
        catch (error) {
            this.log(`[${channel.id}] 命令失败: ${error instanceof Error ? error.message : String(error)}`);
            return withReplyLocale(this.ctx, () => scope.signal.aborted ? replyText('命令已取消。查看当前状态：/status') : replyText('命令执行失败：{0}\n\n查看用法：/help；确认当前会话：/status', error instanceof Error ? error.message : replyText('请查看本机日志。')));
        }
        finally {
            if (this.commandScopes.get(key) === scope)
                this.commandScopes.delete(key);
        }
    }
    takeMergedMessages(key) {
        const messages = this.mergedMessages.get(key) ?? [];
        this.mergedMessages.delete(key);
        return messages;
    }
    async inject(channel, msg, sources = [msg]) {
        if (this.disposed || this.channels.get(channel.id) !== channel)
            return;
        const list = sources.length ? sources : [msg];
        let scope = this.inputScopes.get(channel.id);
        if (!scope)
            this.inputScopes.set(channel.id, scope = new AbortController());
        const { signal } = scope;
        // 账号级发送方式：steer 作为补充指令进入下一步边界，不再显示「排队中」。
        const sendMode = this.resolveConfig(channel.id).sendMode === 'steer' ? 'steer' : 'queue';
        const items = list.map(source => new MessageProgress(channel, source, this.ctx, this.log, sendMode === 'steer' ? 'processing' : 'queued'));
        let accepted = false;
        let submitted = false;
        let requestId;
        let reject = () => { for (const item of items)
            item.finish('error'); };
        try {
            const kind = msg.kind === 'group' ? 'group' : 'dm';
            const firstAttachment = list.find(source => source.attachments?.length)?.attachments[0]?.name;
            const initialTitle = initialSessionTitle(msg.text) || initialSessionTitle(firstAttachment || '');
            const title = initialTitle || msg.username || msg.chatId;
            const binding = await this.router.getOrCreate(channel.id, kind, msg.chatId, title);
            if (initialTitle)
                this.router.setTitle(binding.sessionId, initialTitle, 'message');
            const saved = await this.saveAttachments(channel, binding, list, signal);
            const composed = composeSubmission(list, saved);
            if (signal.aborted)
                return;
            if (!composed.trim()) {
                // 没有正文也没有可用材料时不提交空消息；附件失败原因已经写进 composed。
                return;
            }
            if (msg.userId)
                this.sessionActors.set(binding.sessionId, msg.userId);
            this.interactionMessageIds.set(binding.sessionId, msg.messageId);
            this.streams.reset(`${channel.id}:${msg.chatId}`);
            if (signal.aborted)
                return;
            requestId = crypto.randomUUID();
            const userId = msg.userId ?? list[list.length - 1]?.userId;
            const requestScope = this.createRequestScope(channel, binding, list, saved, userId);
            this.pendingScopes.set(requestId, requestScope);
            this.chatScopes.set(binding.sessionId, requestScope);
            this.deferred.begin(requestId, binding.sessionId, channel.id, { ...msg, userId, sources: requestScope.sources });
            reject = this.progress.begin(binding.sessionId, requestId, items);
            submitted = true;
            this.router.followup(binding, {
                id: requestId,
                role: 'user',
                content: [{ type: 'text', text: composed.trim() }],
                source: { kind: 'user', rpcId: requestId },
            }, sendMode);
            accepted = true;
            this.log(`[${channel.id}] 已注入 ${binding.sessionId}`);
        }
        catch (error) {
            if (requestId)
                this.pendingScopes.delete(requestId);
            try {
                if (requestId)
                    this.deferred.reject(requestId, !submitted);
            }
            catch {
                this.log('[im-delivery] 注入失败记录落盘失败，已暂停本进程恢复');
            }
            try {
                reject();
            }
            catch {
                this.log('[im-progress] 注入失败后的进度清理失败');
            }
            throw error;
        }
        finally {
            if (!accepted)
                for (const item of items)
                    item.finish('cancelled');
        }
    }
    /** 当前消息与直接引用里的附件先落到会话工作区；失败项只返回原因。 */
    async saveAttachments(channel, binding, sources, signal) {
        const attachments = [];
        const seen = new Set();
        for (const source of sources) {
            for (const attachment of [...(source.attachments ?? []), ...(source.quoted?.attachments ?? [])]) {
                if (!attachment?.id || seen.has(attachment.id))
                    continue;
                seen.add(attachment.id);
                attachments.push(attachment);
            }
        }
        if (!attachments.length)
            return [];
        let cwd;
        try {
            cwd = await this.router.workspaceFor(binding);
        }
        catch (error) {
            this.log(`[${channel.id}] 无法确定附件工作区: ${error instanceof Error ? error.message : String(error)}`);
            return attachments.map(attachment => ({
                attachmentId: attachment.id, name: attachment.name, sourceMessageId: attachment.sourceMessageId,
                status: 'failed', reason: 'workspace-unavailable',
            }));
        }
        const results = [];
        let budget = MAX_ATTACHMENT_BYTES;
        for (const attachment of attachments) {
            if (!channel.downloadAttachment) {
                results.push({ attachmentId: attachment.id, name: attachment.name, sourceMessageId: attachment.sourceMessageId, status: 'failed', reason: 'download-failed' });
                continue;
            }
            if (budget <= 0) {
                results.push({ attachmentId: attachment.id, name: attachment.name, sourceMessageId: attachment.sourceMessageId, status: 'failed', reason: 'too-large' });
                continue;
            }
            try {
                const record = await this.attachmentStore.save({
                    cwd, channelId: channel.id, chatId: binding.chatId,
                    sourceMessageId: attachment.sourceMessageId, attachment, signal, maxBytes: budget,
                    download: downloadSignal => channel.downloadAttachment(attachment, downloadSignal, budget),
                });
                budget -= record.bytes;
                results.push({
                    attachmentId: attachment.id, name: record.name, path: record.path, bytes: record.bytes,
                    status: 'done', sourceMessageId: attachment.sourceMessageId, kind: attachment.kind,
                });
            }
            catch (error) {
                const reason = error instanceof AttachmentSaveError ? error.reason : signal.aborted ? 'cancelled' : 'download-failed';
                this.log(`[${channel.id}] 附件保存失败 reason=${reason}`);
                results.push({ attachmentId: attachment.id, name: attachment.name, sourceMessageId: attachment.sourceMessageId, status: 'failed', reason });
            }
        }
        return results;
    }
    /** 请求作用域绑定当前频道、聊天、触发消息与可访问附件；工具读取不得越出这里。 */
    createRequestScope(channel, binding, sources, saved, userId) {
        const last = sources[sources.length - 1] ?? {};
        const target = deliveryTargetOf(sources);
        const scope = {
            sessionId: binding.sessionId,
            channelId: channel.id,
            chatId: binding.chatId,
            kind: binding.kind ?? (last.kind === 'group' ? 'group' : 'dm'),
            userId,
            messageId: target?.messageId,
            threadId: target?.threadId ?? last.threadId ?? '',
            triggerTime: Number(last.createTime) || Date.now(),
            sources: sources.map(item => ({
                messageId: item.messageId ?? '', userId: item.userId ?? '',
                createTime: Number(item.createTime) || 0, threadId: item.threadId ?? '',
            })),
            known: new Map(),
            attachments: new Map(),
            threads: new Set(),
            downloadedBytes: 0,
        };
        for (const source of sources) {
            this.registerContext(scope, source);
            if (source.quoted)
                this.registerContext(scope, source.quoted);
        }
        for (const item of saved) {
            if (item.status === 'done') {
                scope.downloadedBytes += item.bytes;
                const attachment = scope.attachments.get(item.attachmentId);
                if (attachment)
                    scope.attachments.set(item.attachmentId, { ...attachment, saved: item });
            }
        }
        return scope;
    }
    registerContext(scope, message) {
        if (!message)
            return;
        if (message.messageId)
            scope.known.set(message.messageId, message);
        if (message.threadId)
            scope.threads.add(message.threadId);
        for (const attachment of message.attachments ?? [])
            if (attachment?.id)
                scope.attachments.set(attachment.id, attachment);
    }
    activeScope(sessionId) {
        return this.activeScopes.get(sessionId);
    }
    replyTarget(sessionId) {
        const scope = this.activeScopes.get(sessionId) ?? this.chatScopes.get(sessionId);
        return scope?.messageId ? { messageId: scope.messageId } : undefined;
    }
    /** 只在当前 Agent 作用域注册；恢复或换绑同一 Agent 时不重复注册。 */
    registerAgentTools(agentCtx, agent, channelId) {
        if (!agent || this.registeredAgents.has(agent))
            return;
        const tools = agentCtx?.tools;
        if (!tools || typeof tools.register !== 'function')
            return;
        const sessionId = String(agent.session?.id ?? agent.id ?? '');
        if (!sessionId)
            return;
        this.registeredAgents.add(agent);
        const register = (definition) => {
            try {
                tools.register(definition);
            }
            catch (error) {
                this.log(`[${channelId}] 注册工具失败 ${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        };
        register(this.readContextTool(channelId, sessionId));
        register(this.downloadAttachmentTool(channelId, sessionId));
        for (const definition of createFeishuWorkTools({
            channelId,
            resolveChannel: () => this.channels.get(channelId),
            log: this.log,
        }))
            register(definition);
        let hasPresent = false;
        try {
            hasPresent = !!tools.get('present');
        }
        catch {
            hasPresent = false;
        }
        // 宿主已有 present 时直接复用它的交付入口与 deliverables/presented 事件。
        if (!hasPresent)
            register(this.deliverFileTool(channelId, sessionId));
    }
    readContextTool(channelId, sessionId) {
        const self = this;
        const messageSchema = {
            type: 'object', additionalProperties: false,
            properties: {
                message_id: { type: 'string' },
                message_type: { type: 'string' },
                sender: { type: 'string' },
                create_time: { type: 'string' },
                text: { type: 'string' },
                links: { type: 'array', items: { type: 'string' } },
                mentions: { type: 'array', items: { type: 'string' } },
                attachments: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                            attachment_id: { type: 'string' }, kind: { type: 'string' }, name: { type: 'string' },
                        }, required: ['attachment_id', 'kind'] } },
                quoted_message_id: { type: 'string' },
            },
            required: ['message_id', 'message_type', 'sender', 'text', 'links', 'mentions', 'attachments'],
        };
        return {
            name: 'feishu_read_context',
            description: '读取当前飞书请求范围内的消息上下文：指定消息、当前话题回复，或触发消息之前的近期消息。只能读取当前聊天；历史附件只返回清单，不自动下载。读取结果不会重新触发任务。',
            parameters: {
                type: 'object', additionalProperties: false,
                properties: {
                    mode: { type: 'string', enum: ['message', 'thread', 'recent'], description: '读取方式：message=指定消息，thread=当前话题，recent=触发消息之前的近期消息。' },
                    message_id: { type: 'string', description: 'mode=message 时要读取的消息 ID。' },
                    thread_id: { type: 'string', description: 'mode=thread 时的话题 ID；省略则使用当前触发消息所属话题。' },
                    limit: { type: 'integer', description: '最多返回 1-30 条；默认 20。' },
                    page_token: { type: 'string', description: '上一页返回的分页令牌。' },
                },
                required: ['mode'],
            },
            output: {
                schema: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean' },
                        mode: { type: 'string' },
                        messages: { type: 'array', items: messageSchema },
                        truncated: { type: 'boolean' },
                        has_more: { type: 'boolean' },
                        page_token: { type: 'string' },
                        error: { type: 'string' },
                    },
                    required: ['ok'],
                },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            },
            async execute(args, exec) {
                try {
                    return await self.readContextForTool(channelId, sessionId, args ?? {}, exec.signal);
                }
                catch (error) {
                    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
                    return { ok: false, error: aborted ? '读取超时或已取消' : '消息读取失败，可能缺少权限或消息已不可用' };
                }
            },
        };
    }
    downloadAttachmentTool(channelId, sessionId) {
        const self = this;
        return {
            name: 'feishu_download_attachment',
            description: '把当前请求可访问的飞书消息附件下载到当前会话工作区，返回实际保存路径；下载失败时只返回原因，不返回路径。附件 ID 来自触发消息、引用消息或 feishu_read_context 的附件清单。',
            parameters: {
                type: 'object', additionalProperties: false,
                properties: { attachment_id: { type: 'string', description: '附件清单中的附件 ID。' } },
                required: ['attachment_id'],
            },
            output: {
                schema: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        status: { type: 'string' },
                        path: { type: 'string' },
                        source_message_id: { type: 'string' },
                        size: { type: 'integer' },
                        name: { type: 'string' },
                        error: { type: 'string' },
                    },
                    required: ['status'],
                },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            },
            async execute(args, exec) {
                const input = args ?? {};
                const scope = self.activeScope(sessionId);
                if (!scope || scope.channelId !== channelId)
                    return { status: 'failed', error: '当前没有可用的飞书消息上下文' };
                const attachment = scope.attachments.get(String(input.attachment_id ?? ''));
                if (!attachment)
                    return { status: 'failed', error: '附件不在当前请求可访问的消息清单中' };
                const channel = self.channels.get(channelId);
                if (!channel?.downloadAttachment)
                    return { status: 'failed', error: '当前频道不支持附件下载' };
                try {
                    const record = await self.downloadForScope(scope, channel, attachment, exec.signal);
                    if (record.status === 'done')
                        return { status: 'downloaded', path: record.path, source_message_id: record.messageId, size: record.bytes, name: record.name };
                    return { status: 'failed', error: attachmentFailureLabel(record.error ?? record.reason ?? 'download-failed') };
                }
                catch (error) {
                    const reason = error?.reason ?? (exec.signal.aborted ? 'cancelled' : 'download-failed');
                    return { status: 'failed', error: attachmentFailureLabel(reason) };
                }
            },
        };
    }
    deliverFileTool(channelId, sessionId) {
        const self = this;
        return {
            name: 'feishu_deliver_file',
            description: '把当前工作区中的已有文件发送到当前飞书聊天：图片按图片消息发送，普通文件按文件消息发送。仅在用户明确需要收到该文件时调用；同一回合同一文件不会重复发送。',
            parameters: {
                type: 'object', additionalProperties: false,
                properties: { path: { type: 'string', description: '工作区中的文件路径。' } },
                required: ['path'],
            },
            output: {
                schema: {
                    type: 'object', additionalProperties: false,
                    properties: { delivered: { type: 'boolean' }, path: { type: 'string' }, error: { type: 'string' } },
                    required: ['delivered'],
                },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            },
            async execute(args, exec) {
                const input = args ?? {};
                const scope = self.activeScope(sessionId);
                if (!scope || scope.channelId !== channelId)
                    return { delivered: false, error: '当前没有可用的飞书聊天' };
                const channel = self.channels.get(channelId);
                if (!channel)
                    return { delivered: false, error: '当前频道不可用' };
                const path = typeof input.path === 'string' ? input.path.trim() : '';
                if (!path)
                    return { delivered: false, error: '文件路径为空' };
                let turn;
                try {
                    turn = self.ctx.agents?.turnBoundaryOf?.(exec.agent?.session)?.lastTurn;
                }
                catch {
                    turn = undefined;
                }
                const result = await self.fileDelivery.deliverPath({
                    sessionId, session: exec.agent?.session, channel, chatId: scope.chatId,
                    messageId: scope.messageId, path, turn, signal: exec.signal,
                });
                if (result.status === 'sent' || result.status === 'skipped')
                    return { delivered: true, path };
                return { delivered: false, error: result.status === 'missing' ? '文件不存在或不完整' : '发送失败或结果未知' };
            },
        };
    }
    async readContextForTool(channelId, sessionId, args, signal) {
        const scope = this.activeScope(sessionId);
        if (!scope || scope.channelId !== channelId)
            return { ok: false, error: '当前没有可用的飞书消息上下文' };
        const channel = this.channels.get(channelId);
        if (!channel?.readMessage && !channel?.listMessages)
            return { ok: false, error: '当前频道不支持消息上下文读取' };
        const scopeSignal = timeoutSignal(60_000, signal);
        const limit = Math.min(30, Math.max(1, Number.isSafeInteger(args.limit) ? args.limit : 20));
        const pageToken = typeof args.page_token === 'string' ? args.page_token : '';
        if (args.mode === 'message') {
            const messageId = typeof args.message_id === 'string' ? args.message_id : '';
            if (!messageId)
                return { ok: false, error: '需要 message_id' };
            const message = scope.known.get(messageId) ?? await channel.readMessage(messageId, scopeSignal);
            if (!message?.chatId || message.chatId !== scope.chatId)
                return { ok: false, error: '该消息不属于当前聊天，未读取' };
            if (message.deleted)
                return { ok: false, error: '消息已撤回或删除' };
            this.registerContext(scope, message);
            return { ok: true, mode: 'message', messages: [this.contextView(message)], truncated: false, has_more: false };
        }
        if (args.mode === 'thread') {
            const threadId = String(args.thread_id ?? scope.threadId ?? '');
            if (!threadId)
                return { ok: false, error: '当前消息不在话题中，也没有指定 thread_id' };
            if (!scope.threads.has(threadId))
                return { ok: false, error: '只能读取当前请求关联的话题' };
            const page = await channel.listMessages({ chatId: scope.chatId, threadId, pageSize: limit, pageToken }, scopeSignal);
            return this.contextPage(scope, page, 'thread', limit);
        }
        if (args.mode === 'recent') {
            const page = await channel.listMessages({ chatId: scope.chatId, endTime: scope.triggerTime || Date.now(), pageSize: limit, pageToken }, scopeSignal);
            return this.contextPage(scope, page, 'recent', limit);
        }
        return { ok: false, error: '不支持的读取方式' };
    }
    contextPage(scope, page, mode, limit) {
        const messages = [];
        let chars = 0;
        let truncated = page.hasMore;
        for (const message of page.messages) {
            if (message.messageId && message.messageId === scope.messageId)
                continue;
            const view = this.contextView(message);
            const size = view.text.length + 200;
            if (messages.length >= limit || chars + size > 20_000) {
                truncated = true;
                break;
            }
            this.registerContext(scope, message);
            chars += size;
            messages.push(view);
        }
        return {
            ok: true, mode, messages, truncated,
            has_more: page.hasMore,
            ...(page.pageToken ? { page_token: page.pageToken } : {}),
        };
    }
    contextView(message) {
        const text = typeof message.text === 'string' ? message.text : '';
        return {
            message_id: message.messageId ?? '',
            message_type: message.messageType || '',
            sender: message.userId || '未知',
            create_time: message.createTime ? new Date(message.createTime).toISOString() : '',
            text: text.length > 4_000 ? `${text.slice(0, 4_000)}…（已截断）` : text,
            links: (message.links ?? []).slice(0, 20),
            mentions: (message.mentions ?? []).map(mention => mention.name || mention.id).filter(Boolean).slice(0, 20),
            attachments: (message.attachments ?? []).map(attachment => ({
                attachment_id: attachment.id, kind: attachment.kind, name: attachment.name || '',
            })),
            ...(message.parentId ? { quoted_message_id: message.parentId } : {}),
        };
    }
    async downloadForScope(scope, channel, attachment, signal) {
        const cwd = await this.router.workspaceForSession(scope.sessionId);
        const cached = scope.attachments.get(attachment.id)?.saved;
        if (cached?.status === 'done') {
            const verified = await this.attachmentStore.verified(cwd, attachment.id);
            if (verified)
                return verified;
            scope.downloadedBytes = Math.max(0, (scope.downloadedBytes ?? 0) - (cached.bytes ?? 0));
        }
        const remaining = MAX_ATTACHMENT_BYTES - (scope.downloadedBytes ?? 0);
        if (remaining <= 0)
            throw Object.assign(new Error('too-large'), { reason: 'too-large' });
        const record = await this.attachmentStore.save({
            cwd, channelId: scope.channelId, chatId: scope.chatId,
            sourceMessageId: attachment.sourceMessageId, attachment, signal, maxBytes: remaining,
            download: downloadSignal => channel.downloadAttachment(attachment, downloadSignal, remaining),
        });
        scope.downloadedBytes = (scope.downloadedBytes ?? 0) + record.bytes;
        scope.attachments.set(attachment.id, { ...attachment, saved: { ...record, status: 'done' } });
        return record;
    }
    cancelInputs(channelId) {
        if (!this.disposed)
            this.deferred.block(channelId);
        this.choices.clear(channelId);
        this.progress.cancel(channelId);
        for (const key of this.mergedMessages.keys())
            if (key.startsWith(channelId + ':')) {
                this.mergedMessages.delete(key);
                this.merger.cancel(key);
            }
        for (const [key, scope] of this.commandScopes)
            if (key.startsWith(channelId + ':'))
                scope.abort();
        this.inputScopes.get(channelId)?.abort();
        this.inputScopes.delete(channelId);
    }
    approvalVerdict(text) {
        const value = text.trim().toLowerCase();
        if (['批准', '同意', 'yes', 'y', 'allow'].includes(value))
            return true;
        if (['拒绝', '不同意', 'no', 'n', 'reject', 'deny'].includes(value))
            return false;
        return undefined;
    }
    async answerApproval(channelId, msg, allow) {
        if (allow === undefined || msg.attachments?.length)
            return false;
        const binding = this.router.lookup(channelId, msg.kind === 'group' ? 'group' : 'dm', msg.chatId);
        if (!binding)
            return false;
        if (!this.broker.has(binding.sessionId))
            return false;
        // 群聊里只让发起当前任务的人批准，其他成员即使能发言也不能替其决定。
        if (msg.kind === 'group') {
            const actor = this.sessionActors.get(binding.sessionId);
            if (actor && msg.userId && msg.userId !== actor) {
                await this.channels.get(channelId)?.send(msg.chatId, notice(this.ctx, '只有发起当前任务的用户可以批准或拒绝。')).catch(() => undefined);
                return true;
            }
        }
        if (!this.broker.isReady(binding.sessionId)) {
            await this.channels.get(channelId)?.send(msg.chatId, notice(this.ctx, '审批详情仍在发送，请稍后再回复。')).catch(() => undefined);
            return true;
        }
        this.interactionMessageIds.set(binding.sessionId, msg.messageId);
        const ok = this.broker.answer(binding.sessionId, allow);
        if (ok)
            await this.channels.get(channelId)?.send(msg.chatId, withReplyLocale(this.ctx, () => allow ? replyText('已批准。') : replyText('已拒绝。')));
        return ok;
    }
    async onApproval(req, next) {
        const id = String(req.agent?.session?.id ?? req.agent?.id ?? req.session?.id ?? '');
        const resume = this.progress.waiting(id, true);
        try {
            return await this.handleApproval(req, next);
        }
        finally {
            resume();
        }
    }
    async handleApproval(req, next) {
        const currentContract = req.agent !== undefined;
        const rawSessionId = req.agent?.session?.id ?? req.agent?.id ?? req.session?.id;
        const sessionId = rawSessionId ? String(rawSessionId) : '';
        if (!sessionId || !this.router.bindingForSession(sessionId))
            return next();
        const refused = currentContract ? 'rejected' : { behavior: 'reject' };
        const cancelled = currentContract ? 'cancelled' : { behavior: 'reject' };
        if (req.signal?.aborted)
            return cancelled;
        return await this.runInteraction(sessionId, async () => {
            if (this.disposed || req.signal?.aborted)
                return cancelled;
            const binding = this.router.bindingForSession(sessionId);
            const channel = binding ? this.channels.get(binding.channelId) : undefined;
            if (!binding || !channel)
                return refused;
            // 只记录真实发言人；不能拿 chatId 冒充用户，否则群聊会把发起者判成外人。
            const knownActor = this.sessionActors.get(sessionId)
                ?? this.chatActors.get(`${binding.channelId}:${binding.kind}:${binding.chatId}`);
            if (knownActor)
                this.sessionActors.set(sessionId, knownActor);
            const prompt = await withReplyLocale(this.ctx, () => this.approvalPrompt(req));
            const wait = this.broker.wait(sessionId, APPROVAL_WAIT_MS, req.signal);
            if (!wait)
                return refused;
            const ticket = this.broker.token(sessionId);
            const delivery = await this.retryInteraction(channel, () => this.deliverInteraction(channel, binding.chatId, prompt, req.signal, {
                sessionId, message: { chatId: binding.chatId, userId: knownActor ?? binding.chatId, kind: binding.kind, text: '', messageId: this.interactionMessageIds.get(sessionId) },
                choices: withReplyLocale(this.ctx, () => [{ label: replyText('批准一次'), value: 'allow' }, { label: replyText('拒绝'), value: 'reject' }]),
                valid: () => this.broker.token(sessionId) === ticket && this.broker.isReady(sessionId),
            }));
            if (delivery.status === 'aborted' || req.signal?.aborted) {
                this.broker.cancel(sessionId);
                if (delivery.deliveredAny)
                    await this.announceInteractionCancelled(channel, binding.chatId, '审批');
                return cancelled;
            }
            if (delivery.status === 'failed') {
                this.broker.cancel(sessionId);
                return refused;
            }
            this.broker.activate(sessionId);
            const verdict = await wait;
            if (req.signal?.aborted) {
                if (delivery.deliveredAny)
                    await this.announceInteractionCancelled(channel, binding.chatId, '审批');
                return cancelled;
            }
            if (verdict === 'allow')
                return currentContract ? 'allowed-once' : { behavior: 'allow' };
            if (verdict === 'reject')
                return currentContract ? 'rejected' : { behavior: 'reject' };
            if (verdict === 'timeout' && delivery.deliveredAny && !this.disposed) {
                await this.announceApprovalTimedOut(channel, binding.chatId);
            }
            return cancelled;
        }, req.signal, () => cancelled);
    }
    async onUserQuestions(req, next) {
        const rawSessionId = req.agent?.session?.id ?? req.agent?.id;
        const sessionId = rawSessionId ? String(rawSessionId) : '';
        if (!sessionId || !this.router.bindingForSession(sessionId))
            return next();
        const questions = req.questions;
        if (!Array.isArray(questions)
            || questions.length === 0
            || questions.some((question) => !validUserQuestion(question))) {
            throw new Error('无法在当前聊天展示这个问题');
        }
        if (req.signal?.aborted) {
            throw req.signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        const initialBinding = this.router.bindingForSession(sessionId);
        const actor = this.sessionActors.get(sessionId) ?? (initialBinding ? this.chatActors.get(`${initialBinding.channelId}:${initialBinding.kind}:${initialBinding.chatId}`) : undefined);
        if (actor)
            this.sessionActors.set(sessionId, actor);
        const typedQuestions = questions;
        return await this.runInteraction(sessionId, async () => {
            if (this.disposed || req.signal?.aborted) {
                throw req.signal?.reason ?? new DOMException('Aborted', 'AbortError');
            }
            const binding = this.router.bindingForSession(sessionId);
            const channel = binding ? this.channels.get(binding.channelId) : undefined;
            if (!binding || !channel)
                throw new Error('当前聊天已断开，无法在原聊天提问');
            const wait = this.questions.begin(sessionId, typedQuestions, req.signal);
            if (!wait)
                throw new Error('当前聊天已有未完成的问题');
            // Abort can reject while the prompt send is still in flight; attach the
            // observer now, then await the same promise after presentation completes.
            void wait.catch(() => undefined);
            if (actor)
                this.questionActors.set(sessionId, actor);
            const resume = this.progress.waiting(sessionId, true);
            try {
                const delivery = await this.retryInteraction(channel, () => this.deliverQuestionInteraction(sessionId, channel, binding.chatId, this.formatQuestion(typedQuestions[0], 0, typedQuestions.length, { requiresMention: binding.kind === 'group' }), req.signal));
                if (delivery.status === 'aborted' || req.signal?.aborted) {
                    throw req.signal?.reason ?? new DOMException('Aborted', 'AbortError');
                }
                if (delivery.status === 'failed') {
                    this.questions.cancel(sessionId, new Error('交互问题未能发送到原聊天'));
                    throw new Error('交互问题未能发送到原聊天');
                }
                this.questions.activate(sessionId);
                return await wait;
            }
            catch (error) {
                if (req.signal?.aborted) {
                    await this.questionDeliveries.get(sessionId)?.catch(() => undefined);
                    if (this.questionPromptDelivered.has(sessionId)) {
                        await this.announceInteractionCancelled(channel, binding.chatId, '问题');
                    }
                }
                throw error;
            }
            finally {
                resume();
                this.questionSelections.delete(sessionId);
                this.questionActors.delete(sessionId);
                this.questionPromptDelivered.delete(sessionId);
            }
        }, req.signal, () => {
            throw req.signal?.reason ?? new DOMException('Aborted', 'AbortError');
        });
    }
    /**
     * DSH 0.1.1-rc.2 exposes a mutable provider behind a stable service.ask.
     * Decorate the service so later provider registrations remain visible through
     * the original service implementation, while non-IM sessions keep its path.
     */
    scheduleLegacyUserQuestionService() {
        let attempt = 0;
        const retry = () => {
            if (this.disposed)
                return;
            const delay = Math.min(25 * 2 ** attempt, 2_000);
            this.legacyServiceTimer = setTimeout(() => {
                this.legacyServiceTimer = undefined;
                if (this.installLegacyUserQuestionService())
                    return;
                attempt += 1;
                if (attempt === 8)
                    this.log('[interaction] 暂未发现 userQuestions service，保留 waterfall 并继续监听');
                retry();
            }, delay);
            this.legacyServiceTimer.unref?.();
        };
        retry();
    }
    installLegacyUserQuestionService(candidate) {
        if (this.disposed)
            return false;
        if (candidate === undefined) {
            try {
                candidate = this.ctx.get?.('userQuestions', false);
            }
            catch {
                return false;
            }
        }
        if (!candidate || typeof candidate !== 'object')
            return false;
        const service = candidate;
        const currentDescriptor = Reflect.getOwnPropertyDescriptor(service, 'ask');
        const currentAsk = currentDescriptor?.value;
        if (this.wrappedUserQuestionServices.has(service) || currentAsk?.[USER_QUESTION_WRAPPER] === this)
            return true;
        if (typeof service.ask !== 'function')
            return false;
        const originalAsk = service.ask;
        const originalDescriptor = currentDescriptor;
        const wrappedAsk = (request) => this.onUserQuestions(request, () => originalAsk.call(service, request));
        Object.defineProperty(wrappedAsk, USER_QUESTION_WRAPPER, { value: this });
        try {
            service.ask = wrappedAsk;
        }
        catch {
            return false;
        }
        if (Reflect.getOwnPropertyDescriptor(service, 'ask')?.value !== wrappedAsk)
            return false;
        this.wrappedUserQuestionServices.add(service);
        this.log('[interaction] 已接管 userQuestions service 的 IM 会话');
        this.disposeEvents.push(() => {
            if (Reflect.getOwnPropertyDescriptor(service, 'ask')?.value !== wrappedAsk)
                return;
            if (originalDescriptor)
                Reflect.defineProperty(service, 'ask', originalDescriptor);
            else
                Reflect.deleteProperty(service, 'ask');
        });
        return true;
    }
    /**
     * 同一会话的人机交互严格串行。队首只有在用户回复、AbortSignal 或会话销毁时释放；
     * 审批等待有上限。到期由插件按取消答复宿主，不和网页审批抢决定；宿主信号或会话销毁仍优先，且不发超时通知。
     */
    runInteraction(sessionId, task, signal, onAbort) {
        const previous = this.interactionQueues.get(sessionId) ?? Promise.resolve();
        let abortedBeforeStart = false;
        let started = false;
        const scheduled = previous.catch(() => undefined).then(() => {
            started = true;
            if (abortedBeforeStart)
                return undefined;
            return task();
        });
        const tail = scheduled.then(() => undefined, () => undefined);
        this.interactionQueues.set(sessionId, tail);
        void tail.then(() => {
            if (this.interactionQueues.get(sessionId) === tail)
                this.interactionQueues.delete(sessionId);
        });
        if (!signal || !onAbort)
            return scheduled;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback) => {
                if (settled)
                    return;
                settled = true;
                signal.removeEventListener('abort', abort);
                callback();
            };
            const abort = () => {
                if (!started)
                    abortedBeforeStart = true;
                Promise.resolve().then(onAbort).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
            };
            signal.addEventListener('abort', abort, { once: true });
            scheduled.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
            if (signal.aborted)
                abort();
        });
    }
    async approvalPrompt(req) {
        const toolName = req.toolName?.trim() || '工具操作';
        const lines = [
            replyText('DeepSeek Harness 需要你的审批：'),
            '',
            replyText('工具：{0}', toolName),
        ];
        const callId = req.callId?.trim();
        const session = req.agent?.session;
        const events = callId ? await readSessionHistory(this.ctx, session) ?? [] : [];
        const event = callId ? events.findLast((item) => {
            if (item.type === 'tool/call')
                return item.data?.callId === callId;
            if (item.type === 'tool/code-dispatch-start' || item.type === 'tool/ptc-dispatch-start')
                return item.data?.subCallId === callId;
            return false;
        }) : undefined;
        const args = event?.data?.arguments;
        let rendered = '';
        try {
            rendered = typeof args === 'string' ? args : args === undefined ? '' : JSON.stringify(args, null, 2);
        }
        catch {
            rendered = '';
        }
        if (rendered.trim() && rendered.length <= 6_000 && (!event?.data?.name || event.data.name === toolName)) {
            lines.push(replyText('操作参数：'), rendered);
        }
        else {
            lines.push(replyText('参数暂时无法读取。仍请在此批准或拒绝，不要到网页处理。'));
        }
        const reason = req.reason?.trim();
        if (reason)
            lines.push(replyText('原因：{0}', reason));
        lines.push('', replyText('请精准回复「批准」或「拒绝」（也支持：同意 / 不同意 / yes / allow / no / reject）。'));
        lines.push(replyText('{0} 分钟内未回复将取消，这次不会执行。', APPROVAL_WAIT_MS / 60_000));
        return lines.join('\n');
    }
    onSessionEvent(session, event) {
        const id = String(session.id ?? '');
        if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
            if (this.observedTurns.size >= 1024)
                this.observedTurns.delete(this.observedTurns.keys().next().value);
            this.observedTurns.set(id, event.data.turn);
            const scope = this.turnScopes.get(`${id}:${event.data.turn}`);
            if (scope)
                this.activeScopes.set(id, scope);
        }
        if (event.type === 'user/message') {
            const rpcId = event.data?.source?.rpcId ?? event.data?.id ?? '';
            if (this.observedTurns.has(id))
                this.deferred.claim(id, this.observedTurns.get(id), rpcId);
            const scope = this.pendingScopes.get(rpcId);
            if (scope) {
                this.pendingScopes.delete(rpcId);
                const turn = event.data?.turn ?? this.observedTurns.get(id);
                if (Number.isSafeInteger(turn))
                    this.turnScopes.set(`${id}:${turn}`, scope);
                if (!this.activeScopes.has(id))
                    this.activeScopes.set(id, scope);
            }
        }
        if (event.type === 'turn/end') {
            this.activeScopes.delete(id);
            for (const key of [...this.turnScopes.keys()])
                if (key.startsWith(`${id}:`))
                    this.turnScopes.delete(key);
        }
        const turn = event.data?.turn ?? this.observedTurns.get(id);
        if (['assistant/chunk', 'assistant/message', 'turn/end'].includes(event.type ?? '') && this.deferred.coldTurn(id, turn))
            return Promise.resolve();
        const tracked = this.deferred.turnEntries(id, turn);
        const binding = this.router.bindingForSession(id);
        const channel = binding && this.channels.get(binding.channelId);
        const unavailable = !!channel?.canDeliverDeferred && !channel.canDeliverDeferred();
        const invalid = tracked.some(entry => entry.status === 'blocked' || !this.validDelivery(entry));
        if (invalid)
            for (const entry of tracked)
                if (entry.status !== 'sent')
                    this.deferred.patch(entry.id, { status: 'blocked' });
        const skip = (unavailable || invalid) && ['assistant/chunk', 'assistant/message', 'turn/end'].includes(event.type ?? '');
        const trackedEnd = event.type === 'turn/end' && this.progress.hasTurn(id, event.data?.turn);
        this.progress.event(id, event);
        const outcome = { ok: !skip, content: false };
        const work = skip ? Promise.resolve() : this.processSessionEvent(session, event, outcome, trackedEnd);
        if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
            this.progress.delivery(id, event.data?.turn, work.then(() => !outcome.ok ? (outcome.definite ? 'rejected' : false) : outcome.content ? true : undefined, () => false));
        }
        return work.catch(error => { this.log(`[im-progress] 会话回复失败: ${error instanceof Error ? error.name : 'Error'}`); });
    }
    async processSessionEvent(session, event, outcome, trackedEnd = false) {
        const sessionId = session.id ? String(session.id) : '';
        if (!this.router.bindingForSession(sessionId))
            return;
        if (event.type === 'session/title') {
            const title = readSessionTitle(event.data);
            if (title) {
                this.router.setTitle(sessionId, title.title, title.source);
            }
            return;
        }
        // 静音会话：保留登记与标题同步，但不向聊天投递任何输出事件。
        if (this.router.isMuted(sessionId))
            return;
        const binding = this.router.bindingForSession(sessionId);
        const channel = binding ? this.channels.get(binding.channelId) : undefined;
        if (!binding || !channel)
            return;
        const streamKey = `${binding.channelId}:${binding.chatId}`;
        // 有明确触发消息时用回复接口关联来源；话题由回复 API 保持。
        const target = this.replyTarget(sessionId);
        const stillDeliverable = () => {
            const current = this.router.bindingForSession(sessionId);
            return !this.disposed && current?.channelId === binding.channelId && current.chatId === binding.chatId
                && !this.router.isMuted(sessionId) && this.channels.get(binding.channelId) === channel;
        };
        const chunk = event.data?.chunk;
        const markAttempt = () => this.deferred.liveStart(sessionId, event.data?.turn ?? this.observedTurns.get(sessionId));
        if (event.type === 'assistant/chunk' && channel.beginReply && isAssistantTextDelta(chunk)) {
            markAttempt();
            // 事件回调不在请求链路里，流式更新失败必须自兜底，避免 unhandled rejection
            void this.streams.onTextDelta(streamKey, chunk.text, () => channel.beginReply(binding.chatId).catch(() => undefined), sessionId)
                .catch((error) => {
                this.log(`[${channel.id}] 流式更新失败: ${error instanceof Error ? error.message : String(error)}`);
            });
            return;
        }
        if (event.type === 'turn/end') {
            const reason = event.data?.reason;
            this.log(`[${channel.id}] 回合结束 ${sessionId}: ${reason?.kind ?? 'ok'}`);
            if (reason?.kind === 'error' && !trackedEnd) {
                const detail = reason.error?.message || '模型调用失败';
                this.log(`[${channel.id}] 回合失败 ${sessionId}: ${detail}`);
                const failed = notice(this.ctx, '助手没有生成回复，请查看本机日志。');
                const taken = await this.streams.take(streamKey, sessionId);
                if (taken.invalidated || !stillDeliverable())
                    return;
                let failureDelivered;
                if (taken.stream) {
                    failureDelivered = await taken.stream.finish([taken.text, failed].filter(Boolean).join('\n\n')).then(() => true).catch(() => this.deliver(channel, binding.chatId, failed, undefined, target));
                }
                else {
                    failureDelivered = await this.deliver(channel, binding.chatId, failed, undefined, target);
                }
                // 仅在确已送达时标记，失败后同回合残留的 assistant/message 还有机会补发
                if (failureDelivered)
                    this.streams.markDelivered(streamKey, sessionId);
            }
            return;
        }
        if (event.type === 'assistant/message') {
            let stopped = false;
            try {
                const text = assistantText(event.data?.message?.content, channel.skipInterimText);
                if (text === undefined) {
                    this.log(`[${channel.id}] 跳过含工具调用的中间叙述 ${sessionId}`);
                    return;
                }
                const taken = await this.streams.take(streamKey, sessionId);
                stopped = !!taken.invalidated || !stillDeliverable();
                if (stopped)
                    return;
                if (taken.stream) {
                    const finalText = text || taken.text;
                    if (finalText) {
                        outcome.content = true;
                        markAttempt();
                        let delivered = true;
                        try {
                            await taken.stream.finish(finalText);
                        }
                        catch (error) {
                            // 请求可能已经到达渠道，不能自动补一份重复回复。
                            this.log(`[${channel.id}] 流式收口结果未知，请通过 /delivery 查询: ${error instanceof Error ? error.message : String(error)}`);
                            delivered = false;
                            outcome.ok = false;
                            this.streams.markDelivered(streamKey, sessionId);
                        }
                        outcome.ok = outcome.ok && delivered;
                        if (delivered)
                            this.streams.markDelivered(streamKey, sessionId);
                    }
                    return;
                }
                if (this.streams.consumeDelivered(streamKey, sessionId)) {
                    this.log(`[${channel.id}] 忽略重复助手消息 ${sessionId}`);
                    return;
                }
                if (text) {
                    outcome.content = true;
                    markAttempt();
                    this.log(`[${channel.id}] 准备回复 ${sessionId}，长度 ${text.length}`);
                    const delivered = await this.deliver(channel, binding.chatId, text, outcome, target);
                    outcome.ok = outcome.ok && delivered;
                }
                else {
                    this.log(`[${channel.id}] 助手消息为空 ${sessionId}`);
                }
            }
            finally {
                const filesOk = await this.fileDelivery.deliver(session, event, () => {
                    if (stopped || !stillDeliverable())
                        return undefined;
                    const currentTarget = this.replyTarget(sessionId);
                    return { channel, chatId: binding.chatId, messageId: currentTarget?.messageId };
                }, () => { outcome.content = true; markAttempt(); });
                outcome.ok = outcome.ok && filesOk;
            }
        }
    }
    /** 正常交付保持安静；仅异常结果追加必要文字提示。 */
    async notifyCompletion(result) {
        if (result.status === 'completed')
            return;
        const status = result.status;
        const first = result.items[0];
        if (!first)
            return;
        const { channel, message } = first;
        const valid = () => {
            const current = this.router.lookup(channel.id, message.kind ?? 'dm', message.chatId);
            return !this.disposed && this.channels.get(channel.id) === channel && current?.sessionId === result.sessionId
                && (message.kind === 'group' || this.isAuthorized(channel.id, channel, message))
                && (!channel.canDeliverDeferred || channel.canDeliverDeferred())
                && !this.progress.hasNewerTurn(result.sessionId, result.turn)
                && !this.questions.has(result.sessionId) && !this.broker.has(result.sessionId);
        };
        if (!valid())
            return;
        const terminalIds = [];
        const notified = await withReplyLocale(this.ctx, async () => {
            const text = ({
                empty: replyText('本次处理已结束，未返回可投递的结果。可补充要求后继续。'),
                error: replyText('本次处理失败，已返回的内容保留。请查看会话状态，或补充要求后重试。'),
                cancelled: replyText('本次处理已停止，已返回的内容保留。可直接发消息继续。'),
                'delivery-failed': replyText('本次处理已结束，但部分回复或文件未能发送。查看交付记录：/delivery；完整结果和文件请在网页查看，不会自动重复执行任务。'),
            })[status];
            if (!valid())
                return;
            if (result.status === 'error' || result.status === 'cancelled' || result.status === 'empty') {
                for (const entry of this.deferred.list(channel.id, message))
                    if (entry.sessionId === result.sessionId && entry.turn === result.turn && entry.status === 'waiting') {
                        this.deferred.patch(entry.id, { status: 'unknown' });
                        terminalIds.push(entry.id);
                    }
                const taken = await this.streams.take(`${channel.id}:${message.chatId}`, result.sessionId);
                if (!valid())
                    return;
                if (taken.stream) {
                    const body = text;
                    // 复用已有回复流发送异常说明；收口结果不明时不重复发送。
                    await taken.stream.finish([taken.text, body].filter(Boolean).join('\n\n'));
                    return true;
                }
            }
            const outcome = { ok: true };
            await this.deliver(channel, message.chatId, text, outcome);
            return outcome.ok;
        });
        if (notified)
            for (const id of terminalIds)
                this.deferred.patch(id, { status: 'sent' });
    }
    /** 逐片发送；返回是否至少送达过一片，供调用方决定是否标记已投递。 */
    async deliver(channel, chatId, text, outcome, target) {
        let deliveredAny = false;
        let ambiguous = false;
        // 重试预算按整条回复共享：钱花在第一个被拒的分片上，窗口一开后面的分片自然跟上。
        const deadline = Date.now() + SEND_RETRY_BUDGET_MS;
        for (const chunk of splitText(text, channel.maxMessageLength)) {
            const result = await this.sendChunk(channel, chatId, chunk, deadline, target);
            if (result.ok) {
                deliveredAny = true;
                this.log(`[${channel.id}] 已投递 ${chatId}，长度 ${chunk.length}`);
            }
            else {
                if (outcome)
                    outcome.ok = false;
                if (!isDefiniteSendFailure(result.error))
                    ambiguous = true;
                this.log(`[${channel.id}] 回复失败: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
            }
        }
        // 一片都没送到、且每次失败都是平台明确拒绝：不存在重复投递风险，交给自动补发。
        if (!deliveredAny && !ambiguous && outcome)
            outcome.definite = true;
        return deliveredAny;
    }
    /**
     * 发送一个分片，平台明确拒绝时按 {@link SEND_RETRY_DELAYS_MS} 退避重试。
     * 结果不明的失败（超时、网络中断）立即返回：请求可能已经送达。
     * 等待超过 `deadline` 就放弃，让整条回复的重试开销有上界。
     */
    async sendChunk(channel, chatId, chunk, deadline, target) {
        let error;
        for (const [attempt, delay] of this.sendRetryDelaysMs.entries()) {
            if (attempt > 0) {
                if (this.disposed || Date.now() + delay > deadline)
                    break;
                this.log(`[${channel.id}] 平台拒收，${delay / 1000}s 后重试（第 ${attempt + 1}/${this.sendRetryDelaysMs.length} 次）`);
                // dispose 会中止 recoveryScope，退避等待随之立即结束，不拖住插件卸载。
                try {
                    await sleepWithSignal(delay, this.recoveryScope.signal);
                }
                catch {
                    break;
                }
                if (this.disposed)
                    break;
            }
            try {
                await channel.send(chatId, chunk, target);
                return { ok: true };
            }
            catch (caught) {
                error = caught;
                if (!isDefiniteSendFailure(caught))
                    return { ok: false, error };
            }
        }
        return { ok: false, error };
    }
    formatQuestion(...args) { return withReplyLocale(this.ctx, () => formatUserQuestion(...args)); }
    deliverQuestionInteraction(sessionId, channel, chatId, text, signal) {
        let tracked;
        const current = this.questions.current(sessionId);
        const binding = this.router.bindingForSession(sessionId);
        const actor = this.questionActors.get(sessionId) ?? this.sessionActors.get(sessionId) ?? (binding ? this.chatActors.get(`${binding.channelId}:${binding.kind}:${binding.chatId}`) : undefined) ?? (binding?.kind === 'dm' ? chatId : undefined);
        const selected = this.questionSelections.get(sessionId) ?? new Set();
        const choices = current?.question.options?.map((option, index) => ({
            label: (current.question.multiSelect && selected.has(index) ? '✓ ' : '') + option.label,
            value: current.question.multiSelect ? `#question:${index}` : String(index + 1),
            textIncluded: true,
        })) ?? [];
        if (current?.question.multiSelect && selected.size)
            choices.push({ label: withReplyLocale(this.ctx, () => replyText('提交所选')), value: [...selected].map(index => index + 1).join(','), textIncluded: true });
        tracked = this.deliverInteraction(channel, chatId, text, signal, current && actor && choices.length ? {
            sessionId, message: { chatId, userId: actor, kind: binding?.kind ?? 'dm', text: '', messageId: this.interactionMessageIds.get(sessionId) }, choices,
            valid: () => this.questions.isReady(sessionId) && this.questions.current(sessionId)?.question === current.question,
        } : undefined).then((result) => {
            if (result.deliveredAny)
                this.questionPromptDelivered.add(sessionId);
            return result;
        }).finally(() => {
            if (this.questionDeliveries.get(sessionId) === tracked)
                this.questionDeliveries.delete(sessionId);
        });
        this.questionDeliveries.set(sessionId, tracked);
        return tracked;
    }
    async announceApprovalTimedOut(channel, chatId) {
        await this.deliver(channel, chatId, notice(this.ctx, '审批已超时，这次未执行。还要的话请重新说明。'));
    }
    async announceInteractionCancelled(channel, chatId, kind) {
        await this.deliver(channel, chatId, notice(this.ctx, kind === '审批' ? '该审批已取消，无需回复。' : '该问题已取消，无需回复。'));
    }
    /** 同一条提示失败后再发一次。部分平台的正文和问题撞车时，第一次会失败，排空后的重试仍可在聊天里回答。 */
    async retryInteraction(channel, deliver) {
        const first = await deliver();
        if (first.status !== 'failed')
            return first;
        this.log(`[${channel.id}] 交互提示发送失败，重试一次`);
        return deliver();
    }
    /** 交互提示必须完整送达；任一分片失败或取消就不能继续在 IM 中收集决定。 */
    async deliverInteraction(channel, chatId, text, signal, interactive) {
        let deliveredAny = false;
        if (channel.sendChoices && interactive && text.length < channel.maxMessageLength - 512 && !signal?.aborted) {
            const result = await withReplyLocale(this.ctx, () => this.choices.show(channel, interactive.message, text, interactive.choices, interactive.sessionId, interactive.valid, replyText('点击按钮或按提示回复文字。')));
            if (!result)
                return { status: signal?.aborted ? 'aborted' : 'delivered', deliveredAny: true };
        }
        for (const chunk of splitText(text, channel.maxMessageLength)) {
            if (signal?.aborted)
                return { status: 'aborted', deliveredAny };
            try {
                await channel.send(chatId, chunk);
                deliveredAny = true;
                this.log(`[${channel.id}] 已投递交互 ${chatId}，长度 ${chunk.length}`);
            }
            catch (error) {
                this.log(`[${channel.id}] 交互提示发送失败: ${error instanceof Error ? error.message : String(error)}`);
                return { status: 'failed', deliveredAny };
            }
            if (signal?.aborted)
                return { status: 'aborted', deliveredAny };
        }
        return { status: 'delivered', deliveredAny };
    }
}
