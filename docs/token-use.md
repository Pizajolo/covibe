# Where a run's tokens go

This explains what each member sends to its model, how members get their information, why a team run costs more
than one long session, and what covibe does about it.

## What one member sends with every request

Every member is its own Claude Code process (`src/runner/claude-sdk.ts`), including members on ChatGPT or another
provider. For those, covibe's translator turns Claude Code's Anthropic requests into OpenAI requests
(`src/connections/openai-proxy.ts`, `codex-proxy.ts`). Each API request carries all of this again:

| Part | What is in it | Size (measured) |
|---|---|---|
| System prompt | Claude Code's preset, covibe's team protocol (`engine/prompts.ts`: teammates, write scope, sandbox, browser and app notes), the role prompt, the list of brain notes | about 8,700–9,400 characters (about 2,200–2,400 tokens) |
| Tool definitions | The member's built-in tools, plus covibe's tools (ask_question, update_task, propose_brain_note…), plus `StructuredOutput` when the step has a report schema | manager 6 tools, 8,000 chars (about 2,000 tokens); QA 24 tools, 16,700 chars; tester 14 tools, 15,600 chars; frontend 28 tools, 22,100 chars (about 5,500 tokens) |
| Context message | Claude Code's git status snapshot, `CLAUDE.md` (the team's `setting_sources`, `project` by default), and an environment block | about 3,000 characters plus your `CLAUDE.md` |
| The turn | covibe's prompt: goal and attached files, step, the task (JSON from the plan), fix-round feedback (JSON), messages, the todo list, the files changed so far | depends on the run |
| The conversation | Every earlier tool call and result of this member's session: every file it read, every command's output, every screenshot | grows with every tool call |

Measured by pointing the members of `examples/feature-team` at a local server that recorded what Claude Code sent.
About 4 characters make a token. The 13 browser tools and 4 app tools are about 3,300 tokens of the frontend's
overhead on every request.

The first three parts are the same on every request, so they are cheap after the first one when the provider
caches. The conversation is what grows. A member that makes 40 tool calls sends its whole conversation 40 times.

## Where members get their information

Members do not see each other's conversations. What reaches a member:

