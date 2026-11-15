"""공개 국가법령정보센터 검색·판결요지를 소량씩 조회하는 재현 가능한 수집기.

인증 우회·비공개 자료 조회 없음. 캐시는 판결요지·쟁점·공개 메타데이터만 저장한다.
전문 당사자 정보는 저장하지 않는다. 재수집은 명시적으로 실행한 때만 한다.
"""
import argparse
import hashlib
import json
import re
import time
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from rental_law_common import case_numbers

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://www.law.go.kr/LSW/'
TOPICS = [
    ('보증금 반환', '보증금반환'),
    ('임대차 일반', '임대차'),
    ('보증금 반환', '임대차 보증금 반환'),
    ('원상회복', '임대차 원상회복'),
    ('수선 의무', '임대인 수선의무'),
    ('계약 종료', '주택임대차 해지'),
    ('보증금 보호', '주택임대차 대항력'),
    ('계약 갱신', '주택임대차 갱신'),
    ('보증금 정산', '임대차 차임 공제'),
    ('임차권등기', '임차권등기명령'),
]


class Page(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.parts, self.fields, self.case_ids = [], {}, []
        self.skip = 0
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('script', 'style'):
            self.skip += 1
        if tag == 'input' and attrs.get('id') in {'precNm', 'precNo', 'precYd', 'precSeq'}:
            self.fields[attrs['id']] = attrs.get('value', '')
        match = re.search(r"precView\('(\d+)'", attrs.get('onclick', ''))
        if match:
            self.case_ids.append(match[1])

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)

    def handle_data(self, text):
        if not self.skip and text.strip():
            self.parts.append(text.strip())


def fetch(url):
    # 직렬 조회, 요청 사이 간격, 실패 1회만 재시도. 403/429는 즉시 중단한다.
    time.sleep(.4)
    for attempt in range(2):
        try:
            with urlopen(Request(url, headers={'User-Agent': 'RentalLawResearch/0.2 (public-case-reference)'}), timeout=40) as response:
                return response.read().decode('utf-8')
        except Exception as error:
            if getattr(error, 'code', None) in {401, 403, 429} or attempt:
                raise
            time.sleep(2)


def section(text, marker):
    if marker not in text:
        return ''
    return re.split(r'【[^】]+】', text.split(marker, 1)[1], maxsplit=1)[0].strip()


def extract(html, seq, topic, discovered_from):
    page = Page(html)
    text = ' '.join(page.parts)
    fields = page.fields
    quote = section(text, '【판결요지】')
    issues = section(text, '【판시사항】')
    if not quote or len(quote) < 40 or not fields.get('precNo'):
        return None
    if not re.search('임대|임차|보증금|전세', quote + issues):
        return None
    raw_date = fields['precYd']
    when = date.fromisoformat(f'{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}')
    if when > date.today():
        raise ValueError('미래 선고일')
    header = re.search(r'\[([^\[\]]*\d{4}\.\s*\d+\.\s*\d+\.[^\[\]]*(?:판결|결정)[^\[\]]*)\]', text)
    if not header:
        return None
    citation = re.sub(r'\s+', ' ', header[1]).strip()
    court = re.split(r'\s+\d{4}\.', citation, maxsplit=1)[0]
    numbers = case_numbers(fields['precNo'])
    return {
        'id': 'case-law-' + seq, 'type': 'case', 'citation': citation,
        'title': fields['precNm'], 'court': court, 'case_numbers': numbers,
        'original_context': issues or '판시사항 별도 제공 없음. 공개 판결요지와 원문을 확인하세요.',
        'topics': [topic], 'discovered_from': [discovered_from],
        'source_url': BASE + 'precInfoP.do?' + urlencode({'precSeq': seq}),
        'source_publisher': '법제처 국가법령정보센터',
        'verification_level': 'primary_text_checked',
        'source_scope': '공개 판결요지 전체; 공백 정규화. 판결 전문·당사자 정보는 수록하지 않음',
        'source_quote': quote, 'source_issues': issues,
        'source_quote_sha256': hashlib.sha256(quote.encode()).hexdigest(),
        'law_version_label': None, 'law_version_effective_on': None,
        'decision_on': when.isoformat(), 'retrieved_on': date.today().isoformat(),
        'summary': None,
        'cautions': ['공식 판결요지를 수집했지만 법률 전문가의 적용 검토는 거치지 않았어요.',
                     '주택·상가·토지 등 구체적인 임대 대상과 계약·특약·사건 당시 법령을 원문에서 확인해야 해요.',
                     '후속 판결·변경·폐기 여부를 전수 확인하지 않았어요. 책임·공제액을 자동 판정하면 안 돼요.'],
        'evidence_to_prepare': ['실제 계약서·특약', '사건 발생 및 종료 시점', '관련 사진·통지·지급 내역'],
        'related_ids': [], 'reference_eligible_after_legal_review': True,
        'curation_method': '공식 검색 주제 및 임대차 용어 필터; 개별 법률 적용 미검토',
    }


