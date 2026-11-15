-- Renewals are counted, the due date gets its final name, the old import code goes.
ALTER TABLE loans ADD COLUMN renewals integer NOT NULL;
ALTER TABLE loans ALTER COLUMN note TYPE varchar(80);
ALTER TABLE loans RENAME COLUMN due_on TO due_date;
ALTER TABLE loans DROP COLUMN legacy_code;

CREATE INDEX loans_due_idx ON loans (due_date);
