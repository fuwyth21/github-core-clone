# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/fuwyth21/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/fuwyth21/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible forge in one Node process: git smart HTTP
(upload-pack v2, receive-pack v0), the REST v3 API, GraphQL v4, and MCP over
a single in-memory store. No dependencies, no git binary, no outside service.

Built for [the make.fun bounty](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own modules only.

## The lifecycle (main.ts)

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <port>}`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok": true}`: the env's boot probe |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP (2026-07-28, plus the `initialize` handshake) |
| anything else | 404 `{"message": "Not Found"}` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a
missing or wrong token is 401. `/healthz` takes none.

## Layout

- `main.ts` — the lifecycle above. Keep it as it is.
- `app.ts` — the HTTP server and routing.
- `store.ts` — the in-memory store (repos, objects, refs, issues, PRs,
  labels, comments) and the deterministic clock. The bearer token names a
  single user, the viewer; the contest's fixed scenario names that viewer.
- `git.ts` — the git object model: SHA-1 ids, pack v2 read/write (OFS_DELTA
  and REF_DELTA resolved on read, plain objects on write), pkt-line framing,
  and the reachability walk the fetch algorithm needs.
- `githttp.ts` — git smart HTTP: v2/v0 advertisements, `ls-refs`, fetch
  with depth/shallow/unshallow, and fast-forward-only receive-pack.
- `rest.ts` — REST v3, including the three-way squash merge with conflict
  detection against the base branch's current tip.
- `graphql.ts` — a small GraphQL executor (parser + resolver) for the
  documents the suite sends, including `__type` introspection and cursor
  pagination.
- `mcp.ts` — MCP tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) on the same
  store as REST.

## Design notes

- **Determinism.** No `Date.now()` or `Math.random()` in any data path.
  Timestamps come from a fixed epoch plus a monotonic counter, and
  server-created commits use fixed author/committer stamps, so two runs that
  take the same requests produce the same state.
- **Fast paths.** The store is in-memory Maps; the hot workloads do no
  per-request work beyond a lookup and a JSON serialization. Packs are
  written undeltified (the suite's client accepts plain objects) and the
  fetch walk only touches what the request needs.
- **Identity.** The bearer token identifies one user. A repository under any
  other owner reads as 404, and `viewer { login }` answers the token owner.

## Local grading

Start the forge on a port, then run the kit's local runner against it:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types -e "
import('./app.ts').then(async (m) => {
  const server = m.createApp();
  await new Promise((r) => server.listen(18099, r));
});"
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:18099 --token test-token-123 --perf
```

Local result (2026-11-18): **120/120 conformance** (git 30/30, repos 15/15,
issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15),
perf 153/200 (push 49, clone 33, read 36, write 35), **total 953/1000**.
Two fresh runs produce identical check outcomes.

## License

MIT.
