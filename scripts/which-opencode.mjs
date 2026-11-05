#!/usr/bin/env node
/**
 * 打印 up.sh 将要使用的 opencode 可执行文件。
 *
 *   node scripts/which-opencode.mjs          # 只打印路径，供 shell 取值
 *   node scripts/which-opencode.mjs --json   # 带来源和版本，供人看
 *   node scripts/which-opencode.mjs --tsv    # 路径 \t 版本 \t 来源，供 up.sh 一次读完
 *
 * 找不到时退出码 1，up.sh 据此直接报错，不会静默 fallback 到别的东西。
 */
import { resolveOpencode, SOURCE_LABEL } from '../src/which-opencode.js'

const r = resolveOpencode()

if (!r) {
  if (process.argv.includes('--json')) {
    console.error('❌ 没有找到 opencode：桌面版没装，PATH 里也没有')
  }
  process.exit(1)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ...r, label: SOURCE_LABEL[r.source] }, null, 2))
} else if (process.argv.includes('--tsv')) {
  console.log([r.bin, r.version || '-', SOURCE_LABEL[r.source]].join('\t'))
} else {
  console.log(r.bin)
}
