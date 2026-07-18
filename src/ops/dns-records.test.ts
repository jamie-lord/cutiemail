/**
 * The DNS record plan (backlog B1) — exact-output tests.
 *
 * The plan is a pure function, so the tests pin it exactly: which records exist,
 * their owner names, their values, and the rendering rules that matter on the wire
 * (TXT chunking at 255 octets — a DNS character-string ceiling, not a style
 * choice). Negative direction is covered by exactness: any wrong/missing/extra
 * record fails the deep-equality pins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dnsRecordsFor, chunkTxt, renderZone, renderNotes, mtaStsPolicy, mtaStsSection, type DnsPlanParams } from './dns-records.ts';
import { parseStsPolicy, mxAllowed } from '../transport/mta-sts.ts';

const base: DnsPlanParams = {
  domain: 'example.org',
  mailHost: 'mail.example.org',
  ips: ['192.0.2.7'],
  dkim: { selector: 'sel1', txtValue: 'v=DKIM1; k=ed25519; p=AAAA' },
  dmarcPolicy: 'quarantine',
};

test('the plan contains exactly the deliverability cluster, in entry order', () => {
  const records = dnsRecordsFor(base);
  assert.deepEqual(
    records.map((r) => [r.name, r.type, r.value]),
    [
      ['mail.example.org', 'A', '192.0.2.7'],
      ['example.org', 'MX', '10 mail.example.org.'],
      ['example.org', 'TXT', 'v=spf1 ip4:192.0.2.7 -all'],
      ['sel1._domainkey.example.org', 'TXT', 'v=DKIM1; k=ed25519; p=AAAA'],
      ['_dmarc.example.org', 'TXT', 'v=DMARC1; p=quarantine'],
    ],
  );
});

test('an IPv6 address becomes AAAA + ip6: in SPF; v4 and v6 coexist', () => {
  const records = dnsRecordsFor({ ...base, ips: ['192.0.2.7', '2001:db8::25'] });
  assert.deepEqual(
    records.filter((r) => r.type === 'A' || r.type === 'AAAA').map((r) => [r.type, r.value]),
    [['A', '192.0.2.7'], ['AAAA', '2001:db8::25']],
  );
  const spf = records.find((r) => r.name === 'example.org' && r.type === 'TXT')!;
  assert.equal(spf.value, 'v=spf1 ip4:192.0.2.7 ip6:2001:db8::25 -all');
});

test('with no IPs, SPF falls back to mx (the MX host is the sender) and the notes say to pin it', () => {
  const p = { ...base, ips: [] };
  const records = dnsRecordsFor(p);
  assert.equal(records.some((r) => r.type === 'A' || r.type === 'AAAA'), false);
  const spf = records.find((r) => r.name === 'example.org' && r.type === 'TXT')!;
  assert.equal(spf.value, 'v=spf1 mx -all');
  assert.match(renderNotes(p), /--ip <address>/);
});

test('every DMARC policy renders as published', () => {
  for (const policy of ['none', 'quarantine', 'reject'] as const) {
    const dmarc = dnsRecordsFor({ ...base, dmarcPolicy: policy }).find((r) => r.name.startsWith('_dmarc.'))!;
    assert.equal(dmarc.value, `v=DMARC1; p=${policy}`);
  }
});

test('chunkTxt splits at 255 and the chunks reassemble byte-exactly', () => {
  const long = 'x'.repeat(700);
  const chunks = chunkTxt(long);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= 255);
  assert.equal(chunks.join(''), long);
  // Control in the short direction: a value that fits stays one string.
  assert.deepEqual(chunkTxt('v=spf1 mx -all'), ['v=spf1 mx -all']);
});

test('the generated MTA-STS policy round-trips through our OWN enforcement parser (ADR 0013)', () => {
  const policy = mtaStsPolicy('mail.example.org');
  // The exact code that enforces other domains' policies on our outbound leg
  // must accept the policy we tell operators to publish for their inbound.
  const parsed = parseStsPolicy(Buffer.from(policy, 'latin1'));
  assert.equal(parsed.version, 'STSv1');
  assert.equal(parsed.mode, 'enforce');
  assert.equal(mxAllowed(parsed, 'mail.example.org'), true);
  // NEGATIVE CONTROL: a host the policy doesn't list is refused by the same parser.
  assert.equal(mxAllowed(parsed, 'evil.example.net'), false);

  // The id is a content hash: identical runs identical, changed policy changed id.
  const section = mtaStsSection(base);
  const id = /id=([0-9a-f]{12})/.exec(section)?.[1];
  assert.ok(id !== undefined);
  assert.equal(/id=([0-9a-f]{12})/.exec(mtaStsSection(base))?.[1], id);
  const other = /id=([0-9a-f]{12})/.exec(mtaStsSection({ ...base, mailHost: 'other.example.org' }))?.[1];
  assert.notEqual(other, id);
  // And the section names the well-known URL the operator must serve.
  assert.match(section, /https:\/\/mta-sts\.example\.org\/\.well-known\/mta-sts\.txt/);
});

test('renderZone quotes TXT values and splits a long one into adjacent strings', () => {
  const longKey = `v=DKIM1; k=rsa; p=${'A'.repeat(400)}`;
  const zone = renderZone(dnsRecordsFor({ ...base, dkim: { selector: 'sel1', txtValue: longKey } }));
  const dkimLine = zone.split('\n').find((l) => l.startsWith('sel1._domainkey.'))!;
  // Two adjacent quoted strings, which DNS concatenates back to the value.
  const quoted = [...dkimLine.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  assert.equal(quoted.length, 2);
  assert.equal(quoted.join(''), longKey);
  // Non-TXT records are not quoted.
  assert.match(zone, /^example\.org\.\tIN\tMX\t10 mail\.example\.org\.$/m);
  // The notes mention the PTR target.
  assert.match(renderNotes(base), /192\.0\.2\.7 -> mail\.example\.org/);
});
