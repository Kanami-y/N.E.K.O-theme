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
import tempfile
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

#: 最近一次运行的模板备份失败原因。只用于诊断（repair_app 结果里可见），
#: 让「备份失败」不再是黑盒 —— 否则用户只看到「已放弃打补丁」而没有原因。
_BACKUP_ERRORS: list[str] = []

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
                capture_output=True, timeout=3, check=False,
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
        'backup_root': str(backup_root(plugin_root)),
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


def diagnose_app_patch(plugin_root: Path, log: Logger | None = None) -> dict[str, Any]:
    """只读诊断：字段与 ``ensure_app_patch`` 同构，但**一个字节都不写**。

    面板的「安装自检」用它：如果自检本身会修复，那它永远只能看到「已就位」，
    也就永远发现不了「应用更新后模板标记被删了」这类真正需要人知道的问题。
    """
    log = log or _noop_log
    result: dict[str, Any] = {
        'ok': False,
        'disabled': False,
        'dry_run': True,
        'needs_repair': False,
        'app_root': None,
        'assets_written': [],
        'assets_unchanged': [],
        'assets_failed': [],
        'assets_missing': [],
        'templates_patched': [],
        'templates_unchanged': [],
        'templates_skipped': [],
        'templates_missing': [],
        'templates_stale': [],
        'missing_required': [],
        'warnings': [],
        'search_paths': [],
        'platform': sys.platform,
        'platform_note': _platform_note(),
        'plugin_root': str(plugin_root),
        'backup_root': str(backup_root(plugin_root)),
        'autostart': None,
    }

    flag = disabled_flag_path()
    if flag is not None:
        try:
            flag_exists = flag.is_file()
        except OSError:
            flag_exists = False
        if flag_exists:
            result['disabled'] = True
            result['warnings'].append(
                f'检测到卸载标记 {flag}：主题已被卸载（重新运行 install.ps1 可恢复）'
            )
            return result

    loader_dir = plugin_root / 'static' / LOADER_DIR_NAME
    sources = {
        'neko-theme-studio.js': loader_dir / 'neko-theme-studio.js',
        'css/neko-theme-studio.css': loader_dir / 'neko-theme-studio.css',
    }
    missing_sources = [name for name, path in sources.items() if not path.is_file()]
    if missing_sources:
        result['warnings'].append(
            '插件包缺少应用侧资源 ' + '、'.join(missing_sources) + '，无法诊断'
        )
        result['needs_repair'] = True
        return result

    tried: list[str] = []
    app_root = find_app_root(plugin_root, tried)
    result['search_paths'] = tried
    if app_root is None:
        result['warnings'].append(
            '未能定位 N.E.K.O 安装根（resources/bin/templates）；试过：'
            + ('、'.join(tried[:6]) or '（无）')
        )
        result['needs_repair'] = True
        return result

    result['app_root'] = str(app_root)
    bin_dir = app_root / 'resources' / 'bin'
    static_dir = bin_dir / 'static'
    template_dir = bin_dir / 'templates'

    js_bytes = sources['neko-theme-studio.js'].read_bytes()
    css_bytes = sources['css/neko-theme-studio.css'].read_bytes()
    targets = {
        'neko-theme-studio.js': (static_dir / 'neko-theme-studio.js', js_bytes),
        'css/neko-theme-studio.css': (
            static_dir / 'css' / 'neko-theme-studio.css',
            css_bytes,
        ),
    }
    for name, (dst, data) in targets.items():
        try:
            current = dst.read_bytes()
        except FileNotFoundError:
            result['assets_missing'].append(name)
            continue
        except OSError as exc:
            result['assets_missing'].append(name)
            result['warnings'].append(f'读取 {name} 失败：{exc}')
            continue
        if current != data:
            result['assets_missing'].append(name)
        else:
            result['assets_unchanged'].append(name)

    block = build_marker_block(_sha8(js_bytes), _sha8(css_bytes))
    block_bytes = block.encode('utf-8')
    for template_path in _discover_templates(template_dir):
        name = template_path.name
        try:
            raw = template_path.read_bytes()
        except OSError as exc:
            result['templates_skipped'].append(name)
            result['warnings'].append(f'{name} 读取失败，跳过（{exc}）')
            continue
        if block_bytes in raw:
            result['templates_unchanged'].append(name)
            continue
        if MARKER_BEGIN.encode('utf-8') in raw:
            # 有标记但哈希不是当前这套：说明应用升级过、或插件版本落后
            result['templates_stale'].append(name)
        elif not ANCHOR_RE.search(raw.decode('utf-8', 'replace')):
            # 没有 dark-mode.css 锚点的页面本来就不该被注入（游戏页、局部片段等）。
            # 只读诊断必须和 _patch_template 用同一套判据，否则「跳过」会被误报成
            # 「缺失」——用户看到 14 个红项，点「修复」也修不掉。
            result['templates_skipped'].append(name)
            continue
        else:
            result['templates_missing'].append(name)
        if name in REQUIRED_TEMPLATES and name not in result['templates_unchanged']:
            result['missing_required'].append(name)

    result['ok'] = not (
        result['assets_missing']
        or result['templates_missing']
        or result['templates_stale']
        or result['missing_required']
    )
    result['needs_repair'] = not result['ok']
    if result['needs_repair']:
        message = (
            '应用侧补丁不完整：缺资源 '
            + str(len(result['assets_missing']))
            + ' 个 / 缺标记页面 '
            + str(len(result['templates_missing']))
            + ' 个 / 标记过期 '
            + str(len(result['templates_stale']))
            + ' 个（点「修复」可原地补齐）'
        )
        result['warnings'].append(message)
        log('info', message)
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


