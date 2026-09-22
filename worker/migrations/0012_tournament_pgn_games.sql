-- Games we hold with moves, per tournament: the count the explorer shows.
-- Stored on the row so /tournaments stops counting it at read time, which
-- joined every game on every request — ~24K rows read per page load, 81% of
-- D1's daily free-tier read budget. Kept current by the cron after it writes
-- a tournament's games, and recounted for every tournament daily; both go
-- through recountPgnGames in games.js.
ALTER TABLE tournaments ADD COLUMN pgn_games INTEGER NOT NULL DEFAULT 0;

UPDATE tournaments SET pgn_games = (
    SELECT COUNT(*) FROM games g
    WHERE g.tournament_slug = tournaments.slug AND g.pgn IS NOT NULL AND g.pgn != ''
);
