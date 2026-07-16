"""A minimal independent SMTP target for a smoke-calibration of the conformance
suite. aiosmtpd is third-party asyncio SMTP software — NOT my code and NOT
Postfix/Exim ground truth. Its only job here is to be a real, independent server
the runner can drive end-to-end, so runner/reply-reader framing bugs (which the
mutant, being my own code, cannot reveal) would surface.

Recipient policy matches richFixture: accept recipient@ and postmaster@,
reject nobody@ with 550. Everything else accepted (aiosmtpd default-ish) — noted
in triage as open-relay-ish behaviour, not a suite finding.
"""
import asyncio
import signal
from aiosmtpd.controller import Controller

ACCEPT = {'recipient@example.com', 'postmaster@example.com'}
REJECT = {'nobody@example.com'}


class Handler:
    async def handle_RCPT(self, server, session, envelope, address, rcpt_options):
        addr = address.strip('<>').lower()
        if addr in REJECT:
            return '550 5.1.1 <%s>: Recipient address rejected: No such user' % address
        envelope.rcpt_tos.append(address)
        return '250 2.1.5 Ok'

    async def handle_DATA(self, server, session, envelope):
        return '250 2.0.0 Ok: message accepted'


async def main():
    controller = Controller(
        Handler(),
        hostname='127.0.0.1',
        port=2600,
        server_hostname='aiosmtpd.example.com',
    )
    controller.start()
    print('aiosmtpd listening on 127.0.0.1:2600', flush=True)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    controller.stop()


asyncio.run(main())
