"""돌려받집 실행: python3 실험용.py → http://localhost:8001/"""
import importlib.util
from pathlib import Path


def main():
    path = Path(__file__).resolve().parent / 'rental-demo' / 'server.py'
    spec = importlib.util.spec_from_file_location('deposit_guardian_server', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.main()


if __name__ == '__main__':
    main()
