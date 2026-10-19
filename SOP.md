# SOP: hand coding work to DeepSeek with Crew Desk

This is the standard procedure for using Crew Desk to hand bounded coding tasks to low-cost models, DeepSeek first, while your main AI session (or you) stays in charge of planning, review and anything risky.

**The idea in one line:** a strong model plans and reviews; a cheap model does well-described, bounded work; Crew Desk sits in between, keeps the cheap model inside a fixed copy and a spending limit, and shows you exactly what it changed.

Contents: 1 How it works · 2 One-time setup · 3 Pick the lane · 4 Before every task · 5 Write the brief · 6 The task file · 7 Run it · 8 Review and bring the work in · 9 When a run goes wrong · 10 Money rules · 11 Safety rules · 12 Let your lead AI drive it · 13 Quick reference

## 1. How it works

Crew Desk starts the normal Claude Code program as the worker, but points it at the provider's Anthropic-compatible address:

| | DeepSeek | Kimi |
| --- | --- | --- |
| Address | `https://api.deepseek.com/anthropic` | `https://api.moonshot.ai/anthropic` |
| Model | `deepseek-flash` (V4.1 Flash) | `kimi-k3[1m]`, reasoning effort `max` |
| Key, in `.env.local` | `DEEPSEEK_API_KEY` | `MOONSHOT_API_KEY` |
| Billed to | your DeepSeek balance | your Kimi balance |

The worker gets the same tools and loop as Claude Code, with a different model behind it. For each paid worker, Crew Desk also:

- pins every Claude Code model setting (the main model, the Opus, Sonnet, Haiku and subagent defaults) to the chosen model. DeepSeek bills any "claude-opus" name as its much dearer Pro model, so nothing is left to a default;
- turns off background traffic, caps each reply at 16,000 tokens and compacts the context at 200,000 tokens;
- starts Claude Code in safe mode with no settings files and no MCP servers, so the worker reads no `CLAUDE.md`, `AGENTS.md`, hooks or skills. **The brief is its whole world;**
- removes every other credential from the worker's environment; it gets only its own provider key;
- streams usage, so the spending guard can stop a run the moment its estimate reaches the task's budget;
- runs it on a pinned commit in its own Git worktree, so your working files are never touched.

> **Never** put a DeepSeek or Kimi key in your global Claude Code settings, and never run Claude Code by hand with `ANTHROPIC_BASE_URL` set for this work. That skips the ledger, the dashboard and the credential stripping, and can quietly bill your own sessions to the wrong account.

## 2. One-time setup

1. **Install the tools.** Node.js 22 or newer, Git, and Claude Code (`npm install -g @anthropic-ai/claude-code`). Crew Desk runs Claude Code as the worker program for every lane, DeepSeek included.
2. **Get a DeepSeek key.** Create one at https://platform.deepseek.com/api_keys and add a small balance. US$5 is plenty to start; in our own use a DeepSeek task cost about US$0.10.
3. **Install Crew Desk.**
   ```bash
   git clone https://github.com/mani-kanasani/crew-desk-community.git
   cd crew-desk-community
   npm install
   npm run build
   ```
   On Windows PowerShell, type `npm.cmd` instead of `npm` if PowerShell refuses to run scripts.
4. **Add the key.** Copy `.env.example` to `.env.local` and paste the key after `DEEPSEEK_API_KEY=`. Only there: never in chat, a prompt, a task file, a screenshot or a commit. Git already ignores `.env.local`.
5. **Start it and leave it running.** `npm start`, then open http://127.0.0.1:4317. Restart it after any change to `.env.local`.
6. **Check the lanes.** `node bin/crew.mjs status`, or the **AI assistants** page. "Configured" means the key is set, not that it has balance or works; the first run proves that.
7. **Set your budget.** The ledger starts at US$5 for DeepSeek and US$10 for Kimi. Set your own limit, for example `node bin/crew.mjs allocation deepseek 10 "my first month"`. The history of every change is kept.
8. **Record your balance as a baseline.** `node bin/crew.mjs balance deepseek`. You will compare against it when you reconcile (section 9).
9. **Try the demo.** Press **Try a free demo** (or `node bin/crew.mjs demo`). It runs a pre-written change on a sample project with no AI and no cost, so you see a finished task, its activity and its diff end to end.
10. **Register your project.** `node bin/crew.mjs project "/absolute/path/to/your/repo" "My app"`, or **Add a project** on the dashboard's Overview page. It must be a Git repository with at least one commit. Note the project ID that `status` shows.

