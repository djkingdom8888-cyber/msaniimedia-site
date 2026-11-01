"""Integration tests against the real lib/db.py + lib/content.py layer
(SQLite) for the new live_stream_destinations table -- covers the
remember-key opt-in persistence rule and a real regression caught while
building this: deleting a live session that has destinations used to fail
with a FOREIGN KEY constraint error because delete_live_session() didn't
clean up live_stream_destinations rows first."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import content, db

db.init_db()


class StreamDestinationPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.session_id, self.room_code = content.create_live_session("Test Session (automated)", "Test Host")

    def test_key_not_persisted_without_remember_opt_in(self):
        dest_id = content.create_stream_destination(
            self.session_id, "Dest 1", "custom", "rtmp://x/app", "secret-key", True, False,
        )
        row = content.get_stream_destination(dest_id)
        self.assertEqual(row["stream_key"], "", "key should NOT be persisted when remember_key is False")
        self.assertEqual(row["rtmp_url"], "rtmp://x/app")  # non-sensitive fields still persist

    def test_key_persisted_with_remember_opt_in(self):
        dest_id = content.create_stream_destination(
            self.session_id, "Dest 2", "twitch", "rtmp://x/app", "secret-key", True, True,
        )
        row = content.get_stream_destination(dest_id)
        self.assertEqual(row["stream_key"], "secret-key")

    def test_turning_remember_off_blanks_a_previously_remembered_key(self):
        dest_id = content.create_stream_destination(
            self.session_id, "Dest 3", "custom", "rtmp://x/app", "secret-key", True, True,
        )
        self.assertEqual(content.get_stream_destination(dest_id)["stream_key"], "secret-key")
        content.update_stream_destination(dest_id, remember_key=False)
        self.assertEqual(content.get_stream_destination(dest_id)["stream_key"], "")

    def test_updating_key_while_remember_is_off_never_persists_it(self):
        dest_id = content.create_stream_destination(
            self.session_id, "Dest 4", "custom", "rtmp://x/app", "", True, False,
        )
        content.update_stream_destination(dest_id, stream_key="new-secret")
        self.assertEqual(content.get_stream_destination(dest_id)["stream_key"], "")

    def test_list_stream_destinations_scoped_to_session(self):
        other_session_id, _ = content.create_live_session("Other session", "Other Host")
        content.create_stream_destination(self.session_id, "A", "custom", "rtmp://a/app", "", True, False)
        content.create_stream_destination(other_session_id, "B", "custom", "rtmp://b/app", "", True, False)
        try:
            rows = content.list_stream_destinations(self.session_id)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["name"], "A")
        finally:
            content.delete_live_session(other_session_id)

    def test_delete_live_session_with_destinations_does_not_raise(self):
        # Regression: this used to raise sqlite3.IntegrityError (FOREIGN KEY
        # constraint failed) because delete_live_session() didn't delete
        # live_stream_destinations rows before deleting the parent session.
        content.create_stream_destination(self.session_id, "A", "custom", "rtmp://a/app", "", True, False)
        content.create_stream_destination(self.session_id, "B", "twitch", "rtmp://b/app", "key", True, True)
        content.delete_live_session(self.session_id)  # must not raise
        self.assertIsNone(content.get_live_session(self.session_id))
        self.assertEqual(content.list_stream_destinations(self.session_id), [])
        self.session_id = None  # already deleted -- don't double-delete in tearDown

    def test_delete_stream_destination_removes_only_that_row(self):
        d1 = content.create_stream_destination(self.session_id, "A", "custom", "rtmp://a/app", "", True, False)
        d2 = content.create_stream_destination(self.session_id, "B", "custom", "rtmp://b/app", "", True, False)
        content.delete_stream_destination(d1)
        remaining = content.list_stream_destinations(self.session_id)
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["id"], d2)

    def tearDown(self):
        if self.session_id is not None:
            content.delete_live_session(self.session_id)


if __name__ == "__main__":
    unittest.main()
