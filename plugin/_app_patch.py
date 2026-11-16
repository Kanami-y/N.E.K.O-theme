"""应用侧自愈补丁 —— 让插件「装上就能用」，无需任何人手工运行 install.ps1。

为什么需要这个模块
------------------
宿主（N.E.K.O）**没有任何 CSS / JS 注入 API**：projectneko_server.exe 里 inject_css /
global_css / theme_override 全量扫描零命中，插件 SDK 也没有对应能力。应用窗口（:48911）
与插件面板（:48916）跨源，localStorage 不互通、BroadcastChannel 不互通，面板无法直接
通知应用窗口。

唯一可用的通道是「应用窗口自己加载一个 loader 脚本，loader 去轮询插件的 theme.json」。
而让应用窗口加载 loader 的唯一办法，是往 resources/bin/templates/*.html 里插入两行标签。
install.ps1 干的就是这件事 —— 但那要求用户手工跑 PowerShell 脚本，在「从插件市场装一个
插件」的正常路径里不可接受。

于是把同一件事搬到插件自己的 startup 里：插件每次启动都幂等地确认
  1. resources/bin/static/neko-theme-studio.js 与 .../css/neko-theme-studio.css
     与插件包内自带的那份一致；
  2. templates/index.html / templates/chat.html 里有且只有一段 NTS 标记块，
     且标记块里的 ?v= 拼上了当前资源的内容哈希。
任一不符就修好它。这样：

* 零手工安装：从市场装完插件、应用重开一次，主题就生效。
* 真热更新：静态资源被 48911 以 Cache-Control: immutable 缓存，光改文件浏览器永远不会
  重取；把内容哈希写进 URL，内容一变 URL 就变，缓存自然失效。这是唯一能穿透 immutable
  缓存的可靠手段（{{ static_asset_version }} 是启动时固定的，改文件不会变 —— 实测过）。

安全边界
--------
* 只在 resources/bin/templates 存在、且锚点行（dark-mode.css 的 link 标签）唯一命中时
  才动手；模板结构一变就整体放弃并记日志，绝不猜。
* 写回前/后都校验：Jinja 哨兵仍在、BEGIN/END 各 1 次、BOM 状态不变。任一条不满足即
  放弃（原字节保持不动）。
* 修改前把原始字节备份到 %LOCALAPPDATA%/N.E.K.O/theme-studio-backup，只增不删。
  （刻意不放进插件根：/plugin-cli/build 会把插件根下的一切打进安装包。）
* uninstall.ps1 会写一个「停止自愈」标记 %LOCALAPPDATA%/N.E.K.O/theme-studio-disabled；
  该文件存在时本模块整体跳过，保证卸载后重开应用/重载插件不会把主题又装回来。
  install.ps1 成功安装后会删除这个标记。
* 任何异常都被吞掉并降级为日志 —— 补丁失败绝不能让插件启动失败。
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

MARKER_BEGIN = "<!-- NTS:BEGIN -->"
MARKER_END = "<!-- NTS:END -->"

#: 与 install.ps1 的 $AnchorRegex 逐字节一致。
ANCHOR_RE = re.compile(r'<link[^>]*?/css/dark-mode\.css[^>]*?>')

#: Jinja 变量存在性哨兵。模板是多语言/多主题共用的，丢了它整站白屏。
JINJA_SENTINEL = '{{ static_asset_version }}'

#: 必须打上补丁的模板（相对 resources/bin/templates）。缺一个就视为整体失败。
#: index.html 是主窗口，chat.html 是聊天窗口 —— 这两个不可用等于插件没装上。
REQUIRED_TEMPLATES = ('index.html', 'chat.html')

#: 可选模板：凡是带 dark-mode.css 锚点的页面（副标题、toast、播放器、查看器等
#: 浮动窗口）都顺手接上，这样每个窗口都有主题。缺了不影响整体成立。
#: install.ps1 当年只覆盖了两个模板，剩下的窗口永远拿不到主题 —— 这里一并补上。
OPTIONAL_TEMPLATE_GLOB = '*.html'

#: 插件包内自带的应用侧两件套（ship 在插件里，跟着市场包一起走）。
LOADER_DIR_NAME = 'loader'

#: 备份目录名。**必须放在插件包外面**：插件根目录下的任何东西都会被
#: /plugin-cli/build 打进 .neko-plugin 包（实测：连点开头的目录也不排除），
#: 一份 700 KB 的模板备份会把安装包撑大三倍。
BACKUP_DIR_NAME = 'theme-studio-backup'

#: 卸载脚本写的「停止自愈」标记文件名（位于 %LOCALAPPDATA%\N.E.K.O\ 下）。
#: 文件存在 = 用户已经卸载应用侧补丁，本模块必须整体跳过，否则卸载会被
#: 下一次插件启动/重载/repair_app 静默撤销。
DISABLE_FLAG_NAME = 'theme-studio-disabled'

_LOCK = threading.Lock()

Logger = Callable[[str, str], None]


# --------------------------------------------------------------------------- 工具


def _noop_log(level: str, message: str) -> None:  # pragma: no cover - 兜底
    pass


def _sha8(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:8]


def _split_keep_eol(text: str) -> list[str]:
    """按行切分，保留每行行尾（与 install.ps1 的 Split-TextLines 同构）。"""
    lines: list[str] = []
    start = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '\r' and i + 1 < n and text[i + 1] == '\n':
            lines.append(text[start:i + 2])
            i += 2
            start = i
        elif ch == '\n':
            lines.append(text[start:i + 1])
            i += 1
            start = i
        else:
            i += 1
    if start < n:
        lines.append(text[start:])
    return lines


def _detect_eol(text: str) -> str:
    return '\r\n' if '\r\n' in text else '\n'


def _line_body(line: str) -> str:
    return line.rstrip('\r\n')


def _line_eol(line: str) -> str:
    """一行末尾的行尾符（与 _split_keep_eol 配套）。"""
    return line[len(_line_body(line)):]


def _with_eol(text: str, eol: str) -> str:
    """给「行内片段」补上行尾，避免拼接后两行粘在一起。"""
    if text.endswith('\r\n') or text.endswith('\n'):
        return text
    return text + eol


def _atomic_write(path: Path, data: bytes) -> None:
    """同目录临时文件 + os.replace：宿主可能正在读这个文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.{threading.get_ident()}.tmp')
    try:
        with open(tmp, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


# --------------------------------------------------------------------------- 定位


def _ancestors_of(path: Path, depth: int = 5) -> list[Path]:
    out: list[Path] = []
    current = path
    for _ in range(depth):
        parent = current.parent
        if parent == current:
            break
        out.append(parent)
        current = parent
    return out


def _parent_process_exe() -> Path | None:
    """取父进程可执行文件路径（仅 Windows）。

    插件进程是宿主的 multiprocessing 子进程，父进程就是 resources/bin 下的服务端 exe。
    正常情况下 sys.executable 已经等于它；但当插件被别的方式拉起（测试/嵌入式解释器）
    时，这一层能补上。失败一律返回 None。
    """
    if os.name != 'nt':
        return None
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, os.getppid())
        if not handle:
            return None
        try:
            size = wintypes.DWORD(32768)
            buf = ctypes.create_unicode_buffer(size.value)
            if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                return None
            return Path(buf.value)
        finally:
            kernel32.CloseHandle(handle)
    except Exception:  # noqa: BLE001 —— 取不到就算了
        return None