## 3. Pick the lane

| Lane | Give it | What to expect | Money |
| --- | --- | --- | --- |
| **DeepSeek** (`deepseek`) | Routine, well-specified work: one screen, one module or one function with its tests, where the brief states exactly what "done" looks like. | In our own use (39 runs, September 2026): 34 finished, 4 failed, 1 cancelled. Typically about 5 minutes, the longest about 9. | About US$0.10 a run. Default target US$0.40; hard cap US$2 a task. |
| **Kimi** (`kimi`) | Hard reasoning or work across several files, where DeepSeek would guess: tricky rules, a sweep across screens, a module with many edge cases. | 14 runs: 9 finished. Typically about 30 minutes. | About US$2.40 a run. Default target US$3; set 3 to 6 for edit tasks. Hard cap US$10 a task. |
| **Claude** (`claude`, model `sonnet` or `haiku`) | Bounded work when you would rather not spend API money. | Counts against your Claude plan. | No per-run cash cost. |
| **Your lead session only** | Shared types and contracts, database migrations, access rules, anything touching secrets, payments or sending, putting worker changes together, the final review, and every deploy. | | |

Workers have no web access, browser or MCP tools. Don't give them work that needs those, or anything the brief cannot make precise; keep that for your lead session.

## 4. Before every task

- [ ] **Budget.** `node bin/crew.mjs budget`. Check what is left, and that no entry is still **uncertain** (section 9).
- [ ] **Snapshot.** The worker sees a fixed commit, not your working files. Commit what it needs, then `node bin/crew.mjs refresh PROJECT_ID HEAD "reason"`. For uncommitted work, `node bin/crew.mjs snapshot PROJECT_ID "reason"` builds a snapshot without touching your branch, index or files, and refuses likely secret files.
- [ ] **File ownership.** Each worker owns its own files, listed in `allowedPaths`. Shared files (migrations, generated types, shared config, `package.json` and the lockfile) stay with your lead session, or with one worker at a time.
- [ ] **One at a time per paid lane.** Crew Desk runs up to two tasks at once, and only one paid run per provider. Extra tasks wait in line.
- [ ] **No restarts during a paid run.** If Crew Desk restarts mid-run, the run is marked interrupted, never relaunched, and its reservation becomes uncertain.

## 5. Write the brief

The worker reads nothing but the brief, so anything it must obey goes in it. Crew Desk already adds a short standard preamble (the worker rules, the pinned commit, the allowed paths); don't repeat it. Use this shape:

```text
OBJECTIVE
One outcome, in one or two sentences, and why it matters to the user.

READ FIRST
The files to read, with a line each on what to take from them. Quote the relevant
lines of any spec; don't point at a 900-line file.

YOU MAY CHANGE
Exact files (the same list as allowedPaths). New files, with their names.

DO NOT TOUCH
package.json and the lockfile, migrations, shared types, other screens.

RULES
- Match the surrounding code: naming, comment density, plain-language UI text.
- Made-up data only in tests and fixtures: example.com addresses, no real people.
- Tests never call a real provider or the network.
- No secrets anywhere; never read or print .env files.
- Do not commit, push, run migrations, deploy or send anything.
- If something in this brief is wrong or missing, stop and say so rather than guessing.

ACCEPTANCE CRITERIA
Numbered, checkable statements ("an empty list shows ...", "the form rejects ...").

CHECKS TO RUN
npm run typecheck
npm test   (or the specific test files)

REPORT BACK
Changed files; what changed in each; the exact result lines of each check;
anything left undone; questions.
```

Keep a task to one outcome and a handful of files. If it needs more than about six files, or a design decision the brief cannot settle, split it, give it to Kimi, or keep it for your lead session.

## 6. The task file

Always set `maxTurns` and `timeoutSeconds`. The defaults (8 turns, 15 minutes) suit only tiny read-only tasks.

DeepSeek, a routine edit:

