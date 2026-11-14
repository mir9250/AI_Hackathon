import os
import subprocess
import sys
from pathlib import Path

import pytest
from pglast import parse_sql
from pydantic import ValidationError

from app.config import Settings

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('values', [
    {'supabase_url': 'http://public.example'},
    {'supabase_url': 'https://x.example/path'},
    {'supabase_secret_key': ''},
    {'supabase_publishable_key': ''},
    {'cors_origins': ['*']},
    {'cors_origins': ['https://site.example/']},
    {'cors_origins': ['http://public.example']},
])
def test_unsafe_config_is_rejected(values):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{'supabase_url': 'https://local-test.supabase.co',
                                  'supabase_secret_key': 'sb_secret_test',
                                  'supabase_publishable_key': 'sb_publishable_test', **values})


def test_configuration_failure_hides_secret_values():
    env = {**os.environ, 'SUPABASE_URL': 'private-invalid-url',
           'SUPABASE_SECRET_KEY': 'do-not-print-this-secret',
           'SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_test', 'CORS_ORIGINS': '["*"]'}
    result = subprocess.run([sys.executable, '-c', 'import main'], cwd=ROOT / 'backend',
                            env=env, capture_output=True, text=True)
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert 'supabase_url' in output
    assert 'do-not-print-this-secret' not in output
    assert 'private-invalid-url' not in output


def test_migration_parses_as_postgresql():
    sql = (ROOT / 'supabase/migrations/202611140001_initial.sql').read_text()
    assert len(parse_sql(sql)) > 50
