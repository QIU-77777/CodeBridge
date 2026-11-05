/**
 * 后端工厂。
 *
 * Bridge 只依赖一组方法（health / location / subscribe / createSession /
 * prompt / interrupt / listSessions / ...），不关心背后是常驻 HTTP 服务还是
 * 一次性子进程。加第三个后端时在这里注册即可，不用碰 handler.js。
 */

import { OpencodeClient } from './oc.js'
import { PiBackend, capabilitiesFor } from './pi.js'

export function createBackend(cfg, { logger = console, sessionDir, spawnImpl } = {}) {
  const type = cfg.backend?.type || 'opencode'
  if (type === 'opencode') {
    return new OpencodeClient({ url: cfg.opencode.url, password: cfg.opencode.password, logger })
  }
  if (type === 'pi') {
    return new PiBackend({ cfg, logger, sessionDir, spawnImpl })
  }
  throw new Error(
    `未知的 backend.type: ${type}（可选：opencode / pi）。检查 ${cfg.__configPath || 'config.json'}`,
  )
}

export { capabilitiesFor }
