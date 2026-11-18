import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import * as feishu from '../src/channels/feishu.js'

function sdkWith(events, clientShape) {
  return {
    defaultHttpInstance: { request: async () => ({}) },
    Client: class {
      request = async () => ({ bot: { open_id: 'bot' } })
      im = clientShape
    },
    EventDispatcher: class {
      register(value) { Object.assign(events, value); return this }
    },
    WSClient: class { async start() {} close() {} },
  }
}

test('飞书媒体失败提示的业务拒绝记录失败，不泄漏响应详情', async () => {
  const events = {}, logs = []
  const sdk = sdkWith(events, { message: { create: async () => ({ code: 230001, msg: 'private-detail' }) } })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'test', appSecret: 'test' }, line => logs.push(line), async () => sdk)
  try {
    await channel.start()
    await events['im.message.receive_v1']({ message: { chat_id: 'c', chat_type: 'p2p', message_id: 'm', message_type: 'image', content: '{}' } })
    assert.ok(logs.some(line => line.includes('消息提示发送失败')))
    assert.ok(!logs.some(line => line.includes('private-detail')))
  } finally { await channel.stop() }
})

test('飞书附件在接收阶段只解析清单，不下载资源', async () => {
  const events = {}, received = [], replies = []
  let downloads = 0
  const sdk = sdkWith(events, {
    message: { create: async m => replies.push(m) },
    messageResource: { get: async () => { downloads++; return { getReadableStream: () => Readable.from([Buffer.from('png')]) } } },
  })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => sdk)
  channel.setMessageHandler(m => received.push(m))
  try {
    await channel.start()
    await events['im.message.receive_v1']({ message: { chat_id: 'c', chat_type: 'p2p', message_id: 'm', message_type: 'post',
      content: JSON.stringify({ title: '/new', content: [Array.from({ length: 100 }, (_, n) => ({ tag: 'img', image_key: `k${n}` }))] }) },
      sender: { sender_id: { open_id: 'user' } } })
    assert.equal(downloads, 0)
    assert.equal(replies.length, 0)
    assert.equal(received.length, 1)
    assert.equal(received[0].attachments.length, 4)
    assert.equal(received[0].attachmentsTruncated, true)
    assert.match(received[0].attachments[0].id, /^[0-9a-f]{16}$/)
    assert.equal(received[0].quoted, undefined)
  } finally { await channel.stop() }
})

test('英文全局语言下，飞书图片失败提示为英文', async () => {
  const events = {}, replies = []
  const host = { get: (name) => name === 'settings' ? { describe: () => [{ ns: 'locale', value: { preference: 'en' } }] } : undefined }
  const sdk = sdkWith(events, { message: { create: async m => replies.push(m) } })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret', host }, () => {}, async () => sdk)
  try {
    await channel.start()
    await events['im.message.receive_v1']({ message: { chat_id: 'c', chat_type: 'p2p', message_id: 'm', message_type: 'image', content: '{}' } })
    assert.equal(JSON.parse(replies[0].data.content).text, 'The image or message could not be read. Send the image or text again.')
  } finally { await channel.stop() }
})

for (const declared of [false, true]) test(`Feishu enforces the resource byte budget (declared=${declared})`, async () => {
  let downloads = 0
  const streams = []
  const sdk = sdkWith({}, { messageResource: { get: async () => {
    downloads++
    const stream = Readable.from([Buffer.alloc(21 * 1024 * 1024)])
    streams.push(stream)
    return { headers: declared ? { 'content-length': String(21 * 1024 * 1024) } : {}, getReadableStream: () => stream }
  } } })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => sdk)
  try {
    await channel.start()
    await assert.rejects(channel.downloadAttachment({ sourceMessageId: 'm', kind: 'file', fileKey: 'k' }, new AbortController().signal), /resource-too-large/)
    assert.equal(downloads, 1)
    assert.ok(streams.every(s => s.destroyed))
  } finally { await channel.stop() }
})