AUTOSTART_MARKER_NAME = 'theme-studio-autostart-corrected'


def _autostart_marker_path(plugin_root: Path) -> Path:
    """「已经替用户校正过一次 auto_start」的标记文件路径。

    为什么需要标记：install.ps1 会把新装插件的 auto_start 落盘成 false（宿主不从
    plugin.toml 继承），所以插件第一次启动必须把它改回 true，否则重开应用主题就静默
    失效。但用户之后可能**主动**在宿主设置里关掉自动启动 —— 如果每次启动都无条件改回
    true，那是插件在替用户改设置（用户会看到「关了自己又开」）。

    所以只校正一次：校正成功后落一个标记，此后一律尊重用户的选择。
    标记放在 N.E.K.O 数据目录（与 theme-studio-backup 同级），不污染插件包；
    反推不出数据目录时退回插件根。
    """
    data_dir = _neko_data_dir(plugin_root)
    if data_dir is not None:
        return data_dir / AUTOSTART_MARKER_NAME
    return plugin_root / f'.{AUTOSTART_MARKER_NAME}'


def _mark_autostart_corrected(plugin_root: Path, log: Logger) -> None:
    marker = _autostart_marker_path(plugin_root)
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(datetime.now().isoformat(timespec='seconds'), encoding='utf-8')
    except OSError as exc:  # 标记写不进去只会导致下次再校正一次，不影响功能
        log('warning', f'记录 auto_start 校正标记失败（不影响本次会话）：{exc}')

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
    try:
        if _autostart_marker_path(plugin_root).exists():
            # 已经替用户校正过一次：之后用户主动关掉的就该尊重，不再反复改回 true。
            return
    except OSError:
        pass

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
            _mark_autostart_corrected(plugin_root, log)
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
            _mark_autostart_corrected(plugin_root, log)
            log('info', f'已把插件 auto_start 打开并落盘（第 {attempt} 次尝试，经一次翻转为 true 触发写入）')
            return
        time.sleep(1.0)

    log('warning', 'auto_start 偏好未能确认落盘；本次会话主题仍生效，但重开应用后可能需要重新启动一次插件')


def _run(plugin_root: Path, log: Logger, result: dict[str, Any]) -> None:
    _BACKUP_ERRORS.clear()
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


def strip_marker_lines(text: str) -> tuple[str, int, bool]:
    """剥掉文本里所有 NTS 标记段，返回（新文本，移除的行数，是否有缺 END 的残块）。

    语义与 install.ps1 的 Remove-NtsBlockLines 完全一致：
    * BEGIN..END 同行 → 只去掉两标记之间的内容，保留行内左右文字；
    * BEGIN 与 END 跨行 → 删掉整段，保留 BEGIN 行前缀与 END 行后缀；
    * 只有 BEGIN 没有 END（模板残缺）→ 只剥掉 BEGIN 标记文字，绝不吞掉后面的行。

    抽成模块级函数是为了让「卸载（剥标记）」与「安装（剥旧标记再插）」共用同一份
    行级状态机 —— 两份实现各写一遍迟早会在缺 END 的边角上分叉，而那条路径一旦
    走错就是模板尾部被静默删光。
    """
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

    return ''.join(kept), removed, unterminated


