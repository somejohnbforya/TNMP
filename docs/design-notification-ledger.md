# Design: a ledger of notification events

**Status:** stage 1 built, 2026-11-18, on branch `notification-ledger`; deploy waits on John's go. Stages 2–4 are not started (§9). Three interim fixes are live (§8a).

## 1. What went wrong

Two reports during the start of the 2026 Winter TNM.

### The spurious notification (Tue Oct 27, the week before Winter round 1)

Subscribers got **"Round 1 Games Are Up!"** between tournaments. Here's the chain, traced through the production code and confirmed by replaying `computeAppState` at the real timestamps:

1. Fall ended Oct 13. MI later replaced the Fall page with prizes and final standings, removing every "Pairings for Round N" table. The parser therefore reads the page's round as `null` (checked by running the production parser on the live page).
2. `getTimeState` switches the app over to the *next* tournament seven days before its round 1. Because the clock changed on Nov 1, that came to **7:30pm PT, Oct 27**. From then on `cache:appState` describes Winter, and since no Winter round had started, its round is **1**.
3. `dispatchAllNotifications` takes the round from the page, or from `cache:appState` when the page has none. It takes the tournament from `resolveTournament`, which still returned **Fall**. So it asked about **Fall round 1**.
4. The stored games marker said Fall round 7. Fall round 1 is not equal to Fall round 7, so this counted as new. Fall round 1 has 37 of 37 games with moves, so it was "ready". A games notification goes to every subscriber.
5. The results-night cron runs every 5 minutes. One Android device recorded its "shown" ack at 7:35pm PT, the first tick after the switch. A second device acked at 2:06am, consistent with a phone that woke up later.

### This week's games notification (Fri Nov 6)

MI added the round 1 PGNs at 3:20:17pm PT. The notification went out at 3:20:26pm. The push services of **all 22 subscribed devices accepted it, with zero failures** (`lastDeliveredAt` and `failCount` in KV). So the server sent it to everyone, and whatever went wrong for "certain people" happened on the device or in the push service.

The most likely cause, not yet confirmed on a device: the spurious notification and the real one share the tag `tnmp-games-r1`, because the tag is built from the signal and the round and leaves out the tournament. Where the Oct 27 notification was still sitting in someone's notification list, the real one *replaced* it instead of arriving as a new one. Some platforms, iOS among them, may do that replacement silently. To confirm: ask the people who reported it which device they use, and whether an old "Round 1 Games Are Up!" was still showing.

We can't tell more than that, because nothing records whether a device displayed a notification. The service worker's "shown" ack does write `lastDisplayedAt`, but that field is lost in a race (§2), and only 8 of the 22 devices show an ack for today.

### Round 3 read as round 4 (Tue Nov 17)

MI posted round 3's results with the Extra Rated section headed "Pairings for Round 4"; Extra Rated numbers its own rounds and had run ahead. The parser took the page's round as the highest across all sections, so the worker thought it was round 4. The site showed round 4, whose only game was the Extra Rated one. Round 3's results were never announced. A "Round 4 Pairings Are Up!" notification reached 4 devices instead: the per-player lookups searched only the round 4 section, which was Extra Rated, so only Melville and three devices with no player name matched. Fixed in `ebaa22f` (§8a), and the stored state was repaired by hand.

That's the second notification bug in three weeks caused by the worker working out "the current round" wrongly. Each interim fix closes one way of getting it wrong. The ledger removes the need to work it out at all.

## 2. Why: a one-item memory, compared by equality

The notification system keeps no history. For each of the three signals (pairings, results, games) it stores **one** `{tournament, round}`: the last one it announced. Each device record stores one "last notified" mark per signal. A tick sends a notification when the (tournament, round) it derives **differs from** the stored one.

That design has four consequences, and all four showed up:

1. **Anything that differs looks new.** A round that moves backward or sideways, or is simply derived wrong, counts as a fresh event. "Fall round 1 games" was announced in September, but nothing remembers that, so a wrong round became a notification to every subscriber.
2. **Nothing knows what was owed.** An event that is missed, or merged into a recap, leaves no trace. A retry that succeeds doesn't even set the device's mark.
3. **The past can't be reconstructed.** The Oct 27 event has been overwritten everywhere we store state, and Workers logs only go back a few days. The diagnosis above rests on replaying the code, not on a stored record.
4. **Updates to a device record get lost.** `dispatchPushNotifications` writes back the copy of the device record it read *before* sending, and the service worker's ack reads and rewrites the same record moments later. Whichever write lands second erases the other's change: either a delivery mark or the display time. KV is only eventually consistent, so the ack's read can also be stale. A lost mark is another way to get a repeat notification.

