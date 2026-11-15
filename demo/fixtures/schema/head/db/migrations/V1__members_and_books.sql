-- The lending library's first tables: who borrows, what can be borrowed, where it stands.
CREATE TABLE members (
    id         bigserial PRIMARY KEY,
    email      varchar(255) NOT NULL,
    name       varchar(120) NOT NULL,
    phone      varchar(40),
    joined_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shelves (
    id    bigserial PRIMARY KEY,
    code  varchar(12) NOT NULL UNIQUE
);

CREATE TABLE books (
    id        bigserial PRIMARY KEY,
    isbn      varchar(20) NOT NULL UNIQUE,
    title     text NOT NULL,
    shelf_id  bigint REFERENCES shelves (id)
);

CREATE INDEX books_shelf_idx ON books (shelf_id);
