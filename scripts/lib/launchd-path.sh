# launchd plist 用的 PATH。
#
# 为什么需要这个文件：plist 不读用户的 shell 配置（.zshrc 之类），launchd
# 拉起的桥接进程只能靠 plist 里写死的 PATH 找可执行文件。只写系统目录时，
# node 找得到、用户自己装的 CLI 找不到——pi 后端实测踩过：pi 装在 npm
# 全局 bin（~/.npm-global/bin），桥接的 PATH 里没有，进程"活着"但一跑任务
# 就失败（src/pi.js 的健康检查还把这种情况吞掉，不报错）。
#
# 用法：
#   . "$ROOT/scripts/lib/launchd-path.sh"
#   LAUNCHD_PATH="$(ocb_launchd_path)"

# 输出一份 PATH：系统目录打底，再加上当前用户常见的 bin 目录。
# npm 全局目录用 `npm config get prefix` 算，不写死 ~/.npm-global——
# 有人用 nvm、有人用 homebrew 的 node，prefix 各不相同。
ocb_launchd_path() {
  local path="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local npm_prefix d
  npm_prefix="$(npm config get prefix 2>/dev/null || true)"
  for d in "$npm_prefix/bin" "$HOME/.local/bin" "$HOME/.bun/bin"; do
    [ -n "$d" ] && [ -d "$d" ] || continue
    case ":$path:" in
      *":$d:"*) ;;          # 已在 PATH 里，不重复追加
      *) path="$path:$d" ;;
    esac
  done
  printf '%s\n' "$path"
}