```json
{
  "title": "Empty state for the orders table",
  "prompt": "<the brief from section 5>",
  "provider": "deepseek",
  "projectId": "ID_FROM_STATUS",
  "mode": "edit",
  "allowedPaths": ["src/components/OrdersTable.tsx", "tests/orders-table.test.ts"],
  "maxTurns": 60,
  "timeoutSeconds": 1200,
  "budgetUsd": 0.6
}
```

Kimi, hard or cross-file work:

```json
{
  "title": "Discount rules across cart, checkout and invoice",
  "prompt": "<the brief>",
  "provider": "kimi",
  "projectId": "ID_FROM_STATUS",
  "mode": "edit",
  "allowedPaths": ["src/pricing/**", "tests/pricing/**"],
  "maxTurns": 120,
  "timeoutSeconds": 3600,
  "budgetUsd": 4
}
```

A read-only review uses `"mode": "read"` and no `allowedPaths`. `allowedPaths` takes exact files, folders and globs (`src/pricing/**`, `src/*.ts`). Optional: `sourceCommit` pins a different commit; `model` overrides the lane's model (use an exact provider model ID, never a guessed name).

**From the dashboard instead:** press **New task**, pick the project, write the instructions, choose the assistant and whether it may change files, and set the budget target under **Advanced settings**. The dashboard has no file list, so use a task file when the scope check matters.

## 7. Run it

```bash
node bin/crew.mjs run task.json
```

This prints the run ID. A paid task is admitted only after it reserves its budget; it is refused when the lane's allocation, the per-task cap or the one-run-per-provider rule would be broken. Then wait, or raise your allocation on purpose.

Follow progress on the **Tasks** page. From the command line, `node bin/crew.mjs show RUN_ID` now and then; don't poll in a tight loop. Stop a run with `node bin/crew.mjs cancel RUN_ID`; a call already sent may still be charged.

## 8. Review and bring the work in

The worker's report is a claim to check, not a result. Crew Desk never merges, commits or pushes.