The mixed-up tournament and round in §1 is what triggered it. The missing history is why that turned into a notification.

## 3. Events

An **event** is something that happens to one tournament, one round, one signal. Its identity is `slug:signal:round`, for example `2026-winter-tuesday-night-marathon:games:1`.

### Events we observe and may announce (21 per 7-round TNM)

| signal | rounds | announced as |
|---|---|---|
| pairings | 2–7 | "Round N pairings are up", personalised with colour, opponent and board |
| pairings | 1 | posted onsite, so it reaches the page together with round 1 results (this week both were first seen on the same tick). Recorded as an event and merged into the round 1 recap |
| results | 1–6 | "Round N results are in", personalised |
| results | 7 | "Tournament complete", personalised |
| games | 1–7 | "Round N games are up", sent to everyone |

**Events are recorded one by one; messages are built from them.** One message can cover several events: pairings and results arriving on the same tick make a recap, and round 7 results make the final message. The ledger still records each event separately, so whether to merge is a choice about the message, not about what happened.

### Changes on MI's page that are not events

Each of these happens in practice, and each must **not** notify.

| page change | how the design excludes it |
|---|---|
| Final standings and prizes replace the page after the last round (Oct 27) | No pairings tables means no pairings or results event. The round is never filled in from another tournament (§4.3) |
| Results corrected after they were posted | The results event for that round is already in the ledger |
| Late PGNs added after the games notification | The games event for that round is already in the ledger |
| MI renumbers boards when it posts results (Fall round 3) | Not a signal at all; only ingestion handles it |
| Extra Rated pairings or results (it numbers its own rounds, and its pairings arrive after results) | Never an event of its own, and never used to work out the round (§4.3) |
| The page of a tournament we are not currently tracking | Events carry their own tournament ID and are recorded under it, never another tournament's |

### Events driven by the schedule (optional, §8)

These wouldn't be seen on MI's page; the schedule says when they're due. For example "Winter TNM starts tonight", or "next TNM announced" when discovery adds a tournament. The ledger handles them unchanged, since they're just another signal name. Whether we want any of them is open.

## 4. Design

### 4.1 Two D1 tables

```sql
CREATE TABLE notification_events (
    event_key     TEXT PRIMARY KEY,      -- slug:signal:round
    tournament    TEXT NOT NULL,
    signal        TEXT NOT NULL,         -- pairings | results | games
    round         INTEGER NOT NULL,
    observed_at   TEXT NOT NULL,
    status        TEXT NOT NULL,         -- sent | stale | seeded
    message_kind  TEXT,                  -- pairings | results | games | recap | final
    audience      INTEGER                -- devices it was addressed to
);

CREATE TABLE notification_deliveries (
    event_key     TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    status        TEXT NOT NULL,         -- pending | delivered | failed | gone
    attempts      INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    delivered_at  TEXT,                  -- push service accepted it
    displayed_at  TEXT,                  -- service worker showed it
    clicked_at    TEXT,
    error         TEXT,
    PRIMARY KEY (event_key, device_id)
);
```

**Why D1 rather than KV:** KV's free tier caps writes at 1,000 a day, which pushed the September work toward writing as little as possible. D1's cap is 100,000 writes a day. D1 is also consistent, so the lost-update race in §2 can't happen, and it can be queried, so "did Mason get round 3 pairings?" is a single `SELECT`. **Volume:** 21 events and about 25 devices make roughly 525 delivery rows per tournament, about 4,000 a year.

### 4.2 The rule: an event is new only if it has never been recorded

`INSERT INTO notification_events ... ON CONFLICT(event_key) DO NOTHING`, then send only if a row was actually inserted (`meta.changes === 1`). The insert *claims* the event, so two ticks that overlap can't both send it. This membership check replaces the equality check against `state:*`.

**A backstop for going backwards:** refuse to record an event whose round is lower than the highest round already recorded for the same tournament and signal, and log it. A pairings or results event for round 3 after round 4 can only come from a bad input. The backstop doesn't apply to games, because MI could post games late or out of order, and membership already covers that.

**Staleness:** an event first seen after it stops being useful is recorded as `stale` and not sent. This also covers recording an event for the first time long after it happened. The windows, each one named constant:

