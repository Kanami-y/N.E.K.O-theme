/*!
 * rules-for.js -- list every CSS rule whose selector mentions a token, with specificity
 * and the declarations that matter.
 *
 *   node rules-for.js <css-file> <token> [<token> ...]
 *
 * Why: measurements showed :root:root body <SEL> !important losing on a handful of
 * properties. The only way that happens is a native rule with equal-or-higher specificity
 * that is also !important. This prints those rules so the generator can be fixed with
 * evidence instead of guesses.
 *
 * A proper brace-stack walk (with string and comment skipping) is used because the chat
 * bundle is one 1.7 MB line packed with base64 @font-face payloads that break naive splits.
 */
'use strict';
var fs = require('fs');

function specOf(sel) {
  var best = { a: 0, b: 0, c: 0, s: '' };
  sel.split(',').forEach(function (p) {
    var s = p.replace(/"[^"]*"|'[^']*'/g, '"x"').trim();
    var a = (s.match(/#[\w-]+/g) || []).length; s = s.replace(/#[\w-]+/g, ' ');
    var b = 0, c = 0;
    var pcs = s.match(/::?[a-zA-Z-]+(\([^)]*\))?/g) || [];
    pcs.forEach(function (x) {
      if (x.indexOf('::') === 0) { c++; return; }
      var inner = (/^:not\(|^:is\(|^:has\(|^:where\(/.test(x)) ? x.slice(x.indexOf('(') + 1, x.lastIndexOf(')')) : '';
      if (inner) { var sub = specOf(inner); a += sub.a; b += sub.b; c += sub.c; }
      else if (x.indexOf(':where(') !== 0) b++;
    });
    s = s.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, ' ');
    b += (s.match(/\.[\w-]+/g) || []).length; s = s.replace(/\.[\w-]+/g, ' ');
    b += (s.match(/\[[^\]]*\]/g) || []).length; s = s.replace(/\[[^\]]*\]/g, ' ');
    c += (s.match(/[a-zA-Z][\w-]*/g) || []).length;
    if (a > best.a || (a === best.a && (b > best.b || (b === best.b && c > best.c)))) best = { a: a, b: b, c: c, s: p.trim() };
  });
  return best;
}

function walk(css) {
  var rules = [], stack = [], lastEnd = [0], i = 0, n = css.length;
  while (i < n) {
    var ch = css[i];
    if (ch === '/' && css[i + 1] === '*') { var e = css.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === '"' || ch === "'") { var q = ch, j = i + 1; while (j < n && css[j] !== q) { if (css[j] === '\\') j++; j++; } i = j + 1; continue; }
    if (ch === '{') {
      var sel = css.slice(lastEnd[stack.length] || 0, i).trim();
      stack.push({ sel: sel, bodyStart: i + 1 });
      lastEnd[stack.length] = i + 1;
      i++; continue;
    }
    if (ch === '}') {
      var f = stack.pop();
      if (f) {
        rules.push({ sel: f.sel, body: css.slice(f.bodyStart, i), at: stack.map(function (x) { return x.sel; }).join(' >> ') });
        lastEnd[stack.length] = i + 1;
      }
      i++; continue;
    }
    i++;
  }
  return rules;
}

var args = process.argv.slice(2);
var css = fs.readFileSync(args[0], 'utf8');
var rules = walk(css);
console.log('parsed ' + rules.length + ' rules from ' + args[0]);
args.slice(1).forEach(function (tok) {
  console.log('');
  console.log('================ ' + tok + ' ================');
  var hits = rules.filter(function (r) { return r.sel.indexOf(tok) >= 0; });
  if (!hits.length) { console.log('  (no rule mentions it)'); return; }
  hits.forEach(function (r) {
    var sp = specOf(r.sel);
    var body = r.body.replace(/\s+/g, ' ').trim();
    var hasImp = r.body.indexOf('!important') >= 0;
    console.log('  spec(' + sp.a + ',' + sp.b + ',' + sp.c + ')' + (hasImp ? ' !imp' : '      ') +
                (r.at ? '  [in ' + r.at + ']' : '') + '  ' + r.sel);
    console.log('      ' + (body.length > 700 ? body.slice(0, 700) + ' ...' : body));
  });
});
