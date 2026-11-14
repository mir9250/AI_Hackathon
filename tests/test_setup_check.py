import base64
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('check_setup', Path(__file__).parents[1] / 'scripts/check_setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def test_setup_check_detects_secret_in_frontend_without_echoing_it(tmp_path):
    for folder in ['backend', 'frontend']:
        (tmp_path / folder).mkdir()
    (tmp_path / 'backend/.env').write_text(
        'SUPABASE_URL=https://test.supabase.co\nSUPABASE_SECRET_KEY=private-test-value\nSUPABASE_PUBLISHABLE_KEY=sb_publishable_test\n'
        'CORS_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173"]\n')
    frontend = tmp_path / 'frontend/.env'
    public_config = ('VITE_SUPABASE_URL=https://test.supabase.co\n'
                     'VITE_API_BASE_URL=http://localhost:8000\n')
    frontend.write_text(public_config + 'VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test\n')
    assert setup.check(tmp_path) == []
    for secret in ['sb_secret_do-not-print', 'a.' + base64.urlsafe_b64encode(
            b'{"role":"service_role"}').decode().rstrip('=') + '.b']:
        frontend.write_text(public_config + f'VITE_SUPABASE_PUBLISHABLE_KEY={secret}\n')
        errors = setup.check(tmp_path)
        assert errors
        assert secret not in str(errors)


def test_missing_configuration_returns_field_names_only(tmp_path):
    errors = setup.check(tmp_path)
    assert any('SUPABASE_SECRET_KEY' in error for error in errors)
