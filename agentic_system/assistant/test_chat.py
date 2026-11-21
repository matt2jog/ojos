from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from .chat_files import FileTools
from .chat_store import ChatStore


class ChatPersistenceTests(TestCase):
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
