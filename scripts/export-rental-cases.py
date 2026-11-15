"""v0.2 자료 검증·서버 패키징·다운로드 생성. 재수집이나 외부 호출 없음."""
import argparse
import csv
import hashlib
import json
from collections import Counter
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile
from rental_law_common import case_numbers

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data/rental-law/records-v0.2.json'
RUNTIME = ROOT / 'backend/app/data/rental-law-v0.2.json'
OUTPUT = ROOT / '.baze-files/outputs/rental-law-v0.2'


def validate(data):
    records = data['records']
    assert Counter(r['type'] for r in records) == {'statute': 10, 'case': 120}
    ids = [r['id'] for r in records]
    assert len(set(ids)) == 130
    numbers = set()
    for r in records:
        assert r['source_quote'] and r['source_scope'] and r['cautions']
        assert set(r['related_ids']) <= set(ids)
        assert urlsplit(r['source_url']).hostname in {'law.go.kr', 'www.law.go.kr', 'www.easylaw.go.kr'}
        if r['type'] == 'case':
            assert r['case_numbers'] and not numbers.intersection(r['case_numbers']), r['citation']
            numbers.update(r['case_numbers'])
            assert date.fromisoformat(r['decision_on']) <= date.today()
            date.fromisoformat(r['retrieved_on'])
        if r['verification_level'] != 'primary_text_checked':
            assert r['verification_level'] == 'official_secondary_only'
            assert not r['reference_eligible_after_legal_review']
        if r.get('source_quote_sha256'):
            assert hashlib.sha256(r['source_quote'].encode()).hexdigest() == r['source_quote_sha256']
    assert not data['production_ready'] and not data['legal_professional_reviewed']
    assert data['collection_report']['actual_cases'] == 120


def main(check=False):
    data = json.loads(SOURCE.read_text(encoding='utf-8'))
    # 공개 인용의 "2024다297384, 297391" 같은 축약 병합번호도 모두 보존한다.
    if not check:
        for r in data['records']:
            if r['type'] == 'case' and r['id'].startswith('case-law-'):
                number_text = r['citation'].split('선고', 1)[-1].split('판결', 1)[0].split('결정', 1)[0]
                r['case_numbers'] = case_numbers(number_text)
    validate(data)
    canonical = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    if check:
        assert RUNTIME.read_text(encoding='utf-8') == canonical, '서버 자료와 원본 불일치'
        assert (OUTPUT.parent / 'rental-cases-120.csv').read_bytes() == (OUTPUT / 'rental-cases.csv').read_bytes()
        manifest = json.loads((OUTPUT / 'manifest.json').read_text())
        for name, digest in manifest['sha256'].items():
            assert hashlib.sha256((OUTPUT / name).read_bytes()).hexdigest() == digest
        with ZipFile(OUTPUT.parent / 'rental-law-v0.2.zip') as z:
            assert z.testzip() is None
            for name in manifest['sha256']:
                assert z.read(f'rental-law-v0.2/{name}') == (OUTPUT / name).read_bytes()
        print('130건 구조·120개 사건 중복·인용 해시·서버 동기화·다운로드 무결성 확인')
        return
    SOURCE.write_text(canonical, encoding='utf-8')
    RUNTIME.parent.mkdir(parents=True, exist_ok=True)
    RUNTIME.write_text(canonical, encoding='utf-8')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'rental-law.json').write_text(canonical, encoding='utf-8')
    cases = [{**r, 'dataset_version': data['version'], 'legal_professional_reviewed': False,
              'production_ready': False, 'dataset_notice': data['notice'], 'reuse_notice': data['reuse_notice']}
             for r in data['records'] if r['type'] == 'case']
    (OUTPUT / 'rental-cases.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in cases), encoding='utf-8')
    fields = list(dict.fromkeys(k for r in cases for k in r))
    with (OUTPUT / 'rental-cases.csv').open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in cases:
            writer.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for k, v in r.items()})
    (OUTPUT.parent / 'rental-cases-120.csv').write_bytes((OUTPUT / 'rental-cases.csv').read_bytes())
    (OUTPUT / 'README.md').write_text((ROOT / 'data/rental-law/README-v0.2.md').read_text(), encoding='utf-8')
    (OUTPUT / 'collection-report.json').write_text(json.dumps(data['collection_report'], ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    files = [OUTPUT / name for name in ('rental-law.json', 'rental-cases.jsonl', 'rental-cases.csv', 'README.md', 'collection-report.json')]
    manifest = {'version': data['version'], 'statutes': 10, 'cases': 120, 'sha256': {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    with ZipFile(OUTPUT.parent / 'rental-law-v0.2.zip', 'w', ZIP_DEFLATED) as z:
        for p in files + [OUTPUT / 'manifest.json']:
            z.write(p, arcname=f'rental-law-v0.2/{p.name}')
    main(check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    main(parser.parse_args().check)
