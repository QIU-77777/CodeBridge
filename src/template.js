/** 用运行时数据填充 {{变量}}。缺失的变量替换成空串，避免占位符泄漏给模型 */
export function render(template, vars) {
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key]),
  )
}
