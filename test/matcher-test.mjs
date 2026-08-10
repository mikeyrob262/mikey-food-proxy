// The local-table matcher, tested against the exact failures found in the diagnostic.
//
// The bug that mattered was not "weak matching" - it was that a ONE-LETTER token could prefix-match
// a whole word. Chick-fil-A normalises to ["chick","fil","a"], and the old rule asked "does the
// query token START WITH the target token", so the token "a" matched every query beginning with a:
// asparagus, almonds, apple, avocado all returned chicken nuggets and waffle fries.
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

const M = new Function(constLine('MIN_PREFIX_TOKEN') + ex('normalizeQ') + ex('stripPlural') + ex('fuzzyTokenMatch')
  + ';return {normalizeQ,stripPlural,fuzzyTokenMatch};')();

let fails = 0;
const R = '\x1b[31m', G = '\x1b[32m', C = '\x1b[36m', X = '\x1b[0m';
const check = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++;
  console.log('  ' + (ok ? G + 'PASS' + X : R + 'FAIL' + X) + '  ' + label + (ok ? '' : '   got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want))); };

const CFA = 'Chicken Sandwich Chick-fil-A';
const WAFFLE = 'Waffle Fries (Medium) Chick-fil-A';

console.log('\n' + C + '=== the one-letter token bug ===' + X);
check('"asparagus" no longer matches Chick-fil-A', M.fuzzyTokenMatch('asparagus', CFA), false);
check('"almonds" no longer matches Chick-fil-A', M.fuzzyTokenMatch('almonds', CFA), false);
check('"apple" no longer matches waffle fries', M.fuzzyTokenMatch('apple', WAFFLE), false);
check('"avocado" no longer matches Chick-fil-A', M.fuzzyTokenMatch('avocado', CFA), false);
// The single-letter token must still match when it IS the query - "a" is a real, if useless, search.
check('an exact one-letter query still matches its own token', M.fuzzyTokenMatch('a', CFA), true);

console.log('\n' + C + '=== real matches still work ===' + X);
check('"chicken" matches the chicken sandwich', M.fuzzyTokenMatch('chicken', CFA), true);
check('"chicken sandwich" matches', M.fuzzyTokenMatch('chicken sandwich', CFA), true);
check('"chick fil a" matches the brand', M.fuzzyTokenMatch('chick fil a', CFA), true);
check('"waffle" matches waffle fries', M.fuzzyTokenMatch('waffle', WAFFLE), true);
check('"fries" matches (plural handled)', M.fuzzyTokenMatch('fries', WAFFLE), true);
check('"nugget" prefix-matches "nuggets"', M.fuzzyTokenMatch('nugget', 'Chicken Nuggets (8ct) Chick-fil-A'), true);
check('every query token must match, not just one', M.fuzzyTokenMatch('chicken asparagus', CFA), false);

console.log('\n' + C + '=== stripPlural no longer mangles non-plurals ===' + X);
// The old chain was .replace(/(ies)$/,'y').replace(/(es)$/,'').replace(/s$/,'')
check('"cheese" is not turned into "chee"', M.stripPlural('cheese'), 'cheese');
// "molasses" ends in "es", so the ss-guard does not fire and it becomes "molasse". That is fine and
// is not what the guard is for: the old chain turned it into "molas". What has to hold is that both
// sides of a comparison normalise the SAME way, so the word still matches itself.
check('"molasses" is no longer cut to "molas"', M.stripPlural('molasses') === 'molas', false);
check('...and still matches itself after normalising', M.fuzzyTokenMatch('molasses', 'Molasses, blackstrap'), true);
check('"glasses" and "glass" do not collide', M.stripPlural('glass') === M.stripPlural('glasses'), false);
check('"almonds" -> "almond"', M.stripPlural('almonds'), 'almond');
check('"fries" -> "fry"', M.stripPlural('fries'), 'fry');
check('"oats" -> "oat"', M.stripPlural('oats'), 'oat');
check('short words are left alone', M.stripPlural('ice'), 'ice');

console.log('\n' + C + '=== the whole point: cheese matches cheese ===' + X);
check('"cheese" matches a cheese product', M.fuzzyTokenMatch('cheese', 'Cheese Pizza Slice'), true);
check('"cheese slice" matches', M.fuzzyTokenMatch('cheese slice', 'Cheese Pizza Slice'), true);
check('"cheese" does not match a chicken sandwich', M.fuzzyTokenMatch('cheese', CFA), false);

console.log(fails ? '\n' + R + 'matcher: ' + fails + ' FAILED' + X + '\n' : '\n' + G + 'matcher: all checks passed' + X + '\n');
process.exit(fails ? 1 : 0);
