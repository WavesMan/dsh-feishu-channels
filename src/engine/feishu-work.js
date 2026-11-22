/**
 * 飞书工作数据（多维表格 / 任务）的链接解析、结果收敛与错误分类。
 *
 * 只处理应用身份可访问的数据：本模块不发起请求、不持有凭据，也不做用户 OAuth。
 */
const MAX_TEXT = 4_000
const MAX_ARRAY = 50
const MAX_DEPTH = 3
const MAX_FILTER_CONDITIONS = 20
const MAX_FILTER_CHILDREN = 5
const MAX_SORT_FIELDS = 5

export const BITABLE_PAGE_SIZE = 50
export const BITABLE_MAX_PAGE_SIZE = 200
export const BITABLE_META_MAX_PAGE_SIZE = 100
export const TASK_PAGE_SIZE = 50
export const TASK_MAX_PAGE_SIZE = 100

export const EMPTY_TASK_NOTICE = '应用身份没有可读取的任务。个人任务中心的数据需要用户授权，当前版本未启用。'
export const EMPTY_TASKLIST_NOTICE = '应用身份没有可读取的任务清单。'

const BASE_HOSTS = ['feishu.cn', 'larksuite.com']
const OPERATORS = new Set([
    'is', 'isNot', 'contains', 'doesNotContain', 'isEmpty', 'isNotEmpty',
    'isGreater', 'isGreaterEqual', 'isLess', 'isLessEqual', 'like', 'in',
])

function truncate(value, max = MAX_TEXT) {
    return typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value
}

function compact(value, depth = 0) {
    if (typeof value === 'string')
        return truncate(value)
    if (value === null || typeof value === 'number' || typeof value === 'boolean')
        return value
    if (Array.isArray(value))
        return value.slice(0, MAX_ARRAY).map(item => compact(item, depth + 1))
    if (value && typeof value === 'object') {
        if (depth >= MAX_DEPTH) {
            try {
                return truncate(JSON.stringify(value))
            }
            catch {
                return '[无法序列化]'
            }
        }
        return Object.fromEntries(Object.entries(value).slice(0, MAX_ARRAY)
            .map(([key, item]) => [key, compact(item, depth + 1)]))
    }
    return String(value)
}

function tokenLike(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{6,}$/.test(value.trim())
}

