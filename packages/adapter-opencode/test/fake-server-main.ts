// Child-process entry for the fake server, used as `serverCommand` in lifecycle tests. Behaves like
// `opencode serve --port 0`: reads the password from OPENCODE_SERVER_PASSWORD and prints the
// "server listening on <url>" line.

import { FakeOpenCode } from './fake-server.ts';

const fake = new FakeOpenCode({ password: process.env.OPENCODE_SERVER_PASSWORD });
const url = await fake.start(Number(process.env.FAKE_PORT ?? 0));
process.stdout.write(`server listening on ${url}\n`);

const shutdown = (): void => {
  void fake.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