def _patch_template(template_path: Path, block: str, log: Logger, result: dict[str, Any], plugin_root: Path) -> None:
    name = template_path.name
    if not template_path.is_file():
        if name in REQUIRED_TEMPLATES:
            result['warnings'].append(f'必备模板不存在：{template_path}')
        else:
            result['templates_skipped'].append(name)
        return

    try:
        raw = template_path.read_bytes()
    except OSError as exc:
        # 单个模板被占用（宿主读、杀软扫描、编辑器开着）不该让整轮补丁中止：
        # 其余模板照常打，这里只记录并跳过这一个。以前的写法会让 read_bytes 的
        # PermissionError 穿出 _run，结果是「一个模板没写成，全部模板都没打补丁」。
        message = f'{name} 读取失败，跳过（{exc}）'
        result['warnings'].append(message)
        log('warning', message)
        return
    has_bom = raw.startswith(b'\xef\xbb\xbf')
    body = raw[3:] if has_bom else raw
    try:
        text = body.decode('utf-8')
    except UnicodeDecodeError as exc:
        message = f'{name} 不是 UTF-8，跳过（{exc}）'
        result['warnings'].append(message)
        log('warning', message)
        return

    stripped_text, removed, unterminated = strip_marker_lines(text)
    kept = _split_keep_eol(stripped_text)
    eol = _detect_eol(text)
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

    # 2b) 上下文守卫（审查 P1）：ANCHOR_RE 只认 <link ... dark-mode.css>，
    # 不辨它落在 HTML 还是内联 <script> 里。恶意/坏掉的模板可以把这行藏进
    # <script> 字符串，插入后补丁块会变成脚本的一部分 —— 页面报语法错，
    # 而写回校验（哨兵/标记计数）依然全过。所以锚点落在 <script> 区间内就跳过。
    joined = ''.join(kept)
    anchor_offset = sum(len(line) for line in kept[:anchor])
    lowered = joined.lower()
    script_open = lowered.rfind('<script', 0, anchor_offset)
    script_close = lowered.rfind('</script', 0, anchor_offset)
    if script_open >= 0 and script_open > script_close:
        message = f'{name}：dark-mode.css 锚点落在 <script> 区间内（HTML 结构异常），跳过以免写坏脚本'
        result['warnings'].append(message)
        log('warning', message)
        return

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

    # 5) 备份「原始模板」（= 剥掉旧标记后的内容，而不是已带标记的当前文件）。
    #    这样重复打补丁时命中的是同一份 pristine 备份，不会每换一次资源哈希就
    #    多写一份无意义的「已打补丁」副本 —— 既省磁盘，也避免备份目录不可写时
    #    把「本来已经能回滚」的模板判成备份失败而拒绝修补。
    pristine_text = ''.join(kept)
    pristine_payload = (
        b'\xef\xbb\xbf' + pristine_text.encode('utf-8') if has_bom else pristine_text.encode('utf-8')
    )
    if not _backup_once(template_path, pristine_payload, plugin_root, log):
        detail = _BACKUP_ERRORS[-1] if _BACKUP_ERRORS else '原因未知'
        message = f'{name}：原始模板备份失败（{detail}），已放弃打补丁（模板保持原样）'
        result['warnings'].append(message)
        log('warning', message)
        return

    # 6) 原子写回，保持 BOM 状态
    payload = (b'\xef\xbb\xbf' + new_text.encode('utf-8')) if has_bom else new_text.encode('utf-8')
    try:
        _atomic_write(template_path, payload)
    except OSError as exc:
        message = f'{name}：写回失败（{exc}），模板保持原样'
        result['warnings'].append(message)
        log('warning', message)
        return

    # 7) 写回后复核；失败立刻用内存里的原文回滚，不留半坏状态。
    try:
        after = template_path.read_text(encoding='utf-8-sig')
    except OSError as exc:
        after = ''
        log('error', f'{name}：写回后读取失败（{exc}）')
    if JINJA_SENTINEL not in after or after.count(MARKER_BEGIN) != 1 or after.count(MARKER_END) != 1:
        try:
            _atomic_write(template_path, raw)
            restored = '已用原始字节回滚'
        except OSError as exc:
            restored = (
                f'回滚同样失败（{exc}），请用 {backup_root(plugin_root)} 里的备份手工恢复'
            )
        message = f'{name}：写回后复核失败，{restored}'
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


