// main.ts — entrypoint of the forge.
//
// The forge itself lives in app.ts: one process serving git smart HTTP,
// REST v3, GraphQL v4 and MCP over a single in-memory store. This file only
// runs the process's lifecycle against the trial environment (the "env")
// that grades it. The env owns the trial, so the process follows its lead:
//
//   1. MAKEFUN_ENV_URL names the env's origin. With no env to talk to the
//      process has nothing to do, so it exits 1 right away.
//   2. Start the server on an ephemeral port: listen(0) lets the kernel
//      pick a free one. Port 8080 is never bound — the env owns it.
//   3. POST {"port": <bound port>} to $MAKEFUN_ENV_URL/register. The env
//      records the caller's address plus that port as the forge's base URL
//      and dials it from then on. A 200 means the register landed; a 409
//      means another register already won and is equally fine. A 400 or 405
//      is a contract error and ends the process; anything else (the env may
//      still be starting) is retried.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The
//      env answers at once — {"done": false} while the trial runs — so this
//      is a short poll loop, not a held-open request. A failed poll is
//      retried with backoff; the process never exits before the env says so.
//   5. Shut the server down and exit 0. The harness then stops the env,
//      which writes the export the scorer reads.
//
// Nothing here touches the store or the protocols; it only keeps the
// process alive until the trial is over.

import { createApp } from './app.ts';

/** The env's origin, without trailing slashes. Empty when unset. */
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** How long one register or done request may run before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff starts here, doubles per failure, and never passes this. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2_000;

/** Pause for `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff: 250ms, 500ms, 1s, 2s, then 2s forever. */
class Backoff {
  private failures = 0;

  next(): number {
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(this.failures, 8));
    this.failures += 1;
    return wait;
  }
}

/**
 * Tell the env which port the server bound. Returns once the env accepts
 * the register (200, or 409 when a first register already won). Throws on
 * a 400/405 contract error; anything else is retried forever.
 */
async function announcePort(port: number): Promise<void> {
  const backoff = new Backoff();
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The env is not reachable yet (still starting): wait and try again.
      await pause(backoff.next());
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register rejected with HTTP ${response.status}: ${await response.text()}`);
    }
    await pause(backoff.next());
  }
}

/** Poll GET /done until the env answers {"done": true}; never return early. */
async function awaitDone(): Promise<void> {
  const backoff = new Backoff();
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: it is not done, poll again.
    }
    await pause(backoff.next());
  }
}

/** Bind the port, register it, then wait for the env: the process's whole life. */
async function run(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
  process.stdout.write(`[forge] listening on port ${port}\n`);

  await announcePort(port);
  process.stdout.write('[forge] registered with the env; waiting for done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
