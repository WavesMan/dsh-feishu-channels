import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeferredDelivery } from '../src/engine/deferred-delivery.js'

test('交付记录保留触发消息、话题与合并来源', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-feishu-deferred-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const file = join(cwd, 'deferred.json')
  const deferred = new DeferredDelivery(file)
  deferred.begin('req-1', 'dfc:feishu:dm:1:oc_1', 'feishu', {
    chatId: 'oc_1', userId: 'ou_a', kind: 'group', messageId: 'om_trigger', threadId: 'thread_1',
    sources: [
      { messageId: 'om_1', userId: 'ou_a', createTime: 1, threadId: 'thread_1', text: '不应保存的正文' },
      { messageId: 'om_2', userId: 'ou_b', createTime: 2, threadId: '' },
    ],
  })
  const [entry] = deferred.list('feishu', { chatId: 'oc_1', userId: 'ou_a', kind: 'group' })
  assert.equal(entry.message.messageId, 'om_trigger')
  assert.equal(entry.message.threadId, 'thread_1')
  assert.deepEqual(entry.message.sources.map(item => item.messageId), ['om_1', 'om_2'])
  assert.deepEqual(entry.message.sources.map(item => item.userId), ['ou_a', 'ou_b'])
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.entries[0].message.messageId, 'om_trigger')
  assert.equal(JSON.stringify(persisted).includes('不应保存的正文'), false)
})