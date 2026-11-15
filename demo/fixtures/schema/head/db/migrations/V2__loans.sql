CREATE TABLE loans (
    id           bigserial PRIMARY KEY,
    member_id    bigint NOT NULL REFERENCES members (id),
    book_id      bigint NOT NULL REFERENCES books (id),
    lent_at      timestamptz NOT NULL DEFAULT now(),
    due_on       date NOT NULL,
    returned_at  timestamptz,
    note         varchar(200),
    legacy_code  text
);

CREATE INDEX loans_member_idx ON loans (member_id);
CREATE INDEX loans_book_idx ON loans (book_id);
