import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_MESSAGE_ATTACHMENTS,
  attachmentIdOf,
  normalizeFeishuMessage,
  parseFeishuMessageContent,
  sanitizeAttachmentName,
} from '../src/channels/feishu-message.js'

test('文本消息保留正文与完整链接', () => {
  const parsed = parseFeishuMessageContent('text', JSON.stringify({ text: '看这里 https://example.com/a?b=1。' }), 'm')
  assert.match(parsed.text, /看这里/)
  assert.deepEqual(parsed.links, ['https://example.com/a?b=1'])
  assert.deepEqual(parsed.attachments, [])
})

test('富文本保留标题、正文、链接、@ 与图片顺序', () => {
  const message = normalizeFeishuMessage({
    message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', msg_type: 'post', create_time: '1793773379160',
    sender: { sender_id: { open_id: 'ou_user' } },
    body: { content: JSON.stringify({ zh_cn: { title: '对比', content: [[
      { tag: 'text', text: '第一行' },
      { tag: 'a', text: '文档', href: 'https://docs.example.com/x' },
      { tag: 'at', user_id: 'ou_colleague', user_name: '同事' },
      { tag: 'img', image_key: 'img_a' },
      { tag: 'img', image_key: 'img_b' },
    ]] } }) },
  }, { source: 'api' })
  assert.equal(message.text, '对比\n第一行文档 <https://docs.example.com/x>@同事')
  assert.deepEqual(message.links, ['https://docs.example.com/x'])
  assert.deepEqual(message.mentions.map(item => item.id), ['ou_colleague'])
  assert.deepEqual(message.attachments.map(item => item.kind), ['image', 'image'])
  assert.equal(message.attachments[0].id, attachmentIdOf('om_1', 'img_a'))
  assert.equal(message.userId, 'ou_user')
  assert.equal(message.createTime, 1793773379160)
  assert.equal(message.chatType, 'group')
})

test('文件与语音附件按资源类型生成可下载描述', () => {
  const file = normalizeFeishuMessage({ message_id: 'om_f', chat_id: 'c', message_type: 'file', content: JSON.stringify({ file_key: 'k', file_name: '../项目需求.docx' }) })
  assert.equal(file.attachments[0].kind, 'file')
  assert.equal(file.attachments[0].fileKey, 'k')
  assert.equal(file.attachments[0].name, '../项目需求.docx')
  assert.equal(file.attachments[0].sourceMessageId, 'om_f')
  const voice = normalizeFeishuMessage({ message_id: 'om_v', chat_id: 'c', message_type: 'audio', content: JSON.stringify({ file_key: 'v', duration: 1000 }) })
  assert.match(voice.attachments[0].name, /^voice-[0-9a-f]{16}\.opus$/)
})

test('附件数量超出上限时截断并标记', () => {
  const content = { content: [Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 3 }, (_, n) => ({ tag: 'img', image_key: `k${n}` }))] }
  const parsed = parseFeishuMessageContent('post', JSON.stringify(content), 'm')
  assert.equal(parsed.attachments.length, MAX_MESSAGE_ATTACHMENTS + 3)
  const message = normalizeFeishuMessage({ message_id: 'm', chat_id: 'c', message_type: 'post', content: JSON.stringify(content) })
  assert.equal(message.attachments.length, MAX_MESSAGE_ATTACHMENTS)
  assert.equal(message.attachmentsTruncated, true)
})

test('未知消息类型不伪装成可处理内容', () => {
  const message = normalizeFeishuMessage({ message_id: 'm', chat_id: 'c', message_type: 'share_calendar_event', content: '{}' })
  assert.equal(message.supported, false)
  assert.deepEqual(message.attachments, [])
})

test('撤回的消息保留 deleted 标记', () => {
  const message = normalizeFeishuMessage({ message_id: 'm', chat_id: 'c', message_type: 'text', content: '{}', deleted: true })
  assert.equal(message.deleted, true)
})

for (const [input, expected] of [
  ['../项目需求.docx', '项目需求.docx'],
  ['a/b/c.pdf', 'c.pdf'],
  ['CON', 'attachment.bin'],
  ['   ', 'attachment.bin'],
  ['bad\u0000name?.txt', 'badname_.txt'],
]) test(`附件名清理：${JSON.stringify(input)}`, () => {
  assert.equal(sanitizeAttachmentName(input), expected)
})