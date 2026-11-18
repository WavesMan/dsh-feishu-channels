import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileDelivery, FileDeliveryError } from '../src/engine/file-delivery.js'

function hostWith(overrides = {}) {
  const fs = {
    lstat: async () => ({ type: 'file' }),
    resolve: async path => path,
    stat: async () => ({ type: 'file', size: 4 }),
    readBytes: async () => Buffer.from('data'),
    ...overrides.fs,
  }
  return {
    get(name) {
      if (name === 'workspaceFiles') return overrides.workspaceFiles
      if (name === 'fs') return fs
      if (name === 'sandboxPolicy') return { workspaceRoot: overrides.cwd }
      return undefined
    },
  }
}

function channelWith(calls, overrides = {}) {
  return {
    id: 'feishu',
    sendFile: async (...args) => { calls.push(['file', ...args]) },
    sendImage: async (...args) => { calls.push(['image', ...args]) },
    send: async (...args) => { calls.push(['text', ...args]) },
    ...overrides,
  }
}

test('普通文件按文件消息发送，同一回合内不重复发送', async () => {
  const calls = []
  const host = hostWith({ cwd: 'C:/workspace' })
  const delivery = new FileDelivery(host, () => {})
  const channel = channelWith(calls)
  const session = { id: 's1', header: { cwd: 'C:/workspace' } }
  const first = await delivery.deliverPath({ sessionId: 's1', session, channel, chatId: 'c', messageId: 'm', path: 'report.txt', turn: 3, signal: new AbortController().signal })
  const second = await delivery.deliverPath({ sessionId: 's1', session, channel, chatId: 'c', messageId: 'm', path: 'report.txt', turn: 3, signal: new AbortController().signal })
  assert.equal(first.status, 'sent')
  assert.equal(second.status, 'skipped')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'file')
  assert.equal(calls[0][1], 'c')
  assert.deepEqual(calls[0][4], { messageId: 'm' })
  assert.deepEqual(delivery.deliveries().map(item => item.status), ['sent'])
})

test('图片按图片消息发送', async () => {
  const calls = []
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('rest')])
  const host = hostWith({ cwd: 'C:/workspace', fs: { readBytes: async () => png } })
  const delivery = new FileDelivery(host, () => {})
  const channel = channelWith(calls)
  const result = await delivery.deliverPath({ sessionId: 's1', session: { id: 's1', header: { cwd: 'C:/workspace' } }, channel, chatId: 'c', path: 'chart.png', turn: 1, signal: new AbortController().signal })
  assert.equal(result.status, 'sent')
  assert.equal(calls[0][0], 'image')
  assert.equal(calls[0][2].mediaType, 'image/png')
})

test('平台明确拒绝时报告失败并记录状态，不返回已发送', async () => {
  const calls = []
  const host = hostWith({ cwd: 'C:/workspace' })
  const delivery = new FileDelivery(host, () => {})
  const channel = channelWith(calls, { sendFile: async () => { throw new FileDeliveryError('rejected', 'file-send-rejected') } })
  const result = await delivery.deliverPath({ sessionId: 's1', session: { id: 's1', header: { cwd: 'C:/workspace' } }, channel, chatId: 'c', path: 'report.txt', turn: 2, signal: new AbortController().signal })
  assert.equal(result.status, 'failed')
  assert.equal(delivery.deliveries()[0].status, 'rejected')
  assert.ok(calls.some(item => item[0] === 'text' && /未能发送/.test(item[2])))
})

test('超时或断连按结果未知处理，不自动重试', async () => {
  const calls = []
  const host = hostWith({ cwd: 'C:/workspace' })
  const delivery = new FileDelivery(host, () => {})
  const channel = channelWith(calls, { sendFile: async () => { throw new FileDeliveryError('unknown', 'file-send-timeout') } })
  const result = await delivery.deliverPath({ sessionId: 's1', session: { id: 's1', header: { cwd: 'C:/workspace' } }, channel, chatId: 'c', path: 'report.txt', turn: 2, signal: new AbortController().signal })
  assert.equal(result.status, 'unknown')
  assert.equal(delivery.deliveries()[0].status, 'unknown')
  assert.ok(calls.some(item => item[0] === 'text' && /结果未知/.test(item[2])))
})

test('文件交付结果持久化到记录文件', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-feishu-ledger-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const ledger = join(cwd, 'file-delivery.json')
  const host = hostWith({ cwd: 'C:/workspace' })
  const calls = []
  const channel = channelWith(calls)
  const first = new FileDelivery(host, () => {}, ledger)
  await first.deliverPath({ sessionId: 's1', session: { id: 's1', header: { cwd: 'C:/workspace' } }, channel, chatId: 'c', path: 'report.txt', turn: 1, signal: new AbortController().signal })
  const persisted = JSON.parse(await readFile(ledger, 'utf8'))
  assert.equal(persisted.version, 1)
  assert.equal(persisted.records[0].status, 'sent')
  const second = new FileDelivery(host, () => {}, ledger)
  assert.equal(second.deliveries()[0].name, 'report.txt')
  assert.equal(second.deliveries()[0].status, 'sent')
})

test('拒绝发送工作区外的文件', async () => {
  const calls = []
  const host = hostWith({ cwd: 'C:/workspace' })
  const delivery = new FileDelivery(host, () => {})
  const channel = channelWith(calls)
  const result = await delivery.deliverPath({ sessionId: 's1', session: { id: 's1', header: { cwd: 'C:/workspace' } }, channel, chatId: 'c', path: '../secret.txt', turn: 1, signal: new AbortController().signal })
  assert.equal(result.status, 'failed')
  assert.equal(calls.length, 0)
})

test('文件在交付前被删除时静默跳过', async () => {
  const calls = []
  const host = hostWith({ cwd: 'C:/workspace', fs: { lstat: async () => { throw Object.assign(new Error('gone'), { code: 'FS_NOT_FOUND' }) } } })
  const delivery = new FileDelivery(host, () => {})
  const channel = channelWith(calls)
  const result = await delivery.deliverPath({ sessionId: 's1', session: { id: 's1', header: { cwd: 'C:/workspace' } }, channel, chatId: 'c', path: 'gone.txt', turn: 1, signal: new AbortController().signal })
  assert.equal(result.status, 'missing')
  assert.equal(calls.length, 0)
})