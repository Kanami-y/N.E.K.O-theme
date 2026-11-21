#!/usr/bin/env node
/**
 * gen-version.js -- derive one version from plugin/plugin.toml and write it into
 * the three places that must never drift:
 *
 *   plugin/build_info.py        PLUGIN_VERSION = "x.y.z"
 *   plugin/pyproject.toml       version = "x.y.z"          (first occurrence, [project])
 *   plugin/static/index.html    ?v=<version>-<hash8> on every local css/js reference
 *                               and the visible text "插件 vx.y.z"
 *
 * <hash8> is the first 8 hex chars of the sha256 of the referenced file's bytes,
 * so a content change busts the immutable /static cache even when the version
 * was not bumped (48911 answers /static/*?v=... with max-age=31536000, immutable).
 *
 * Usage:
 *   node tools/gen-version.js                 # rewrite the three files
 *   node tools/gen-version.js --check         # exit 1 if any file is out of sync (CI)
 *   node tools/gen-version.js --root <dir>    # operate on a copy (tests)
 *   node tools/gen-version.js --quiet
 *
 * The single source of truth is plugin/plugin.toml; this script never bumps the
 * version itself. It only touches the three files above -- nothing else.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function hash8(buf) {
  return sha256(buf).slice(0, 8);
}

function parseArgs(argv) {
  var opts = { check: false, quiet: false, root: '' };
  for (var i = 0; i < argv.length; i += 1) {
    var a = argv[i];
    if (a === '--check' || a === '-c') { opts.check = true; }
    else if (a === '--quiet' || a === '-q') { opts.quiet = true; }
    else if (a === '--root') {
      opts.root = argv[i + 1] || '';
      i += 1;
      if (!opts.root) { throw new Error('--root 需要一个目录参数'); }
    } else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/gen-version.js [--check] [--root <dir>] [--quiet]');
      process.exit(0);
    } else {
      throw new Error('未知参数: ' + a);
    }
  }
  return opts;
}

function readUtf8(file) {
  var buf = fs.readFileSync(file);
  var hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  var text = hasBom ? buf.slice(3).toString('utf8') : buf.toString('utf8');
  return { text: text, hasBom: hasBom, bytes: buf };
}

function writeUtf8Atomic(file, text, hasBom) {
  var data = hasBom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    : Buffer.from(text, 'utf8');
  var tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    fs.renameSync(tmp, file);
  }
}

function readVersion(pluginToml) {
  var text = readUtf8(pluginToml).text;
  var m = /^\s*version\s*=\s*"([^"]+)"/m.exec(text);
  if (!m) {
    throw new Error('plugin/plugin.toml 里找不到 version = "x.y.z"');
  }
  var ver = m[1];
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ver)) {
    throw new Error('plugin/plugin.toml 的 version 不是语义化版本: ' + ver);
  }
  return ver;
}

function replaceLine(text, re, replacement, label) {
  if (!re.test(text)) {
    throw new Error('找不到要改写的行: ' + label);
  }
  re.lastIndex = 0;
  return text.replace(re, replacement);
}

function buildBuildInfo(file, version) {
  var f = readUtf8(file);
  var re = /^(\s*PLUGIN_VERSION\s*=\s*")[^"]+(")/m;
  var next = replaceLine(f.text, re, '$1' + version + '$2', 'plugin/build_info.py: PLUGIN_VERSION');
  return { file: file, old: f, next: next, changed: next !== f.text };
}

function buildPyproject(file, version) {
  var f = readUtf8(file);
  // only the first `version = "..."` (the [project] one; plugin.toml has its own copy)
  var re = /^(\s*version\s*=\s*")[^"]+(")/m;
  var next = replaceLine(f.text, re, '$1' + version + '$2', 'plugin/pyproject.toml: version');
  return { file: file, old: f, next: next, changed: next !== f.text };
}

function buildIndexHtml(file, staticDir, version) {
  var f = readUtf8(file);
  var text = f.text;
  var problems = [];

  // 1) every local href/src that carries ?v= gets <version>-<sha256(file)8>
  text = text.replace(/((?:href|src)\s*=\s*["'])([^"'?#]+)\?v=([^"']*)(["'])/g,
    function (all, head, url, q, tail) {
      if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(url)) { return all; }
      var rel = url.replace(/^\.\//, '').replace(/^\/+/, '');
      var abs = path.resolve(staticDir, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        problems.push('引用的文件不存在，无法计算内容哈希: ' + url);
        return all;
      }
      var h = hash8(fs.readFileSync(abs));
      return head + url + '?v=' + version + '-' + h + tail;
    });

  // 2) the visible panel version tag: 插件 vX.Y.Z
  text = text.replace(/插件\s*v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g, '插件 v' + version);

  if (problems.length) {
    throw new Error(problems.join('\n'));
  }
  return { file: file, old: f, next: text, changed: text !== f.text };
}

function firstDiffLine(a, b) {
  var la = a.split('\n');
  var lb = b.split('\n');
  var n = Math.max(la.length, lb.length);
  for (var i = 0; i < n; i += 1) {
    if (la[i] !== lb[i]) {
      return { line: i + 1, expected: la[i], actual: lb[i] };
    }
  }
  return null;
}

function main() {
  var opts = parseArgs(process.argv.slice(2));
  var repoRoot = opts.root
    ? path.resolve(opts.root)
    : path.resolve(__dirname, '..');
  var pluginDir = path.join(repoRoot, 'plugin');
  var staticDir = path.join(pluginDir, 'static');

  var version = readVersion(path.join(pluginDir, 'plugin.toml'));
  var results = [
    buildBuildInfo(path.join(pluginDir, 'build_info.py'), version),
    buildPyproject(path.join(pluginDir, 'pyproject.toml'), version),
    buildIndexHtml(path.join(staticDir, 'index.html'), staticDir, version)
  ];

  var drift = results.filter(function (r) { return r.changed; });
  if (!opts.quiet) {
    var rel = function (p) { return path.relative(repoRoot, p).replace(/\\/g, '/'); };
    console.log('版本源 plugin/plugin.toml: v' + version);
    results.forEach(function (r) {
      console.log('  ' + (r.changed ? 'DRIFT ' : 'OK    ') + rel(r.file));
    });
  }

  if (opts.check) {
    if (drift.length === 0) {
      if (!opts.quiet) { console.log('OK: 版本字符串全部一致。'); }
      process.exit(0);
    }
    drift.forEach(function (r) {
      var d = firstDiffLine(r.next, r.old.text);
      console.error('MISMATCH ' + r.file + (d ? ('  第 ' + d.line + ' 行') : ''));
      if (d) {
        console.error('  expected: ' + d.expected);
        console.error('  actual  : ' + d.actual);
      }
    });
    console.error('版本不一致：先跑 node tools/gen-version.js（或在临时副本上生成）。');
    process.exit(1);
  }

  drift.forEach(function (r) {
    writeUtf8Atomic(r.file, r.next, r.old.hasBom);
  });
  if (!opts.quiet) {
    if (drift.length === 0) { console.log('OK: 无需改动。'); }
    else { console.log('已更新 ' + drift.length + ' 个文件 → v' + version); }
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('gen-version: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
}
