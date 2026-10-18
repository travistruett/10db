-- The index keys on the implicit rowid of `decisions` (its primary key is TEXT). VACUUM may renumber
-- implicit rowids, so never VACUUM this database without rebuilding the index afterwards with
-- INSERT INTO decisions_fts(decisions_fts) VALUES ('rebuild'). Backups use .backup(), which is safe.
CREATE VIRTUAL TABLE decisions_fts USING fts5(question, choice, rationale, content='decisions', content_rowid='rowid');
--> statement-breakpoint
CREATE TRIGGER decisions_fts_insert AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, question, choice, rationale) VALUES (new.rowid, new.question, new.choice, new.rationale);
END;
--> statement-breakpoint
CREATE TRIGGER decisions_fts_delete AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, question, choice, rationale) VALUES ('delete', old.rowid, old.question, old.choice, old.rationale);
END;
--> statement-breakpoint
CREATE TRIGGER decisions_fts_update AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, question, choice, rationale) VALUES ('delete', old.rowid, old.question, old.choice, old.rationale);
  INSERT INTO decisions_fts(rowid, question, choice, rationale) VALUES (new.rowid, new.question, new.choice, new.rationale);
END;
