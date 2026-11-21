import asyncio
from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

from . import adk_chat
from .chat_files import FileTools
from .chat_store import ChatStore


class ChatPersistenceTests(TestCase):
    def test_catalog_migrates_and_preserves_legacy_chats(self):
        with TemporaryDirectory(prefix="ojos-chat-catalog-") as directory:
            path = Path(directory) / "chat.sqlite3"
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript("""
                    CREATE TABLE chat (
                        id TEXT PRIMARY KEY, context TEXT NOT NULL DEFAULT '',
                        summary TEXT NOT NULL DEFAULT '', through_seq INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE TABLE turn (
                        seq INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, id TEXT NOT NULL,
                        question TEXT NOT NULL, answer TEXT NOT NULL, UNIQUE(chat_id, id)
                    );
                    INSERT INTO chat(id,context) VALUES('old','Previous screen');
                    INSERT INTO turn(chat_id,id,question,answer) VALUES('old','1','Old topic','Old answer');
                """)
            store = ChatStore(path)
            store.save_turn("new", "1", "New question", "New answer", "", ("New topic", "New description"))
            store.save_turn("new", "2", "Follow-up", "Next answer", "", ("Skip renaming", "Skip"))
            self.assertEqual(store.chats(), [
                {"id": "new", "title": "New topic", "description": "New description"},
                {"id": "old", "title": "Old topic", "description": "Old answer"},
            ])
            cursor = store.recent("new")[-1]["seq"]
            self.assertEqual([turn["id"] for turn in store.recent("new", before=cursor)], ["1"])
            self.assertEqual(ChatStore(path).context("old")[0], "Previous screen")

    def test_compaction_and_index_stay_with_each_chat(self):
        with TemporaryDirectory(prefix="ojos-chat-test-") as directory:
            path = Path(directory) / "chat.sqlite3"
            store = ChatStore(path)
            store.save_turn("one", "turn", "First question", "First answer", "Initial context")
            store.save_turn("one", "next", "Follow-up", "Second answer", "")
            store.save_turn("two", "turn", "Other question", "Other answer", "Other context")
            through = store.recent("one")[0]["seq"]
            store.compact("one", "Summary", through)
            store.index("one", "root1/notes.txt", "digest", [("1", "Maple grows here")])
            store.remember("one", "turn", "Bring a charger")
            reopened = ChatStore(path)
            self.assertEqual(reopened.context("one"), ("Initial context", "Summary", through))
            self.assertEqual([turn["id"] for turn in reopened.recent("one", through)], ["next"])
            self.assertEqual(reopened.turn("two", "turn")["answer"], "Other answer")
            self.assertTrue(reopened.passages("one", "maple"))
            self.assertEqual(reopened.passages("two", "maple"), [])
            self.assertEqual(reopened.recall("two", "charger"), [])

    def test_file_tools_restrict_reads_to_approved_roots(self):
        with TemporaryDirectory(prefix="ojos-file-test-") as directory:
            workspace = Path(directory)
            root = workspace / "inbox"
            root.mkdir()
            (root / "notes.txt").write_text("Maple\nViolet", encoding="utf-8")
            (root / ".env.backup").write_text("ignored", encoding="utf-8")
            (workspace / "outside.txt").write_text("outside", encoding="utf-8")
            tools = FileTools([root])
            self.assertEqual(tools.list_files()["files"], ["root1/notes.txt"])
            self.assertEqual(tools.read_file("root1/notes.txt", 2)["lines"], ["2: Violet"])
            for reference in ("root1/../outside.txt", "root1/.env.backup", "root2/notes.txt"):
                with self.subTest(reference=reference), self.assertRaises(ValueError):
                    tools.read_file(reference)


class DelegationTests(IsolatedAsyncioTestCase):
    async def test_children_share_tools_but_cannot_delegate_and_fifth_call_is_rejected(self):
        with TemporaryDirectory(prefix="ojos-delegate-test-") as directory:
            path = Path(directory)
            service = adk_chat.ChatService("synthetic-test", "gemini-4-hydrogen", path / "db.sqlite3", [path])
            launched = []

            async def run(agent, parts, earlier, max_calls, emit=None):
                tools = {tool.__name__: tool for tool in agent.tools}
                if agent.name == "ojos_delegate":
                    self.assertNotIn("run_subagent", tools)
                    self.assertEqual(set(tools), parent_tools)
                    self.assertEqual(agent.model.model, "gemini-4-neon")
                    self.assertEqual(agent.generate_content_config.thinking_config.thinking_level, "HIGH")
                    launched.append(parts[0].text)
                    return "Work complete"
                parent_tools.update(set(tools) - {"run_subagent"})
                delegate = tools["run_subagent"]
                results = await asyncio.gather(*(delegate(f"Task {i}", "high", "gemini-4-neon") for i in range(5)))
                self.assertTrue(all(result == {"findings": "Work complete"} for result in results[:4]))
                self.assertIn("four subagents", results[4]["error"])
                return "Combined answer"

            parent_tools = set()
            with patch.object(adk_chat, "_run_agent", run), patch.object(
                service, "_name_chat", return_value=("Delegation test", "Test of tool and depth limits")
            ):
                self.assertEqual(await service.run("chat", "turn", "Delegate tasks", "", None, lambda *_: None),
                                 "Combined answer")
            self.assertEqual(len(launched), 4)
            self.assertEqual(service.store.chats("chat")[0]["title"], "Delegation test")