def _app_root_from_processes(tried: list[str] | None = None) -> Path | None:
    """兜底：从「正在运行的 N.E.K.O / projectneko_server 进程」反推安装根。

    为什么需要它：sys.executable 与父进程都只在「插件进程由宿主 backend 直接拉起」时
    才有用。换了设备 / 换了分发方式（商店版、某些打包器、开发模式下用别的解释器跑
    backend）时，这几条线索可能全指向无关目录 —— 实测在一个普通 Python shell 里跑
    ensure_app_patch，probes 全落在 python/系统目录上，明明装着 N.E.K.O 也说找不到。

    这里改为扫一遍系统上的进程：找 image name 命中 N.E.K.O* / projectneko_server* 的，
    取它们的 exe 路径，再按 resources/bin 结构上溯。只读查询，失败一律忽略。

    前提：Windows 上枚举进程用 PowerShell/ctypes；其它平台用 ps。
    """
    candidates: list[Path] = []

    for exe in _process_image_paths():
        candidates.append(exe)
        candidates.append(exe.parent)
        candidates.extend(_ancestors_of(exe, 6))

    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if tried is not None and key not in seen:
            seen.add(key)
            tried.append(key)
        try:
            if (candidate / 'resources' / 'bin' / 'templates').is_dir():
                return candidate
        except OSError:
            continue
    return None


