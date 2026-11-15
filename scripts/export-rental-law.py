"""선별 자료 검증과 JSON/JSONL/CSV 다운로드 묶음 생성. 외부 호출 없음."""

import csv
import hashlib
import json
from collections import Counter
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data/rental-law/records.json"
OUTPUT = ROOT / ".baze-files/outputs/rental-law-v0.1"


def validate(data):
    records = data["records"]
    ids = [r["id"] for r in records]
    assert len(ids) == len(set(ids)), "중복 ID"
    assert Counter(r["type"] for r in records) == {"statute": 10, "case": 5}
    assert not data["production_ready"] and not data["legal_professional_reviewed"]
    date.fromisoformat(data["retrieved_on"])
    for r in records:
        assert set(r["related_ids"]) <= set(ids), f"연결 대상 없음: {r['id']}"
        assert r["summary"] and r["source_quote"] and r["cautions"]
        assert r["source_scope"] and r["evidence_to_prepare"]
        assert urlsplit(r["source_url"]).hostname in {"www.law.go.kr", "law.go.kr", "www.easylaw.go.kr"}
        assert r["verification_level"] in {"primary_text_checked", "official_secondary_only"}
        if r["verification_level"] == "official_secondary_only":
            assert not r["reference_eligible_after_legal_review"]
        if r["type"] == "statute":
            date.fromisoformat(r["law_version_effective_on"])
            assert r["decision_on"] is None and r["law_version_label"]
        else:
            date.fromisoformat(r["decision_on"])
            assert r["law_version_effective_on"] is None
            assert r["court"] and r["case_numbers"] and r["original_context"]


def main():
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    validate(data)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    rows = [{**r, "retrieved_on": data["retrieved_on"],
             "legal_professional_reviewed": False, "production_ready": False,
             "dataset_notice": data["notice"], "reuse_notice": data["reuse_notice"]}
            for r in data["records"]]
    (OUTPUT / "rental-law.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUTPUT / "rental-law.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    fields = list(dict.fromkeys(key for r in rows for key in r))
    with (OUTPUT / "rental-law.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, list) else v
                             for k, v in r.items()})
    (OUTPUT / "README.md").write_text(
        (ROOT / "data/rental-law/README.md").read_text(encoding="utf-8"), encoding="utf-8")
    files = [OUTPUT / name for name in ("rental-law.json", "rental-law.jsonl", "rental-law.csv", "README.md")]
    manifest = {"dataset_id": data["dataset_id"], "version": data["version"],
                "records": len(rows), "sha256": {
                    p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
    manifest_path = OUTPUT / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with ZipFile(OUTPUT.parent / "rental-law-v0.1.zip", "w", ZIP_DEFLATED) as archive:
        for p in files + [manifest_path]:
            archive.write(p, arcname=f"rental-law-v0.1/{p.name}")
    assert len([json.loads(line) for line in (OUTPUT / "rental-law.jsonl").read_text(encoding="utf-8").splitlines()]) == 15
    with (OUTPUT / "rental-law.csv").open(encoding="utf-8-sig", newline="") as f:
        exported = list(csv.DictReader(f))
    assert [r["id"] for r in exported] == [r["id"] for r in rows]
    assert all(r["source_quote"] == original["source_quote"] for r, original in zip(exported, rows))
    print("조문 10건 + 판례 5건 검증 완료; JSON·JSONL·CSV·README·manifest 및 ZIP 생성")


if __name__ == "__main__":
    main()
