CREATE TABLE authors (
    id    bigserial PRIMARY KEY,
    name  varchar(160) NOT NULL
);

CREATE TABLE book_authors (
    book_id    bigint NOT NULL REFERENCES books (id),
    author_id  bigint NOT NULL REFERENCES authors (id),
    PRIMARY KEY (book_id, author_id)
);