def collect(target):
    cache = Path('/tmp/opencode/rental-case-cache')
    cache.mkdir(parents=True, exist_ok=True)
    seed = json.loads((ROOT / 'data/rental-law/records.json').read_text())
    cases = [r.copy() for r in seed['records'] if r['type'] == 'case']
    for r in cases:
        r['retrieved_on'] = seed['retrieved_on']
        r['curation_method'] = 'v0.1 수작업 선별; 전문가 미검토'
    numbers = {n for r in cases for n in r['case_numbers']}
    seen = set()
    failures = []
    # 주제별 순환으로 최신 보증금 사건만으로 채우지 않는다.
    for pg in range(1, 13):
        for topic, query in TOPICS:
            search = BASE + 'precSc.do?' + urlencode({'query': query, 'pg': pg, 'outmax': 15})
            ids = list(dict.fromkeys(Page(fetch(search)).case_ids))
            for seq in ids:
                if seq in seen:
                    continue
                seen.add(seq)
                url = BASE + 'precInfoP.do?' + urlencode({'precSeq': seq})
                cached = cache / (seq + '.json')
                if cached.exists():
                    record = json.loads(cached.read_text(encoding='utf-8'))
                    if record:
                        record['topics'] = [topic]
                        record['discovered_from'] = [search]
                else:
                    record = extract(fetch(url), seq, topic, search)
                    cached.write_text(json.dumps(record, ensure_ascii=False), encoding='utf-8')
                if not record:
                    failures.append({'source_url': url, 'reason': '판결요지·메타데이터 누락 또는 임대차 직접 관련성 필터 미충족'})
                    continue
                if numbers.intersection(record['case_numbers']):
                    continue
                numbers.update(record['case_numbers'])
                cases.append(record)
                (cache / 'progress.json').write_text(json.dumps({'count': len(cases), 'cases': cases}, ensure_ascii=False), encoding='utf-8')
                print(f"{len(cases)}/{target} {record['citation']}", flush=True)
                if len(cases) == target:
                    seed.update(version='0.2.0', retrieved_on=date.today().isoformat(),
                                curation_notice='기존 수작업 선별 5건과 공식 검색·용어 필터로 추가 수집한 판결요지입니다. 120건 전체를 전문가가 선별·검토한 자료가 아닙니다.')
                    seed['records'] = [r for r in seed['records'] if r['type'] == 'statute'] + cases
                    seed['collection_report'] = {'target_cases': target, 'actual_cases': len(cases),
                        'checked_candidate_ids': len(seen), 'skipped_candidates': failures,
                        'topics': [t for t, _ in TOPICS], 'automatic_refresh': False}
                    out = ROOT / 'data/rental-law/records-v0.2.json'
                    out.write_text(json.dumps(seed, ensure_ascii=False, indent=2) + '\n')
                    return
    raise RuntimeError(f'목표 미달: {len(cases)}건. 완료 데이터로 저장하지 않음')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', type=int, default=120)
    collect(parser.parse_args().target)
