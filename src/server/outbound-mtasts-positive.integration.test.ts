/**
 * MTA-STS enforce POSITIVE control (RFC 8461). Every other enforce test asserts a FAILURE (no
 * STARTTLS, untrusted cert, unlisted MX), so a regression that made enforce always fail would go
 * unnoticed while it silently deferred all mail to Gmail/Outlook for five days and then bounced
 * it. This proves enforce actually DELIVERS when the certificate is valid, by injecting a test CA
 * (the seam the enforce path previously lacked): a leaf whose name matches the MX host, chained
 * to that CA, over a real TLS handshake. Plus the discriminating negative: a cert that is TRUSTED
 * (same CA) but has the WRONG name still fails - proving it is the hostname check, not just trust.
 *
 * Fixtures are a throwaway CA + leaves generated for this test only (SANs: leaf = IP:127.0.0.1 +
 * DNS:mx.enforce.test; wrong = DNS:wrong.mx.test). No security value anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayOutbound } from './outbound.ts';
import { SmtpReceiver, type DeliveredMessage } from './smtp-receiver.ts';
import { parseStsPolicy } from '../transport/mta-sts.ts';

const CA_CERT = `-----BEGIN CERTIFICATE-----
MIIDGzCCAgOgAwIBAgIUfQ1DUaFBOaQcmojJA9wNRXO/S6swDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRY3V0aWVtYWlsIFRlc3QgQ0EwIBcNMjYwNzIyMTgwNzQx
WhgPMjEyNjA2MjgxODA3NDFaMBwxGjAYBgNVBAMMEWN1dGllbWFpbCBUZXN0IENB
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAph4pUSnRx711kwonV2m8
5UAKJACq1u4x7S53EyqH2SVX8s6JezuKCAe9Rq1doEEBZttEJyGd1SejQ+Cdzl23
kxWQ771wI7DAxIeabh3ACiFv+CzWcYphFqbvTMVwydmw5y5dj5LObJYUPGMrWDf8
h4fYmdMF2RRjYayuwbZgLDJ7GXz91yNp7oO/vfxw1tGNzOAacio8M6l6+GagjJle
LCrQpq3FnR5Iav9CqN7s4vThcO5BD5/aKUyTEOK2k1+BO4CxiFlg1yvvR197jR7i
ZPMfvnTVzHgyc6w98QqrabFkOEFNxHCh4fpGEdiZl8zqepXHwxSKzyTjBBGWzoPl
NQIDAQABo1MwUTAdBgNVHQ4EFgQUuhZX9JjgmzG0fYb4mdT92EMLx7QwHwYDVR0j
BBgwFoAUuhZX9JjgmzG0fYb4mdT92EMLx7QwDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAQEAeFRhy4RmgK4NF0wTQVFq7GeudbqA9ET625phAzcXbBGH
BRUGTj0BCpSQNRjIdIYQA7zlKblw9lxmOPR21Sn7M02o6J2J/sdy/9xStst5rXOF
LlEdgRsJ7kCtKtp/TRvmMfhB7gn2B/tEpHmxU73/wAGx/AOYlEZkgEtSwALcAolN
krc0Tx7rdUbbT6GuV+Xf+wz81q1sbwU+x9+kmi5CBYq8+iO4yWiEXhEQskpUqG7b
X741IgMKfNGwZST7bMLACKounhmwm5N32WV6Jn/mm1mOsmXACuD6J9EOxa2asIDl
Jk70dkIczP6Btgpr4jLFKzfOlNvo0nJKlUydNdhJvQ==
-----END CERTIFICATE-----
`;

const LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIIDKjCCAhKgAwIBAgIUDbtq6mqfB57KYBlgrjOApGuOb5IwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRY3V0aWVtYWlsIFRlc3QgQ0EwIBcNMjYwNzIyMTgwNzQx
WhgPMjEyNjA2MjgxODA3NDFaMBoxGDAWBgNVBAMMD214LmVuZm9yY2UudGVzdDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAN2qn3LgPa4iDNRm90X6347X
nbHjCd7Y5s/+is6o30vF+51UcYl77y8H6GI3MSe/gKuEtuTtwTn9IVbYo1zjUU5f
z79ncZXoOU2I6fdQ+QjAvbDsDaUT5k+hIoecJKemkhmIejmRTl4K++i2OkxXBNOc
H7Ew9Q5v3pSahMvHkw1NhK8A8wXbVH5Odv2Q+RZi+EZF0OXEl0NQfn0RuzDLnzb7
DxFZ2KtN0Kfop2qz6t4Hrl1wilr3G4se3Icg8D2Kf26V5vONnoH71L5HBaOhNNqS
RhDoQQNzZ54Uih9DSAxD34sldjlkDoBcyw1vpE3MXhBOhW+qn2Zy4t6vw8KYUJMC
AwEAAaNkMGIwIAYDVR0RBBkwF4cEfwAAAYIPbXguZW5mb3JjZS50ZXN0MB0GA1Ud
DgQWBBSD1X4wmjapORq+W4OP3kXJOuoHAzAfBgNVHSMEGDAWgBS6Flf0mOCbMbR9
hviZ1P3YQwvHtDANBgkqhkiG9w0BAQsFAAOCAQEAP3/fThc/EafKjrwCtICLkeQo
37T+wmTIDhfqy5VttaRZ5K/K5apM6PX+KLQBAMONYcI9j1wSF4pd9s7ocxq4FZoj
OGbx/aC7UWd/y5V8FZWfrMjbS8zDvkLXuvz1UtpjKPxvCfv4w9ndi7Zr9iyTjSxV
3mIdHjUaSoiHsKxDhS+iK2HFTmgqXyUbR8DNW0jyC12zZNxBmP8RubabHX9DX4vC
FSKu0SkALzN0AlmMmmcjLioaZ7nouVIdC4QB34jsnPZDo9aUGF82R2cGuBN2l/FS
EbQ4nuC6DrE85KtQfpoT5k3/121rppdveGb5f628/klb+pGKl86LgIHSgIQZvg==
-----END CERTIFICATE-----
`;

const LEAF_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDdqp9y4D2uIgzU
ZvdF+t+O152x4wne2ObP/orOqN9LxfudVHGJe+8vB+hiNzEnv4CrhLbk7cE5/SFW
2KNc41FOX8+/Z3GV6DlNiOn3UPkIwL2w7A2lE+ZPoSKHnCSnppIZiHo5kU5eCvvo
tjpMVwTTnB+xMPUOb96UmoTLx5MNTYSvAPMF21R+Tnb9kPkWYvhGRdDlxJdDUH59
Ebswy582+w8RWdirTdCn6Kdqs+reB65dcIpa9xuLHtyHIPA9in9ulebzjZ6B+9S+
RwWjoTTakkYQ6EEDc2eeFIofQ0gMQ9+LJXY5ZA6AXMsNb6RNzF4QToVvqp9mcuLe
r8PCmFCTAgMBAAECgf9QzorHziwP1Pms52l/5ud35JUeYL3fM+61gnTeOF9sne9O
OoLuSjdAop8Fqv61hbrlZxTlMSjW1OiZC4KtpUTEYmWpZmi4LoKM5cnffPzlihHX
qo/RKMxGmbkhMq+YQtWTNQRU30wNCmVLmXmMyPj7yyb4zAeqQRYezUabz8RZtQb0
Su/H3Ek9uOnFxJSVSdyXeLiPSZkiZMjWhykXNKnFbojBL4QlIMvYkKk74M6VR6Yb
GTpjqkfINWu7ahNv29dqirG5Ko8QNguwWY/1W9zPUPkudG7qQTv9JRWo4i9VUXvs
ZanD44U4mhU45HXuKxyQ6hn1MissiThjTc1Lnq0CgYEA8ZYGMDbl825QbUaFLQYS
ar1gPu7sLdidtRWngLV8qD+wRKm2aszlsPUY5uOwy0TP/gDkRoa3LbdXi46tVGIs
JTyIyLDWjCcSNnMfKovqXoWRH1FyqVgTD8RmPQbtdOZX86dwBQClMT7zEJ9FzXqD
OP7xN5ISS4+cfZmdL4z8OJcCgYEA6uRZMwI0YRMgxK+AGglGreZUV1VgfIrIMIRG
YXdR1aNRCPxAyjx/wmMTdGeCIEUdUSw0lURFVyRKR7LFakG92OnacQyTgGoj7kjo
MPaDogY6EDGjJ4iJwOiXpckDasN3yBCF7F3cHSsQ6jPcWvtBbqFbX5sTy5jBWPfb
ouIEi2UCgYBaQRYmxRu7iib57DKs02vl/MIMQO5zYk3o7SIa77KWmNSdklnYJJxb
M/YNrFrMVfTujB68Sm/84FYQiUkwEU00zBy9/XLqAV7IgNHP712r2nKRJLiVk5Xr
ehBIFGJ6HeQV3yP2ens8nqvoNdi6H18O2A/+FtBG8mwgcFdNAHrqGQKBgQDDaqRX
Dn97P4mkeImvn4YAyT3jxnDWTDOOQY24KqeXgB67xfk1By4XD4ww7KhSpo1kac15
XWn+vH9btPwOkZEbNDr6kEbqr+Miq98YVQ5gLqQBsvoUusA4EImRcHF6UhKGDFEO
u2uTjK+u2OR7gMsH+g/ls0O9v2Ej3lkI4tZ7DQKBgQCpy1WO3Dp+ZO/7tZia+SxN
TPc90iMXab/uiJbbLF6FsaTI28W9wT1u8aaCkr9KwDl/qupSzq3m+xB/TwWlTrPj
Uh8TKRaHrOm2QuKuZHOiGD+VDdfpGiR0SRsFUSCVYn3MYK08wKM5i0APceVeBEqX
VO4qXhlRRfak8+sbovFXKw==
-----END PRIVATE KEY-----
`;

const WRONG_CERT = `-----BEGIN CERTIFICATE-----
MIIDIDCCAgigAwIBAgIUDbtq6mqfB57KYBlgrjOApGuOb5MwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRY3V0aWVtYWlsIFRlc3QgQ0EwIBcNMjYwNzIyMTgwNzQx
WhgPMjEyNjA2MjgxODA3NDFaMBgxFjAUBgNVBAMMDXdyb25nLm14LnRlc3QwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDDg+lgaSLNtQxn/zPoT+SWOfwH
5QnfSEAEO181hWBTT+YLkVjncRCUqPSKk+8RIMrZGRigJgInOTNf1DnBFke4wSir
W9vd4XRS8NT1Do8eF1tqsOGOP9zYkdvfgkkdYR9F9RlL413PPtK4TUq4oFt5FIJf
ZVpaADSl7llAmHGmAri22ZVqC/MtXwQVifrI6wXgW5++RNs7WZKb0ej1ytIPiRF0
Oso/z65xNHT9SsaMNO+IbcXSF6oMqPg/LBjhSQnF44ThfwfgNqrbNouH0IqtV8iR
/ZaMPjjBxfL9C+3pjDAs9siDUSs3s19QXvsoXBd9SnW5B2UAjMb/CcLiuSHnAgMB
AAGjXDBaMBgGA1UdEQQRMA+CDXdyb25nLm14LnRlc3QwHQYDVR0OBBYEFP8cBOxy
teJbWxxlBsm9IrDps71JMB8GA1UdIwQYMBaAFLoWV/SY4JsxtH2G+JnU/dhDC8e0
MA0GCSqGSIb3DQEBCwUAA4IBAQA8XqxvZqOdTuMNnW3NJO+UpW00y/sXNneTb85X
nyy4qs9sCVpD6zy5lQjhwIPX8iwW7opqOJx2CK7LLqNh3+NVdgVWymach+nx6QN/
ju/Env5xL2pFBF9EAmqfV4xwTJFrr1uUb5LklNGu2B8pLzvreEs3MzbHIgDryrAt
4xXv2NyGhITAxQin4PQDqcltKUlfI85hhUou3SG9cs4C42mgwgKMtWXAdqbnek2B
JKw364WFukhCDpkXp0e7SNmDVd05+CkFNRY5PwjfatRHp1q20QlRvnTyJtvEd63p
y1Ozn5pM8T61iSU72zEYj9+A/fG2xsySFM/4AG7t1JBC8BEx
-----END CERTIFICATE-----
`;

const WRONG_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDDg+lgaSLNtQxn
/zPoT+SWOfwH5QnfSEAEO181hWBTT+YLkVjncRCUqPSKk+8RIMrZGRigJgInOTNf
1DnBFke4wSirW9vd4XRS8NT1Do8eF1tqsOGOP9zYkdvfgkkdYR9F9RlL413PPtK4
TUq4oFt5FIJfZVpaADSl7llAmHGmAri22ZVqC/MtXwQVifrI6wXgW5++RNs7WZKb
0ej1ytIPiRF0Oso/z65xNHT9SsaMNO+IbcXSF6oMqPg/LBjhSQnF44ThfwfgNqrb
NouH0IqtV8iR/ZaMPjjBxfL9C+3pjDAs9siDUSs3s19QXvsoXBd9SnW5B2UAjMb/
CcLiuSHnAgMBAAECggEAH3ULaRwxYdiV8OuiPegQ1szojJqg3oCA8E1fMbzOdUkf
MdBGdiJ+cPTIN726ks5sZMbBbA8BfK8a4XnDexorGwJVGVETzJzYOvoNwYoAo+5N
IproB5ul3GCHeGw9eFEml3pqggfIka5BeC7TbWY7oX0XxuKHSYDL98CkMpz0eCmi
sB1HSItsUN8cNNYR0YQazgoA05OkbwEw8j5CpIk0kPFI7pVpkC3wFO56os0YKQpQ
c9DrvPslhw6LT7WCHKjgpKqJAITmN6qk6J66ly41oaPGebxc/UIATSzFk78BXQWK
2FPQdKKCzK5JZhxgoy/+2inrYNs+43+RQ5kq0wkAnQKBgQDzZPFYHsdhQM6j2uaV
aw9xs20Bo3q+Ge9tRmdW9eVTOffqIFi31wZvuqzGcBov3VbXWrrtqW6jJ2MLcfMp
0qrAi30y3NwaG9q1VQaKdMw5BLBPHSvYRe+rARkfJcV0gnkJ20R6rqPk58QmH2Pf
B5WG5D9OTn3RgxyWt98qp+WxMwKBgQDNpCl9PA15brhuzBTX9P2Si58GdkICv7Rd
dDhamh1IsMoTmt0gtPVgSvC4H1aPeB8Dn7xZEMkcNPCaW/5wr4uxn2qW2Ffws/yt
kdmLf3KR+ZyVOuuIggf2vSQQJa3lZyZhkqkk8p/pQw2IWjj9FkKQZlUOLCPIz5Jt
KdDdZJ/0fQKBgQC4s2Bmc6zvw2NMesBCoSTuLq/I74skmb/Ul/mxxxZIyxO0KunI
ULeEsA+O4uEsc3YEJMj3s3zO+QOzWryhf0mupevTXkD02zBkLOqyxSF5H3LABq4Q
CDpw9Xtf5KTr3lsFvMxBoSekfLCgEXATfsjcvXbA8NWP2UQnp88FqrWmewKBgQCU
vI84OZ7Ia6E+VsHUdF/kM/0LComhLkbBvTEQmiLNQB6V+CiQ+9obpTjQ148TN1pl
Y3eRTpC2z7SARWyJ4omYDetfhAQCyBkmyWO+X8lotxJVI6fr7h6C1qHBVdWdFZ/U
/cnyYrUnkB8rit+IoldHYyAje/QzXqFQ33E1vYwOGQKBgQCjUmgpMJK7CPat+KPt
SIRD6WPpq+6NZFgJiQ5g1tm/K7myjGJnYZEoYxx//1OuKobnR+w9CJnRLzKQRdP1
B1b5QVVUbIqbfzeFWrrekeAak5aK5vq9thhBHMMRl/teoOfYwrRXxeK/TiPnUVDF
oPJI4R1YXjIlgMYYsQdTbmGjuQ==
-----END PRIVATE KEY-----
`;

const MSG = { from: 'me@sender.test', recipients: ['friend@mx.enforce.test'], data: Buffer.from('Subject: enforced\r\n\r\nsent under a validated enforce policy\r\n', 'latin1') };
const enforce127 = parseStsPolicy(Buffer.from('version: STSv1\nmode: enforce\nmx: 127.0.0.1\nmax_age: 86400\n', 'latin1'));

test('MTA-STS enforce POSITIVE control: a valid, CA-chained, name-matching cert DELIVERS over TLS', async () => {
  const received: DeliveredMessage[] = [];
  const mx = await SmtpReceiver.start((m) => { received.push(m); }, { domain: 'mx.enforce.test', tls: { key: LEAF_KEY, cert: LEAF_CERT } });
  try {
    const [r] = await relayOutbound(MSG, {
      clientName: 'sender.test',
      resolveHosts: async () => ['127.0.0.1'],
      port: mx.port,
      resolveStsPolicy: async () => enforce127,
      tlsOptions: { ca: CA_CERT }, // trust the throwaway test CA the leaf chains to
    });
    assert.equal(r!.ok, true, `enforce must DELIVER to a valid cert: ${r!.detail}`);
    assert.equal(r!.classification, 'success');
    assert.equal(received.length, 1, 'the message was delivered under enforce');
    assert.equal(received[0]!.overTls, true, 'and it went over the validated TLS session');
  } finally {
    await mx.close();
  }
});

test('MTA-STS enforce: a TRUSTED-but-WRONG-NAME cert still fails (it is the hostname check, not just trust)', async () => {
  const received: DeliveredMessage[] = [];
  // The cert chains to the same injected CA (so it is TRUSTED), but its only name is
  // wrong.mx.test - it does not match the 127.0.0.1 we connect to.
  const mx = await SmtpReceiver.start((m) => { received.push(m); }, { domain: 'mx.enforce.test', tls: { key: WRONG_KEY, cert: WRONG_CERT } });
  try {
    const [r] = await relayOutbound(MSG, {
      clientName: 'sender.test',
      resolveHosts: async () => ['127.0.0.1'],
      port: mx.port,
      resolveStsPolicy: async () => enforce127,
      tlsOptions: { ca: CA_CERT },
    });
    assert.equal(r!.ok, false, 'a name-mismatched cert must not receive mail under enforce');
    assert.equal(received.length, 0, 'nothing was delivered to the wrong-name MX');
  } finally {
    await mx.close();
  }
});
