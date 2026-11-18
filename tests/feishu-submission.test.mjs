import test from 'node:test'
import assert from 'node:assert/strict'
import { composeSubmission, deliveryTargetOf } from '../src/engine/feishu-submission.js'

function source(overrides = {}) {
  return {
    messageId: 'om_1', chatId: 'oc_1', userId: 'ou_a', createTime: 1793773379160,
    text: '你好', links: [], mentions: [], attachments: [], ...overrides,
  }
}

test('单条纯文字消息保持原样', () => {
  assert.equal(composeSubmission([source()]), '你好')
})

test('多条消息按来源分块，不串正文和发送者', () => {
  const text = composeSubmission([
    source({ messageId: 'om_1', userId: 'ou_a', text: '第一条' }),
    source({ messageId: 'om_2', userId: 'ou_b', text: '第二条' }),
  ])
  assert.match(text, /以下 2 条飞书消息按发送顺序合并/)
  assert.match(text, /\[飞书消息 1\/2\][\s\S]*ou_a[\s\S]*第一条/)
  assert.match(text, /\[飞书消息 2\/2\][\s\S]*ou_b[\s\S]*第二条/)
  assert.ok(text.indexOf('第一条') < text.indexOf('第二条'))
})

test('引用内容只展示一次，并保留根消息标记', () => {
  const quote = { messageId: 'om_q', userId: 'ou_q', text: '被引用的原文', attachments: [] }
  const text = composeSubmission([
    source({ messageId: 'om_1', text: '问一', quoted: quote }),
    source({ messageId: 'om_2', text: '问二', quoted: { ...quote, isRoot: true } }),
  ])
  assert.equal(text.match(/被引用的原文/g)?.length, 1)
  assert.match(text, /引用消息（直接引用）：om_q/)
  assert.match(text, /与前述引用相同（om_q）/)
})

test('引用读取失败明确标记，不伪装成已知内容', () => {
  const text = composeSubmission([source({ text: '帮我看看', quotedError: 'permission' })])
  assert.match(text, /引用消息读取失败：无权限读取/)
  assert.match(text, /不能当作已知事实/)
})

test('附件路径与失败原因分开说明', () => {
  const text = composeSubmission([source({ attachments: [{ id: 'a' }, { id: 'b' }] })], [
    { attachmentId: 'a', sourceMessageId: 'om_1', name: '项目需求.docx', status: 'done', path: '.feishu/attachments/om_1/a/项目需求.docx', bytes: 12 },
    { attachmentId: 'b', sourceMessageId: 'om_1', name: '大文件.zip', status: 'failed', reason: 'too-large' },
  ])
  assert.match(text, /项目需求\.docx：已保存到 \.feishu\/attachments\/om_1\/a\/项目需求\.docx（12 字节）/)
  assert.match(text, /大文件\.zip：未保存（超过 20 MiB 接收上限）/)
})

test('引用附件显示在引用内容下', () => {
  const quote = { messageId: 'om_q', userId: 'ou_q', text: '看这个文件', attachments: [{ id: 'q1' }] }
  const text = composeSubmission([source({ quoted: quote })], [
    { attachmentId: 'q1', sourceMessageId: 'om_q', name: '需求.pdf', status: 'done', path: '.feishu/attachments/om_q/q1/需求.pdf', bytes: 9 },
  ])
  assert.match(text, /引用附件：[\s\S]*需求\.pdf：已保存到/)
})

test('附件截断在来源中明示', () => {
  const text = composeSubmission([source({ attachments: [{ id: 'a' }], attachmentsTruncated: true })], [])
  assert.match(text, /附件数量超过单条消息上限/)
})

test('合并输入以最后一条带 ID 的消息作为回复目标', () => {
  assert.deepEqual(deliveryTargetOf([source({ messageId: 'om_1' }), source({ messageId: 'om_2', threadId: 't' })]), { messageId: 'om_2', threadId: 't' })
  assert.deepEqual(deliveryTargetOf([{ messageId: '' }]), undefined)
})