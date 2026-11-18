// app.ts — the HTTP server.
//
// One process, four surfaces over one store:
//   GET  /healthz                      the env's boot probe
//   /<owner>/<repo>.git/...            git smart HTTP (githttp.ts)
//   /api/v3/...                        GitHub REST v3 (rest.ts)
//   POST /api/graphql                  GitHub GraphQL v4 (graphql.ts)
//   POST /mcp                          Model Context Protocol (mcp.ts)
//   anything else                      404 {"message": "Not Found"}
//
// The base URL is taken from the request's Host header, so pagination Link
// headers and repository URLs always carry the origin the suite dialed.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit, matchGitRoute } from './githttp.ts';
import { handleRest, sendJson } from './rest.ts';
import type { RestCtx } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import type { GraphqlCtx } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import type { McpCtx } from './mcp.ts';

/** Bodies larger than this are refused (packs top out well under a megabyte). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const restCtx: RestCtx = { store, token, baseUrl: '' };
  const graphqlCtx: GraphqlCtx = { store, token };
  const mcpCtx: McpCtx = { store, token, baseUrl: '' };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers.host ?? '127.0.0.1';
        const baseUrl = `http://${host}`;
        restCtx.baseUrl = baseUrl;
        mcpCtx.baseUrl = baseUrl;

        const url = new URL(req.url ?? '/', baseUrl);
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const gitRoute = matchGitRoute(pathname);
        if (gitRoute !== null) {
          const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
          handleGit(store, req, res, gitRoute, url.searchParams, body);
          return;
        }

        if (method === 'POST' && pathname === '/api/graphql') {
          const body = await readBody(req);
          handleGraphql(graphqlCtx, req, res, body);
          return;
        }

        if (method === 'POST' && pathname === '/mcp') {
          const body = await readBody(req);
          handleMcp(mcpCtx, req, res, body);
          return;
        }

        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const handled = handleRest(restCtx, req, res, pathname, url.searchParams, body);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let one bad request take the server down.
        process.stderr.write(`[app] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
          else res.end();
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
  return server;
}