1. **Read the report.** `node bin/crew.mjs show RUN_ID`, or open the task in the dashboard.
2. **Read the whole diff** (the task's **File changes** tab, or `node bin/crew.mjs diff RUN_ID`). The scope check lists any file changed outside `allowedPaths`; reject those changes or be sure you understand them.
3. **Apply it to your project.**
   ```bash
   node bin/crew.mjs patch RUN_ID run.patch
   git -C "/path/to/your/repo" apply --3way run.patch
   ```
   Keep the patch file outside your repository, or delete it afterwards. (`patch` writes the file itself, so it works in every shell, including Windows PowerShell 5.1.)
4. **Run the checks yourself** in your project: the type check, the tests, the build where it matters, and look at any screen it changed.
5. **Finish and commit.** Fix what the worker left, then commit, naming the run ID in the message.
6. **Note what happened.** The run ID, what you took, and any follow-up, wherever you track your work.

## 9. When a run goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| "Stopped by Crew Desk's paid-lane guard (budget target or context bound reached)" | The run reached its `budgetUsd`, or one call grew too large. A call in flight may still be charged. | Check `budget`. Run it again with a higher `budgetUsd` (up to the cap), or split the task. |
| "stopped at the turn limit (N turns); the diff may be incomplete" | It ran out of turns before finishing. | Treat the diff as partial. Raise `maxTurns`, or split the task. |
| "Claude CLI returned an error" or "Stream idle timeout" | The provider or the connection failed during the run. | Read `node bin/crew.mjs logs RUN_ID`, then queue it again once, by hand. Never retry in a loop. If it keeps happening, `node bin/crew.mjs pause deepseek "reason"` and do the work on Claude. |
| "Server restarted before this run completed" | Crew Desk restarted during the run. It is not relaunched. | Reconcile the reservation (below), then queue it again. |
| An entry shows **uncertain** in `budget` | Usage was incomplete, or the run stopped, was cancelled or restarted. | `node bin/crew.mjs balance deepseek`, compare with your baseline, then `node bin/crew.mjs reconcile ENTRY_ID ACTUAL_USD "source"`. Until then the amount stays counted as spent. |
| Admission refused | The allocation, the per-task cap, or another paid run on that provider. | Wait for the other run, split the task, or raise your allocation on purpose. |
| The lane says pricing is missing or unverified | `server/provider-pricing.json` has no verified price for that model. | Check the provider's price page and update the card (rates in USD per million tokens, a `checkedAt` date and a source link). Crew Desk will not guess a price. |

## 10. Money rules

- **Your allocation is a decision, not a default.** Set it with `allocation` and change it on purpose; every change is kept in the ledger's history. The ledger file (`.local/build-budget.json`) is never reset or edited by hand, and money cannot move between lanes.
- **Estimates are not bills.** They are tokens times the published rates. DeepSeek may hold your balance in CNY, and Kimi's charges can post late; reconcile against the provider's balance.
- **The ledger limits what Crew Desk sends; it is not a cap on the provider's side.** If your provider offers a spending limit in its console, set one there too.
- **Prices change.** The price cards were checked on 21 September 2026. Look at the provider's price page now and then and update `server/provider-pricing.json`.

## 11. Safety rules

- Keys live only in `.env.local`, on the server side. Never put one in a task file, a brief, or anything with a `VITE_` prefix.
- A worktree separates Git changes; it is **not** a sandbox. Workers can run commands on your computer, so register only repositories you trust, and never give a worker production credentials or ask it to deploy, run migrations or send messages.
- Snapshots are built from commits, so `.env.local` files never reach a worker; the `snapshot` command also refuses likely secret files.
- Worktrees and logs can contain your project's code and data. Use the demo project for screenshots and recordings.

## 12. Let your lead AI drive it

Your main Claude Code or Codex session can do sections 4 to 8 for you through the CLI (or the MCP tools). Paste this into its instructions (`CLAUDE.md` or `AGENTS.md` in your project), with the path filled in:

```text
## Delegating to Crew Desk
Crew Desk runs bounded coding tasks on cheaper models. It lives at
/absolute/path/to/crew-desk-community and must be running (npm start there).
- Use it for routine, well-specified work in one or a few files. Keep shared
  types, migrations, secrets, payments, integration and deploys for yourself.
- Before a task: `node bin/crew.mjs budget`, commit what the worker needs, then
  `node bin/crew.mjs refresh PROJECT_ID HEAD "reason"`.
- Write the brief in the shape in its SOP.md section 5, save the task JSON
  (section 6: provider "deepseek", mode "edit", allowedPaths, maxTurns,
  timeoutSeconds, budgetUsd) outside the repository, and run
  `node bin/crew.mjs run task.json`.
- Check `node bin/crew.mjs show RUN_ID` occasionally, not in a tight loop.
- Treat the report as a claim. Read the whole diff, then
  `node bin/crew.mjs patch RUN_ID <file outside the repo>` and
  `git apply --3way <that file>`. Run the checks yourself before committing.
- Never retry a paid run automatically, raise an allocation, or put a key in a
  task file. Ask me instead.
```

## 13. Quick reference

```bash
node bin/crew.mjs status                                  # lanes, projects, runs
node bin/crew.mjs project "/path/to/repo" "Name"          # register a repository
node bin/crew.mjs refresh PROJECT_ID HEAD "reason"        # move the snapshot to the latest commit
node bin/crew.mjs snapshot PROJECT_ID "reason"            # snapshot uncommitted work
node bin/crew.mjs budget                                  # allocations, spent, reserved, uncertain
node bin/crew.mjs allocation deepseek|kimi USD "reason"   # set a lane's limit
node bin/crew.mjs balance deepseek|kimi                   # provider balance (numbers only)
node bin/crew.mjs run task.json                           # queue a task
node bin/crew.mjs show RUN_ID                             # status and report
node bin/crew.mjs logs RUN_ID                             # full log (only to chase a failure)
node bin/crew.mjs diff RUN_ID                             # the change, as JSON
node bin/crew.mjs patch RUN_ID [FILE]                     # the change, as a patch file
node bin/crew.mjs cancel RUN_ID                           # stop a run
node bin/crew.mjs reconcile ENTRY_ID ACTUAL_USD "source"  # settle an uncertain entry
node bin/crew.mjs pause|resume deepseek|kimi "reason"     # take a lane out of use, or back
node bin/crew.mjs demo                                    # the free practice task
```