test('Feishu aborts a stalled resource download and cleans up the late stream', async () => {
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const sdk = sdkWith({}, { messageResource: { get: () => pending } })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => sdk)
  await channel.start()
  const controller = new AbortController()
  const work = channel.downloadAttachment({ sourceMessageId: 'm', kind: 'image', imageKey: 'k' }, controller.signal)
  controller.abort()
  const outcome = await Promise.race([work.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('hung'), 40))])
  const stream = Readable.from([Buffer.from('x')])
  complete({ getReadableStream: () => stream, headers: {} })
  await work.catch(() => {})
  assert.equal(outcome, 'rejected')
  assert.equal(stream.destroyed, true)
  await channel.stop()
})

test('Feishu callback routes attachments and preserves group addressing', async () => {
  const events = {}, received = [], replies = [], logs = []
  let resourceCalls = 0
  const sdk = sdkWith(events, {
    message: { create: async m => replies.push(m) },
    messageResource: { get: async () => { resourceCalls++; throw new Error('receive must not download') } },
  })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, s => logs.push(s), async () => sdk)
  channel.setMessageHandler(m => received.push(m))
  await channel.start()
  try {
    const message = { chat_id: 'chat', message_id: 'm', chat_type: 'group', message_type: 'image', content: JSON.stringify({ image_key: 'key' }) }
    await events['im.message.receive_v1']({ message })
    assert.equal(received.length, 0)
    await events['im.message.receive_v1']({ message: { ...message, mentions: [{ id: { open_id: 'bot' } }] }, sender: { sender_id: { open_id: 'user' } } })
    assert.equal(received.length, 1)
    assert.equal(received[0].attachments[0].kind, 'image')
    assert.equal(received[0].addressed, true)
    assert.equal(received[0].messageId, 'm')
    assert.equal(received[0].userId, 'user')
    await events['im.message.receive_v1']({ message: { ...message, chat_type: 'p2p', message_type: 'post', content: JSON.stringify({ title: 'Compare', content: [[{ tag: 'text', text: 'caption' }, { tag: 'img', image_key: 'one' }, { tag: 'img', image_key: 'two' }]] }) } })
    assert.equal(received[1].attachments.length, 2)
    assert.match(received[1].text, /Compare[\s\S]*caption/)
    await events['im.message.receive_v1']({ message: { ...message, chat_type: 'p2p', content: '{}' } })
    assert.equal(received.length, 2)
    assert.match(replies.pop().data.content, /失败/)
    assert.equal(resourceCalls, 0)
    assert.ok(logs.every(s => !s.includes('receive must not download')))
  } finally { await channel.stop() }
})

for (const stop of [false, true]) test(`Feishu per-chat ordering and lifecycle guard with quote reads: stop=${stop}`, async () => {
  const events = {}, received = []
  let release
  const pending = new Promise(resolve => { release = resolve })
  const sdk = sdkWith(events, {
    message: {
      get: () => pending,
      create: async () => ({ code: 0 }),
      patch: async () => ({ code: 0 }),
    },
    messageResource: { get: async () => ({ getReadableStream: () => Readable.from([Buffer.from('png')]) }) },
  })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => sdk)
  channel.setMessageHandler(m => received.push(m))
  await channel.start()
  const emit = m => events['im.message.receive_v1']({ message: { chat_id: 'chat', chat_type: 'p2p', ...m } })
  const first = emit({ message_id: 'image', message_type: 'image', content: JSON.stringify({ image_key: 'k' }), parent_id: 'parent' })
  const second = emit({ message_id: 'text', message_type: 'text', content: JSON.stringify({ text: 'later' }) })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(received.length, 0)
    if (stop) await channel.stop()
    release({ code: 0, data: { items: [{ message_id: 'parent', chat_id: 'chat', msg_type: 'text', body: { content: JSON.stringify({ text: 'quoted' }) }, sender: { id: 'user' } }] } })
    await Promise.all([first, second])
    assert.deepEqual(received.map(m => m.messageId), stop ? [] : ['image', 'text'])
    if (!stop) {
      assert.equal(received[0].quoted.text, 'quoted')
      assert.equal(received[0].quoted.isRoot, false)
    }
  } finally { release({ code: 0, data: { items: [] } }); await Promise.all([first, second]); await channel.stop() }
})

