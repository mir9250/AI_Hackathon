"""Offline configuration check. Never print configuration values or contact services."""
import json
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]


def check(root=ROOT):
    errors = []
    configs = {}
    required = {
        'backend': ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'CORS_ORIGINS'],
        'frontend': ['VITE_API_BASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'],
    }
    for folder, keys in required.items():
        path = root / folder / '.env'
        configs[folder] = dotenv_values(path) if path.exists() else {}
        for key in keys:
            value = configs[folder].get(key) or ''
            if not value.strip() or 'YOUR_' in value.upper():
                errors.append(f'{folder}/.env: {key} 설정 필요')
    backend, frontend = configs['backend'], configs['frontend']
    urls = [backend.get('SUPABASE_URL'), frontend.get('VITE_SUPABASE_URL')]
    if all(urls) and urls[0].rstrip('/') != urls[1].rstrip('/'):
        errors.append('양쪽 Supabase URL이 일치하지 않음')
    for label, value in [('SUPABASE_URL', urls[0]), ('VITE_SUPABASE_URL', urls[1]),
                         ('VITE_API_BASE_URL', frontend.get('VITE_API_BASE_URL'))]:
        try:
            parsed = urlsplit(value or '')
            local = parsed.hostname in {'localhost', '127.0.0.1'}
            if (not parsed.hostname or parsed.username or parsed.password or parsed.query
                    or parsed.fragment or parsed.path not in {'', '/'}
                    or not (parsed.scheme == 'https' or (local and parsed.scheme == 'http'))):
                raise ValueError()
        except ValueError:
            errors.append(f'{label}: 유효한 HTTPS origin 필요 (로컬 HTTP 허용)')
    for key, value in frontend.items():
        if value and (value.startswith('sb_secret_') or 'SERVICE_ROLE' in key or 'SECRET' in key):
            errors.append(f'frontend/.env: {key} 비밀 키 사용 금지')
        if value and value.count('.') == 2:
            # Inspect legacy JWT role locally without printing or trusting its signature.
            try:
                import base64
                payload = value.split('.')[1]
                role = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4))).get('role')
                if role == 'service_role':
                    errors.append(f'frontend/.env: {key} 관리자 JWT 사용 금지')
            except (ValueError, UnicodeDecodeError, AttributeError):
                pass
    try:
        origins = json.loads(backend.get('CORS_ORIGINS') or '')
        if not isinstance(origins, list) or frontend.get('VITE_API_BASE_URL') is None:
            raise ValueError()
        if not {'http://localhost:5173', 'http://127.0.0.1:5173'}.issubset(origins):
            errors.append('CORS_ORIGINS: 로컬 프론트 origin 두 개 등록 필요')
    except (ValueError, TypeError):
        errors.append('CORS_ORIGINS: JSON 배열 필요')
    return errors


if __name__ == '__main__':
    problems = check()
    for problem in problems:
        print(problem)
    print('설정 점검 실패. 값은 출력하지 않았습니다.' if problems else
          '로컬 설정 점검 통과. 실제 키 유효성·DB 적용·외부 연결은 별도 확인이 필요합니다.')
    raise SystemExit(1 if problems else 0)
