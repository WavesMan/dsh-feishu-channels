import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BITABLE_MAX_PAGE_SIZE,
  BITABLE_PAGE_SIZE,
  bitableFailureLabel,
  clampPageSize,
  fieldView,
  normalizeFilter,
  normalizeSort,
  parseBaseTarget,
  platformCodeOf,
  recordView,
  resolveBitableTarget,
  taskFailureLabel,
  taskView,
  tasklistView,
  tableView,
} from '../src/engine/feishu-work.js'

test('解析飞书多维表格链接与 app_token', () => {
  assert.deepEqual(parseBaseTarget('https://acme.feishu.cn/base/bascnABC123?table=tbl1&view=vew1'), {
    appToken: 'bascnABC123', tableId: 'tbl1', viewId: 'vew1',
  })
  assert.deepEqual(parseBaseTarget('https://acme.larksuite.com/base/bascnABC123'), { appToken: 'bascnABC123', tableId: undefined, viewId: undefined })
  assert.deepEqual(parseBaseTarget('bascnABC123'), { appToken: 'bascnABC123' })
})

test('拒绝非飞书域名与 wiki 链接', () => {
  assert.equal(parseBaseTarget('https://evil.example/base/bascnABC123'), undefined)
  assert.equal(parseBaseTarget('https://acme.feishu.cn/wiki/wikcnABC'), undefined)
  assert.equal(parseBaseTarget('not a link'), undefined)
})

test('显式 app_token 优先，其次解析链接', () => {
  assert.deepEqual(resolveBitableTarget({ app_token: 'bascnTOKEN', url: 'https://acme.feishu.cn/base/bascnURL' }), { appToken: 'bascnTOKEN' })
  assert.deepEqual(resolveBitableTarget({ url: 'https://acme.feishu.cn/base/bascnURL?table=tbl' }), { appToken: 'bascnURL', tableId: 'tbl', viewId: undefined })
  assert.equal(resolveBitableTarget({}), undefined)
})

test('分页大小按上限收敛', () => {
  assert.equal(clampPageSize(undefined, BITABLE_PAGE_SIZE, BITABLE_MAX_PAGE_SIZE), 50)
  assert.equal(clampPageSize(999, BITABLE_PAGE_SIZE, BITABLE_MAX_PAGE_SIZE), 200)
  assert.equal(clampPageSize(10, BITABLE_PAGE_SIZE, BITABLE_MAX_PAGE_SIZE), 10)
  assert.equal(clampPageSize(-1, BITABLE_PAGE_SIZE, BITABLE_MAX_PAGE_SIZE), 50)
})

test('筛选只保留协议支持的字段与操作符', () => {
  assert.deepEqual(normalizeFilter({
    conjunction: 'and',
    conditions: [
      { field_name: '状态', operator: 'isNot', value: ['已完成'] },
      { field_name: '负责人', operator: 'contains', value: ['张三'] },
      { field_name: '', operator: 'is', value: ['x'] },
      { field_name: '状态', operator: 'dropTable', value: ['x'] },
    ],
    children: [
      { conjunction: 'or', conditions: [{ field_name: '优先级', operator: 'is', value: ['高'] }] },
      { conjunction: 'or', conditions: [] },
    ],
  }), {
    conjunction: 'and',
    conditions: [
      { field_name: '状态', operator: 'isNot', value: ['已完成'] },
      { field_name: '负责人', operator: 'contains', value: ['张三'] },
    ],
    children: [
      { conjunction: 'or', conditions: [{ field_name: '优先级', operator: 'is', value: ['高'] }] },
    ],
  })
  assert.equal(normalizeFilter({ conditions: [] }), undefined)
  assert.equal(normalizeFilter(null), undefined)
})

test('排序字段收敛', () => {
  assert.deepEqual(normalizeSort([
    { field_name: '截止时间', desc: true },
    { field_name: '优先级' },
    { field_name: '' },
    { field_name: 'a' }, { field_name: 'b' }, { field_name: 'c' }, { field_name: 'd' },
  ]), [
    { field_name: '截止时间', desc: true },
    { field_name: '优先级', desc: false },
    { field_name: 'a', desc: false },
    { field_name: 'b', desc: false },
  ])
})

test('字段视图保留类型与选项名', () => {
  assert.deepEqual(fieldView({
    field_id: 'fld1', field_name: '状态', type: 3, ui_type: 'SingleSelect',
    property: { options: [{ name: '待处理' }, { id: 'opt2' }, { name: '' }] },
  }), {
    field_id: 'fld1', field_name: '状态', type: 3, ui_type: 'SingleSelect', options: ['待处理', 'opt2'],
  })
  assert.deepEqual(tableView({ table_id: 'tbl1', name: '任务', revision: 2 }), { table_id: 'tbl1', name: '任务', revision: 2 })
})

test('记录视图压缩超长文本', () => {
  const long = 'x'.repeat(5_000)
  const record = recordView({
    record_id: 'rec1', created_time: 1, last_modified_time: 2,
    fields: { 标题: '任务', 描述: long, 附件: [{ name: 'a.pdf' }] },
  })
  assert.equal(record.record_id, 'rec1')
  assert.equal(record.fields.标题, '任务')
  assert.equal(record.fields.描述.endsWith('…'), true)
  assert.equal(record.fields.描述.length, 4_001)
  assert.deepEqual(record.fields.附件, [{ name: 'a.pdf' }])
})

test('任务与清单视图保留规划所需字段', () => {
  const task = taskView({
    guid: 'g1', summary: '准备周会', description: '整理进度', completed_at: '2026-11-20T00:00:00Z',
    due: { timestamp: '1795000000', is_all_day: true },
    creator: { id: 'ou_a', type: 'user', role: 'creator', name: '我' },
    members: [{ id: 'ou_a', type: 'user', role: 'assignee', name: '我' }],
    tasklists: [{ tasklist_guid: 'tl1' }],
    origin: { href: { url: 'https://applink.feishu.cn/task/g1' } },
  })
  assert.equal(task.task_guid, 'g1')
  assert.equal(task.completed, true)
  assert.equal(task.due.is_all_day, true)
  assert.equal(task.members[0].role, 'assignee')
  assert.equal(task.tasklists[0].tasklist_guid, 'tl1')
  assert.match(task.url, /g1/)
  assert.deepEqual(tasklistView({ guid: 'tl1', name: '工作', owner: { id: 'ou_a', type: 'user', role: 'owner', name: '我' }, url: 'https://x' }), {
    tasklist_guid: 'tl1', name: '工作',
    owner: { id: 'ou_a', type: 'user', role: 'owner', name: '我' },
    url: 'https://x',
  })
})

test('错误分类只输出安全文案', () => {
  const platform = (code, status) => ({ response: { status, data: { code } } })
  assert.equal(bitableFailureLabel({ name: 'TimeoutError' }), '读取超时或已取消')
  assert.match(bitableFailureLabel(platform(99991672, 403)), /缺少多维表格权限/)
  assert.match(bitableFailureLabel(platform(0, 403)), /协作者/)
  assert.match(bitableFailureLabel(platform(0, 404)), /不存在/)
  assert.match(bitableFailureLabel(platform(99991400, 429)), /限流/)
  assert.match(taskFailureLabel(platform(0, 403)), /用户授权/)
  assert.deepEqual(platformCodeOf(platform(99991672, 403)), { code: 99991672, status: 403 })
})