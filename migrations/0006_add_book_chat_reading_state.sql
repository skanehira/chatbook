-- Whether the conversation the reader had open was the book's own rather than a
-- highlight's. Saved with the rest of the place alongside selection_id — at most
-- one of the two is set — and not with the panels: a narrow screen has a
-- conversation open on the book too, where the panels are a drawer and a sheet.
-- NULL is "nothing recorded yet": a book stored before this column, or one
-- nobody has read.
ALTER TABLE pdfs ADD COLUMN last_read_book_chat INTEGER;
