/**
 * The Public Suffix List algorithm, checked against the CANONICAL publicsuffix.org test
 * suite (tests/tests.txt) — embedded verbatim below. It exercises normal rules, wildcard
 * rules (*.ck, *.kobe.jp), exception rules (!www.ck, !city.kobe.jp), the default "*" rule,
 * mixed case, leading dots, an unlisted TLD, private suffixes (uk.com), and IDN in both
 * Unicode and punycode. A passing run is the negative-controlled corpus for this module:
 * each case asserts a specific registrable domain, and getting the public-suffix boundary
 * wrong changes the answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registeredDomain } from './public-suffix.ts';
import { organizationalDomain } from '../server/dmarc-inbound.ts';

// The publicsuffix.org checkPublicSuffix() corpus: "<input> <expected>", `null` = null.
const CORPUS = `
null null
COM null
example.COM example.com
WwW.example.COM example.com
.com null
.example null
.example.com null
.example.example null
example null
example.example example.example
b.example.example example.example
a.b.example.example example.example
biz null
domain.biz domain.biz
b.domain.biz domain.biz
a.b.domain.biz domain.biz
com null
example.com example.com
b.example.com example.com
a.b.example.com example.com
uk.com null
example.uk.com example.uk.com
b.example.uk.com example.uk.com
a.b.example.uk.com example.uk.com
test.ac test.ac
mm null
c.mm null
b.c.mm b.c.mm
a.b.c.mm b.c.mm
jp null
test.jp test.jp
www.test.jp test.jp
ac.jp null
test.ac.jp test.ac.jp
www.test.ac.jp test.ac.jp
kyoto.jp null
test.kyoto.jp test.kyoto.jp
ide.kyoto.jp null
b.ide.kyoto.jp b.ide.kyoto.jp
a.b.ide.kyoto.jp b.ide.kyoto.jp
c.kobe.jp null
b.c.kobe.jp b.c.kobe.jp
a.b.c.kobe.jp b.c.kobe.jp
city.kobe.jp city.kobe.jp
www.city.kobe.jp city.kobe.jp
ck null
test.ck null
b.test.ck b.test.ck
a.b.test.ck b.test.ck
www.ck www.ck
www.www.ck www.ck
us null
test.us test.us
www.test.us test.us
ak.us null
test.ak.us test.ak.us
www.test.ak.us test.ak.us
k12.ak.us null
test.k12.ak.us test.k12.ak.us
www.test.k12.ak.us test.k12.ak.us
食狮.com.cn 食狮.com.cn
食狮.公司.cn 食狮.公司.cn
www.食狮.公司.cn 食狮.公司.cn
shishi.公司.cn shishi.公司.cn
公司.cn null
食狮.中国 食狮.中国
www.食狮.中国 食狮.中国
shishi.中国 shishi.中国
中国 null
xn--85x722f.com.cn xn--85x722f.com.cn
xn--85x722f.xn--55qx5d.cn xn--85x722f.xn--55qx5d.cn
www.xn--85x722f.xn--55qx5d.cn xn--85x722f.xn--55qx5d.cn
shishi.xn--55qx5d.cn shishi.xn--55qx5d.cn
xn--55qx5d.cn null
xn--85x722f.xn--fiqs8s xn--85x722f.xn--fiqs8s
www.xn--85x722f.xn--fiqs8s xn--85x722f.xn--fiqs8s
shishi.xn--fiqs8s shishi.xn--fiqs8s
xn--fiqs8s null
`;

test('registeredDomain matches the canonical publicsuffix.org test suite', () => {
  let checked = 0;
  for (const line of CORPUS.trim().split('\n')) {
    const [inputTok, expectedTok] = line.trim().split(/\s+/);
    const input = inputTok === 'null' ? '' : inputTok!;
    const expected = expectedTok === 'null' ? null : expectedTok!;
    assert.equal(registeredDomain(input), expected, `registeredDomain(${JSON.stringify(inputTok)})`);
    checked++;
  }
  assert.ok(checked >= 70, `ran the whole corpus (${checked} cases)`);
});

test('the full PSL fixes DMARC org-domain cases the old two-label heuristic got wrong', () => {
  // A three-label public suffix: the org domain is the last THREE labels, not two. The old
  // heuristic only knew a hand-curated set; the PSL knows the whole list.
  assert.equal(organizationalDomain('mail.example.co.uk'), 'example.co.uk');
  assert.equal(organizationalDomain('a.b.example.act.edu.au'), 'example.act.edu.au'); // 4-label suffix
  // The alignment consequence: two unrelated registrants under a public suffix must NOT
  // share an organizational domain (which would be a false DMARC pass).
  assert.notEqual(organizationalDomain('alice.co.uk'), organizationalDomain('bob.co.uk'));
  assert.equal(organizationalDomain('sub.alice.co.uk'), 'alice.co.uk');
  // A plain two-label domain is its own organizational domain.
  assert.equal(organizationalDomain('example.com'), 'example.com');
  // organizationalDomain never returns null (unlike registeredDomain): a bare public
  // suffix as a From domain aligns only with itself.
  assert.equal(organizationalDomain('co.uk'), 'co.uk');
});
