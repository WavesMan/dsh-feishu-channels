/**
 * 把飞书来源整理成提交给 DSH 的正文。
 *
 * 合并消息时按来源分块：不同发送者的正文、引用和附件各自成段，不能拼成
 * 一个对象；引用与附件按 ID 去重。附件只写工作区相对路径与保存状态，
 * 失败项明确说明原因，不提供看似可用的路径。
 */

import { attachmentPathLine } from './file-input.js';

const QUOTE_FAILURE_LABELS = {
    permission: '无权限读取',
    'not-found': '消息不存在或已撤回',
    withdrawn: '消息已撤回',
    unsupported: '消息类型暂不支持',
    throttled: '平台限流',
    timeout: '读取超时',
    unavailable: '暂时无法读取',
};

function quoteFailureLabel(reason) {
    return QUOTE_FAILURE_LABELS[reason] ?? '暂时无法读取';
}

function isoTime(value) {
    const ms = Number(value)
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : ''
}

function sourceHeader(index, total, source) {
    const lines = [];
    if (total > 1)
        lines.push(`[飞书消息 ${index + 1}/${total}]`);
    lines.push(`发送者：${source.userId || '未知'}`);
    const time = isoTime(source.createTime);
    if (time)
        lines.push(`时间：${time}`);
    if (source.messageId)
        lines.push(`消息 ID：${source.messageId}`);
    return lines;
}

function bodyLines(source) {
    return ['正文：', source.text?.trim() || '（无文字内容）'];
}

function quoteLines(source, seenQuotes, savedByMessage) {
    if (source.quotedError) {
        return ['引用消息读取失败：' + quoteFailureLabel(source.quotedError), '缺失的内容不能当作已知事实。'];
    }
    const quote = source.quoted;
    if (!quote)
        return [];
    const quotedId = quote.messageId || '';
    if (quotedId && seenQuotes.has(quotedId))
        return [`引用消息：与前述引用相同（${quotedId}）`];
    if (quotedId)
        seenQuotes.add(quotedId);
    const label = quote.isRoot ? '根消息' : '直接引用';
    const lines = [`引用消息（${label}）${quotedId ? `：${quotedId}` : ''}`];
    if (quote.userId)
        lines.push(`引用发送者：${quote.userId}`);
    const time = isoTime(quote.createTime);
    if (time)
        lines.push(`引用时间：${time}`);
    lines.push(quote.text?.trim() ? quote.text.trim() : '（被引用消息没有文字内容）');
    const saved = quotedId ? savedByMessage.get(quotedId) ?? [] : [];
    if (saved.length) {
        lines.push('引用附件：');
        for (const item of saved)
            lines.push(attachmentPathLine(item));
    }
    return lines;
}

/**
 * @param {Array<object>} sources 触发请求的飞书消息（合并时按顺序多条）
 * @param {Array<object>} saved 当前消息附件与引用附件的保存结果
 * @returns {string}
 */
export function composeSubmission(sources, saved = []) {
    const list = Array.isArray(sources) && sources.length ? sources : [];
    if (!list.length)
        return '';
    const savedByMessage = new Map();
    for (const item of saved) {
        const key = item.sourceMessageId || '';
        const bucket = savedByMessage.get(key) ?? [];
        bucket.push(item);
        savedByMessage.set(key, bucket);
    }
    const hasMaterial = saved.length > 0
        || list.some(source => source.quoted || source.quotedError || source.attachments?.length || source.attachmentsTruncated);
    if (list.length === 1 && !hasMaterial)
        return list[0].text?.trim() ?? '';

    const blocks = [];
    if (list.length > 1) {
        blocks.push(`以下 ${list.length} 条飞书消息按发送顺序合并；请分别看待来源，不要合并不同发送者的要求。`);
    }
    const seenQuotes = new Set();
    list.forEach((source, index) => {
        const lines = [...sourceHeader(index, list.length, source), ...bodyLines(source)];
        const quote = quoteLines(source, seenQuotes, savedByMessage);
        if (quote.length)
            lines.push('', ...quote);
        const savedHere = savedByMessage.get(source.messageId || '') ?? [];
        if (savedHere.length) {
            lines.push('', '附件：');
            for (const item of savedHere)
                lines.push(attachmentPathLine(item));
        }
        if (source.attachmentsTruncated)
            lines.push('', '附件数量超过单条消息上限，部分附件未接收。');
        blocks.push(lines.join('\n'));
    });
    return blocks.join('\n\n');
}

/** 合并输入以最后一条触发消息作为回复目标；未合并时就是该消息本身。 */
export function deliveryTargetOf(sources) {
    const list = Array.isArray(sources) ? sources : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const source = list[index];
        if (source?.messageId)
            return { messageId: source.messageId, ...(source.threadId ? { threadId: source.threadId } : {}) };
    }
    return undefined;
}