import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImEngine } from '../src/engine/gateway.js'

function makeStore() {
  return {
    get: () => undefined,
    findSession: () => undefined,
    list: () => [],
    upsert() {},
    updateSession() {},
    saveHistory() {},
    retain() {},
    removeSession() {},
  }
}

function makeEngine() {
  const config = { mergeTimeoutSecs: 0 }
  const ctx = { get: () => undefined }
  return new ImEngine(ctx, makeStore(), { has: () => false }, config, () => {}, () => {}, () => config, () => 'approved')
}

function toolsHarness(present = false) {
  const registered = new Map()
  return {
    registered,
    tools: {
      register(definition) { registered.set(definition.name, definition) },
      get(name) { return present && name === 'present' ? { name } : undefined },
    },
  }
}

function message(overrides = {}) {
  return {
    messageId: 'om_x', chatId: 'oc_1', userId: 'ou_user', createTime: 1_793_773_379_160,
    text: 'hello', links: [], mentions: [], attachments: [], ...overrides,
  }
}

function scopeFor(engine, overrides = {}) {
  const scope = {
    sessionId: 'dfc:feishu:dm:1:oc_1', channelId: 'feishu', chatId: 'oc_1', kind: 'dm', userId: 'ou_user',
    messageId: 'om_trigger', threadId: 'thread_1', triggerTime: 1_793_773_379_160,
    known: new Map(), attachments: new Map(), threads: new Set(['thread_1']), downloadedBytes: 0,
    ...overrides,
  }
  engine.chatScopes.set(scope.sessionId, scope)
  engine.activeScopes.set(scope.sessionId, scope)
  return scope
}

function agentFor(tools) {
  const sessionId = 'dfc:feishu:dm:1:oc_1'
  const ctx = { tools }
  return { session: { id: sessionId }, id: sessionId, ctx }
}

const exec = { signal: new AbortController().signal }

test('注册上下文与附件下载工具；宿主有 present 时不重复提供交付工具', (t) => {
  const engine = makeEngine()
  t.after(() => engine.dispose())
  const withPresent = toolsHarness(true)
  engine.registerAgentTools({ tools: withPresent.tools }, agentFor(withPresent.tools), 'feishu')
  assert.deepEqual([...withPresent.registered.keys()].sort(), ['feishu_download_attachment', 'feishu_read_context'])
  const withoutPresent = toolsHarness(false)
  const agent = agentFor(withoutPresent.tools)
  agent.session = { id: 'dfc:feishu:dm:2:oc_1' }
  engine.registerAgentTools({ tools: withoutPresent.tools }, agent, 'feishu')
  assert.ok(withoutPresent.registered.has('feishu_deliver_file'))
})

test('注册对同一 Agent 只执行一次', (t) => {
  const engine = makeEngine()
  t.after(() => engine.dispose())
  const harness = toolsHarness(false)
  const agent = agentFor(harness.tools)
  engine.registerAgentTools({ tools: harness.tools }, agent, 'feishu')
  const count = harness.registered.size
  engine.registerAgentTools({ tools: harness.tools }, agent, 'feishu')
  assert.equal(harness.registered.size, count)
})

test('feishu_read_context 只读取当前聊天，并排除触发消息', async (t) => {
  const engine = makeEngine()
  t.after(() => engine.dispose())
  const scope = scopeFor(engine)
  const channel = {
    id: 'feishu',
    readMessage: async (id) => id === 'om_other'
      ? message({ messageId: id, chatId: 'oc_2' })
      : message({ messageId: id, attachments: [{ id: 'a2', kind: 'file', name: 'x.txt', sourceMessageId: id }] }),
    listMessages: async () => ({
      messages: [
        message({ messageId: 'om_trigger', text: '触发消息' }),
        message({ messageId: 'om_history', text: '历史消息', userId: 'ou_other' }),
      ],
      hasMore: false,
      pageToken: '',
    }),
  }
  engine.channels.set('feishu', channel)
  const harness = toolsHarness(false)
  engine.registerAgentTools({ tools: harness.tools }, agentFor(harness.tools), 'feishu')
  const read = harness.registered.get('feishu_read_context')

  const direct = await read.execute({ mode: 'message', message_id: 'om_x' }, exec)
  assert.equal(direct.ok, true)
  assert.equal(direct.messages[0].text, 'hello')
  assert.equal(direct.messages[0].attachments[0].attachment_id, 'a2')
  assert.ok(scope.attachments.has('a2'))

  const other = await read.execute({ mode: 'message', message_id: 'om_other' }, exec)
  assert.equal(other.ok, false)
  assert.match(other.error, /不属于当前聊天/)

  const recent = await read.execute({ mode: 'recent', limit: 5 }, exec)
  assert.equal(recent.ok, true)
  assert.deepEqual(recent.messages.map(item => item.message_id), ['om_history'])

  const thread = await read.execute({ mode: 'thread' }, exec)
  assert.equal(thread.ok, true)
  const unknownThread = await read.execute({ mode: 'thread', thread_id: 'other_thread' }, exec)
  assert.equal(unknownThread.ok, false)
})

test('feishu_download_attachment 只接受清单内附件并返回真实路径', async (t) => {
  const engine = makeEngine()
  t.after(() => engine.dispose())
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-feishu-tool-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  engine.router.workspaceForSession = async () => cwd
  const scope = scopeFor(engine)
  scope.attachments.set('a1', { id: 'a1', kind: 'file', fileKey: 'k', name: '报告.txt', sourceMessageId: 'om_q' })
  let downloads = 0
  engine.channels.set('feishu', {
    id: 'feishu',
    downloadAttachment: async () => { downloads += 1; return Buffer.from('report') },
  })
  const harness = toolsHarness(false)
  engine.registerAgentTools({ tools: harness.tools }, agentFor(harness.tools), 'feishu')
  const download = harness.registered.get('feishu_download_attachment')

  const first = await download.execute({ attachment_id: 'a1' }, exec)
  assert.equal(first.status, 'downloaded')
  assert.equal(first.size, 6)
  assert.match(first.path, /^\.feishu\/attachments\/om_q\/a1\/报告\.txt$/)
  assert.equal(await readFile(join(cwd, first.path), 'utf8'), 'report')

  const second = await download.execute({ attachment_id: 'a1' }, exec)
  assert.equal(second.status, 'downloaded')
  assert.equal(downloads, 1)

  const unknown = await download.execute({ attachment_id: 'nope' }, exec)
  assert.equal(unknown.status, 'failed')
  assert.match(unknown.error, /不在当前请求/)
})

test('显式交付工具返回成功或明确失败，不谎报已发送', async (t) => {
  const engine = makeEngine()
  t.after(() => engine.dispose())
  scopeFor(engine)
  engine.channels.set('feishu', { id: 'feishu' })
  engine.fileDelivery.deliverPath = async ({ path }) => path === 'ok.txt' ? { status: 'sent' } : { status: 'unknown' }
  const harness = toolsHarness(false)
  engine.registerAgentTools({ tools: harness.tools }, agentFor(harness.tools), 'feishu')
  const deliver = harness.registered.get('feishu_deliver_file')
  assert.deepEqual(await deliver.execute({ path: 'ok.txt' }, { ...exec, agent: agentFor(harness.tools) }), { delivered: true, path: 'ok.txt' })
  const failed = await deliver.execute({ path: 'bad.txt' }, { ...exec, agent: agentFor(harness.tools) })
  assert.equal(failed.delivered, false)
})