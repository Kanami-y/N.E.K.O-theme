"""离线加载 plugin/__init__.py（不依赖宿主 SDK、不依赖网络）。

测试需要的是「后端校验器」这类纯函数，而 plugin/__init__.py 顶部 import 了
`plugin.sdk.plugin` —— 那是宿主运行时才有的包。这里把 import 语句替换成一个
最小桩，然后 exec 模块源码，返回模块命名空间。

只给测试用；生产代码永远走真实 SDK。
"""

from __future__ import annotations

from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
ROOT = PLUGIN_DIR.parent
# 市场校验会把整个 plugin/ 目录挂到 <neko>/plugin/plugins/<id>/ 下，
# 那时仓库级的 test/、tools/、app/ 都不存在 —— 这类测试只能跳过。
HAS_REPO_TREE = (ROOT / "tools").is_dir()
SOURCE_PATH = PLUGIN_DIR / "__init__.py"


def repo_text(*parts: str) -> str:
    """读仓库级文件；市场校验环境没有仓库树时返回空串（对应测试由 setUpModule 跳过）。"""
    path = ROOT.joinpath(*parts)
    return path.read_text(encoding="utf-8") if path.is_file() else ""


_IMPORT_HEAD = "from plugin.sdk.plugin import ("

_STUB = '''
class SdkError(Exception):
    pass


class NekoPluginBase:
    pass


def _passthrough(*args, **kwargs):
    # 两种用法都要支持：
    #   @lifecycle(id="startup")   → 带 kwargs，返回装饰器
    #   @neko_plugin              → 直接套在类/函数上，原样返回
    # 少了第二个分支，`NekoThemeStudioPlugin` 在测试里会变成一个函数（实例化就
    # TypeError: object.__new__(X): X is not a type object），于是这个类永远没被
    # 任何测试碰过。
    if len(args) == 1 and not kwargs and callable(args[0]):
        return args[0]

    def deco(fn):
        return fn
    return deco


class _Result:
    def __init__(self, value):
        self.value = value


def Ok(value):
    return _Result(value)


def Err(value):
    return _Result(value)


lifecycle = plugin_entry = neko_plugin = _passthrough
tr = lambda key, default=None: default  # noqa: E731
ui = type("UI", (), {"context": staticmethod(_passthrough)})
'''

_cache: dict | None = None


def load_backend() -> dict:
    """返回模块命名空间字典（带缓存）。"""
    global _cache
    if _cache is not None:
        return _cache
    source = SOURCE_PATH.read_text(encoding="utf-8")
    start = source.index(_IMPORT_HEAD)
    end = source.index(")", start) + 1
    patched = source[:start] + _STUB + source[end:]
    ns: dict = {"__name__": "nts_under_test", "__package__": None}
    exec(compile(patched, str(SOURCE_PATH), "exec"), ns)  # noqa: S102 - 测试专用
    _cache = ns
    return ns
