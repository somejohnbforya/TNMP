-- Rating floor from US Chess member data, refreshed alongside rating.
-- NULL = not yet determined, 0 = checked and no floor, else the floor.
ALTER TABLE players ADD COLUMN rating_floor INTEGER;
