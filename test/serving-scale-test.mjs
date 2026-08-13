// FDC values are PER 100 g, and the proxy was labelling them as a serving.
//
// foodNutrients[].value is per 100 g for every FDC dataType. servingSize/servingSizeUnit describe
// the LABEL serving and were read only to build the display string, so a row arrived with per-100 g
// macros under a "32g" heading. Logging one Quest protein-chip bag recorded 375 cal / 65.6 g protein
// against a real 140 / 19.
//
// AND THE DIRECTION FLIPS WITH SERVING SIZE. An OWYN shake is a ~354 g serving, so the identical
// unscaled figure UNDER-reports it by roughly the factor a 32 g bag is OVER-reported by. The bug was
// never "understating" — it was unscaled, and which way it lied depended on whether the serving sat
// above or below 100 g. Both directions are pinned below.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'api', 'food.js'), 'utf8');

function ex(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let j = src.indexOf('{', i), d = 0;
  for (; j < src.length; j++) { const c = src[j]; if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } }
  return src.slice(i, j + 1) + '\n';
}
const constLine = (n) => { const i = src.indexOf('const ' + n + ' ='); return src.slice(i, src.indexOf('\n', i)) + '\n'; };

const M = new Function(constLine('FDC_MASS_UNITS') + ex('fdcServing') + 'return {fdcServing, FDC_MASS_UNITS};')();

const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', X = '\x1b[0m';
let fails = 0;
const ok = (l, c) => { if (!c) fails++; console.log('  ' + (c ? G + 'PASS' + X : R + 'FAIL' + X) + '  ' + l); };
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.05 : tol);

// The mapper's arithmetic, applied exactly as the shipped code applies it.
function scale(per100, p) {
  const sv = M.fdcServing(p), f = sv.factor;
  const r1 = (x) => Math.round((x || 0) * f * 10) / 10;
  return { cal: Math.round((per100.cal || 0) * f), p: r1(per100.p), c: r1(per100.c), f: r1(per100.f),
           sodium: Math.round((per100.sodium || 0) * f), srv: sv.label, per100: sv.per100 };
}

console.log('\n' + Y + '=== the reported case: a 32 g bag was over-reported ===' + X);
{
  // Quest protein chips as FDC publishes them: per 100 g.
  const per100 = { cal: 437, p: 59.4, c: 25, f: 15.6, sodium: 1094 };
  const row = scale(per100, { servingSize: 32, servingSizeUnit: 'g', dataType: 'Branded' });
  ok('the label reports the real serving', row.srv === '32g');
  ok('calories land near the real 140', near(row.cal, 140, 5));
  ok('protein lands near the real 19 g', near(row.p, 19, 0.6));
  ok('...not the per-100 g 59.4 it used to report', row.p < 25);
  ok('sodium scales with everything else', near(row.sodium, 350, 12));
}

console.log('\n' + Y + '=== the same bug the other way: a 354 g shake was under-reported ===' + X);
{
  // An OWYN-shaped shake: 231 cal / 35 g protein per ~354 g serving -> per 100 g is much smaller.
  const per100 = { cal: 65, p: 9.9, c: 5.4, f: 2.5, sodium: 48 };
  const row = scale(per100, { servingSize: 354, servingSizeUnit: 'g', dataType: 'Branded' });
  ok('the label reports the real serving', row.srv === '354g');
  ok('calories climb to the real ~231', near(row.cal, 231, 6));
  ok('protein climbs to the real ~35 g', near(row.p, 35, 0.6));
  ok('...rather than the 9.9 it used to report', row.p > 30);
  ok('so the fix is SCALING, not a one-way correction',
     row.p > per100.p && scale({ cal: 437, p: 59.4 }, { servingSize: 32, servingSizeUnit: 'g' }).p < 59.4);
}

console.log('\n' + Y + '=== a serving we cannot convert is never guessed at ===' + X);
{
  const oz = M.fdcServing({ servingSize: 1, servingSizeUnit: 'oz' });
  ok('an ounce serving is not scaled', oz.factor === 1);
  ok('...and says the basis it actually reports', oz.per100 === true && /^100g/.test(oz.label));
  ok('...while still naming the label serving as context', /label serving 1 oz/.test(oz.label));
  const piece = M.fdcServing({ servingSize: 2, servingSizeUnit: 'piece' });
  ok('a piece serving is not scaled either', piece.factor === 1 && piece.per100 === true);
  const per100row = scale({ cal: 437, p: 59.4 }, { servingSize: 1, servingSizeUnit: 'oz' });
  ok('so its numbers are unchanged from FDC', per100row.cal === 437 && per100row.p === 59.4);
}

console.log('\n' + Y + '=== rows with no serving are per-100 g and now SAY so ===' + X);
{
  const none = M.fdcServing({ dataType: 'SR Legacy' });
  ok('no servingSize means no scaling', none.factor === 1);
  ok('...and the label is 100g, not "1 serving"', none.label === '100g');
  ok('...which is what SR Legacy and Foundation actually are', none.per100 === true);
  // This was the quieter half of the same misstatement and is the majority of generic results.
  ok('the old "1 serving" label is gone from the source', !/'1 serving'/.test(src));
}

console.log('\n' + Y + '=== millilitres count as a mass basis; junk does not ===' + X);
{
  ok('ml scales', M.fdcServing({ servingSize: 240, servingSizeUnit: 'ml' }).factor === 2.4);
  ok('...and is labelled ml, not g', M.fdcServing({ servingSize: 240, servingSizeUnit: 'ml' }).label === '240ml');
  ok('GRM (FDC uppercase) scales', M.fdcServing({ servingSize: 50, servingSizeUnit: 'GRM' }).factor === 0.5);
  ok('a zero serving does not divide by anything', M.fdcServing({ servingSize: 0, servingSizeUnit: 'g' }).factor === 1);
  ok('a negative serving is refused', M.fdcServing({ servingSize: -5, servingSizeUnit: 'g' }).factor === 1);
  ok('a non-numeric serving is refused', M.fdcServing({ servingSize: 'x', servingSizeUnit: 'g' }).factor === 1);
  ok('no row at all does not throw', M.fdcServing(null).factor === 1);
}

console.log('\n' + Y + '=== rounding happens ONCE, after scaling ===' + X);
{
  // Rounding per-100 g and then scaling compounds the error; the shipped mapper keeps raw values
  // and rounds at the end. Asserted on the source because the ordering is the whole point.
  ok('nutrients are collected raw', /if\(id==1008\|\|id=='208'\) cal=v/.test(src));
  ok('...not pre-rounded', !/cal=Math\.round\(v\)/.test(src));
  ok('...and protein is raw too', /id=='203'\) pro=v/.test(src));
  ok('the scale-then-round step exists', /_r1 = \(x\) => Math\.round\(\(x\|\|0\)\*_f\*10\)\/10/.test(src));
  ok('the mapper asks fdcServing for the basis', /const _sv = fdcServing\(p\)/.test(src));
  ok('and srv comes from that decision', /const srv = _sv\.label/.test(src));
}

console.log(fails ? ('\n' + R + fails + ' failed' + X) : ('\n' + G + 'serving scale: all checks passed' + X));
process.exit(fails ? 1 : 0);
