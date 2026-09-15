# Game ingestion: identify a game by who played it, not by its board

**Status:** open questions ruled by John on 2026-09-14 (see Decisions); build not started. Written 2026-09-14.
**Scope:** the worker cron's game ingestion and byes rebuild (`worker/src/cron.js`, `worker/src/parser.js`), the D1 `games` schema, and the two places in the client that derive a game's identity from its board.
**Related:** `8de137f` (the unblock: a colliding GameId no longer sinks a round; failed writes retry and show in `/health`).

## Why

On 2026-09-14, Fall round 2's PGNs still had not ingested, days after MI posted them. The immediate cause, two different games carrying the same GameId, is fixed in `8de137f`. The investigation behind that fix found it was one of six failures with a single root: **the cron identifies a game by (tournament, round, board)**, and the board is exactly the fact the sources omit or disagree on.

### The three sources on an MI tournament page

| Source | Rounds it covers | What it carries | Known defects |
|---|---|---|---|
| Pairings table | The current round only. It is replaced when the next round's pairings post. | Board, section, colors, both players with USCF IDs, results as first posted | A first-posted result can be wrong (Summer R3). Extra Rated pairings appear to count their own rounds (see below). |
| Standings table | Every round | Who played whom (by rank), W/L/D, forfeits (X/F), byes (H/B/U), USCF IDs | Names are truncated ("Samir S", "Frisc Del Rosario"). No board or color. The Extra Rated section numbers its own rounds, which are not TNM rounds. |
| PGN textareas | Rounds whose PGNs have been posted | Moves, colors, result, round, sometimes board, GameId, Elo, date | Headers are hand-entered: wrong boards, a GameId and Elo copied from another game, truncated names ("Perlov, Daniel Rob") |

### What board-as-identity breaks today

Each row below was confirmed by hand against D1 and the tournament's MI standings.

| Failure | Instance | Mechanism |
|---|---|---|
| A whole round refused | Fall R2 (fixed in `8de137f`) | A copied GameId violates the UNIQUE index on `game_id`, and D1's all-or-nothing batch rolls back every game in the round |
| One game stored twice, with contradictory results | Summer R3 Diller–Hasteer: a board-43 row with no moves says 1-0; a board-2 row with the PGN says 0-1. Standings say Hasteer won. | Pairings and PGN disagree on the board, so the two rows never meet. The pairings row's result is never corrected once it is anything but `*`. |
| Extra Rated game filed in the wrong round | Summer Del Rosario–Chea: a row with no moves in R4, the PGN in R6 | Standings list it as Extra Rated round 4; the PGN says `6.39`. The row with no moves can only have come from the pairings table, so those pairings evidently said "Round 4" too, and the cron read that as TNM round 4. |
| Invented boards | 6 stored rows (1 Summer, 5 Silman), plus Fall R2's three (boards 928, 933, 949), which landed on 2026-09-14. Fall R2 Hasteer–Guan now exists twice: board 41 (from pairings) and board 949 (from the PGN). | A PGN without a board gets a hashed 900+ board that can never meet the real row |
| Forfeits stored as games | Fall R2 boards 26/35/36 (live now); Silman R7, 6 rows; Summer R7, at least 2 of 3 | Forfeit cleanup deletes the rows, then the shell step re-inserts them from the pairings table in the same run. A final round's pairings never leave the page, so its forfeit rows are permanent. |
| A real game lost to an Extra Rated game on the same board | Summer R6 Walder–Shrauger and R7 Kojevnikov–Harris. Both PGNs are on MI's page; neither game is in D1. | Two PGNs claim one board: `6.8` (Walder–Shrauger, plus an Extra Rated game tagged 6.8) and `7.38` (Kojevnikov–Harris, plus an Extra Rated game). The parser keeps one PGN per round and board, so the later one in the file, the Extra Rated game, replaced the regular game before D1 was touched. |

Related: rows for pairings that were never played, e.g. Summer R2 board 4, Mallela–Winslow `*`. Standings show Mallela took a half-point bye.

