import test from 'node:test'
import assert from 'node:assert/strict'
import { createFeishuChannel } from '../src/channels/feishu.js'

function sdkFor(calls) {
  let failCode
  const clientShape = {
    bitable: {
      app: {
        get: async payload => { calls.push(['bitable.app.get', payload]); return { code: 0, data: { app: { name: '工作 Base' } } } },
      },
      appTable: {
        list: async payload => {
          calls.push(['bitable.appTable.list', payload])
          if (failCode !== undefined) return { code: failCode }
          return { code: 0, data: { items: [{ table_id: 'tbl1', name: '任务表', revision: 1 }], has_more: false } }
        },
      },
      appTableField: {
        list: async payload => {
          calls.push(['bitable.appTableField.list', payload])
          return { code: 0, data: { items: [{ field_id: 'fld1', field_name: '状态', type: 3 }], has_more: true, page_token: 'p2' } }
        },
      },
      appTableRecord: {
        search: async payload => {
          calls.push(['bitable.appTableRecord.search', payload])
          return { code: 0, data: { items: [{ record_id: 'rec1', fields: { 标题: '周会' } }], has_more: false, total: 1 } }
        },
      },
    },
    task: {
      v2: {
        task: {
          list: async payload => { calls.push(['task.list', payload]); return { code: 0, data: { items: [{ guid: 'g1', summary: '准备周会' }], has_more: false } } },
          get: async payload => { calls.push(['task.get', payload]); return { code: 0, data: { task: { guid: 'g1', summary: '准备周会' } } } },
        },
        tasklist: {
          list: async payload => { calls.push(['tasklist.list', payload]); return { code: 0, data: { items: [{ guid: 'tl1', name: '工作' }], has_more: false } } },
          tasks: async payload => { calls.push(['tasklist.tasks', payload]); return { code: 0, data: { items: [{ guid: 'g1', summary: '准备周会' }], has_more: false } } },
        },
      },
    },
  }
  return {
    fail(code) { failCode = code },
    sdk: {
      defaultHttpInstance: {},
      Client: class {
        request = async () => ({ bot: { open_id: 'bot' } })
        bitable = clientShape.bitable
        task = clientShape.task
      },
      EventDispatcher: class { register() { return this } },
      WSClient: class { async start() {} close() {} },
    },
  }
}

test('频道以应用身份调用多维表格与任务接口', async (t) => {
  const calls = []
  const harness = sdkFor(calls)
  const channel = createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => harness.sdk)
  await channel.start()
  t.after(() => channel.stop())

  const app = await channel.bitableGet('bascnABC')
  assert.equal(app.name, '工作 Base')

  const tables = await channel.bitableListTables('bascnABC', { pageSize: 50 })
  assert.equal(tables.items[0].table_id, 'tbl1')
  assert.deepEqual(calls.find(([name]) => name === 'bitable.appTable.list')[1], {
    path: { app_token: 'bascnABC' }, params: { page_size: 50 },
  })

  const fields = await channel.bitableListFields('bascnABC', 'tbl1', { viewId: 'vew1', pageSize: 20, pageToken: 'p1' })
  assert.equal(fields.hasMore, true)
  assert.equal(fields.pageToken, 'p2')
  assert.deepEqual(calls.find(([name]) => name === 'bitable.appTableField.list')[1], {
    path: { app_token: 'bascnABC', table_id: 'tbl1' }, params: { view_id: 'vew1', page_size: 20, page_token: 'p1' },
  })

  const records = await channel.bitableSearchRecords('bascnABC', 'tbl1', {
    viewId: 'vew1', fieldNames: ['标题'], filter: { conjunction: 'and', conditions: [{ field_name: '状态', operator: 'isNot', value: ['已完成'] }] },
    sort: [{ field_name: '截止时间', desc: true }], pageSize: 30, pageToken: 'r1',
  })
  assert.equal(records.items[0].record_id, 'rec1')
  assert.equal(records.total, 1)
  assert.deepEqual(calls.find(([name]) => name === 'bitable.appTableRecord.search')[1], {
    path: { app_token: 'bascnABC', table_id: 'tbl1' },
    params: { user_id_type: 'open_id', page_size: 30, page_token: 'r1' },
    data: {
      view_id: 'vew1', field_names: ['标题'],
      filter: { conjunction: 'and', conditions: [{ field_name: '状态', operator: 'isNot', value: ['已完成'] }] },
      sort: [{ field_name: '截止时间', desc: true }],
    },
  })

  const tasks = await channel.taskList({ completed: false, pageSize: 20 })
  assert.equal(tasks.items[0].guid, 'g1')
  assert.deepEqual(calls.find(([name]) => name === 'task.list')[1], {
    params: { user_id_type: 'open_id', page_size: 20, page_token: undefined, completed: false },
  })

  assert.equal((await channel.taskGet('g1')).summary, '准备周会')
  assert.equal((await channel.tasklistList({ pageSize: 10 })).items[0].guid, 'tl1')
  assert.equal((await channel.tasklistTasks('tl1', { completed: true })).items[0].guid, 'g1')
  assert.deepEqual(calls.find(([name]) => name === 'tasklist.tasks')[1], {
    path: { tasklist_guid: 'tl1' }, params: { user_id_type: 'open_id', page_size: 50, page_token: undefined, completed: true },
  })
})

test('业务码拒绝保留平台码，供工具映射安全提示', async (t) => {
  const calls = []
  const harness = sdkFor(calls)
  const channel = createFeishuChannel('feishu', { appId: 'app', appSecret: 'secret' }, () => {}, async () => harness.sdk)
  await channel.start()
  t.after(() => channel.stop())
  harness.fail(99991672)
  await assert.rejects(channel.bitableListTables('bascnABC'), error => error.platformCode === 99991672)
})