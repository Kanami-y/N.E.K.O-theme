/*!
 * find-rules.js -- extract native CSS rules for target selectors, with specificity and !important.
 *
 *   node find-rules.js <css-file> <token> [<token> ...]
 *
 * Why: :root:root body <SEL> is (0,3,1). Some native rules beat that, which shows up as
 * "the sentinel value had no effect". This prints the actual competing selectors so the
 * generator can be told exactly what it must outrank -- instead of guessing.
 */
'use strict';
var fs = require('fs');

function specOf(sel) {
  /* crude but adequate: count #id, .class/[attr]/:pseudo-class, element/::pseudo-element
     in the highest-specificity compound of a comma-separated selector list */
  var parts = sel.split(',').map(function (s) { return s.trim(); });
  var best = { a: 0, b: 0, c: 0, s: '' };
  parts.forEach(function (p) {
    var s = p.replace(/"[^"]*"|'[^']*'/g, '');
    var a = (s.match(/#[A-Za-z_][\w-]*/g) || []).length; s = s.replace(/#[A-Za-z_][\w-]*/g, ' ');
    var b = (s.match(/\[[^\]]*\]/g) || []).length; s = s.replace(/\[[^\]]*\]/g, ' ');
    var pcs = s.match(/:[a-zA-Z-]+(\([^)]*\))?/g) || [];
    var pe = pcs.filter(function (x) { return x.indexOf('::') === 0; });
    b += pcs.length - pe.length; var c = pe.length; s = s.replace(/:[a-zA-Z-]+(\([^)]*\))?/g, ' ');
    b += (s.match(/\.[A-Za-z_][\w-]*/g) || []).length; s = s.replace(/\.[A-Za-z_][\w-]*/g, ' ');
    c += (s.match(/[a-zA-Z][\w-]*/g) || []).length;
    if (a > best.a || (a === best.a && (b > best.b || (b === best.b && c > best.c)))) best = { a: a, b: b, c: c, s: p };
  });
  return best;
}

/* Split a stylesheet into top-level rules without a full parser: track brace depth, and
   remember @media/@supports conditions so we can report them. */
function parseRules(css) {
  var rules = [], i = 0, n = css.length;
  var stack = [];
  while (i < n) {
    var ch = css[i];
    if (ch === '/' && css[i + 1] === '*') { var e = css.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === '{') {
      stack.push(i); i++; continue;
    }
    if (ch === '}') {
      var start = stack.pop();
      if (start !== undefined) {
        var prelude = css.slice(stack.length ? stack[stack.length - 1] + 1 : 0, start).trim();
        var lastBrace = prelude.lastIndexOf('}');
        var sel = css.slice(start === 0 ? 0 : (function () {
          var depth = 0, j = start - 1;
          for (; j >= 0; j--) { if (css[j] === '}') depth++; else if (css[j] === '{') { if (depth === 0) break; depth--; } }
          return j + 1;
        })(), start).trim();
        rules.push({ sel: sel, body: css.slice(start + 1, i), depth: stack.length });
      }
      i++; continue;
    }
    i++;
  }
  return rules;
}

var args = process.argv.slice(2);
var file = args[0];
var tokens = args.slice(1);
var css = fs.readFileSync(file, 'utf8');
var rules = parseRules(css);

tokens.forEach(function (tok) {
  console.log('================ ' + tok + ' ================');
  var found = 0;
  rules.forEach(function (r) {
    if (r.sel.indexOf(tok) < 0) return;
    /* only report rules whose *last* compound contains the token (that is what can style it) */
    var sp = specOf(r.sel);
    var body = r.body.replace(/\s+/g, ' ').trim();
    if (body.length > 400) body = body.slice(0, 400) + ' ...';
    var imp = /!important/.test(body);
    found++;
    console.log('  spec(' + sp.a + ',' + sp.b + ',' + sp.c + ')' + (imp ? ' [has !important]' : '                    ') +
                '  ' + r.sel);
    console.log('      ' + body);
  });
  if (!found) console.log('  (no rule mentions this token)');
  console.log('');
});
