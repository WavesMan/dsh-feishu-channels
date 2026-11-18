/**
 * 飞书消息结构统一：事件与 API 查询返回的消息字段不同，先转换成同一份
 * { messageId, chatId, userId, createTime, parentId, rootId, threadId, text,
 *   links, mentions, attachments }，后续流程只认这一份。
 *
 * 本模块不发起网络请求、不写文件，纯结构转换，便于单独测试。
 */
import { createHash } from 'node:crypto'

/** 单条消息最多接收的附件数；与第一版 20 MiB 累计预算一起限制处理量。 */
export const MAX_MESSAGE_ATTACHMENTS = 4

const MAX_NAME_CHARS = 120
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const URL_RE = /\bhttps?:\/\/[^\s<>"'）】。，、；：！？》」』]+/gi

/** 附件在服务端的唯一 ID；不含原始 key，避免把文件定位信息交给模型。 */
export function attachmentIdOf(messageId, key) {
  return createHash('sha1')
    .update(`${messageId ?? ''}\u0000${key ?? ''}`)
    .digest('hex')
    .slice(0, 16)
}

/** 清掉目录分隔符、控制字符与 Windows 保留名，避免附件名越出工作区。 */
export function sanitizeAttachmentName(name, fallback = 'attachment.bin') {
  const raw = typeof name === 'string' ? name : ''
  const leaf = raw.replace(/\\/g, '/').split('/').pop() ?? ''
  let cleaned = leaf
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, MAX_NAME_CHARS)
  if (!cleaned || cleaned === '.' || cleaned === '..' || WINDOWS_RESERVED.test(cleaned))
    cleaned = fallback
  return cleaned
}

function parseJson(value) {
  if (typeof value !== 'string')
    return value && typeof value === 'object' ? value : undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function collectLinks(text, links) {
  for (const match of String(text ?? '').matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?]+$/, '')
    if (url && !links.includes(url))
      links.push(url)
  }
}

function localizedPost(content) {
  const value = content?.post ?? content
  if (!value || typeof value !== 'object')
    return undefined
  if (Array.isArray(value.content))
    return value
  for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
    if (Array.isArray(value[locale]?.content))
      return value[locale]
  }
  return Object.values(value).find(item => Array.isArray(item?.content))
}

function readPost(content, textParts, links, mentions, attachments, messageId) {
  const post = localizedPost(content)
  if (!post)
    return false
  if (post.title) {
    textParts.push(String(post.title))
    collectLinks(post.title, links)
  }
  for (const row of post.content) {
    const line = []
    for (const item of Array.isArray(row) ? row : []) {
      if (!item || typeof item !== 'object')
        continue
      if (item.tag === 'text' && typeof item.text === 'string') {
        line.push(item.text)
        collectLinks(item.text, links)
      } else if (item.tag === 'a') {
        const label = typeof item.text === 'string' ? item.text : ''
        const href = typeof item.href === 'string' ? item.href : ''
        line.push(href ? `${label || href} <${href}>` : label)
        if (href && !links.includes(href))
          links.push(href)
      } else if (item.tag === 'at') {
        mentions.push({
          id: String(item.user_id ?? ''),
          name: typeof item.user_name === 'string' ? item.user_name : '',
          key: '',
        })
        line.push(`@${item.user_name || item.user_id || 'unknown'}`)
      } else if (item.tag === 'img') {
        if (item.image_key) {
          attachments.push({
            id: attachmentIdOf(messageId, item.image_key),
            kind: 'image',
            imageKey: String(item.image_key),
            name: '',
            sourceMessageId: messageId,
          })
        }
      } else if (item.tag === 'media') {
        if (item.file_key) {
          attachments.push({
            id: attachmentIdOf(messageId, item.file_key),
            kind: 'file',
            fileKey: String(item.file_key),
            name: '',
            sourceMessageId: messageId,
          })
        }
      } else if (item.tag === 'emotion') {
        line.push(typeof item.emoji_type === 'string' ? `[${item.emoji_type}]` : '[表情]')
      } else if (item.tag === 'code_block' && typeof item.text === 'string') {
        line.push(item.text)
      } else if (item.tag === 'hr') {
        line.push('\n---\n')
      } else if (typeof item.text === 'string') {
        line.push(item.text)
        collectLinks(item.text, links)
      }
    }
    if (line.length)
      textParts.push(line.join(''))
  }
  return true
}

/**
 * 解析消息正文。返回文本、链接与附件描述；不认识的结构交给调用方决定是否提示。
 * @param {string} messageType - text / post / image / file / audio / media / sticker ...
 * @param {unknown} content - 事件里的 JSON 字符串或 API 里的对象
 * @param {string} messageId - 用于生成附件 ID
 */
