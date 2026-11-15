"""사건번호 표기의 병합·축약 번호를 정규화한다. 날짜나 조문번호는 입력하지 않는다."""
import re


def case_numbers(value):
    value = re.sub(r'\([^)]*\)', '', value)
    tokens = re.findall(r'\d{2,4}[가-힣]+\d+|(?<!\d)\d{4,9}(?!\d)', value)
    output, prefix = [], None
    for token in tokens:
        full = re.fullmatch(r'(\d{2,4}[가-힣]+)(\d+)', token)
        if full:
            prefix = full[1]
            output.append(token)
        elif prefix:
            output.append(prefix + token)
    return list(dict.fromkeys(output))
