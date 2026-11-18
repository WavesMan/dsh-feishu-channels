import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentSaveError, AttachmentStore, MAX_ATTACHMENT_BYTES } from '../src/engine/attachment-store.js'

async function workspace() {
  return mkdtemp(join(tmpdir(), 'dsh-feishu-attachment-'))
}

function attachment(name = '项目需求.docx') {
  return { id: 'a'.repeat(16), kind: 'file', fileKey: 'k', name, sourceMessageId: 'om_1' }
}

test('附件保存到工作区固定目录并写入记录', async (t) => {
  const cwd = await workspace()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const store = new AttachmentStore()
  const record = await store.save({ cwd, channelId: 'feishu', chatId: 'oc_1', sourceMessageId: 'om_1', attachment: attachment(), download: async () => Buffer.from('hello') })
  assert.equal(record.status, 'done')
  assert.equal(record.bytes, 5)
  assert.equal(record.path, '.feishu/attachments/om_1/aaaaaaaaaaaaaaaa/项目需求.docx')
  assert.equal((await readFile(join(cwd, record.path), 'utf8')), 'hello')
  const records = JSON.parse(await readFile(join(cwd, '.feishu', 'attachments', 'records.json'), 'utf8'))
  assert.equal(records.version, 1)
  assert.equal(records.records[attachment().id].status, 'done')
})

test('重复下载复用已完成记录且不再请求资源', async (t) => {
  const cwd = await workspace()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const store = new AttachmentStore()
  let downloads = 0
  const download = async () => { downloads += 1; return Buffer.from('hello') }
  const first = await store.save({ cwd, channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_1', attachment: attachment(), download })
  const second = await store.save({ cwd, channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_1', attachment: attachment(), download })
  assert.equal(downloads, 1)
  assert.deepEqual(second, first)
})

test('记录存在但文件被移走后重新下载', async (t) => {
  const cwd = await workspace()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const store = new AttachmentStore()
  let downloads = 0
  const download = async () => { downloads += 1; return Buffer.from('hello') }
  const first = await store.save({ cwd, channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_1', attachment: attachment(), download })
  await rm(join(cwd, first.path))
  const second = await store.save({ cwd, channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_1', attachment: attachment(), download })
  assert.equal(downloads, 2)
  assert.equal((await stat(join(cwd, second.path))).isFile(), true)
})

test('同名附件按来源与附件目录隔离，不覆盖已有文件', async (t) => {
  const cwd = await workspace()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, '项目需求.docx'), 'workspace-own')
  const store = new AttachmentStore()
  const one = await store.save({ cwd, channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_1', attachment: attachment(), download: async () => Buffer.from('one') })
  const two = await store.save({ cwd, channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_2',
    attachment: { ...attachment(), id: 'b'.repeat(16), sourceMessageId: 'om_2' }, download: async () => Buffer.from('two') })
  assert.notEqual(one.path, two.path)
  assert.equal(await readFile(one.path ? join(cwd, one.path) : '', 'utf8'), 'one')
  assert.equal(await readFile(two.path ? join(cwd, two.path) : '', 'utf8'), 'two')
  assert.equal(await readFile(join(cwd, '项目需求.docx'), 'utf8'), 'workspace-own')
})

test('超出预算的文件不落盘也不返回可用路径', async (t) => {
  const cwd = await workspace()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const store = new AttachmentStore()
  await assert.rejects(
    store.save({ cwd, channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_1', attachment: attachment(), maxBytes: 4, download: async () => Buffer.from('hello') }),
    (error) => error instanceof AttachmentSaveError && error.reason === 'too-large',
  )
  const records = JSON.parse(await readFile(join(cwd, '.feishu', 'attachments', 'records.json'), 'utf8'))
  assert.equal(records.records[attachment().id].status, 'failed')
  assert.equal(records.records[attachment().id].path, undefined)
  await assert.rejects(stat(join(cwd, '.feishu', 'attachments', 'om_1', attachment().id, '项目需求.docx')))
})

test('下载失败记录原因并清理临时文件', async (t) => {
  const cwd = await workspace()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const store = new AttachmentStore(() => {})
  await assert.rejects(
    store.save({ cwd, channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_1', attachment: attachment(), download: async () => { throw new Error('network secret') } }),
    (error) => error instanceof AttachmentSaveError && error.reason === 'download-failed',
  )
  const records = JSON.parse(await readFile(join(cwd, '.feishu', 'attachments', 'records.json'), 'utf8'))
  assert.equal(records.records[attachment().id].status, 'failed')
  assert.equal(records.records[attachment().id].error, 'download-failed')
  const dir = join(cwd, '.feishu', 'attachments', 'om_1', attachment().id)
  const entries = await import('node:fs/promises').then(fs => fs.readdir(dir))
  assert.deepEqual(entries, [])
})

test('无文件名的图片按实际字节补扩展名', async (t) => {
  const cwd = await workspace()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const store = new AttachmentStore()
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('rest')])
  const record = await store.save({ cwd, channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_1',
    attachment: { id: 'c'.repeat(16), kind: 'image', imageKey: 'k', name: '' }, download: async () => png })
  assert.equal(record.name, `attachment-${'c'.repeat(16)}.png`)
  assert.match(record.path, /\.png$/)
})

test('资源端提前判定超限时按超限记录，不伪装成网络失败', async (t) => {
  const cwd = await workspace()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const store = new AttachmentStore()
  await assert.rejects(
    store.save({ cwd, channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_1', attachment: attachment(), download: async () => { throw new Error('resource-too-large') } }),
    (error) => error instanceof AttachmentSaveError && error.reason === 'too-large',
  )
  const records = JSON.parse(await readFile(join(cwd, '.feishu', 'attachments', 'records.json'), 'utf8'))
  assert.equal(records.records[attachment().id].error, 'too-large')
})

test('workspace 缺失时明确失败', async () => {
  const store = new AttachmentStore()
  await assert.rejects(
    store.save({ cwd: '', channelId: 'feishu', chatId: 'c', sourceMessageId: 'om_1', attachment: attachment(), download: async () => Buffer.from('x') }),
    (error) => error instanceof AttachmentSaveError && error.reason === 'workspace-unavailable',
  )
  assert.ok(MAX_ATTACHMENT_BYTES === 20 * 1024 * 1024)
})