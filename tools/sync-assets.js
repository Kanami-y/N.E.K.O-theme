#!/usr/bin/env node
/**
 * sync-assets.js -- keep the two deployed copies of the app-side loader/CSS in
 * lockstep with the single source of truth:
 *
 *   source: plugin/static/loader/neko-theme-studio.css
 *   source: plugin/static/loader/neko-theme-studio.js
 *
 *   target: app/css/neko-theme-studio.css              (manual install layout)
 *   target: app-patch/files/css/neko-theme-studio.css  (app-patch layout)
 *   target: app/neko-theme-studio.js                   (manual install layout)
 *   target: app-patch/files/neko-theme-studio.js       (app-patch layout)
 *
 * The plugin startup (_app_patch.py) also refreshes resources/bin/static from
 * the packaged loader; this script only maintains the repo copies. It probes
 * every target path first, prints the matrix, then writes only drifted files
 * atomically (temp file + rename).
 *
 * Usage:
 *   node tools/sync-assets.js            # copy source -> all targets
 *   node tools/sync-assets.js --check    # sha256 compare, exit 1 on drift (CI)
 *   node tools/sync-assets.js --root <dir>
 *   node tools/sync-assets.js --quiet
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
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
      console.log('usage: node tools/sync-assets.js [--check] [--root <dir>] [--quiet]');
      process.exit(0);
    } else {
      throw new Error('未知参数: ' + a);
    }
  }
  return opts;
}

function writeAtomic(file, data) {
  var tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    fs.renameSync(tmp, file);
  }
}

// The one asset source plus the real targets verified by hand in this repo.
var MATRIX = [
  {
    src: 'plugin/static/loader/neko-theme-studio.css',
    targets: [
      'app/css/neko-theme-studio.css',
      'app-patch/files/css/neko-theme-studio.css'
    ]
  },
  {
    src: 'plugin/static/loader/neko-theme-studio.js',
    targets: [
      'app/neko-theme-studio.js',
      'app-patch/files/neko-theme-studio.js'
    ]
  }
];

function main() {
  var opts = parseArgs(process.argv.slice(2));
  var repoRoot = opts.root ? path.resolve(opts.root) : path.resolve(__dirname, '..');

  var rows = [];
  var errors = [];
  MATRIX.forEach(function (pair) {
    var srcAbs = path.join(repoRoot, pair.src);
    if (!fs.existsSync(srcAbs)) {
      errors.push('缺少资产源: ' + pair.src);
      return;
    }
    var srcBuf = fs.readFileSync(srcAbs);
    var srcSha = sha256(srcBuf);
    pair.targets.forEach(function (rel) {
      var dstAbs = path.join(repoRoot, rel);
      var row = {
        src: pair.src,
        dst: rel,
        srcSha: srcSha,
        srcSize: srcBuf.length,
        exists: fs.existsSync(dstAbs),
        dirExists: fs.existsSync(path.dirname(dstAbs)),
        drift: true,
        dstSha: '',
        dstSize: 0
      };
      if (row.exists) {
        var dstBuf = fs.readFileSync(dstAbs);
        row.dstSha = sha256(dstBuf);
        row.dstSize = dstBuf.length;
        row.drift = row.dstSha !== srcSha;
      }
      if (!row.dirExists) {
        errors.push('目标目录不存在（布局与预期不符，拒绝凭空创建）: ' + path.dirname(rel));
      }
      row.buf = srcBuf;
      row.dstAbs = dstAbs;
      rows.push(row);
    });
  });

  if (!opts.quiet) {
    console.log('资产同步矩阵（唯一源 = plugin/static/loader/）:');
    var fmt = function (n) { return String(n); };
    console.log('  ' + '源'.padEnd(38) + ' ' + 'sha8'.padEnd(9) + ' ' + 'size'.padEnd(7) + ' -> 目标');
    rows.forEach(function (r) {
      console.log('  ' + r.src.padEnd(38) + ' ' + r.srcSha.slice(0, 8).padEnd(9) + ' ' +
        fmt(r.srcSize).padEnd(7) + ' -> ' + r.dst +
        (r.exists ? (r.drift ? '  [DRIFT]' : '  [same]') : '  [MISSING]'));
    });
  }

  if (errors.length) {
    errors.forEach(function (e) { console.error('ERROR ' + e); });
    process.exit(2);
  }

  var drift = rows.filter(function (r) { return r.drift; });
  if (opts.check) {
    if (drift.length === 0) {
      if (!opts.quiet) { console.log('OK: 4 个目标与源 sha256 全部一致。'); }
      process.exit(0);
    }
    drift.forEach(function (r) {
      console.error('DRIFT ' + r.dst + '  (' +
        (r.exists ? ('src ' + r.srcSha.slice(0, 8) + ' vs dst ' + r.dstSha.slice(0, 8)) : '目标缺失') + ')');
    });
    console.error('资产漂移：先跑 node tools/sync-assets.js。');
    process.exit(1);
  }

  drift.forEach(function (r) {
    writeAtomic(r.dstAbs, r.buf);
  });
  if (!opts.quiet) {
    if (drift.length === 0) { console.log('OK: 无需改动。'); }
    else {
      console.log('已同步 ' + drift.length + ' 个文件:');
      drift.forEach(function (r) { console.log('  ' + r.dst); });
    }
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('sync-assets: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
}
