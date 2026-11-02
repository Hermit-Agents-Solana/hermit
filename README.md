# HERMIT

**The next agent moves right in.** One shared project memory for Claude Code, Cursor, Codex and any MCP client, with a log anyone can check on Solana.

An agent leaves what it decided. The next one, in any tool, picks it up where the last one stopped.

- Site: https://hermitsol.fun
- API: https://api.hermitsol.fun
- X: https://x.com/hermit_network

## How it works
A **shell** is one project's memory. Agents reach it over MCP (Streamable HTTP) or plain REST with an `hk_` key. No wallet and no sign-up are needed to start.

| Tool | What it does |
|---|---|
| `pickup` | Start of a session: the current plan, decisions and last handoff |
| `recall` | Search by meaning and by exact words |
| `remember` | Store a fact, lesson or constraint |
| `decide` | Record a decision, and replace an older one |
| `plan` | Set the current plan |
| `handoff` | Leave a note for the next agent |
| `forget` | Clear an entry's text. Its hash stays, so the chain still verifies |

Search is hybrid: SQLite FTS5 plus vectors from `bge-m3`, joined by rank fusion. There is no second LLM. Your agent does the thinking, HERMIT only stores and finds.

## Connect
Create a shell on the site, or:
```
curl -X POST https://api.hermitsol.fun/v1/shells -H "content-type: application/json" -d '{"name":"my project"}'
```
Then, in Claude Code:
```
claude mcp add --transport http hermit https://api.hermitsol.fun/mcp --header "Authorization: Bearer YOUR_KEY"
```
Add one line to `CLAUDE.md` or `AGENTS.md`, because an agent can skip a tool it was only told about:
```
Call hermit pickup when you start and hermit handoff before you finish.
```

## The log
Every write extends a per-shell SHA-256 chain. An entry's hash covers:
```
prev, shell, seq, kind, agent, created, supersedes, content_hash
```
joined by newlines, where `content_hash` is the sha256 of the text. The text sits outside the chain, so `forget` can clear it without breaking anything.

At most once an hour, while something has changed, a Solana Memo transaction records `hermit:1:<root>`. The root is the sha256 of the sorted leaves `sha256(shellId):seq:head`, so shell ids never appear on chain.

The site's **Check the chain** button recomputes every hash of the open shell in your browser and compares the root with the memo on Solana. The [open shell](https://hermitsol.fun) is the real build log of this project.

## What it does not promise
- Text is stored readable on the server, because search needs it. It is not encrypted under your key.
- An anchor proves the log existed in that form at that time. It does not prove that what an agent wrote is true.
- Secrets are stripped before storing (`worker/src/redact.js`) by patterns, plus a math check for Solana keypairs. It catches the usual formats, not everything.

## $HERMIT
The memory is free. Holding the token raises limits on shells, memories and keys. Balances are read on chain, and nothing is locked or spent. The token address will only be published from [@hermit_network](https://x.com/hermit_network).

## Run your own
`worker/` is a Cloudflare Worker with D1, Vectorize and Workers AI. `site/` is one static page.
```
cd worker
npm install
npx wrangler d1 create hermit                  # paste the id into wrangler.toml
npx wrangler d1 execute hermit --remote --file=schema.sql
npx wrangler vectorize create hermit --dimensions=1024 --metric=cosine
npx wrangler secret put SOL_RPC_URL            # a Solana mainnet RPC url
npx wrangler secret put ANCHOR_KEY             # hex seed of a wallet with a little SOL
npx wrangler deploy
node test.mjs
```
Point `API` in `site/index.html` at your worker. Without `ANCHOR_KEY` the memory still works and nothing is anchored.

## License
MIT
