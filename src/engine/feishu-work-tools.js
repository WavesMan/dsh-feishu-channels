/**
 * 飞书工作读取工具：多维表格与任务，只使用应用身份（tenant token）。
 *
 * 工具返回结构化数据供 Agent 做工作规划；不写表格、不改任务，也不做用户 OAuth。
 */
import {
    BITABLE_MAX_PAGE_SIZE,
    BITABLE_META_MAX_PAGE_SIZE,
    BITABLE_PAGE_SIZE,
    EMPTY_TASKLIST_NOTICE,
    EMPTY_TASK_NOTICE,
    TASK_MAX_PAGE_SIZE,
    TASK_PAGE_SIZE,
    bitableFailureLabel,
    clampPageSize,
    fieldView,
    normalizeFilter,
    normalizeSort,
    pageTokenOf,
    platformCodeOf,
    recordView,
    resolveBitableTarget,
    taskFailureLabel,
    taskView,
    tasklistView,
    tableView,
} from './feishu-work.js'

const textRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function objectSchema(properties, required = ['ok']) {
    return {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, ...properties },
        required,
    }
}

const memberSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        id: { type: 'string' }, type: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' },
    },
    required: ['id', 'type', 'role', 'name'],
}

const tableSchema = {
    type: 'object', additionalProperties: false,
    properties: { table_id: { type: 'string' }, name: { type: 'string' }, revision: { type: 'integer' } },
    required: ['table_id', 'name'],
}

const fieldSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        field_id: { type: 'string' }, field_name: { type: 'string' }, type: { type: 'integer' },
        ui_type: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
    },
    required: ['field_id', 'field_name', 'type'],
}

const recordSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        record_id: { type: 'string' }, fields: { type: 'object' },
        created_time: { type: 'integer' }, last_modified_time: { type: 'integer' },
    },
    required: ['record_id', 'fields'],
}

const taskSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        task_guid: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' },
        completed: { type: 'boolean' }, completed_at: { type: 'string' },
        due: { type: 'object', additionalProperties: false, properties: { timestamp: { type: 'string' }, is_all_day: { type: 'boolean' } }, required: ['timestamp', 'is_all_day'] },
        creator: memberSchema, members: { type: 'array', items: memberSchema },
        tasklists: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { tasklist_guid: { type: 'string' } }, required: ['tasklist_guid'] } },
        parent_task_guid: { type: 'string' }, url: { type: 'string' },
    },
    required: ['task_guid', 'summary'],
}

const tasklistSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        tasklist_guid: { type: 'string' }, name: { type: 'string' }, owner: memberSchema,
        members: { type: 'array', items: memberSchema }, url: { type: 'string' },
        created_at: { type: 'string' }, updated_at: { type: 'string' },
    },
    required: ['tasklist_guid', 'name'],
}

const appSchema = {
    type: 'object', additionalProperties: false,
    properties: { app_token: { type: 'string' }, name: { type: 'string' } },
    required: ['app_token'],
}

const baseParameters = {
    url: { type: 'string', description: '飞书多维表格链接，形如 https://xxx.feishu.cn/base/<app_token>?table=<table_id>。' },
    app_token: { type: 'string', description: 'Base 的 app_token；与 url 二选一。' },
    page_size: { type: 'integer', description: '每页条数；多维表格默认 50、最多 200。' },
    page_token: { type: 'string', description: '上一页返回的分页令牌。' },
}

/**
 * @param {{ channelId: string, resolveChannel: () => object|undefined, log: (line: string) => void }} options
 * @returns {object[]} Agent 作用域内的工具定义
 */
