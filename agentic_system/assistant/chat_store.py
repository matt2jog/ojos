"""Durable chat context owned by Ojos, independent of the ADK session."""

from contextlib import contextmanager
from pathlib import Path
import re
import sqlite3


class ChatStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS chat (
                    id TEXT PRIMARY KEY, context TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '', through_seq INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS turn (
                    seq INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, id TEXT NOT NULL,
                    question TEXT NOT NULL, answer TEXT NOT NULL, UNIQUE(chat_id, id)
                );
                CREATE INDEX IF NOT EXISTS turn_chat ON turn(chat_id, seq);
                CREATE TABLE IF NOT EXISTS note (
                    chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, text TEXT NOT NULL,
                    UNIQUE(chat_id, text)
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS passage USING fts5(
                    chat_id UNINDEXED, source UNINDEXED, location UNINDEXED, digest UNINDEXED, text
                );
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def context(self, chat_id):
        with self.connect() as db:
            row = db.execute("SELECT context, summary, through_seq FROM chat WHERE id=?", (chat_id,)).fetchone()
            return tuple(row) if row else ("", "", 0)

    def recent(self, chat_id, through=0, limit=None):
        sql = "SELECT seq,id,question,answer FROM turn WHERE chat_id=? AND seq>? ORDER BY seq DESC"
        args = (chat_id, through)
        if limit is not None:
            sql += " LIMIT ?"
            args += (limit,)
        with self.connect() as db:
            return [dict(row) for row in reversed(db.execute(sql, args).fetchall())]

    def turn(self, chat_id, turn_id):
        with self.connect() as db:
            row = db.execute("SELECT question,answer FROM turn WHERE chat_id=? AND id=?", (chat_id, turn_id)).fetchone()
            return dict(row) if row else None

    def compact(self, chat_id, summary, through):
        with self.connect() as db:
            db.execute("UPDATE chat SET summary=?, through_seq=? WHERE id=? AND through_seq<?",
                       (summary, through, chat_id, through))

    def save_turn(self, chat_id, turn_id, question, answer, context):
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO chat(id,context) VALUES(?,?)", (chat_id, context))
            db.execute("INSERT INTO turn(chat_id,id,question,answer) VALUES(?,?,?,?)",
                       (chat_id, turn_id, question, answer))

    def index(self, chat_id, source, digest, passages):
        with self.connect() as db:
            old = db.execute("SELECT digest FROM passage WHERE chat_id=? AND source=? LIMIT 1",
                             (chat_id, source)).fetchone()
            if old and old[0] == digest:
                return False
            db.execute("DELETE FROM passage WHERE chat_id=? AND source=?", (chat_id, source))
            total = db.execute("SELECT count(*) FROM passage WHERE chat_id=?", (chat_id,)).fetchone()[0]
            if total + len(passages) > 128:
                raise ValueError("This chat’s file index is full.")
            db.executemany("INSERT INTO passage VALUES(?,?,?,?,?)",
                           [(chat_id, source, location, digest, text) for location, text in passages])
            return True

    def passages(self, chat_id, query=None, limit=5):
        with self.connect() as db:
            if query is None:
                # A small deterministic prefix is reused by every turn until the index changes.
                rows = db.execute("SELECT source,location,text FROM passage WHERE chat_id=? ORDER BY rowid LIMIT ?",
                                  (chat_id, limit))
            else:
                terms = re.findall(r"\w+", query)[:8]
                if not terms:
                    return []
                match = " OR ".join(f'"{term}"' for term in terms)
                rows = db.execute("SELECT source,location,text FROM passage WHERE chat_id=? AND passage MATCH ? "
                                  "ORDER BY rank LIMIT ?", (chat_id, match, limit))
            return [dict(row) for row in rows]

    def remember(self, chat_id, turn_id, note):
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO note VALUES(?,?,?)", (chat_id, turn_id, note))

    def recall(self, chat_id, query):
        with self.connect() as db:
            rows = db.execute("SELECT turn_id,text FROM note WHERE chat_id=? AND instr(lower(text),lower(?))>0 "
                              "ORDER BY rowid DESC LIMIT 6", (chat_id, query))
            return [dict(row) for row in rows]