/** 从 Base 链接或 app_token 解析目标；只接受飞书/Lark 域名。 */
export function parseBaseTarget(input) {
    const raw = typeof input === 'string' ? input.trim() : ''
    if (!raw)
        return undefined
    if (tokenLike(raw))
        return { appToken: raw }
    let url
    try {
        url = new URL(raw)
    }
    catch {
        return undefined
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        return undefined
    const host = url.hostname.toLowerCase()
    if (!BASE_HOSTS.some(suffix => host === suffix || host.endsWith(`.${suffix}`)))
        return undefined
    const match = /\/base\/([A-Za-z0-9_-]+)/.exec(url.pathname)
    if (!match)
        return undefined
    return {
        appToken: match[1],
        tableId: url.searchParams.get('table') || undefined,
        viewId: url.searchParams.get('view') || undefined,
    }
}

/** 优先使用显式 app_token，其次解析 Base 链接。 */
export function resolveBitableTarget(args) {
    const token = typeof args?.app_token === 'string' ? args.app_token.trim() : ''
    if (token)
        return parseBaseTarget(token) ?? parseBaseTarget(args?.url)
    return parseBaseTarget(args?.url)
}

export function clampPageSize(value, fallback, max) {
    const size = Number(value)
    return Number.isSafeInteger(size) && size > 0 ? Math.min(size, max) : fallback
}

export function pageTokenOf(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeCondition(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined
    const field = typeof value.field_name === 'string' ? value.field_name.trim() : ''
    if (!field || !OPERATORS.has(value.operator))
        return undefined
    const values = (Array.isArray(value.value) ? value.value : [])
        .filter(item => typeof item === 'string' || typeof item === 'number')
        .slice(0, MAX_FILTER_CONDITIONS)
        .map(String)
    return { field_name: field, operator: value.operator, ...(values.length ? { value: values } : {}) }
}

/** 只保留飞书筛选协议支持的字段与操作符，避免把任意对象透传给上游。 */
export function normalizeFilter(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return undefined
    const conjunction = input.conjunction === 'or' ? 'or' : 'and'
    const conditions = (Array.isArray(input.conditions) ? input.conditions : [])
        .map(normalizeCondition).filter(Boolean).slice(0, MAX_FILTER_CONDITIONS)
    const children = (Array.isArray(input.children) ? input.children : [])
        .slice(0, MAX_FILTER_CHILDREN)
        .map(child => {
            if (!child || typeof child !== 'object')
                return undefined
            const childConditions = (Array.isArray(child.conditions) ? child.conditions : [])
                .map(normalizeCondition).filter(Boolean).slice(0, MAX_FILTER_CONDITIONS)
            if (!childConditions.length)
                return undefined
            return { conjunction: child.conjunction === 'or' ? 'or' : 'and', conditions: childConditions }
        })
        .filter(Boolean)
    if (!conditions.length && !children.length)
        return undefined
    return { conjunction, ...(conditions.length ? { conditions } : {}), ...(children.length ? { children } : {}) }
}

export function normalizeSort(input) {
    if (!Array.isArray(input))
        return undefined
    const sort = input.slice(0, MAX_SORT_FIELDS).map(item => {
        if (!item || typeof item !== 'object')
            return undefined
        const field = typeof item.field_name === 'string' ? item.field_name.trim() : ''
        return field ? { field_name: field, desc: item.desc === true } : undefined
    }).filter(Boolean)
    return sort.length ? sort : undefined
}

function memberView(member) {
    return {
        id: String(member?.id ?? ''),
        type: String(member?.type ?? ''),
        role: String(member?.role ?? ''),
        name: typeof member?.name === 'string' ? truncate(member.name, 200) : '',
    }
}

export function tableView(table) {
    return {
        table_id: String(table?.table_id ?? ''),
        name: truncate(String(table?.name ?? ''), 200),
        ...(Number.isSafeInteger(table?.revision) ? { revision: table.revision } : {}),
    }
}

export function fieldView(field) {
    const property = field?.property ?? {}
    const options = (Array.isArray(property?.options) ? property.options : [])
        .map(option => typeof option?.name === 'string' ? option.name : option?.id)
        .filter(Boolean).slice(0, MAX_ARRAY)
    return {
        field_id: String(field?.field_id ?? ''),
        field_name: truncate(String(field?.field_name ?? ''), 200),
        type: Number.isSafeInteger(field?.type) ? field.type : 0,
        ...(typeof field?.ui_type === 'string' ? { ui_type: field.ui_type } : {}),
        ...(options.length ? { options } : {}),
    }
}

export function recordView(record) {
    return {
        record_id: String(record?.record_id ?? ''),
        fields: compact(record?.fields ?? {}),
        ...(Number.isSafeInteger(record?.created_time) ? { created_time: record.created_time } : {}),
        ...(Number.isSafeInteger(record?.last_modified_time) ? { last_modified_time: record.last_modified_time } : {}),
    }
}

export function taskView(task) {
    const due = task?.due
    const href = task?.origin?.href?.url
    return {
        task_guid: String(task?.guid ?? ''),
        summary: truncate(String(task?.summary ?? ''), 200),
        description: truncate(String(task?.description ?? '')),
        completed: Boolean(task?.completed_at),
        ...(task?.completed_at ? { completed_at: String(task.completed_at) } : {}),
        ...(due ? { due: { timestamp: String(due.timestamp ?? ''), is_all_day: due.is_all_day === true } } : {}),
        ...(task?.creator ? { creator: memberView(task.creator) } : {}),
        ...(Array.isArray(task?.members) ? { members: task.members.slice(0, MAX_ARRAY).map(memberView) } : {}),
        ...(Array.isArray(task?.tasklists) ? { tasklists: task.tasklists.slice(0, 20).map(item => ({ tasklist_guid: String(item?.tasklist_guid ?? '') })) } : {}),
        ...(task?.parent_task_guid ? { parent_task_guid: String(task.parent_task_guid) } : {}),
        ...(typeof href === 'string' && href ? { url: truncate(href, 500) } : {}),
    }
}

export function tasklistView(tasklist) {
    return {
        tasklist_guid: String(tasklist?.guid ?? ''),
        name: truncate(String(tasklist?.name ?? ''), 200),
        ...(tasklist?.owner ? { owner: memberView(tasklist.owner) } : {}),
        ...(Array.isArray(tasklist?.members) ? { members: tasklist.members.slice(0, MAX_ARRAY).map(memberView) } : {}),
        ...(typeof tasklist?.url === 'string' && tasklist.url ? { url: truncate(tasklist.url, 500) } : {}),
        ...(tasklist?.created_at ? { created_at: String(tasklist.created_at) } : {}),
        ...(tasklist?.updated_at ? { updated_at: String(tasklist.updated_at) } : {}),
    }
}

/** 只提取安全的状态码，供日志使用；不返回上游响应正文。 */
export function platformCodeOf(error) {
    const code = Number(error?.response?.data?.code ?? error?.platformCode)
    const status = Number(error?.response?.status)
    return {
        ...(Number.isFinite(code) ? { code } : {}),
        ...(Number.isFinite(status) ? { status } : {}),
    }
}

function failureCategory(error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
        return 'timeout'
    const { code, status } = platformCodeOf(error)
    if (code === 99991672)
        return 'scope'
    if (status === 403)
        return 'forbidden'
    if (status === 404 || code === 230002)
        return 'not-found'
    if (status === 429 || code === 99991400 || code === 230020)
        return 'throttled'
    return 'unknown'
}

export function bitableFailureLabel(error) {
    switch (failureCategory(error)) {
        case 'timeout': return '读取超时或已取消'
        case 'scope': return '应用缺少多维表格权限，或新权限尚未发布生效'
        case 'forbidden': return '应用不是该多维表格的协作者，或文档权限未生效'
        case 'not-found': return '多维表格或数据表不存在，或应用无权访问'
        case 'throttled': return '平台限流，请稍后重试'
        default: return '读取多维表格失败，请检查应用权限与资源授权'
    }
}

export function taskFailureLabel(error) {
    switch (failureCategory(error)) {
        case 'timeout': return '读取超时或已取消'
        case 'scope': return '应用缺少任务读取权限，或新权限尚未发布生效'
        case 'forbidden': return '应用没有该任务或清单的读取权限；个人任务通常需要用户授权'
        case 'not-found': return '任务或清单不存在，或应用无权访问'
        case 'throttled': return '平台限流，请稍后重试'
        default: return '读取任务失败，请检查应用权限'
    }
}