"Shell" below means a game row created from the pairings table, before its PGN arrives.

Caveat on the evidence: the ad-hoc standings audit also printed many "missing" and "not in standings" lines. Those were artifacts of its naive surname matching (truncated names, multi-word surnames like "Arevalo Rivas"). Only the cases in the table above are confirmed.

### The same Extra Rated misreading corrupts the byes table

The cron rebuilds `byes` from every standings section, Extra Rated included, and that section's round columns are Extra Rated rounds. An Extra Rated `U` ("no Extra Rated game in this Extra Rated round") becomes a zero-point bye in the TNM round with the same number, often a round the player spent playing a regular game. All 174 byes rows that contradict a game in the same round were classified against standings, matching players by USCF ID:

| Cause | Spring | Silman | Summer | Fall | Total |
|---|---|---|---|---|---|
| Extra Rated standings marker read as a TNM-round bye | 35 | 30 | 45 | 0 | 110 |
| Bye written one round early by the standings parser before `013eabb`; Spring ended before that fix and was never rebuilt | 36 | 0 | 0 | 0 | 36 |
| Not an error: a real bye plus an Extra Rated game the same night | 4 | 10 | 8 | 1 | 23 |
| A real bye whose contradicting game row is a pairing that was never played | 0 | 3 | 1 | 0 | 4 |
| Unexplained (Spring R6 Casares, full bye) | 1 | 0 | 0 | 0 | 1 |

This accounts for the byes/games contradiction first noticed on 2026-08-12, when it was 123 rows.

## Goals

1. Exactly one row per game actually played, in the right TNM round, however late or inconsistently the sources arrive.
2. Every field comes from the source that is reliable for it, and a later, better source corrects an earlier one.
3. One bad row costs that row, never the round.
4. Less code: the invented-board hash, the separate shell write path, and the forfeit create-then-delete cycle all go away.

## Non-goals

- Historical (2009–2025) ingestion and the players/alias system.
- Fixing MI's data. We tolerate it.
- Restoring the constraints the live `games` table has lost (see "Drift" at the end).

## Design

### 1. A game is (tournament, round, the two players)

A game's identity is the tournament slug, the TNM round, and the **unordered** pair of canonical player norms. Board, colors, section, result, and GameId are attributes.

Players resolve to canonical norms through their USCF IDs wherever the source links one (pairings and standings both do), and through the players table's aliases otherwise. Because the pair is unordered, a PGN whose colors disagree with the pairings still meets its row.

### 2. Each fact comes from the source that's reliable for it

| Fact | First choice | Fallback | Rule |
|---|---|---|---|
| The game happened, and its result | Standings | Pairings (current round), then PGN | Standings correct earlier results; a disagreement is logged |
| Forfeits and byes | Standings (X/F, H/B/U) | Pairings X/F markers | A forfeited pairing gets no game row, ever |
| Board, section (regular games) | Pairings | PGN `round.board`, PGN Event | Never invented. NULL is allowed; 495 rows already have none. |
| Board (Extra Rated games) | Pairings, which MI updates with Extra Rated boards after results post | MI's numbering convention (§10) | Never the PGN's board tag and never a hash (Decision 5) |
| Colors | Pairings | PGN | A disagreement is logged |
| Moves, opening | PGN | — | |
| TNM round of an Extra Rated game | PGN Round tag, cross-checked against `[Date]` and the tournament's `round_dates` | The page's current TNM round, when first seen in pairings | Extra Rated standings rounds are never read as TNM rounds; they only confirm that the pair played and how it ended |
| GameId | PGN, when no other game holds it | NULL | The rule shipped in `8de137f` |

Evidence for the Extra Rated rule: Summer's Extra Rated rounds 3, 4, and 5 were TNM rounds 5, 6, and 7, but in Silman, Extra Rated round 1 was TNM round 6 and round 5 was TNM round 7. There is no fixed offset, because several Extra Rated games can be played on the same TNM night.

### 3. Reconcile, then write