def _process_image_paths() -> list[Path]:
    """列出所有进程的可执行文件路径，只保留名字像 N.E.K.O / projectneko_server 的。"""
    import subprocess

    wanted = ('neko', 'projectneko')
    out: list[Path] = []

    if os.name == 'nt':
        try:
            completed = subprocess.run(
                ['powershell', '-NoProfile', '-NonInteractive', '-Command',
                 'Get-Process | Where-Object { $_.Path } | Select-Object -ExpandProperty Path'],
                capture_output=True, timeout=8, check=False,
            )
            text = completed.stdout.decode('utf-8', 'replace')
        except (OSError, ValueError, subprocess.SubprocessError):
            text = ''
    else:
        try:
            completed = subprocess.run(['ps', '-eo', 'comm='], capture_output=True,
                                       timeout=8, check=False)
            text = completed.stdout.decode('utf-8', 'replace')
        except (OSError, ValueError, subprocess.SubprocessError):
            text = ''

    for line in text.splitlines():
        raw = line.strip()
        if not raw:
            continue
        name = os.path.basename(raw).lower()
        if not any(token in name for token in wanted):
            continue
        try:
            path = Path(raw)
            if path.is_file():
                out.append(path)
        except OSError:
            continue
    return out


def find_app_root(plugin_root: Path, tried: list[str] | None = None) -> Path | None:
    """找到 N.E.K.O 安装根（resources/bin/templates 的祖先）。

    插件子进程就是 resources/bin/projectneko_server.exe（实测：父进程与插件进程是同一个
    exe，只是后者带 --multiprocessing-fork），因此 sys.executable 往上三层就是应用根。
    再叠加父进程、环境变量与逐层祖先，覆盖 frozen / 源码 / 嵌入式解释器三种情形。

    tried：可选出参。找不到时把试过的候选路径追加进去 —— 换了一台设备却没效果时，
    「它到底找过哪些地方」是唯一能自己看出问题的线索（面板的安装自检会显示前几条）。
    """
    probes: list[Path] = []

    override = os.environ.get('NEKO_APP_ROOT')
    if override:
        probes.append(Path(override))

    try:
        exe = Path(sys.executable).resolve()
        probes.append(exe.parent.parent.parent)   # resources/bin/x.exe -> 应用根
        probes.append(exe.parent.parent)          # 兜底：直接指到 resources
        probes.extend(_ancestors_of(exe))
    except OSError:
        pass

    parent_exe = _parent_process_exe()
    if parent_exe is not None:
        probes.append(parent_exe.parent.parent.parent)
        probes.extend(_ancestors_of(parent_exe))

    seen: set[str] = set()
    for candidate in probes:
        try:
            key = str(candidate)
        except OSError:
            continue
        if tried is not None and key not in seen:
            seen.add(key)
            tried.append(key)
        try:
            if (candidate / 'resources' / 'bin' / 'templates').is_dir():
                return candidate
        except OSError:
            continue

    # 兜底：直接从正在运行的 N.E.K.O 进程反推（见 _app_root_from_processes 的说明）。
    found = _app_root_from_processes(tried)
    if found is not None:
        return found

    return None


# --------------------------------------------------------------------------- 主流程


def _platform_note() -> str | None:
    """平台层面的已知限制（None 表示没有已知问题）。"""
    if sys.platform == 'darwin':
        return ('macOS 的 .app 包受系统保护，插件进程无法改写其中的 resources/bin，'
                '主题不会自动安装；本插件目前只支持 Windows。')
    if sys.platform.startswith('linux'):
        return ('Linux 上只要 N.E.K.O 安装目录对当前用户可写就能用；'
                'AppImage、只读挂载或沙箱分发（如 Flatpak）不支持自动安装。')
    return None


