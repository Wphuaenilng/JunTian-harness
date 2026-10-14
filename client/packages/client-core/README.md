# @tianshu/client-core

The **only** package that speaks the Tianshu sidecar protocol. Above this line the UI
sees five event categories; below it there are 56 wire event types.

## Endpoints consumed

| Endpoint | Where | Why |
|---|---|---|
| `GET /health` | `sidecar-client.ts:health()` | readiness + `protocolVersion` fence + `capabilities` |
| `GET /sessions` | `listSessions()` | sidebar (`?includeArchived=true`) |
| `POST /sessions` | `createSession()` | new session |
| `GET/DELETE/POST /sessions/:id`(+`/unarchive`) | `getSession/archive/unarchive` | open, archive |
| `PATCH /sessions/:id` | `renameSession()` | title |
| `POST /sessions/:id/prompt` | `prompt()` | run; **409 → caller queues** |
| `POST /sessions/:id/queue` `/queue/retract` | `queue()/retractQueued()` | busy-lane follow-up, input never lost |
| `POST /sessions/:id/abort` | `abort()` | stop a run |
| `GET /sessions/:id/stream?since=N` | `session-stream.ts` | event timeline (fetch, not EventSource: Bearer); framing is `sse-frames.ts` |
| `GET /sessions/:id/events?since=` | `events()` | REST 尾段快照（`EventWindow`）：内核这一路只回 `{events,lastSeq}`，**没有磁盘头字段**，所以"还有没有更早的"在这儿问不出来 |
| `GET /sessions/:id/events?before=` | `historyPage()` | 冷通道向上分页（`ColdEventPage`）：多回一个 `firstSeq`＝磁盘日志最早 seq，`events[0].seq === firstSeq` 是唯一的"翻到头"可观察信号；页首还会向前对齐到最近的 user 事件，所以一页可能比 `limit` 长 |
| `GET/POST /sessions/:id/interventions[/:rid/answer]` | `interventions()/answerApproval()` | approval ground truth +回执 |
| `GET /events` | `server-events.ts` | liveness + list invalidation (**health heartbeat, not a session timeline**); framing is `sse-frames.ts`, but the event guard stays local — these frames have **no `seq`**, so `readSse`'s guard would drop every one of them |
| `GET /sessions/:id/git/diff` `…/git/file-base` `…/git/working-tree` | `sessionFileDiff()/sessionFileBase()/sessionWorkingTree()` | the tool card's landed diff + before-view; baseline-scoped, and a path escaping the cwd answers **500** |
| `GET/POST /git/workbench/*`, `/config/*`, `/schedule*`, `/tasks`, `/sessions/:id/cockpit`, `/rewind-points`, `/rewind`, `/files`, `/file-content`, `/dir`, `/artifacts` | `sidecar-client.ts` (each method cites its route) | panels; see each `ui-*` README for which package consumes which |

## Block folding — facts in, wording out

`SessionModel` derives the `Block`s the view renders. Two rules it must keep:

- **No sentences.** A block carries facts (`{kind:'turn', truncated:true}`,
  `name:''`), never formatted text — a model that owns wording owns the language. The
  i18n scan in `packages/locale/test/locale.test.ts` fails the build on CJK in
  `client-core/src`.
- **Carry both halves of a tool result.** `result` is the prose receipt the model sees;
  the unified diff is only ever in `uiContent` (2000-char wire cap, with the server's own
  `outputTruncated` mirrored onto `block.truncated`). Dropping `uiContent` makes an edit
  card show a receipt and no change — the bug this package actually had.

`tool-file.ts` decides addressability (`toolFilePath` for the `file_path`-shaped single
mutators; `relativeToCwd` maps a wire path into the session cwd or refuses it).

## Event categories

`event-category.ts` maps all 56 generated event types onto
`lifecycle / text / tool / state / custom`. The table is exhaustive over the generated
union, so a new contract event **fails typecheck until it is categorized on purpose**;
`categorize()` then tolerates anything unknown at runtime (additive changes never bump
`protocolVersion`).

`approval_*` are deliberately `lifecycle`: that is the category the UI arms its
"pending too long" watch on (OpenCode #16367 class of failure).

## Invariants

- `seq === 0` is synthetic meta (`replay_window`, `job_snapshot`, `delegation_snapshot`,
  `approval_snapshot`): passes through, **never advances the reconnect cursor**.
- One SSE connection = one generation; a reconnect seals the previous partial.
- Reconnect pacing counts **consecutive failures since the last delivered frame** — any inbound
  frame resets the ladder, so a long healthy period is never punished with a saturated first
  retry. Ceiling = `min(500ms · 2^attempt, 10s)`, waited as a full-jitter draw over `[0, ceiling]`
  (`reconnectCeiling`; `rand`/`sleepMs` exist so the ladder is assertable without wall clocks).
- `readSse` ignores unparseable frames instead of killing the stream.
- Never bypass the sidecar: no `~/.rivet` reads, no direct SQLite (plan §2.2).

## Regenerating the contract mirror

```bash
node scripts/gen-protocol-types.mjs          # mirror + manifest
node scripts/gen-protocol-types.mjs --check   # CI drift gate
```