The three write phases that touch `games` today (forfeit cleanup, full-game upsert, shell upsert) are replaced by one pure step:

```
reconcile({ page, existingRows, players, tournament })
  → { upserts, deletes, conflicts, unmatched }
```

It builds the tournament's desired rows from the three sources per the table above, diffs them against D1's rows by identity, and returns only the differences. Because it is pure, it can be tested without D1. The cron becomes: fetch → parse → reconcile → write → save hash.

### 4. Attaching a PGN to its game

The search is limited to the PGN's own round, about 40 games. A PGN matches a game when both players match, in either color order, and **exactly one** game in the round matches. Players match when:

1. their canonical norms (or an alias) are equal; or
2. their names are compatible: surnames equal ignoring case and hyphenation, with multi-word surnames compared as token sets, and first names prefix-compatible ("Daniel Rob" ~ "Daniel Robert", "Edward M" ~ "Edward", "Julian" ~ "Julian Patricio").

The PGN's board number is only a tie-breaker. No match, or several, makes the PGN "unmatched", and it is stored under its own player names (Decision 1).

### 5. A bad row can't sink a round

Constraint conflicts (identity uniqueness, GameId collisions) are resolved inside `reconcile`, so the batch is valid by construction. If a batch still fails, its statements are retried one at a time, and each failing row is recorded in `state:lastCheck`. The page hash is saved only after success, which is already shipped.

### 6. Schema: one migration

- Add a virtual generated column `pair_key` = `min(white_norm, black_norm) || '|' || max(white_norm, black_norm)`, with a UNIQUE index on `(tournament_slug, round, pair_key)`.
- Demote UNIQUE `(tournament_slug, round, board)` to a plain index. The board is now an attribute that can be corrected or missing, and swapping boards between two games would otherwise violate uniqueness mid-batch.
- Record `idx_games_game_id` as UNIQUE with `IF NOT EXISTS`. Production has had it for some time; no migration ever created it.
- **Ordering:** CI applies migrations before it deploys the worker. The UNIQUE `pair_key` index fails to create while duplicate pairs exist, which would block the deploy, so the repair (§8) must run first.
- **Verify before relying on it:** that D1 accepts `ALTER TABLE … ADD COLUMN … GENERATED ALWAYS AS (…) VIRTUAL` and an index on that column. Try it on a local D1 first.

### 7. Client

Two places in the client derive identity from the board:

- `src/tnm.js:59` gives a row without a GameId the id `slug:round:board`. With NULL boards, two such rows in the same round would collide. Instead, the server should return a stable id for every row (the GameId, else `slug:round:pair_key`), so identity has one writer.
- `src/record.js:69` includes the board in a record's context fingerprint, so a corrected or cleared board changes the fingerprint. During the build, check how the TNM dataset refreshes cached records when a server row's board changes. The content-fingerprint rescue needs moves, and rows with no moves have none.

### 8. Repair existing rows

A one-time script runs `reconcile` in dry-run over every tournament whose MI page still carries standings (Decision 4: today Spring 2026, 3rd Silman, Summer 2026, and Fall 2026), and lists the deletes, merges, and result corrections it would make. It is applied after review. Known targets:

- Summer R3 board 43
- Summer R4 Del Rosario–Chea
- The forfeit rows in Silman R7 and Summer R7
- Fall R2's Extra Rated games, numbered per §10: board 949 merges into the pairings row on 41, 933 becomes 39, and 928 becomes 40
- The six older invented boards (Summer 941; Silman 915, 941, 945, 974, 992), renumbered the same way
- `*` rows for pairings that were never played
- Summer R6 Walder–Shrauger and R7 Kojevnikov–Harris, restored from their PGNs, which are still on MI's page
- Summer R2 Guan–Harris, an Extra Rated row with no moves filed under the Extra Rated heading's round (its PGN, `4.45`, is in R4)
- The byes table of every cron-era tournament, rebuilt under §9's rule. This clears the 110 Extra Rated rows and Spring's 36 shifted rows.

### 9. Byes come only from regular sections

