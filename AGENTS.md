# Crew Desk

Notes for an AI coding agent working on Crew Desk itself (not on a project Crew Desk runs workers for).

- Crew Desk is a local dashboard and queue for Claude Code workers. The server is `server/index.mjs`, the paid-lane ledger is `server/budget.mjs`, usage accounting is `server/usage.mjs`, the CLI is `bin/crew.mjs` and the MCP server is `bin/mcp.mjs`. The screens are in `src/`.
- The browser, the CLI and the MCP tools must keep working on the same persisted queue and the same worker results. Launch delegated work through the queue so it shows under Tasks; never bypass it with a standalone Claude Code process.
- Never simulate a provider being connected, and never invent usage, test results or costs. Missing counters are unknown, not zero. Estimates are not bills.
- The demo provider is a labelled, deterministic local rehearsal, never an AI run.
- Never switch providers silently or retry paid jobs automatically.
- Never commit `.env`, `.env.local`, `.local/` or real client data.
- Run `npm test` and `npm run build` after meaningful changes, then open the dashboard and look at what you changed.
