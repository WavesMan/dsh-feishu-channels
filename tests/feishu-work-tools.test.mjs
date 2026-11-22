import test from 'node:test'
import assert from 'node:assert/strict'
import { ImEngine } from '../src/engine/gateway.js'

function makeEngine() {
  const store = {
    get: () => undefined, findSession: () => undefined, list: () => [],
    upsert() {}, updateSession() {}, saveHistory() {}, retain() {}, removeSession() {},
  }
  const config = { mergeTimeoutSecs: 0 }
  return new ImEngine({ get: () => undefined }, store, { has: () => false }, config, () => {}, () => {}, () => config, () => 'approved')
}

function toolsHarness() {
  const registered = new Map()
  return {
    registered,
    tools: { register: definition => registered.set(definition.name, definition), get: () => undefined },
  }
}

function agentFor(tools) {
  const sessionId = 'dfc:feishu:dm:1:oc_1'
  return { session: { id: sessionId }, id: sessionId, ctx: { tools } }
}

function channelWith(overrides = {}) {
  const calls = { tables: [], fields: [], records: [], taskList: [], taskGet: [], tasklistList: [], tasklistTasks: [] }
  return {
    id: 'feishu',
    calls,
    bitableGet: async () => ({ name: '工作 Base' }),
    bitableListTables: async () => ({ items: [{ table_id: 'tbl1', name: '任务表', revision: 1 }], hasMore: false, pageToken: '' }),
    bitableListFields: async (token, tableId, options) => {
      calls.fields.push({ token, tableId, options })
      return { items: [{ field_id: 'fld1', field_name: '状态', type: 3, ui_type: 'SingleSelect', property: { options: [{ name: '待处理' }] } }], hasMore: false, pageToken: '' }
    },
    bitableSearchRecords: async (token, tableId, options) => {
      calls.records.push({ token, tableId, options })
      return { items: [{ record_id: 'rec1', fields: { 标题: '周会', 状态: '待处理' } }], hasMore: false, pageToken: '', total: 1 }
    },
    taskList: async options => {
      calls.taskList.push(options)
      return { items: [{ guid: 'g1', summary: '准备周会', due: { timestamp: '1795000000', is_all_day: false }, members: [] }], hasMore: false, pageToken: '' }
    },
    taskGet: async guid => { calls.taskGet.push(guid); return { guid, summary: '任务详情', description: '准备材料' } },
    tasklistList: async options => { calls.tasklistList.push(options); return { items: [{ guid: 'tl1', name: '工作' }], hasMore: false, pageToken: '' } },
    tasklistTasks: async (guid, options) => {
      calls.tasklistTasks.push({ guid, options })
      return { items: [{ guid: 'g1', summary: '准备周会' }], hasMore: false, pageToken: '' }
    },
    ...overrides,
  }
}

function setup(channel) {
  const engine = makeEngine()
  if (channel)
    engine.channels.set('feishu', channel)
  const harness = toolsHarness()
  engine.registerAgentTools({ tools: harness.tools }, agentFor(harness.tools), 'feishu')
  return { engine, tool: name => harness.registered.get(name), harness }
}

const exec = { signal: new AbortController().signal }

test('读取多维表格概览并解析 Base 链接', async (t) => {
  const channel = channelWith()
  const { engine, tool } = setup(channel)
  t.after(() => engine.dispose())
  const result = await tool('feishu_bitable_overview').execute({ url: 'https://acme.feishu.cn/base/bascnABC?table=tbl1' }, exec)
  assert.equal(result.ok, true)
  assert.deepEqual(result.app, { app_token: 'bascnABC', name: '工作 Base' })
  assert.equal(result.tables[0].table_id, 'tbl1')
})

test('字段与记录查询使用 URL 中的 table_id，并收敛筛选与分页', async (t) => {
  const channel = channelWith()
  const { engine, tool } = setup(channel)
  t.after(() => engine.dispose())
  const url = 'https://acme.feishu.cn/base/bascnABC?table=tbl1&view=vew1'
  const fields = await tool('feishu_bitable_fields').execute({ url }, exec)
  assert.equal(fields.ok, true)
  assert.equal(channel.calls.fields[0].tableId, 'tbl1')
  assert.equal(channel.calls.fields[0].options.viewId, 'vew1')
  assert.deepEqual(fields.fields[0].options, ['待处理'])

  const records = await tool('feishu_bitable_records').execute({
    url,
    field_names: ['标题', '状态'],
    filter: { conjunction: 'and', conditions: [{ field_name: '状态', operator: 'isNot', value: ['已完成'] }, { field_name: 'x', operator: 'drop', value: ['y'] }] },
    sort: [{ field_name: '截止时间', desc: true }],
    page_size: 999,
  }, exec)
  assert.equal(records.ok, true)
  assert.equal(records.records[0].record_id, 'rec1')
  const options = channel.calls.records[0].options
  assert.deepEqual(options.fieldNames, ['标题', '状态'])
  assert.deepEqual(options.filter, { conjunction: 'and', conditions: [{ field_name: '状态', operator: 'isNot', value: ['已完成'] }] })
  assert.deepEqual(options.sort, [{ field_name: '截止时间', desc: true }])
  assert.equal(options.pageSize, 200)
})