export function parseFeishuMessageContent(messageType, content, messageId = '') {
  const parsed = parseJson(content)
  const textParts = []
  const links = []
  const mentions = []
  const attachments = []
  let supported = true
  switch (messageType) {
    case 'text':
      if (typeof parsed?.text === 'string') {
        textParts.push(parsed.text)
        collectLinks(parsed.text, links)
      }
      break
    case 'post':
      supported = readPost(parsed, textParts, links, mentions, attachments, messageId)
      break
    case 'image':
      if (parsed?.image_key) {
        attachments.push({
          id: attachmentIdOf(messageId, parsed.image_key),
          kind: 'image',
          imageKey: String(parsed.image_key),
          name: '',
          sourceMessageId: messageId,
        })
      }
      break
    case 'file':
      if (parsed?.file_key) {
        attachments.push({
          id: attachmentIdOf(messageId, parsed.file_key),
          kind: 'file',
          fileKey: String(parsed.file_key),
          name: typeof parsed.file_name === 'string' ? parsed.file_name : '',
          sourceMessageId: messageId,
        })
      }
      break
    case 'audio':
      if (parsed?.file_key) {
        attachments.push({
          id: attachmentIdOf(messageId, parsed.file_key),
          kind: 'file',
          fileKey: String(parsed.file_key),
          name: `voice-${attachmentIdOf(messageId, parsed.file_key)}.opus`,
          sourceMessageId: messageId,
        })
      }
      break
    case 'media':
      if (parsed?.file_key) {
        const id = attachmentIdOf(messageId, parsed.file_key)
        attachments.push({
          id,
          kind: 'file',
          fileKey: String(parsed.file_key),
          name: typeof parsed.file_name === 'string' && parsed.file_name
            ? parsed.file_name
            : `video-${id}.mp4`,
          sourceMessageId: messageId,
        })
      }
      break
    case 'sticker':
      if (parsed?.file_key) {
        const id = attachmentIdOf(messageId, parsed.file_key)
        attachments.push({
          id,
          kind: 'image',
          fileKey: String(parsed.file_key),
          name: `sticker-${id}.png`,
          sourceMessageId: messageId,
        })
      }
      break
    case 'merge_forward':
      textParts.push('[合并转发的消息]')
      break
    case 'share_chat':
    case 'share_user':
      textParts.push('[分享的群名片或联系人]')
      break
    case 'interactive':
      textParts.push('[卡片消息]')
      break
    case 'system':
      if (typeof parsed?.text === 'string')
        textParts.push(parsed.text)
      break
    default:
      supported = false
  }
  return { text: textParts.join('\n').trim(), links, mentions, attachments, supported }
}

function senderId(raw) {
  return String(raw?.sender?.sender_id?.open_id
    ?? raw?.sender?.id
    ?? raw?.sender?.sender_id?.user_id
    ?? raw?.sender_id?.open_id
    ?? '')
}

/**
 * 事件与 API 消息统一结构。
 * @param {object} raw - im.message.receive_v1 的 message，或 im/v1/messages 返回的 item
 * @param {{ chatType?: string, source?: 'event'|'api' }} [options]
 */
export function normalizeFeishuMessage(raw, options = {}) {
  const messageId = String(raw?.message_id ?? '')
  const messageType = String(raw?.message_type ?? raw?.msg_type ?? '')
  const parsed = parseFeishuMessageContent(messageType, raw?.content ?? raw?.body?.content, messageId)
  const attachments = parsed.attachments.slice(0, MAX_MESSAGE_ATTACHMENTS)
  const mentions = parsed.mentions.map(item => ({ ...item }))
  for (const mention of Array.isArray(raw?.mentions) ? raw.mentions : []) {
    const id = String(mention?.id?.open_id ?? mention?.id?.user_id ?? mention?.id?.union_id ?? '')
    if (!id)
      continue
    if (mentions.some(item => item.id === id && item.key === String(mention.key ?? '')))
      continue
    mentions.push({ id, name: typeof mention.name === 'string' ? mention.name : '', key: String(mention.key ?? '') })
  }
  const text = parsed.text
  return {
    messageId,
    chatId: String(raw?.chat_id ?? ''),
    chatType: String(raw?.chat_type ?? options.chatType ?? ''),
    userId: senderId(raw),
    createTime: Number(raw?.create_time) || 0,
    parentId: String(raw?.parent_id ?? ''),
    rootId: String(raw?.root_id ?? ''),
    threadId: String(raw?.thread_id ?? ''),
    messageType,
    text,
    links: parsed.links,
    mentions,
    attachments,
    attachmentsTruncated: parsed.attachments.length > attachments.length,
    supported: parsed.supported,
    deleted: raw?.deleted === true,
  }
}