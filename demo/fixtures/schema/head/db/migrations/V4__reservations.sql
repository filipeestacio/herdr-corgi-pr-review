-- A member can reserve a book that is lent out.
CREATE TABLE reservations (
    id           bigserial PRIMARY KEY,
    member_id    bigint NOT NULL REFERENCES members (id),
    book_id      bigint NOT NULL REFERENCES books (id),
    reserved_at  timestamptz NOT NULL DEFAULT now(),
    expires_on   date
);

CREATE INDEX reservations_member_idx ON reservations (member_id);
