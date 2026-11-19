-- The notification ledger (docs/design-notification-ledger.md). One row per
-- event that has happened, one per device a message was addressed to. An
-- event is new only if it has never been recorded, which replaces comparing
-- against a single "last announced" value per signal.

CREATE TABLE notification_events (
    event_key    TEXT PRIMARY KEY,   -- tournament:signal:round
    tournament   TEXT NOT NULL,
    signal       TEXT NOT NULL,      -- pairings | results | games
    round        INTEGER NOT NULL,
    observed_at  TEXT NOT NULL,
    status       TEXT NOT NULL,      -- sent | stale | seeded
    message_kind TEXT,               -- pairings | results | games | recap | final
    audience     INTEGER             -- devices the message was addressed to
);

CREATE INDEX idx_notification_events_signal ON notification_events (tournament, signal, round);

-- A message covering several events (a recap) is recorded against its lead
-- event, the results.
CREATE TABLE notification_deliveries (
    event_key     TEXT NOT NULL,
    device_id     TEXT NOT NULL,     -- the device record's key without "device:"
    status        TEXT NOT NULL,     -- pending | delivered | failed | expired | gone
    attempts      INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    delivered_at  TEXT,              -- the push service accepted it
    displayed_at  TEXT,              -- the service worker showed it
    clicked_at    TEXT,
    error         TEXT,
    payload       TEXT,              -- kept only while a retry is pending
    PRIMARY KEY (event_key, device_id)
);

CREATE INDEX idx_notification_deliveries_due ON notification_deliveries (status, next_retry_at);
CREATE INDEX idx_notification_deliveries_device ON notification_deliveries (device_id, delivered_at);

-- Seed every event that has already happened, in every tournament, so no past
-- event can ever look new. A round with stored games had its pairings and its
-- results; a round more than half of whose games have moves had its games.
-- (Deploy between Tuesday night and Monday 8pm: then every round on MI's page
-- already has stored games.)
INSERT INTO notification_events (event_key, tournament, signal, round, observed_at, status)
SELECT tournament_slug || ':' || s.signal || ':' || round, tournament_slug, s.signal, round,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seeded'
FROM (SELECT DISTINCT tournament_slug, round FROM games)
CROSS JOIN (SELECT 'pairings' AS signal UNION ALL SELECT 'results') AS s;

INSERT INTO notification_events (event_key, tournament, signal, round, observed_at, status)
SELECT tournament_slug || ':games:' || round, tournament_slug, 'games', round,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'seeded'
FROM games
GROUP BY tournament_slug, round
HAVING SUM(CASE WHEN pgn IS NOT NULL AND pgn != '' THEN 1 ELSE 0 END) * 2 > COUNT(*);