def ensure_app_patch(plugin_root: Path, log: Logger | None = None) -> dict[str, Any]:
    """幂等确保「应用侧两件套 + 模板标记」到位。返回诊断结果，从不抛异常。"""
    log = log or _noop_log
    result: dict[str, Any] = {
        'ok': False,
        'disabled': False,
        'app_root': None,
        'assets_written': [],
        'assets_unchanged': [],
        'assets_failed': [],
        'templates_patched': [],
        'templates_unchanged': [],
        'templates_skipped': [],
        'missing_required': [],
        'warnings': [],
        # 换机排查用的观测字段（面板「安装自检」直接展示）：
        'search_paths': [],      # 找不到安装根时，试过哪些候选目录
        'platform': None,        # sys.platform
        'platform_note': None,   # 平台层面的已知限制说明
        'plugin_root': str(plugin_root),
        'autostart': None,
    }

    result['platform'] = sys.platform
    result['platform_note'] = _platform_note()

    # 卸载 kill-switch：uninstall.ps1 卸载时写这个标记，表示「用户要求移除主题」。
    # 插件本体可能还在（甚至 auto_start 仍为 true），但绝不能再把两件套/模板标记
    # 写回去 —— 否则卸载会被下一次启动静默撤销（这是 0.1.4 的真实缺陷）。
    flag = disabled_flag_path()
    if flag is not None:
        try:
            flag_exists = flag.is_file()
        except OSError:
            flag_exists = False
        if flag_exists:
            message = (
                f'检测到卸载标记 {flag}，跳过应用侧补丁自愈'
                '（如需恢复主题，请重新运行 install.ps1）'
            )
            result['disabled'] = True
            result['warnings'].append(message)
            log('info', message)
            return result

    with _LOCK:
        try:
            _migrate_legacy_backup(plugin_root, log)
            _run(plugin_root, log, result)
        except Exception as exc:  # noqa: BLE001 —— 补丁失败绝不影响插件启动
            result['warnings'].append(f'应用侧补丁异常（已忽略）：{exc}')
            log('warning', f'应用侧补丁异常（已忽略）：{exc}')
    return result


def build_marker_block(js_hash: str, css_hash: str) -> str:
    """生成替换 install.ps1 的 $MarkerBlock（单行，标签间无换行）。

    与 install.ps1 的差别只有一处：?v= 后面多拼了内容哈希，用来穿透
    Cache-Control: immutable。
    """
    return (
        MARKER_BEGIN
        + '<link rel="stylesheet" href="/static/css/neko-theme-studio.css?v='
        + JINJA_SENTINEL
        + '-'
        + css_hash
        + '">'
        + '<script src="/static/neko-theme-studio.js?v='
        + JINJA_SENTINEL
        + '-'
        + js_hash
        + '" defer></script>'
        + MARKER_END
    )


def _migrate_legacy_backup(plugin_root: Path, log: Logger) -> None:
    """把 0.1.3 早期版本留在插件根里的备份目录搬出去。

    旧位置会让 /plugin-cli/build 把 23 个模板备份（约 700 KB）打进安装包。
    搬运失败就把目录清空（备份是可再生的：模板改回原样后会重新备份）。
    """
    legacy = plugin_root / '_app_patch_backup'
    try:
        if not legacy.is_dir():
            return
        target = backup_root(plugin_root)
        target.mkdir(parents=True, exist_ok=True)
        for item in legacy.iterdir():
            if not item.is_file():
                continue
            dest = target / item.name
            if not dest.exists():
                os.replace(item, dest)
            else:
                item.unlink()
        try:
            legacy.rmdir()
        except OSError:
            # 还有残留（被占用/子目录）：至少把文件删掉，减小安装包体积
            for item in legacy.rglob('*'):
                try:
                    item.unlink()
                except OSError:
                    pass
            try:
                legacy.rmdir()
            except OSError:
                pass
        log('info', f'已把模板备份从插件包迁出 → {target}')
    except OSError as exc:
        log('warning', f'迁移旧备份目录失败（不影响补丁）：{exc}')


def _neko_data_dir(plugin_root: Path) -> Path | None:
    """从插件根反推 N.E.K.O 数据目录（.../N.E.K.O/.neko-plugin-installations/plugins/<id>）。"""
    try:
        parts = plugin_root.resolve().parts
    except OSError:
        return None
    for marker in ('.neko-plugin-installations',):
        if marker in parts:
            idx = parts.index(marker)
            return Path(*parts[:idx])
    return None


def disabled_flag_path() -> Path | None:
    """uninstall.ps1 写的「停止自愈」标记路径（存在即跳过整个自愈）。"""
    override = os.environ.get('NEKO_NTS_DISABLE_FILE')
    if override:
        return Path(override)
    local = os.environ.get('LOCALAPPDATA')
    if local:
        return Path(local) / 'N.E.K.O' / DISABLE_FLAG_NAME
    return None


