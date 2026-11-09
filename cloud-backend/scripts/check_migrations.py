"""Validate reference SQL in disposable SQLite; does not contact D1 or R2."""
from pathlib import Path
import sqlite3


def main():
    migrations = Path(__file__).resolve().parents[1] / 'migrations'
    with sqlite3.connect(':memory:') as db:
        db.execute('PRAGMA foreign_keys = ON')
        for name in ('0000_loose_makkari.sql', '0001_big_cable.sql'):
            db.executescript((migrations / name).read_text(encoding='utf-8'))
        expected = {
            'users': {'id', 'email', 'display_name', 'created_at', 'last_login_at'},
            'login_events': {'id', 'user_id', 'kind', 'visit_id', 'occurred_at'},
            'workspaces': {'user_id', 'payload', 'version', 'updated_at'},
            'photos': {'id', 'user_id', 'object_key', 'mime', 'bytes', 'created_at'},
        }
        for table, columns in expected.items():
            actual = {row[1] for row in db.execute(f'PRAGMA table_info({table})')}
            if actual != columns:
                raise RuntimeError(f'{table}: unexpected columns')
        indexes = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        if not {'login_events_user_time', 'login_events_visit_kind', 'photos_user'} <= indexes:
            raise RuntimeError('Missing indexes')
        db.execute("INSERT INTO users VALUES ('test-user', 'test@example.invalid', 'Test', 'test-time', NULL)")
        db.execute("INSERT INTO workspaces (user_id, payload, updated_at) VALUES ('test-user', '{}', 'test-time')")
        if db.execute('SELECT version FROM workspaces').fetchone() != (0,):
            raise RuntimeError('Workspace default version mismatch')
        db.execute("INSERT INTO photos VALUES ('test-photo', 'test-user', 'photos/test', 'image/png', 8, 'test-time')")
        db.execute("INSERT INTO login_events VALUES ('event-1', 'test-user', 'login', 'visit', 'test-time')")
        try:
            db.execute("INSERT INTO login_events VALUES ('event-2', 'test-user', 'login', 'visit', 'test-time')")
        except sqlite3.IntegrityError:
            pass
        else:
            raise RuntimeError('Duplicate visit must be rejected')
        db.execute("DELETE FROM users WHERE id='test-user'")
        for table in ('workspaces', 'photos', 'login_events'):
            if db.execute(f'SELECT COUNT(*) FROM {table}').fetchone() != (0,):
                raise RuntimeError(f'{table}: cascade failed')
        if db.execute('PRAGMA foreign_key_check').fetchall():
            raise RuntimeError('Foreign key check failed')
    print('PASS: reference migrations, columns, indexes, default version, unique visit, cascade')
    print('SQLite memory only; D1 runtime and private R2 binding NOT verified.')


if __name__ == '__main__':
    main()
