-- Keyed on the implicit rowid of `principles`, like decisions_fts: VACUUM may renumber implicit rowids,
-- so never VACUUM this database without rebuilding both indexes afterwards. Backups use .backup(), which is safe.
CREATE VIRTUAL TABLE principles_fts USING fts5(statement, topic_key, source_quote, content='principles', content_rowid='rowid');
--> statement-breakpoint
CREATE TRIGGER principles_fts_insert AFTER INSERT ON principles BEGIN
  INSERT INTO principles_fts(rowid, statement, topic_key, source_quote) VALUES (new.rowid, new.statement, new.topic_key, new.source_quote);
END;
--> statement-breakpoint
CREATE TRIGGER principles_fts_delete AFTER DELETE ON principles BEGIN
  INSERT INTO principles_fts(principles_fts, rowid, statement, topic_key, source_quote) VALUES ('delete', old.rowid, old.statement, old.topic_key, old.source_quote);
END;
--> statement-breakpoint
CREATE TRIGGER principles_fts_update AFTER UPDATE ON principles BEGIN
  INSERT INTO principles_fts(principles_fts, rowid, statement, topic_key, source_quote) VALUES ('delete', old.rowid, old.statement, old.topic_key, old.source_quote);
  INSERT INTO principles_fts(rowid, statement, topic_key, source_quote) VALUES (new.rowid, new.statement, new.topic_key, new.source_quote);
END;
