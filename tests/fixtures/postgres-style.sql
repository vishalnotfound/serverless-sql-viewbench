CREATE TABLE authors (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL
);
CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES authors(id),
  title TEXT NOT NULL,
  published DATE
);
INSERT INTO authors (id, name) VALUES (1,'Ursula K. Le Guin'),(2,'Toni Morrison');
INSERT INTO books (id, author_id, title, published) VALUES
(1,1,'The Dispossessed','1974-05-01'),
(2,1,'A Wizard of Earthsea','1968-11-01'),
(3,2,'Beloved','1987-09-02');