test('Feishu quote failures keep the request and mark missing content', async () => {
  const events = {}, received = []
  const sdk = sdkWith(events, {
    message: {
      get: async () => { const error = new Error('private'); error.response = { status: 403, data: { code: 99991672 } }; throw error },
      create: async () => ({ code: 0 }),
    },
  })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => sdk)
  channel.setMessageHandler(m => received.push(m))
  await channel.start()
  try {
    await events['im.message.receive_v1']({ message: { chat_id: 'chat', chat_type: 'p2p', message_id: 'm', message_type: 'text',
      content: JSON.stringify({ text: 'look at this' }), parent_id: 'parent' } })
    assert.equal(received.length, 1)
    assert.equal(received[0].quotedError, 'permission')
    assert.equal(received[0].text, 'look at this')
  } finally { await channel.stop() }
})

test('飞书通用文件资源按 file 下载并保留字节', async () => {
  const calls = []
  const sdk = sdkWith({}, { messageResource: { get: async request => {
    calls.push(request)
    return { getReadableStream: () => Readable.from([Buffer.from('pdf')]) }
  } } })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => sdk)
  await channel.start()
  try {
    const data = await channel.downloadAttachment({ sourceMessageId: 'file-message', kind: 'file', fileKey: 'key' }, new AbortController().signal)
    assert.equal(data.toString(), 'pdf')
    assert.equal(calls[0].params.type, 'file')
    assert.equal(calls[0].path.file_key, 'key')
  } finally { await channel.stop() }
})

test('飞书发送文件与图片时可关联触发消息，图片走图片消息', async () => {
  const events = {}, uploaded = [], sent = []
  const sdk = sdkWith(events, {
    file: { create: async request => { uploaded.push(['file', request]); return { file_key: 'file-key' } } },
    image: { create: async request => { uploaded.push(['image', request]); return { image_key: 'image-key' } } },
    message: {
      create: async request => { sent.push(['create', request]); return { code: 0 } },
      reply: async request => { sent.push(['reply', request]); return { code: 0 } },
    },
  })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => sdk)
  await channel.start()
  try {
    await channel.sendFile('chat', { name: 'a.txt', data: new Uint8Array([65]) }, new AbortController().signal, { messageId: 'trigger' })
    assert.equal(uploaded[0][0], 'file')
    assert.equal(sent[0][0], 'reply')
    assert.equal(sent[0][1].path.message_id, 'trigger')
    assert.equal(sent[0][1].data.msg_type, 'file')
    await channel.sendImage('chat', { name: 'a.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]) }, new AbortController().signal, { messageId: 'trigger' })
    assert.equal(uploaded[1][0], 'image')
    assert.equal(sent[1][1].data.msg_type, 'image')
    assert.match(sent[1][1].data.content, /image-key/)
  } finally { await channel.stop() }
})

test('飞书回复接口不可用时不静默改发到聊天', async () => {
  const events = {}, sent = []
  const sdk = sdkWith(events, { message: { create: async request => { sent.push(request); return { code: 0 } } } })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => sdk)
  await channel.start()
  try {
    await assert.rejects(channel.send('chat', '正文', { messageId: 'trigger' }), /reply-unsupported/)
    assert.equal(sent.length, 0)
  } finally { await channel.stop() }
})

test('飞书卡片回调只转交不透明 token，业务失败触发文字降级', async () => {
  const events = {}, received = [], sent = []
  let code = 0
  const sdk = sdkWith(events, {
    message: {
      create: async request => { sent.push(request); return { code } },
      patch: async () => ({ code }),
    },
  })
  const channel = feishu.createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => sdk)
  channel.setMessageHandler(message => received.push(message))
  try {
    await channel.start()
    await channel.sendChoices({ chatId: 'chat', kind: 'group' }, 'menu', [{ label: 'New', token: 'opaque:0' }])
    const card = JSON.parse(sent[0].data.content)
    assert.deepEqual(card.elements[1].actions[0].value, { token: 'opaque:0', group: true })
    await events['card.action.trigger']({ operator: { open_id: 'user' }, context: { open_chat_id: 'chat' }, action: { value: { token: 'opaque:0', group: true } } })
    assert.equal(received[0].actionToken, 'opaque:0')
    assert.equal(received[0].userId, 'user')
    assert.equal(received[0].text, '')
    code = 999
    await assert.rejects(channel.sendChoices({ chatId: 'chat' }, 'menu', [{ label: 'New', token: 'opaque:0' }]))
  } finally { await channel.stop() }
})