def _backup_candidates(plugin_root: Path) -> list[Path]:
    """备份落点候选目录（按优先级）。

    实测：部分宿主/安全软件组合下，插件子进程会失去对
    ``%LOCALAPPDATA%\\N.E.K.O`` 的写权限（PermissionError）；若把它当成唯一落点，
    「备份成功才允许改模板」这条硬规则就会退化成「永远无法打补丁」。
    所以依次尝试：LOCALAPPDATA → 插件根 → 系统临时目录。
    """
    override = os.environ.get('NEKO_NTS_BACKUP_DIR')
    if override:
        return [Path(override)]
    candidates: list[Path] = [backup_root(plugin_root)]
    plugin_local = plugin_root / BACKUP_DIR_NAME
    if plugin_local not in candidates:
        candidates.append(plugin_local)
    temp_dir = Path(tempfile.gettempdir()) / 'neko-theme-studio-backup'
    if temp_dir not in candidates:
        candidates.append(temp_dir)
    return candidates


def _backup_once(template_path: Path, raw: bytes, plugin_root: Path, log: Logger) -> bool:
    """备份原始模板；返回是否已有可用备份。

    审查 P1：备份失败原本只记 warning 继续写，等于拿「唯一可回滚的副本」去冒险 ——
    写了模板却没备份，用户想回退就只剩重装应用。现在备份失败就拒绝打补丁。
    传入的 ``raw`` 应是**原始模板字节**（剥掉 NTS 标记后的内容），这样重复打补丁
    会命中同一份备份，不必每次资源哈希变化都新写一份。
    """
    digest = _sha8(raw)
    pattern = f'{template_path.name}.pristine-{digest}.*.bak'
    for backup_dir in _backup_candidates(plugin_root):
        try:
            backup_dir.mkdir(parents=True, exist_ok=True)
            if list(backup_dir.glob(pattern)):
                return True
            stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
            target = backup_dir / f'{template_path.name}.pristine-{digest}.{stamp}.bak'
            _atomic_write(target, raw)
            if not target.is_file() or target.stat().st_size != len(raw):
                raise OSError(f'校验失败（目标 {target}，期望 {len(raw)} 字节）')
            log('info', f'已备份原始模板：{target.name}（{len(raw)} 字节）')
            return True
        except OSError as exc:
            _BACKUP_ERRORS.append(f'{template_path.name} @ {backup_dir}: {type(exc).__name__}: {exc}')
            log('warning', f'备份目录不可用（{backup_dir}）：{exc}')
            continue
    log('error', '所有备份目录都不可写，已跳过打补丁')
    return False

# ---------------------------------------------------------------------------
# 卸载 / 恢复（0.15.5）
# ---------------------------------------------------------------------------
# 0.15.4 及以前，「卸载应用侧补丁」只能靠仓库根目录的 uninstall.ps1 —— 而那个脚本
# 从来不在 .neko-plugin 包里（插件市场只装 plugin/ 子树）。结果是：用户从市场装了插件，
# 想干净卸载时既找不到脚本、面板里也没有入口，只能手工去改 templates/*.html。
# 这一组函数把同一件事搬到插件内部，并让「停止自愈」这件事第一次真正可执行：
#   1. detach：写停止标记 → 剥离所有模板里的 NTS 段 → 备份并删除两件套；
#   2. restore：删停止标记 → 走一遍 ensure_app_patch 把两件套与标记装回去。
# 两者都幂等，都可以重复点。

BOM_BYTES = bytes([0xEF, 0xBB, 0xBF])


def is_disabled() -> bool:
    """用户是否已「卸载应用侧补丁」（停止自愈标记存在）。"""
    flag = disabled_flag_path()
    if flag is None:
        return False
    try:
        return flag.is_file()
    except OSError:
        return False


def _write_disable_flag(log: Logger) -> Path | None:
    flag = disabled_flag_path()
    if flag is None:
        log('warning', '无法确定卸载标记路径（LOCALAPPDATA 未设置），本次卸载不会跨重启保持')
        return None
    try:
        flag.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().isoformat(timespec='seconds')
        _atomic_write(flag, ('disabled by theme studio panel at ' + stamp + '\n').encode('utf-8'))
        return flag
    except OSError as exc:
        log('warning', '写卸载标记失败（' + str(exc) + '）；本次仍会剥离已装载的补丁，但重开应用后可能被重新安装')
        return None


def _remove_disable_flag(log: Logger) -> bool:
    flag = disabled_flag_path()
    if flag is None:
        return False
    try:
        if flag.is_file():
            flag.unlink()
        return True
    except OSError as exc:
        log('warning', '删除卸载标记失败（' + str(exc) + '）')
        return False


def _uninstall_backup_dir(plugin_root: Path) -> Path:
    return backup_root(plugin_root) / 'static-uninstalled'


