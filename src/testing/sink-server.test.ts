import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { withSink } from './sink-server.ts';
import { dotStuff } from '../wire/bytes.ts';

/**
 * A throwaway lockstep SMTP client: connect, then for each command write it and
 * await one reply line. Deliberately minimal — the point is to exercise the sink,
 * not to be a good client.
 */
async function deliver(port: number, from: string, recipients: readonly string[], body: Buffer): Promise<void> {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });

  const readLine = (): Promise<string> =>
    new Promise((resolve) => {
      const onData = (chunk: Buffer): void => {
        const s = chunk.toString('latin1');
        sock.removeListener('data', onData);
        resolve(s);
      };
      sock.on('data', onData);
    });

  await readLine(); // greeting
  const cmd = async (line: string): Promise<void> => {
    sock.write(Buffer.from(line + '\r\n', 'latin1'));
    await readLine();
  };
  await cmd('EHLO client.test');
  await cmd(`MAIL FROM:<${from}>`);
  for (const r of recipients) await cmd(`RCPT TO:<${r}>`);
  await cmd('DATA'); // draws 354
  // Send the (already dot-stuffed) body followed by the end-of-data terminator.
  sock.write(Buffer.concat([body, Buffer.from('\r\n.\r\n', 'latin1')]));
  await readLine(); // 250 accepted
  await cmd('QUIT');
  sock.destroy();
}

test('sink captures envelope and un-stuffs a dot-stuffed body line', async () => {
  await withSink(async (sink) => {
    // A body whose first line begins with a dot — the canonical §4.5.2 case.
    const body = Buffer.from('.secret leading-dot line\r\nsecond line', 'latin1');
    await deliver(sink.port, 'sender@example.com', ['rcpt@example.com'], dotStuff(body));

    assert.equal(sink.received.length, 1);
    const msg = sink.last!;
    assert.equal(msg.from, 'sender@example.com');
    assert.deepEqual(msg.recipients, ['rcpt@example.com']);
    // The sink must have removed exactly the one stuffing dot, restoring the body.
    assert.equal(msg.data.toString('latin1'), '.secret leading-dot line\r\nsecond line');
  });
});

test('sink preserves multiple recipients in order and the exact reverse-path', async () => {
  await withSink(async (sink) => {
    await deliver(sink.port, 'BoB@Example.COM', ['a@x.test', 'b@y.test'], Buffer.from('hello', 'latin1'));
    const msg = sink.last!;
    assert.equal(msg.from, 'BoB@Example.COM', 'the reverse-path case is preserved exactly');
    assert.deepEqual(msg.recipients, ['a@x.test', 'b@y.test']);
    assert.equal(msg.data.toString('latin1'), 'hello');
  });
});

test('sink handles an empty body', async () => {
  await withSink(async (sink) => {
    await deliver(sink.port, 'e@example.com', ['r@example.com'], Buffer.alloc(0));
    assert.equal(sink.last!.data.length, 0);
  });
});

test('sink un-stuffs a line that is only dots', async () => {
  await withSink(async (sink) => {
    // A body line of "..text" is the stuffed form of ".text"; "..." -> "..".
    const body = Buffer.from('...three dots', 'latin1');
    await deliver(sink.port, 's@example.com', ['r@example.com'], dotStuff(body));
    assert.equal(sink.last!.data.toString('latin1'), '...three dots');
  });
});
