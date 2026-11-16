/* Print every rule in a stylesheet whose selector mentions a token, in document order.
 * One-line bundles have no line numbers, so order index is the only way to see the cascade.
 * usage: node rule-order.js <css-file> <selector-token> [prop-filter]
 */
const fs = require('fs');
const file = process.argv[2];
const token = process.argv[3];
const propFilter = process.argv[4] || '';
const css = fs.readFileSync(file, 'utf8');

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

const rules = [];
let i = 0;
while (i < css.length) {
  // find next '{' at top level (skip @media preamble by treating at-rules generically)
  let brace = css.indexOf('{', i);
  if (brace < 0) break;
  let sel = css.slice(i, brace).trim();
  // find matching close brace
  let depth = 1, j = brace + 1;
  while (j < css.length && depth > 0) {
    const c = css[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    j++;
  }
  let body = css.slice(brace + 1, j - 1);
  if (/^@(media|supports|layer|container|scope)/i.test(sel)) {
    // recurse into nested block: treat inner rules as rules with an at-rule prefix
    const inner = body;
    let k = 0;
    while (k < inner.length) {
      const b2 = inner.indexOf('{', k);
      if (b2 < 0) break;
      const s2 = inner.slice(k, b2).trim();
      let d2 = 1, m2 = b2 + 1;
      while (m2 < inner.length && d2 > 0) {
        const c = inner[m2];
        if (c === '{') d2++;
        else if (c === '}') d2--;
        m2++;
      }
      rules.push({ sel: s2, body: inner.slice(b2 + 1, m2 - 1), at: sel });
      k = m2;
    }
  } else if (sel) {
    rules.push({ sel, body, at: '' });
  }
  i = j;
}

const hits = [];
rules.forEach((r, idx) => {
  if (r.sel.indexOf(token) < 0) return;
  const decls = stripComments(r.body).split(';').map(s => s.trim()).filter(Boolean)
    .filter(d => !propFilter || d.split(':')[0].trim().indexOf(propFilter) === 0);
  if (!decls.length) return;
  hits.push({ idx, sel: r.sel, at: r.at, decls });
});

console.log('file: ' + file);
console.log('total rules parsed: ' + rules.length);
console.log('rules mentioning "' + token + '"' + (propFilter ? ' with prop ' + propFilter : '') + ': ' + hits.length);
hits.forEach(h => {
  console.log('--- idx ' + h.idx + (h.at ? '  @' + h.at : ''));
  console.log('    ' + h.sel);
  h.decls.forEach(d => console.log('      ' + d));
});