| event | sendable until |
|---|---|
| pairings for round N | round N starts |
| results for round N | 12 hours after first seen |
| games for round N | round N+1 starts; for the last round, 7 days after it. PGNs sometimes don't go up until the weekend (John, 2026-11-06), so a fixed 24 hours would drop real games messages |

The push's own `expiresAt`, which limits retries, uses the same time.

### 4.3 Where events come from

- **Pairings and results** come only from the TNM sections' own "Pairings for Round N" headers, each carrying its own round. The round is never filled in from `cache:appState`, and Extra Rated sections never count (the parser already works this way since `ebaa22f`). A page with no TNM pairings tables gives no pairings or results events, which is right: there is nothing to announce.
- **Games** come from D1 and need no round to be worked out. Each tick checks every round of the tracked tournament that is ready (more than half its rows have moves) and has no games event yet. "Which round are we on?" stops mattering for games.
- The tournament ID is always the one whose page or rows produced the event. The app's display state (`computeAppState`, which looks ahead to the next tournament during the gap week) is never consulted. This removes the trigger in §1 at its source.

### 4.4 Messages

On each tick, gather the events that were newly claimed and pick one message, using the existing `selectNotificationKind` rules: round 7 results make the final message; pairings and results for the same round together make a recap; then results, then pairings, then games. Who receives it stays as it is now (§6). The notification's `tag` becomes `tnmp-<event_key>`, so two different events can never replace each other on a device.

### 4.5 Deliveries and retries

Each device the message is addressed to gets a `pending` delivery row, and the send updates it. Retries read the `pending` rows that are due, instead of scanning every device record in KV. The payload carries the `event_key`. The ack and click handlers run a single `UPDATE ... SET displayed_at = ?` on one delivery row: no reading first, and no shared record to overwrite.

**Old service workers.** TNMP has real users, so phones keep running the old service worker until their owner next opens the site. An old one acks with only `deviceId` and no `event_key`. The handler then stamps that device's most recent delivered row, which is the notification it just showed. It's one `UPDATE`, the same shape as the new path, so there's no separate code for old clients to remove later.

The device record in KV is left holding only what describes the device: its subscription, name, preferences and label. It's written only when a device subscribes or changes its preferences.

### 4.6 What this removes

- the three `state:*` keys, and the comparison done on every tick
- the per-device mark fields (`lastNotifiedPairings`, `lastNotifiedResults`, `lastNotifiedGames`) and `retryPayload`, `retryAfter`, `failCount`, `lastDeliveredAt`, `lastDisplayedAt` and `lastClickedAt`
- the retry sweep's KV list and its bookkeeping in the Durable Object (`pendingRetries`, `lastRetrySweep`): a `SELECT` on due rows replaces them
- the falling back to `cache:appState` for the round in `dispatchAllNotifications`
- the KV writes on the dispatch path, along with the cap concern behind the September work in that area

## 5. Rollout: seed before switching

When the ledger is first deployed it's empty, so every event that has already happened would look new. The migration that creates the tables therefore also **seeds** them from D1 itself, in plain SQL: one `seeded` row for every event that has already happened in **every** tournament the database knows. For each tournament and each round that has games, that's pairings and results; for each round whose games are ready, that's games too. Seeding all of history, not just the current tournament, means no past event can ever look new again, which is the whole class behind the Oct 27 bug.

CI applies migrations before it deploys the worker, so the ledger is seeded before the new dispatch code runs. The one event the games table can't show is pairings posted for a round that hasn't been played yet, which exist from Monday night until Tuesday night. A migration can't read KV, where the old state lives, so the deploy avoids that window instead: **deploy between Tuesday night, once results are posted, and Monday 8pm.** Then every round on MI's page already has games, and so has seeded rows.

A delivery row for a seeded event is never created, so today's "shown" data simply starts fresh.

## 6. Who receives each message

Unchanged; written down here so it becomes a decision rather than an accident:

| message | sent to |
|---|---|
| pairings, results, recap, final | devices with that preference on, whose player is found in the posted pairings, plus devices with no player name set |
| games | every device with results notifications on |

A player on a bye isn't in the pairings, so they currently get no pairings, results or recap message for that round. §8 asks whether that's right.

## 7. Acceptance criteria

Each of these runs the production worker against the real local D1 and KV of `wrangler dev` / Miniflare, never hand-written fakes:

1. **Gap week replay:** the Fall page as it reads now, with the clock at Tue Oct 27 7:35pm PT, produces no event and sends nothing.
2. **Winter round 1 replay:** pairings and results seen on the same tick send one recap. A later tick with the PGNs sends one games message. Re-running both ticks sends nothing.
3. **Overlapping ticks:** two runs claiming the same event send it once.
4. **Corrections:** a results correction or late PGNs after an event was sent produce nothing.
5. **Going backwards:** a page whose round goes from 4 to 3 records nothing and logs it.
6. **Seeding:** deploying in the middle of a tournament, with seeding, re-sends nothing.
7. **Acks:** an ack arriving while the dispatch is still running is never lost, and never erases a delivery.
8. **Tags:** two events for the same round number in different tournaments get different tags.

**Where the tests run (corrected 2026-11-18).** This note first said the worker's tests had to move to `@cloudflare/vitest-pool-workers` before this change. They don't. `games.d1.test.js` already runs production SQL against real SQLite (`node:sqlite`) with every real migration applied, and D1 is SQLite. The ledger lives in D1, so its tests use that same harness, extended with `batch()`. That includes the seeding migration, run over rows shaped like the real ones.

What stays outside them: the push services themselves, which we don't control; and the device records in KV, which are now only read during dispatch. `cron.kv.test.js` and `push.test.js` fake KV; the parts of them that test notification state go away with that state.

## 8. John's answers (2026-11-06)

1. **Scheduled events: yes.** They're a good idea. Which messages, and when, is still to be designed; they go in as signals of their own (§3).
2. **Admin alert: yes.** An event that is due but never seen alerts John, never subscribers. Still to settle: when each event counts as overdue, and how the alert reaches him.
3. **Players on byes: likely yes.** They may get the pairings and results messages. That changes who receives them (§6), which today is only players found in the posted pairings.
4. **Staleness windows: games need longer.** PGNs sometimes don't go up until the weekend, so a 24-hour window would drop real games messages. Games stay sendable until the next round's pairings are up (or until the next round starts), rather than a fixed number of hours.

## 8a. Interim fix, ahead of the ledger (2026-11-06)

John's ruling: one thing at a time. First make the current design work as intended, with no more missed or spurious notifications; the ledger follows. Two changes:

- **The round comes only from the tournament being notified about.** `fallbackRound` uses `cache:appState`'s round only when that state describes the same tournament. That removes the trigger in §1. The Fall round 7 case still works: in Fall's results window the app state describes Fall, round 7.
- **Notification tags include the tournament.** `tnmp-<slug>-<type>-r<round>`, so a real notification can't silently replace another tournament's notification for the same round. It takes effect for each device once its service worker updates (the next time they open the site).

- **(2026-11-18, `ebaa22f`) The page's round comes only from the TNM sections.** Extra Rated sections count as the current night's games whatever round they're numbered, so the per-player lookups always include them (§1, round 3 read as round 4).

Known risks the interim fixes leave in place, all covered by the ledger: the race in which an ack and a delivery overwrite each other's change to the device record (§2.4), and a retry that succeeds without setting the device's mark. Both matter only if a signal is dispatched a second time, which the `state:*` keys prevent.

## 9. Stages

One thing at a time (John, 2026-11-06). Each stage ships on its own, and stage 1 is the whole replacement in one change: building the ledger beside the old state and switching over later would mean running two routes.

1. **The ledger.** One migration creates both tables and seeds them (§5). Dispatch collects the events it sees, claims them, picks one message and records deliveries (§4.2–4.5). Retries read pending deliveries; ack and click become one `UPDATE`; the notification tag becomes the event key. `/health` reads the latest events from the ledger. The `state:*` keys, the per-device marks and the retry fields on device records go (§4.6). Messages and who receives them don't change.
2. **Alerts to John.** An event that is due but never seen alerts John, never subscribers. The ledger plus the round dates say what's due. To settle first: when each event counts as overdue, and how the alert reaches John. One option is a push to devices flagged as his; another is an email, which needs Cloudflare Email Sending, since today's address only forwards incoming mail.
3. **Players on byes** get the pairings and results messages (§6, John's answer 3). This is only a change to who receives them.
4. **Scheduled events**, such as "Winter TNM starts tonight" (§3). Which messages, and when, is still to be designed.

## 10. Not covered here

- The service worker's tag collision affects only notifications that are still sitting in someone's list. §4.4 fixes it for the future; nothing can be done about the old one now.
- `getTimeState`'s seven-day look-ahead is still right for what the app *displays*. This design only stops notifications from reading it.