The byes rebuild skips Extra Rated standings sections, because their H/B/U describe Extra Rated rounds, not TNM rounds. A bye and an Extra Rated game on the same night are both true, so any check that a bye "contradicts" a game must ignore Extra Rated games.

This rule doesn't depend on the rest of the redesign and could ship on its own.

### 10. Extra Rated board numbers follow MI's convention

This is Decision 5. An Extra Rated game's board comes from the pairings table, which MI updates with Extra Rated board numbers after results are posted. When the pairings table doesn't list the game, it is numbered the way MI numbers them: Extra Rated boards start right after the round's last regular board and count up (last regular game on 38 → 39, 40, 41).

The fallback, precisely:

- "Last regular board" is the highest board number among the round's regular-section games. Byes carry no board number in the pairings table.
- Numbers already taken in the round are skipped, including Extra Rated boards the pairings table did publish.
- Unlisted Extra Rated games are numbered in the order their PGNs appear in MI's file.
- Once stored, a number changes only if the pairings table publishes a different one, so a later PGN never renumbers earlier games.

Evidence from MI's pages:

- **Silman R7:** regular boards end at 39; the Extra Rated game is on 40.
- **Fall R2:** regular boards end at 38. The pairings table lists one Extra Rated game, Hasteer–Guan on 41, and leaves 39 and 40 unlisted. The convention gives the two unlisted games 39 (Hasteer–Robinson) and 40 (Tobias–Hallman), in file order.
- **Summer R7:** MI's own pairings table put Extra Rated Langendorf–Martin on board 38 alongside U1600 Kojevnikov–Harris, also on 38. Now that the board is not part of a game's identity, both keep the number MI published.
- **PGN board tags are not used for Extra Rated games.** Summer's `6.8` gave an Extra Rated game a regular board, and that collision is how Walder–Shrauger was lost.

## Rejected alternatives

- **Keep board identity and patch each symptom.** Each patch covers one case, and Summer R3 (the sources disagree on the board) has no fix while the board is the identity.
- **GameId as identity.** It is exporter metadata: it collides (Fall R2), and a game has none until its PGN posts.
- **Board first, players as the fallback.** That keeps two identities, and when a PGN's wrong board points at a different game, that game's row gets overwritten.
- **Standings only.** Standings carry no boards or colors, and a round's standings appear only after its results, too late for the pairings notification.
- **Write every statement individually.** It isolates failures by brute force, at ~40 D1 round-trips per run. Validating first keeps a single batch, with per-row retry only on failure.

## Acceptance criteria

1. **An independent audit comes back clean.** Standings pairs are matched by USCF ID, never by the new name matcher, which would share its mistakes. They are compared against D1 rows mapped to USCF IDs through the players table. After repair, Fall, Summer, and Silman show zero duplicate games, zero forfeit rows, zero result contradictions, and every regular-section standings game present exactly once.
2. **Every PGN** on those three pages is stored exactly once. A PGN that matched no game is stored under its own player names and listed in the run log.
3. **Known-answer tests** cover every confirmed case: Diller–Hasteer (board disagreement plus a wrong posted result); Hasteer–Guan (a board-less PGN meets pairings board 41); Del Rosario–Chea (Extra Rated round numbering); Fall R2 forfeits (no rows); Walder–Shrauger and Kojevnikov–Harris (two PGNs claiming one board both survive); Extra Rated boards (Fall R2: Hasteer–Robinson 39, Tobias–Hallman 40, Hasteer–Guan 41 from pairings; Silman R7: Dick–Casares 40); the Fall R2 GameId collision; and the name forms "Perlov, Daniel Rob", "Samir S", "Arevalo Rivas", and "De La Fuente Alvarez".
4. **Replay tests.** The unblock's end-to-end harness (the real `TournamentCron` over SQLite built from production's schema) moves into the repo with page fixtures. Each page is replayed as pairings-only, then with results, then with PGNs, and reconcile converges to the same rows regardless of order.
5. **Idempotent.** A second run over an unchanged page writes nothing.
6. **Byes agree with games.** No byes row contradicts a regular-section game in the same round.