test('非法链接不发起读取，并返回明确提示', async (t) => {
  const channel = channelWith()
  const { engine, tool } = setup(channel)
  t.after(() => engine.dispose())
  const result = await tool('feishu_bitable_records').execute({ url: 'https://evil.example/base/bascnABC' }, exec)
  assert.equal(result.ok, false)
  assert.match(result.error, /链接或 app_token/)
  assert.equal(channel.calls.records.length, 0)
})

test('非法筛选条件不静默退化为全表查询', async (t) => {
  const channel = channelWith()
  const { engine, tool } = setup(channel)
  t.after(() => engine.dispose())
  const result = await tool('feishu_bitable_records').execute({
    app_token: 'bascnABC', table_id: 'tbl1',
    filter: { conditions: [{ field_name: '状态', operator: 'dropTable', value: ['x'] }] },
  }, exec)
  assert.equal(result.ok, false)
  assert.match(result.error, /筛选条件格式/)
  assert.equal(channel.calls.records.length, 0)
})

test('应用权限错误映射为安全提示', async (t) => {
  const channel = channelWith({
    bitableSearchRecords: async () => { throw Object.assign(new Error('secret detail'), { platformCode: 99991672 }) },
    taskList: async () => { throw Object.assign(new Error('secret detail'), { response: { status: 403, data: { code: 0 } } }) },
  })
  const { engine, tool } = setup(channel)
  t.after(() => engine.dispose())
  const records = await tool('feishu_bitable_records').execute({ app_token: 'bascnABC', table_id: 'tbl1' }, exec)
  assert.equal(records.ok, false)
  assert.match(records.error, /缺少多维表格权限/)
  assert.ok(!records.error.includes('secret detail'))
  const tasks = await tool('feishu_task_list').execute({}, exec)
  assert.equal(tasks.ok, false)
  assert.match(tasks.error, /用户授权/)
  assert.ok(!tasks.error.includes('secret detail'))
})

test('读取任务、任务详情、清单与清单任务', async (t) => {
  const channel = channelWith()
  const { engine, tool } = setup(channel)
  t.after(() => engine.dispose())
  const tasks = await tool('feishu_task_list').execute({ completed: false, page_size: 10 }, exec)
  assert.equal(tasks.ok, true)
  assert.equal(tasks.tasks[0].task_guid, 'g1')
  assert.equal(channel.calls.taskList[0].completed, false)

  const detail = await tool('feishu_task_get').execute({ task_guid: 'g1' }, exec)
  assert.equal(detail.ok, true)
  assert.equal(detail.task.description, '准备材料')

  const lists = await tool('feishu_tasklist_list').execute({}, exec)
  assert.equal(lists.ok, true)
  assert.equal(lists.tasklists[0].tasklist_guid, 'tl1')

  const listTasks = await tool('feishu_tasklist_tasks').execute({ tasklist_guid: 'tl1', completed: true }, exec)
  assert.equal(listTasks.ok, true)
  assert.equal(listTasks.tasks[0].task_guid, 'g1')
  assert.equal(channel.calls.tasklistTasks[0].options.completed, true)
})

test('任务为空时明确说明应用身份范围', async (t) => {
  const channel = channelWith({
    taskList: async () => ({ items: [], hasMore: false, pageToken: '' }),
    tasklistList: async () => ({ items: [], hasMore: false, pageToken: '' }),
  })
  const { engine, tool } = setup(channel)
  t.after(() => engine.dispose())
  const tasks = await tool('feishu_task_list').execute({}, exec)
  assert.equal(tasks.ok, true)
  assert.match(tasks.notice, /用户授权/)
  const lists = await tool('feishu_tasklist_list').execute({}, exec)
  assert.equal(lists.ok, true)
  assert.match(lists.notice, /没有可读取的任务清单/)
})