def _http_json(url: str, payload: dict[str, Any] | None = None,
               method: str | None = None, timeout: float = 20.0) -> Any:
    import json
    import urllib.request

    data = None if payload is None else json.dumps(payload).encode('utf-8')
    request = urllib.request.Request(
        url,
        data=data,
        method=method or ('POST' if data else 'GET'),
        headers={'Content-Type': 'application/json'} if data else {},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    return json.loads(raw.decode('utf-8')) if raw else None


def _ensure_autostart_async(plugin_root: Path, log: Logger, result: dict[str, Any]) -> None:
    """在后台线程里补 auto_start，绝不在 startup 里同步发请求。

    为什么必须是异步：插件 startup 是宿主同步等待的（超过 10s 就判
    'startup timed out' 并把插件标成 failed/stopped）。而 auto_start 只能靠
    PUT /plugin/<id>/auto-start 设置，这个请求打回宿主服务端 —— 宿主此刻正阻塞在
    startup 上，同步调用必然自锁。实测同步版本正是这样超时的。
    """
    thread = threading.Thread(
        target=_ensure_autostart,
        args=(plugin_root, log),
        name='nts-autostart',
        daemon=True,
    )
    thread.start()
    result['autostart'] = 'scheduled'


def _autostart_persisted(plugin_root: Path, plugin_id: str) -> bool | None:
    """读磁盘上的 overrides，判断 auto_start 是否已经落盘。None 表示读不到。"""
    import json

    data_dir = _neko_data_dir(plugin_root)
    if data_dir is None:
        return None
    path = data_dir / 'config' / 'plugin_runtime_overrides.json'
    try:
        overrides = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    entry = overrides.get(plugin_id)
    if not isinstance(entry, dict):
        return False
    return entry.get('auto_start') is True


def _put_autostart(base: str, plugin_id: str, value: bool) -> None:
    _http_json(
        f'{base}/plugin/{plugin_id}/auto-start',
        {'auto_start': value},
        method='PUT',
        timeout=10.0,
    )


def _ensure_autostart(plugin_root: Path, log: Logger) -> None:
    """确保插件重启后会被自动拉起（并把偏好真正写进磁盘）。

    为什么必须在插件里做：宿主**不会**从 plugin.toml 继承 auto_start（install 会把
    新装插件的 auto_start 落盘成 false，并写 plugin_autostart_pending.json）。用户从
    市场装完插件不该再去勾一个开关，否则重开应用主题就静默失效。

    为什么不能只发一次 PUT：宿主的 set_plugin_auto_start 只在「与它内存里的值不同」时
    才写盘。内存值来自清单默认值（本插件 plugin.toml 写的是 true），而磁盘上是 install
    写下的 false —— 于是 PUT true 与内存相同、直接跳过落盘，响应照样 200 success。
    实测：连发两次 PUT true，plugin_runtime_overrides.json 的 mtime/内容都不变。
    对策：PUT 之后回读磁盘；没落盘就「反着写一次再正着写一次」，制造一次真实变化。
    实测该抖动序列会立刻把 {"auto_start": true} 写进 overrides 文件。
    """
    plugin_id = 'neko_theme_studio'
    if _autostart_persisted(plugin_root, plugin_id) is True:
        return  # 快路径：绝大多数启动会走到这里，一个请求都不发。

    # 等宿主走出 startup 再发请求，否则请求打回来会撞在它自己的启动锁上。
    time.sleep(3.0)

    base = os.environ.get('NEKO_PLUGIN_BASE_URL') or 'http://127.0.0.1:' + os.environ.get('NEKO_PLUGIN_PORT', '48916')
    for attempt in range(1, 4):
        try:
            # 必须不带 Origin 头：带任意 Origin 的插件变更请求会被 mutation_auth 判 403。
            _put_autostart(base, plugin_id, True)
        except Exception as exc:  # noqa: BLE001 —— 失败不影响插件运行
            log('warning', f'打开 auto_start 失败（第 {attempt} 次，不影响本会话）：{exc}')
            time.sleep(1.0)
            continue

        if _autostart_persisted(plugin_root, plugin_id) is True:
            log('info', f'已把插件 auto_start 打开并落盘（第 {attempt} 次尝试）')
            return

        # 没落盘：宿主认为偏好没变化所以跳过了写盘，制造一次真实变化再写回来。
        time.sleep(0.4)
        try:
            _put_autostart(base, plugin_id, False)
            time.sleep(0.4)
            _put_autostart(base, plugin_id, True)
        except Exception as exc:  # noqa: BLE001
            log('warning', f'auto_start 落盘重试失败（第 {attempt} 次）：{exc}')
            time.sleep(1.0)
            continue

        if _autostart_persisted(plugin_root, plugin_id) is True:
            log('info', f'已把插件 auto_start 打开并落盘（第 {attempt} 次尝试，经一次翻转为 true 触发写入）')
            return
        time.sleep(1.0)

    log('warning', 'auto_start 偏好未能确认落盘；本次会话主题仍生效，但重开应用后可能需要重新启动一次插件')


def _run(plugin_root: Path, log: Logger, result: dict[str, Any]) -> None:
    loader_dir = plugin_root / "static" / LOADER_DIR_NAME
    js_src = loader_dir / "neko-theme-studio.js"
    css_src = loader_dir / "neko-theme-studio.css"

    # 先做与资源无关的一步：确保重开应用后插件还会被自动拉起。
    # 放在所有早退之前，因为即使应用根找不到，auto_start 也应该被修好。
    _ensure_autostart_async(plugin_root, log, result)

    missing = [p.name for p in (js_src, css_src) if not p.is_file()]
    if missing:
        message = f'插件包缺少应用侧资源 {missing}（static/{LOADER_DIR_NAME}/），跳过自愈补丁'
        result['warnings'].append(message)
        log('warning', message)
        return

    tried: list[str] = []
    app_root = find_app_root(plugin_root, tried)
    result['search_paths'] = tried
    if app_root is None:
        message = ('未能定位 N.E.K.O 安装根（resources/bin/templates），跳过自愈补丁；'
                   '试过的目录：' + ('、'.join(tried[:6]) or '（无）'))
        result['warnings'].append(message)
        log('warning', message)
        return

    result['app_root'] = str(app_root)
    bin_dir = app_root / 'resources' / 'bin'
    static_dir = bin_dir / 'static'
    template_dir = bin_dir / 'templates'

    js_bytes = js_src.read_bytes()
    css_bytes = css_src.read_bytes()

    _sync_asset(static_dir / "neko-theme-studio.js", js_bytes, log, result, "neko-theme-studio.js")
    _sync_asset(static_dir / "css" / "neko-theme-studio.css", css_bytes, log, result, "css/neko-theme-studio.css")

    block = build_marker_block(_sha8(js_bytes), _sha8(css_bytes))

    targets = _discover_templates(template_dir)

    for template_path in targets:
        _patch_template(template_path, block, log, result, plugin_root)
        if template_path.name in REQUIRED_TEMPLATES and template_path.name not in (
            result['templates_patched'] + result['templates_unchanged']
        ):
            result['missing_required'].append(template_path.name)

    # 资源写失败与缺必备模板同属「补丁没装好」：不能只在 warnings 里留痕，
    # 否则宿主/install.ps1 看到 ok=True 会误以为主题可用（页面 404 白屏无提示）。
    result['ok'] = not result['missing_required'] and not result['assets_failed']
    if result['missing_required']:
        log(
            'error',
            '应用侧补丁不完整，缺失必备模板：'
            + ', '.join(result['missing_required'])
            + '（应用界面可能不会加载主题）',
        )
    if result['assets_failed']:
        log(
            'error',
            '应用侧资源写入失败：'
            + ', '.join(result['assets_failed'])
            + '（主题样式/脚本可能 404，页面只有裸 HTML）',
        )
    if result['ok']:
        log('info',
            '应用侧补丁就绪：'
            f'改写 {len(result["templates_patched"])} 个模板、'
            f'已最新 {len(result["templates_unchanged"])} 个模板；'
            f'资源改写 {result["assets_written"] or "无"}')


def _discover_templates(template_dir: Path) -> list[Path]:
    """找出所有带 dark-mode.css 锚点的模板（必备的两个排在最前）。"""
    found: list[Path] = []
    try:
        entries = sorted(template_dir.glob(OPTIONAL_TEMPLATE_GLOB))
    except OSError:
        entries = []

    for path in entries:
        if not path.is_file():
            continue
        found.append(path)

    # 必备模板即使不在 glob 结果里也要尝试（缺失时由调用方记为 missing_required）
    ordered: list[Path] = []
    by_name = {path.name: path for path in found}
    for name in REQUIRED_TEMPLATES:
        ordered.append(by_name.get(name, template_dir / name))
    for path in found:
        if path.name not in REQUIRED_TEMPLATES:
            ordered.append(path)
    return ordered


def _sync_asset(dst: Path, data: bytes, log: Logger, result: dict[str, Any], label: str) -> bool:
    """让应用侧资源与插件包内一致。返回 True 表示「文件已就绪」（含无需改动）。

    写失败返回 False 并登记到 result['assets_failed'] —— 由调用方并入 ok。
    """
    try:
        if dst.is_file() and dst.read_bytes() == data:
            result['assets_unchanged'].append(label)
            return True
        _atomic_write(dst, data)
        result['assets_written'].append(label)
        log('info', f'应用侧资源已更新：{dst}（{len(data)} 字节）')
        return True
    except OSError as exc:
        message = f'写入应用侧资源失败 {dst}：{exc}'
        result['assets_failed'].append(label)
        result['warnings'].append(message)
        log('warning', message)
        return False


def _patch_template(template_path: Path, block: str, log: Logger, result: dict[str, Any], plugin_root: Path) -> None:
    name = template_path.name
    if not template_path.is_file():
        if name in REQUIRED_TEMPLATES:
            result['warnings'].append(f'必备模板不存在：{template_path}')
        else:
            result['templates_skipped'].append(name)
        return

    raw = template_path.read_bytes()
    has_bom = raw.startswith(b'\xef\xbb\xbf')
    body = raw[3:] if has_bom else raw
    try:
        text = body.decode('utf-8')
    except UnicodeDecodeError as exc:
        message = f'{name} 不是 UTF-8，跳过（{exc}）'
        result['warnings'].append(message)
        log('warning', message)
        return

    eol = _detect_eol(text)
    lines = _split_keep_eol(text)

    # 1) 删掉旧的 NTS 段（含跨行残留），保证幂等。
    #    语义与 install.ps1 的 Remove-NtsBlockLines 完全一致：
    #    * BEGIN..END 同行 → 只去掉两标记之间的内容，保留行内左右文字；
    #    * BEGIN 与 END 跨行 → 删掉整段，保留 BEGIN 行前缀与 END 行后缀；
    #    * **只有 BEGIN 没有 END（模板残缺）→ 只剥掉 BEGIN 标记文字，绝不吞掉
    #      后面的任何行**。早期实现一旦进入 in_block 就把余下所有行丢弃，会把
    #      模板尾部（含 </html>）静默删光，同时第 4 步校验还会通过（插入的标记块
    #      自带 Jinja 哨兵和 1/1 计数），结果页面白屏却上报「已打补丁」。
    kept: list[str] = []
    removed = 0
    unterminated = False
    idx = 0
    total = len(lines)
    while idx < total:
        line = lines[idx]
        body_line = _line_body(line)
        begin_at = body_line.find(MARKER_BEGIN)
        end_at = body_line.find(MARKER_END)

        if begin_at < 0 and end_at < 0:
            kept.append(line)
            idx += 1
            continue

        if begin_at >= 0 and end_at > begin_at:
            # 单行块
            combined = line[:begin_at] + line[end_at + len(MARKER_END):]
            removed += 1
            if _line_body(combined).strip():
                kept.append(combined)
            idx += 1
            continue

        if begin_at >= 0:
            # BEGIN 在本行，END 可能在后续行
            end_idx = None
            for j in range(idx + 1, total):
                if MARKER_END in _line_body(lines[j]):
                    end_idx = j
                    break
            if end_idx is None:
                # 只有 BEGIN 没有 END：模板已损坏。只剥标记文字，保留其余内容。
                unterminated = True
                stripped = _line_body(line).replace(MARKER_BEGIN, '', 1)
                kept.append(_with_eol(stripped, _line_eol(line)) if _line_body(stripped).strip() else '')
                idx += 1
                continue
            head = line[:begin_at]
            if _line_body(head).strip():
                kept.append(_with_eol(head, eol))
            tail_line = lines[end_idx]
            end_pos = tail_line.find(MARKER_END)
            tail = tail_line[end_pos + len(MARKER_END):]
            if _line_body(tail).strip():
                kept.append(_with_eol(tail, eol))
            removed += end_idx - idx + 1
            idx = end_idx + 1
            continue

        # 孤立 END（没有 BEGIN）：去掉标记文字，保留其余内容
        stripped = line[:end_at] + line[end_at + len(MARKER_END):]
        removed += 1
        if _line_body(stripped).strip():
            kept.append(stripped)
        else:
            kept.append('')
        idx += 1

    if unterminated:
        message = (
            f'{name}：发现只有 BEGIN 没有 END 的残缺标记，'
            '已只剥离标记文字并重新写入完整标记段（其余内容原样保留）'
        )
        result['warnings'].append(message)
        log('warning', message)

    # 2) 找锚点：dark-mode.css 的 link 行，必须唯一
    indexes = [i for i, line in enumerate(kept) if ANCHOR_RE.search(_line_body(line))]
    if not indexes:
        # 这个页面本来就不引 dark-mode.css，不属于主题作用范围 —— 安静跳过。
        result['templates_skipped'].append(name)
        return
    if len(indexes) > 1:
        message = f'{name}：dark-mode.css 锚点命中 {len(indexes)} 处（应为 1），跳过以免写坏模板'
        result['warnings'].append(message)
        log('warning', message)
        return
    anchor = indexes[0]

    # 3) 插入（补丁块独占一行，紧跟锚点之后）
    new_lines = kept[: anchor + 1] + [block + eol] + kept[anchor + 1 :]
    new_text = ''.join(new_lines)

    # 4) 写回前校验
    if JINJA_SENTINEL not in new_text:
        message = f'{name}：写回前校验失败 —— 丢失 Jinja 哨兵，放弃'
        result['warnings'].append(message)
        log('warning', message)
        return
    if new_text.count(MARKER_BEGIN) != 1 or new_text.count(MARKER_END) != 1:
        message = f'{name}：写回前校验失败 —— 标记数异常，放弃'
        result['warnings'].append(message)
        log('warning', message)
        return
    # 硬守卫：模板尾部被吃掉是最坏的故障（页面白屏且难恢复）。宁可跳过不写。
    if '</html>' in text and '</html>' not in new_text:
        message = f'{name}：写回前校验失败 —— 会丢失 </html>（模板尾被截断），放弃写入'
        result['warnings'].append(message)
        log('warning', message)
        return
    if len(new_text) < len(text) // 2:
        message = (
            f'{name}：写回前校验失败 —— 内容长度从 {len(text)} 骤减到 {len(new_text)} 字节'
            f'（不足原长度 50%），放弃写入'
        )
        result['warnings'].append(message)
        log('warning', message)
        return

    if new_text == text:
        result['templates_unchanged'].append(name)
        return

    # 5) 备份原始字节（同内容只备份一次）
    _backup_once(template_path, raw, plugin_root, log)

    # 6) 原子写回，保持 BOM 状态
    payload = (b'\xef\xbb\xbf' + new_text.encode('utf-8')) if has_bom else new_text.encode('utf-8')
    try:
        _atomic_write(template_path, payload)
    except OSError as exc:
        message = f'{name}：写回失败（{exc}），模板保持原样'
        result['warnings'].append(message)
        log('warning', message)
        return

    # 7) 写回后复核
    after = template_path.read_text(encoding='utf-8-sig')
    if JINJA_SENTINEL not in after or after.count(MARKER_BEGIN) != 1 or after.count(MARKER_END) != 1:
        message = (
            f'{name}：写回后复核失败，请用 {backup_root(plugin_root)} 里的原始模板备份恢复'
        )
        result['warnings'].append(message)
        log('error', message)
        return

    result['templates_patched'].append(name)
    log('info', f'模板已打补丁：{template_path}（锚点第 {anchor + 1} 行之后，替换旧段 {removed} 行）')


def backup_root(plugin_root: Path) -> Path:
    """备份根目录：优先 LOCALAPPDATA（不随插件包走），否则退回插件根。"""
    override = os.environ.get('NEKO_NTS_BACKUP_DIR')
    if override:
        return Path(override)
    local = os.environ.get('LOCALAPPDATA')
    if local:
        return Path(local) / 'N.E.K.O' / BACKUP_DIR_NAME
    return plugin_root / BACKUP_DIR_NAME


def _backup_once(template_path: Path, raw: bytes, plugin_root: Path, log: Logger) -> None:
    try:
        backup_dir = backup_root(plugin_root)
        backup_dir.mkdir(parents=True, exist_ok=True)
        digest = _sha8(raw)
        existing = list(backup_dir.glob(f'{template_path.name}.pristine-{digest}.*.bak'))
        if existing:
            return
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        target = backup_dir / f'{template_path.name}.pristine-{digest}.{stamp}.bak'
        _atomic_write(target, raw)
        log('info', f'已备份原始模板：{target.name}（{len(raw)} 字节）')
    except OSError as exc:  # 备份失败不阻止打补丁，但要留痕
        log('warning', f'备份模板失败（继续打补丁）：{exc}')
