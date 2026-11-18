/**
 * 飞书附件改为工作区路径输入：插件只把已落盘文件的相对路径与失败原因
 * 交给 DSH，不再把字节转成 Chat 文件输入（receiptId）。
 */

const REASON_LABELS = {
    'too-large': '超过 20 MiB 接收上限',
    'empty': '内容为空',
    'cancelled': '下载被取消',
    'download-failed': '下载失败',
    'write-failed': '写入工作区失败',
    'workspace-unavailable': '无法确定会话工作区',
}

export function attachmentFailureLabel(reason) {
    return REASON_LABELS[reason] ?? '下载失败'
}

/** @param {{ name?: string, status: string, path?: string, bytes?: number, attachmentId?: string, reason?: string }} file */
export function attachmentPathLine(file) {
    if (file.status === 'done' && file.path)
        return `- ${file.name}：已保存到 ${file.path}（${file.bytes} 字节）`;
    return `- ${file.name || file.attachmentId}：未保存（${attachmentFailureLabel(file.reason)}）`;
}