def detach_app_patch(plugin_root: Path, log: Logger | None = None) -> dict[str, Any]:
    """从应用里摘掉主题：写停止标记、剥离模板标记、删除两件套（先备份）。"""
    log = log or _noop_log
    result: dict[str, Any] = {
        'ok': False,
        'disabled': True,
        'flag': None,
        'app_root': None,
        'templates_cleared': [],
        'templates_untouched': [],
        'templates_failed': [],
        'assets_removed': [],
        'assets_backed_up': [],
        'warnings': [],
        'search_paths': [],
    }

    flag = _write_disable_flag(log)
    result['flag'] = str(flag) if flag is not None else None

    tried: list[str] = []
    app_root = find_app_root(plugin_root, tried)
    result['search_paths'] = tried
    if app_root is None:
        message = ('未能定位 N.E.K.O 安装根（resources/bin/templates），未改动模板与资源；'
                   '停止标记已写，下次启动不会再自愈')
        result['warnings'].append(message)
        log('warning', message)
        result['ok'] = flag is not None
        return result

    result['app_root'] = str(app_root)
    bin_dir = app_root / 'resources' / 'bin'
    static_dir = bin_dir / 'static'
    template_dir = bin_dir / 'templates'

    for template_path in _discover_templates(template_dir):
        # _discover_templates 会把必备模板（index/chat）排在前面，即使它们并不存在。
        # 卸载时「本来就没有这一页」不是失败，安静跳过（否则 ok 永远为 False）。
        if not template_path.is_file():
            continue
        name = template_path.name
        try:
            raw = template_path.read_bytes()
        except OSError as exc:
            result['templates_failed'].append(name)
            result['warnings'].append(name + ' 读取失败，未改动（' + str(exc) + '）')
            continue
        has_bom = raw.startswith(BOM_BYTES)
        body = raw[3:] if has_bom else raw
        try:
            text = body.decode('utf-8')
        except UnicodeDecodeError:
            result['templates_failed'].append(name)
            result['warnings'].append(name + ' 不是 UTF-8，未改动')
            continue
        new_text, removed, unterminated = strip_marker_lines(text)
        if removed == 0 and not unterminated:
            result['templates_untouched'].append(name)
            continue
        payload = new_text.encode('utf-8')
        if has_bom:
            payload = BOM_BYTES + payload
        try:
            # 剥离前留一份带标记的副本：万一剥离写坏，还能照着它手工恢复。
            _backup_uninstall_copy(plugin_root, template_path, raw, log)
            _atomic_write(template_path, payload)
            result['templates_cleared'].append(name)
        except OSError as exc:
            result['templates_failed'].append(name)
            result['warnings'].append(name + ' 写回失败（' + str(exc) + '）')

    for rel in (Path('neko-theme-studio.js'), Path('css') / 'neko-theme-studio.css'):
        target = static_dir / rel
        try:
            if not target.is_file():
                continue
            data = target.read_bytes()
            backup = _uninstall_backup_dir(plugin_root) / rel
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_bytes(data)
            result['assets_backed_up'].append(str(backup))
            target.unlink()
            result['assets_removed'].append(str(target))
        except OSError as exc:
            result['warnings'].append(str(target) + ' 删除失败（' + str(exc) + '）')

    result['ok'] = not result['templates_failed']
    if result['ok']:
        log('info', '应用侧补丁已卸载：清理 ' + str(len(result['templates_cleared'])) + ' 个模板、删除 '
            + str(len(result['assets_removed'])) + ' 个资源文件；重开应用后主题不再出现')
    else:
        log('warning', '应用侧补丁卸载不完整：' + ', '.join(result['templates_failed']))
    return result


def _backup_uninstall_copy(plugin_root: Path, template_path: Path, raw: bytes, log: Logger) -> None:
    """卸载前把「带标记的当前文件」另存一份，便于人工恢复。失败不阻断卸载。"""
    try:
        target = _uninstall_backup_dir(plugin_root) / 'templates' / template_path.name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file():
            target.write_bytes(raw)
    except OSError as exc:
        log('warning', '卸载备份 ' + template_path.name + ' 失败（' + str(exc) + '），继续卸载')


def restore_app_patch(plugin_root: Path, log: Logger | None = None) -> dict[str, Any]:
    """重新装上应用侧补丁：删停止标记，然后走一遍幂等自愈。"""
    log = log or _noop_log
    removed = _remove_disable_flag(log)
    result = ensure_app_patch(plugin_root, log)
    result['flag_removed'] = removed
    return result
