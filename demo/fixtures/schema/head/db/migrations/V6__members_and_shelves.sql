-- One account per address, a phone number for every member, and no shelves any more.
CREATE UNIQUE INDEX CONCURRENTLY members_email_key ON members (email);
ALTER TABLE members ALTER COLUMN phone SET NOT NULL;

ALTER TABLE books DROP COLUMN shelf_id;
DROP TABLE shelves;