export function createFeishuWorkTools({ channelId, resolveChannel, log = () => { } }) {
    const run = async (failureLabel, task) => {
        const channel = resolveChannel()
        if (!channel)
            return { ok: false, error: '当前频道不可用' }
        try {
            return await task(channel)
        }
        catch (error) {
            const codes = platformCodeOf(error)
            log(`[${channelId}] 工作数据读取失败${codes.code ? ` code=${codes.code}` : ''}${codes.status ? ` http=${codes.status}` : ''}`)
            return { ok: false, error: failureLabel(error) }
        }
    }
    const targetOf = (args) => resolveBitableTarget(args ?? {})
    const tableOf = (args, target) => {
        const tableId = typeof args?.table_id === 'string' ? args.table_id.trim() : target?.tableId
        return tableId || ''
    }
    return [
        {
            name: 'feishu_bitable_overview',
            description: '读取一个飞书多维表格的基础信息与数据表列表。需要 Base 链接或 app_token；应用必须已被添加为该 Base 的协作者（应用身份，不是用户身份）。先用它确认 table_id。',
            parameters: {
                type: 'object', additionalProperties: false,
                properties: { ...baseParameters },
                required: [],
            },
            output: {
                schema: objectSchema({
                    app: appSchema,
                    tables: { type: 'array', items: tableSchema },
                    has_more: { type: 'boolean' },
                    page_token: { type: 'string' },
                }),
                render: textRender,
            },
            async execute(args, exec) {
                return run(bitableFailureLabel, async channel => {
                    const target = targetOf(args)
                    if (!target)
                        return { ok: false, error: '请提供飞书多维表格链接或 app_token' }
                    const app = await channel.bitableGet(target.appToken, exec.signal)
                    const page = await channel.bitableListTables(target.appToken, {
                        pageSize: clampPageSize(args?.page_size, BITABLE_PAGE_SIZE, BITABLE_META_MAX_PAGE_SIZE),
                        pageToken: pageTokenOf(args?.page_token),
                    }, exec.signal)
                    return {
                        ok: true,
                        app: { app_token: target.appToken, ...(typeof app?.name === 'string' && app.name ? { name: app.name } : {}) },
                        tables: page.items.map(tableView),
                        has_more: page.hasMore,
                        ...(page.pageToken ? { page_token: page.pageToken } : {}),
                    }
                })
            },
        },
        {
            name: 'feishu_bitable_fields',
            description: '列出多维表格数据表的字段、类型与选项。先用它确认字段名，再按字段筛选记录。应用身份只读。',
            parameters: {
                type: 'object', additionalProperties: false,
                properties: {
                    ...baseParameters,
                    table_id: { type: 'string', description: '数据表 ID；可省略，若 Base 链接带 table 参数则自动使用。' },
                    view_id: { type: 'string', description: '可选视图 ID。' },
                },
                required: [],
            },
            output: {
                schema: objectSchema({
                    table_id: { type: 'string' },
                    fields: { type: 'array', items: fieldSchema },
                    has_more: { type: 'boolean' },
                    page_token: { type: 'string' },
                }),
                render: textRender,
            },
            async execute(args, exec) {
                return run(bitableFailureLabel, async channel => {
                    const target = targetOf(args)
                    if (!target)
                        return { ok: false, error: '请提供飞书多维表格链接或 app_token' }
                    const tableId = tableOf(args, target)
                    if (!tableId)
                        return { ok: false, error: '请提供 table_id，或在 Base 链接中带 table 参数' }
                    const page = await channel.bitableListFields(target.appToken, tableId, {
                        viewId: typeof args?.view_id === 'string' ? args.view_id : target.viewId,
                        pageSize: clampPageSize(args?.page_size, BITABLE_PAGE_SIZE, BITABLE_META_MAX_PAGE_SIZE),
                        pageToken: pageTokenOf(args?.page_token),
                    }, exec.signal)
                    return {
                        ok: true, table_id: tableId,
                        fields: page.items.map(fieldView),
                        has_more: page.hasMore,
                        ...(page.pageToken ? { page_token: page.pageToken } : {}),
                    }
                })
            },
        },
        {
            name: 'feishu_bitable_records',
            description: '读取多维表格记录，支持字段选择、视图、筛选、排序与分页。只读；应用身份只能访问已被授权为协作者的 Base。',
            parameters: {
                type: 'object', additionalProperties: false,
                properties: {
                    ...baseParameters,
                    table_id: { type: 'string', description: '数据表 ID；可省略，若 Base 链接带 table 参数则自动使用。' },
                    view_id: { type: 'string', description: '可选视图 ID。' },
                    field_names: { type: 'array', items: { type: 'string' }, description: '只返回这些字段；省略返回全部字段。' },
                    filter: { type: 'object', description: '飞书筛选条件：{ conjunction, conditions: [{ field_name, operator, value }], children? }。' },
                    sort: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { field_name: { type: 'string' }, desc: { type: 'boolean' } }, required: ['field_name'] }, description: '排序字段，最多 5 个。' },
                },
                required: [],
            },
            output: {
                schema: objectSchema({
                    table_id: { type: 'string' },
                    records: { type: 'array', items: recordSchema },
                    has_more: { type: 'boolean' },
                    page_token: { type: 'string' },
                    total: { type: 'integer' },
                }),
                render: textRender,
            },
            async execute(args, exec) {
                return run(bitableFailureLabel, async channel => {
                    const target = targetOf(args)
                    if (!target)
                        return { ok: false, error: '请提供飞书多维表格链接或 app_token' }
                    const tableId = tableOf(args, target)
                    if (!tableId)
                        return { ok: false, error: '请提供 table_id，或在 Base 链接中带 table 参数' }
                    const fieldNames = (Array.isArray(args?.field_names) ? args.field_names : [])
                        .filter(item => typeof item === 'string' && item.trim())
                        .slice(0, 100)
                    const filter = normalizeFilter(args?.filter)
                    if (args?.filter && !filter)
                        return { ok: false, error: '筛选条件格式无法识别，请使用 field_name、operator 和 value 数组' }
                    const sort = normalizeSort(args?.sort)
                    if (args?.sort && !sort)
                        return { ok: false, error: '排序条件格式无法识别，请使用 field_name 和 desc' }
                    const page = await channel.bitableSearchRecords(target.appToken, tableId, {
                        viewId: typeof args?.view_id === 'string' ? args.view_id : target.viewId,
                        fieldNames,
                        filter,
                        sort,
                        pageSize: clampPageSize(args?.page_size, BITABLE_PAGE_SIZE, BITABLE_MAX_PAGE_SIZE),
                        pageToken: pageTokenOf(args?.page_token),
                    }, exec.signal)
                    return {
                        ok: true, table_id: tableId,
                        records: page.items.map(recordView),
                        has_more: page.hasMore,
                        ...(page.pageToken ? { page_token: page.pageToken } : {}),
                        ...(Number.isSafeInteger(page.total) ? { total: page.total } : {}),
                    }
                })
            },
        },
        {
            name: 'feishu_task_list',
            description: '以应用身份列出可读取的任务。应用身份通常只能看到应用参与或被共享的任务；个人任务中心的数据需要用户授权，当前版本未启用。',
            parameters: {
                type: 'object', additionalProperties: false,
                properties: {
                    completed: { type: 'boolean', description: '只看已完成或未完成任务；省略返回全部。' },
                    page_size: { type: 'integer', description: '每页条数；默认 50、最多 100。' },
                    page_token: { type: 'string', description: '上一页返回的分页令牌。' },
                },
                required: [],
            },
            output: {
                schema: objectSchema({
                    tasks: { type: 'array', items: taskSchema },
                    has_more: { type: 'boolean' },
                    page_token: { type: 'string' },
                    notice: { type: 'string' },
                }),
                render: textRender,
            },
            async execute(args, exec) {
                return run(taskFailureLabel, async channel => {
                    const page = await channel.taskList({
                        completed: typeof args?.completed === 'boolean' ? args.completed : undefined,
                        pageSize: clampPageSize(args?.page_size, TASK_PAGE_SIZE, TASK_MAX_PAGE_SIZE),
                        pageToken: pageTokenOf(args?.page_token),
                    }, exec.signal)
                    return {
                        ok: true,
                        tasks: page.items.map(taskView),
                        has_more: page.hasMore,
                        ...(page.pageToken ? { page_token: page.pageToken } : {}),
                        ...(page.items.length ? {} : { notice: EMPTY_TASK_NOTICE }),
                    }
                })
            },
        },
        {
            name: 'feishu_task_get',
            description: '读取单个飞书任务的详情。需要应用对该任务有读取权限；只读。',
            parameters: {
                type: 'object', additionalProperties: false,
                properties: { task_guid: { type: 'string', description: '任务 GUID。' } },
                required: ['task_guid'],
            },
            output: {
                schema: objectSchema({ task: taskSchema }),
                render: textRender,
            },
            async execute(args, exec) {
                return run(taskFailureLabel, async channel => {
                    const taskGuid = typeof args?.task_guid === 'string' ? args.task_guid.trim() : ''
                    if (!taskGuid)
                        return { ok: false, error: '需要 task_guid' }
                    const task = await channel.taskGet(taskGuid, exec.signal)
                    if (!task)
                        return { ok: false, error: '任务不存在或应用无权访问' }
                    return { ok: true, task: taskView(task) }
                })
            },
        },
        {
            name: 'feishu_tasklist_list',
            description: '列出应用身份可读取的飞书任务清单。个人清单通常需要用户授权，当前版本未启用。',
            parameters: {
                type: 'object', additionalProperties: false,
                properties: {
                    page_size: { type: 'integer', description: '每页条数；默认 50、最多 100。' },
                    page_token: { type: 'string', description: '上一页返回的分页令牌。' },
                },
                required: [],
            },
            output: {
                schema: objectSchema({
                    tasklists: { type: 'array', items: tasklistSchema },
                    has_more: { type: 'boolean' },
                    page_token: { type: 'string' },
                    notice: { type: 'string' },
                }),
                render: textRender,
            },
            async execute(args, exec) {
                return run(taskFailureLabel, async channel => {
                    const page = await channel.tasklistList({
                        pageSize: clampPageSize(args?.page_size, TASK_PAGE_SIZE, TASK_MAX_PAGE_SIZE),
                        pageToken: pageTokenOf(args?.page_token),
                    }, exec.signal)
                    return {
                        ok: true,
                        tasklists: page.items.map(tasklistView),
                        has_more: page.hasMore,
                        ...(page.pageToken ? { page_token: page.pageToken } : {}),
                        ...(page.items.length ? {} : { notice: EMPTY_TASKLIST_NOTICE }),
                    }
                })
            },
        },
        {
            name: 'feishu_tasklist_tasks',
            description: '列出飞书任务清单中的任务。需要应用对该清单有读取权限；只读。',
            parameters: {
                type: 'object', additionalProperties: false,
                properties: {
                    tasklist_guid: { type: 'string', description: '任务清单 GUID。' },
                    completed: { type: 'boolean', description: '只看已完成或未完成任务；省略返回全部。' },
                    page_size: { type: 'integer', description: '每页条数；默认 50、最多 100。' },
                    page_token: { type: 'string', description: '上一页返回的分页令牌。' },
                },
                required: ['tasklist_guid'],
            },
            output: {
                schema: objectSchema({
                    tasklist_guid: { type: 'string' },
                    tasks: { type: 'array', items: taskSchema },
                    has_more: { type: 'boolean' },
                    page_token: { type: 'string' },
                }),
                render: textRender,
            },
            async execute(args, exec) {
                return run(taskFailureLabel, async channel => {
                    const tasklistGuid = typeof args?.tasklist_guid === 'string' ? args.tasklist_guid.trim() : ''
                    if (!tasklistGuid)
                        return { ok: false, error: '需要 tasklist_guid' }
                    const page = await channel.tasklistTasks(tasklistGuid, {
                        completed: typeof args?.completed === 'boolean' ? args.completed : undefined,
                        pageSize: clampPageSize(args?.page_size, TASK_PAGE_SIZE, TASK_MAX_PAGE_SIZE),
                        pageToken: pageTokenOf(args?.page_token),
                    }, exec.signal)
                    return {
                        ok: true, tasklist_guid: tasklistGuid,
                        tasks: page.items.map(taskView),
                        has_more: page.hasMore,
                        ...(page.pageToken ? { page_token: page.pageToken } : {}),
                    }
                })
            },
        },
    ]
}