- **From the engine, in its turn prompt.** The goal, its `task` (a JSONata selection of earlier reports, usually
  its tasks from the plan), the feedback of a fix round (the gate's `feed` expressions, as JSON), the todo list,
  messages from the inbox, and now the files teammates changed.
- **From teammates, while it works.** `send_message`, a teammate's reply to `request_work`, the lead's answer to
  `ask_question`.
- **From disk.** Everything else. A member reads the project itself, and read-only members (QA) read the merged
  result in the integration worktree.
- **From its own past.** A member's session is resumed across steps and fix rounds (same working folder), so it
  remembers its earlier turns, and all of that is sent again.

## Why a team spends more than one Opus session

1. **Every member explores the project again.** One session reads a file once. In a team, the planner reads it,
   each builder reads it, QA reads it, the tester reads it, and each copy is sent again with every later request of
   that member. This is usually the biggest part.
2. **Every member pays the fixed overhead** (5,000–9,000 tokens per request, above) in its own session.
3. **Every step ran, needed or not.** QA, the tester and the manager's report ran for a one-line change. The
   report step also resumed the manager's whole planning session just to restate the reports.
4. **Fix rounds reran every builder.** A finding for the frontend also sent the backend back to work, and it
   resumed its whole session to find out it had nothing to do.
5. **A member's tool list could change between its turns.** Claude caches the prompt from the tool list on, so
   a different tool list means the member's whole conversation is read again at full price. The manager got
   `update_task` only once the todo list existed, so its report turn re-read its whole planning session uncached.
6. **A lead answering a question** worked in a copy of its planning session, with other tools and another report
   schema. Each question re-read the planner's whole conversation without the cache.
7. **A member that ends with text instead of its report** gets one more request from Claude Code
   (`[structured-output-enforce]`), with the whole conversation. Models other than Claude do this more often.
8. **Other providers cache less.** Claude caches automatically. covibe gives the ChatGPT (Codex) API the session as
   a cache key. OpenAI's Chat Completions caches by prefix. Many other providers (OpenRouter routes, Groq, Ollama)
   do not cache at all, so every request costs the full conversation.
9. **Screenshots stay in the conversation.** Each one is sent again with every later request.

The Home screen's token count includes cache reads. A cached token costs about a tenth of an uncached one, so a
team can show many more tokens and still cost less than the count suggests. Compare the dollar estimate or
your plan usage, not just the token count.

## What covibe does about it

- **The planner chooses who is needed** (`engine/selection.ts`). The member of the planning step (a step named
  `plan`, or the lead's first step) is told which members have steps after its own. It names the members the goal
  needs, with the `select_members` tool or a `members` list in its plan report. The steps of members it leaves
  out are skipped, their gates too. A member it gives a task to always runs. A step marked `required: true` always
  runs in full. If the planner does not choose, everyone runs, as before.
- **Fix rounds rerun only the owners.** When every item of the feedback names an `owner`, a parallel step reruns
  only those members' branches, and the others keep their reports. An item without an owner reruns everyone.
- **The plan hands over what the planner found.** The planner is asked to put files, functions, patterns and
  commands into its tasks. Builders are told to start from them. The example plan schema has `files` per task.
- **Members see what changed.** Each turn lists the files teammates changed and who changed them, so QA and the
  tester go straight to them instead of searching (QA has no git).
- **A member's tools stay the same on all its turns**, so its prompt cache holds from turn to turn.
- **The translators send the right roles.** Claude Code sends its environment as a system message. It used to
  reach GPT models as an assistant message (as if the model had said it). It is now a system or developer
  message. OpenAI's Chat Completions also gets the session as `prompt_cache_key`.
- **Report schemas reach Claude Code without `$schema`.** That line costs tokens and means nothing to the model,
  and some Claude Code versions refuse to start with the draft 2020-12 `$schema`. covibe still checks reports
  against the full schema.
- **The lead answers questions in a session of its own.** The first question starts a small read-only session with
  what the run has settled: the plan's report, the todo list and the files changed. Later questions in the run
  resume that session, one at a time, with the same tools and report schema, so it is cached and the lead stays
  consistent with its earlier answers. The planning session is no longer copied.
- **covibe can write the summary.** A step `{ id: report, summary: true }` has no member: covibe gathers the
  summary from the run's log (goal, plan, tasks, each member's latest report, files changed, gates and fix rounds,
  members left out, questions answered, open minor findings). Without a model it costs nothing; the example team
  uses it that way. With a `model`, that model writes those facts up in prose in one request, with its own short
  system prompt, no tools, no git status or `CLAUDE.md` and no member's session: a few thousand tokens however
  long the run was.

## What you can do in the team file

- Give `browser: true` only to members that open pages. The browser and app tools cost about 3,300 tokens on
  every request.
- Use `effort: medium` or `low` for reviewers and testers. Set `effort` for members on other providers too:
  Claude Code's effort becomes the reasoning effort on ChatGPT.
- Use `cache_ttl: 1h` for members resumed after long waits, such as builders between fix rounds. A 1-hour cache
  write costs more than a 5-minute one, but less than writing the whole conversation again after it expired.
- Give review findings and test failures an `owner` (the example schemas do), so fix rounds stay narrow.
- End with `{ id: report, summary: true }` instead of a member's report step, which resumes that member's whole
  session. Add `model: haiku` (or another cheap model) to it if you want the summary in prose.
- Keep `CLAUDE.md` short. With `setting_sources: [project]` every member sends it with every request.
- Watch the brain on the project's Brain tab: the list of notes goes into every member's prompt, and each note a
  member reads stays in its conversation. **Summarize** compresses the notes; pick its model in Settings.
- Prefer providers that cache for members that make many tool calls.
