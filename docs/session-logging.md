# Session logging

Every run of the server writes to its own timestamped file, `output/logs/session_{ts}.jsonl`.
Restarting the server — including a watch-mode reload — starts a new one. All logging for a
session lands in that single file; there are no separate per-error files.

The format is [JSON Lines](https://jsonlines.org): one JSON object per line, so the file is
greppable by eye and parseable by a script. Every entry carries a `timestamp` and a `level`
of either `info` or `error`.

Entries that record an actual change to a saved list also carry a `mutation` object:

```jsonc
{"timestamp":"…","level":"info","message":"Removed \"Ritual Coffeehouse\" from list \"TEST 1\"",
 "mutation":{"op":"remove-from-list","place":"Ritual Coffeehouse","list":"TEST 1"}}
```

Mutations are recorded at the atomic level at which Google Maps actually changes — `add-to-list`,
`remove-from-list`, `append-note` — rather than at the level of the user-facing action. A **move**
therefore appears as an add followed by a remove. This is deliberate: each atomic record carries
everything needed to construct its own inverse, which is what makes the log usable for undo.

| `op` | Inverse |
|---|---|
| `add-to-list` | remove the place from `list` |
| `remove-from-list` | add the place back to `list` |
| `append-note` | restore `previousNote` |

`previousNote` matters most — it is the only record anywhere of what a note said beforehand. Maps
keeps no history, and the collect snapshot is overwritten on every re-sync.

Every mutation is written by `recordMutation()` in `src/mutations.ts`, which both logs it here and
flags the mutated list for re-sync (see the [architecture notes](./architecture.md#the-recordmutation-abstraction)).

Two guarantees make the log trustworthy for recovery:

- **Append-only, flushed per entry.** Written with a synchronous append per line, so a crash or a
  force-closed browser (which is how cancellation works) can never truncate what came before.
- **Written only after the change commits.** Every mutation is logged after its settle wait, never
  before — so anything in the file is something that actually happened.

The converse is worth knowing: a process killed mid-click can leave a change made in Maps but not
logged. The window is small, but the log is a lower bound on what happened, not a perfect mirror.
There is no automatic rollback — the log gives you the data to reconstruct by hand.
