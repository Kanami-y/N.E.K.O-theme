// Extract the biggest inline <script> block from a served page and syntax-check it.
// Written because the harness page silently produced no output: with a syntax error
// nothing runs at all, not even the window.onerror handler, so the DOM dump just shows
// the original <title> and an empty <pre>. node --check on the extracted body tells us
// immediately whether that is the cause.
const fs = require('fs');
const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const re = /<script>([\s\S]*?)<\/script>/g;
let m, best = '';
while ((m = re.exec(html)) !== null) {
  if (m[1].length > best.length) best = m[1];
}
console.log('extracted inline script length =', best.length);
try {
  new Function(best);
  console.log('SYNTAX OK');
} catch (e) {
  console.log('SYNTAX ERROR:', e.message);
  // Point at the offending line by bisecting on line count.
  const lines = best.split('\n');
  for (let n = lines.length; n > 0; n--) {
    try { new Function(lines.slice(0, n).join('\n') + '\n}'.repeat(0)); }
    catch (e2) {
      if (String(e2.message).indexOf('Unexpected end') < 0) {
        console.log('  first bad line ~', n, ':', JSON.stringify(lines[n - 1]));
        break;
      }
    }
  }
}
for (const probe of ['watchdog', 'NTS-DONE', 'data-nts-payload', 'var OUT']) {
  console.log('contains', JSON.stringify(probe), '=', html.indexOf(probe) >= 0);
}