## Decisions

Ruled by John on 2026-09-14.

### Decision 1: a PGN that matches no game is stored under its own player names

Example: Fall R2 Hasteer–Robinson, which has no pairings row and, so far, no Extra Rated standings. It is stored under the names in its PGN header and listed in the run log.

- **Rejected: hold it until pairings or standings list the game.** Extra Rated games on a page with no Extra Rated standings (Fall so far) could wait indefinitely, and games already on the site would disappear.
- **Rejected: store it as "provisional" and re-attach it once a match appears.** That adds a state the app and `reconcile` would both have to understand.
- **Why:** the moves matter more than tidy labels. A duplicate caused by a name-matching miss shows up in the audit and can be fixed; a game that was never stored is invisible to everyone.

### Decision 2: standings set the stored result; the PGN text stays as recorded

When the PGN's `Result` header and standings disagree, the `result` column follows standings and the disagreement is logged. The pairings table's first-posted result is corrected the same way (Summer R3 Diller–Hasteer).

- **Rejected: the PGN wins.** Its header is typed by the recorder, and the stored result would contradict the tournament director's record wherever wins and losses are counted.
- **Rejected: standings win and the stored PGN's header is rewritten.** That edits the source text and makes later comparisons against MI's file harder.
- **Why:** standings are the more accurate record. Across the audited tournaments, no PGN result contradicted standings; the one contradiction came from the pairings table.
- **Follow-up:** the app shows the stored result everywhere, and PGN downloads write it into the `Result` header. The one place that reads the PGN's own header is the MI embed's share title (`src/embed.js:290`). Point that at the stored result too.

### Decision 3: the same two players meeting twice in one round is unsupported

The first game is kept and the second is logged, not stored.

- **Rejected: add an "Extra Rated or not" flag to the identity.** The flag would have to agree across all three sources, and a single disagreement splits one game into two rows, the exact failure this redesign removes.
- **Why:** it has never happened. Across all 23,864 games in D1, back to 2009, there is exactly one same-pair-same-round case, and it is the Summer R3 duplicate bug, not a real rematch.

### Decision 4: repair every tournament whose MI page still carries standings

Today that is Spring 2026, 3rd Silman, Summer 2026, and Fall 2026. The 2025 Fall, 2025 Winter, and 2026 New Year's pages no longer show standings, and their rows show none of the damage markers: no rows without moves, no invented boards, no byes. The 2009–2025 historical import was curated and verified separately and is out of scope.

- **Rejected: reach further back through another source, such as the US Chess API.** Nothing is known to be broken there.
- **Rejected: repair Fall only.** That would leave known duplicates, forfeit rows, and bogus byes in three tournaments that feed player histories and the explorer.

### Decision 5: Extra Rated boards follow MI's numbering convention

This is John's description of how the club numbers these games. An Extra Rated game takes its board number from the pairings table, which MI updates with those numbers after results post. Otherwise, Extra Rated boards start right after the last board the regular sections used, so a last regular game on 38 means 39, 40, 41. The precise fallback and the evidence are in §10.

- **Rejected: hashed boards in the 900s** (today's behavior). They are numbers nobody at the club would recognize.
- **Rejected: the PGN's board tag.** The recorder types it, and Summer's `6.8` put an Extra Rated game on a regular board.

## Plan

1. Build `reconcile` with acceptance tests 3–5, using saved pages as fixtures.
2. Dry-run the repair script on the tournaments in Decision 4, review, apply.
3. Ship the migration (§6) and the cron switch-over, deployed outside the Monday and Tuesday cron windows.
4. Run the audit (acceptance 1, 2, and 6) against production.

## Drift recorded along the way

- Production's `games` table no longer matches the migrations. A UNIQUE index on `game_id` was added by hand (origin unknown: it is in no migration, script, or commit). The NOT NULL and foreign-key constraints from `0001_initial.sql` are absent, which suggests the table was rebuilt at some point; compare `0008_restore_unique_constraint.sql`.
