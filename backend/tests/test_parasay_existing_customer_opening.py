"""Focused, isolated tests for the PARASAY existing-customer opening preview.
The test database is in memory; no production customer or voucher is touched.
"""
import asyncio
import csv
import io
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

import app.data_import as importer


def _csv():
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, delimiter="؛", fieldnames=[
        "CustomerID", "CustomerCode", "AccountID", "BalanceAmount",
        "BalanceState", "VerifiedNetBalance",
    ])
    writer.writeheader()
    for i in range(400):
        if i < 76:
            value = 1 if i < 75 else 39668475516 - 75
        elif i < 98:
            value = -1 if i < 97 else -(3888791595 - 21)
        else:
            value = 0
        writer.writerow({
            "CustomerID": i + 1,
            "CustomerCode": str(21001 + i),
            "AccountID": 7300 + i,
            "BalanceAmount": str(abs(value)) + ".00",
            "BalanceState": "بد" if value > 0 else "بس" if value < 0 else "بی حساب",
            "VerifiedNetBalance": str(value) + ".00",
        })
    return buffer.getvalue().encode("utf-8-sig")


@pytest.fixture
def preview_database(monkeypatch):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT, is_active INTEGER)"))
        conn.execute(text("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, notes TEXT, company_id INTEGER)"))
        conn.execute(text("CREATE TABLE accounting_entries (id INTEGER PRIMARY KEY, customer_id INTEGER, company_id INTEGER)"))
        conn.execute(text("INSERT INTO companies VALUES (1, 'هایپر دکتر', 1), (2, 'تنفسی', 1)"))
        conn.execute(text("INSERT INTO customers (id, name, notes, company_id) VALUES (:id, :name, :notes, 1)"), [
            {"id": i + 1, "name": "مشتری " + str(i + 1),
             "notes": "کد پاراسای: " + str(21001 + i) + " | وارد شده از پاراسای"}
            for i in range(400)
        ])
    monkeypatch.setattr(importer, "engine", engine)
    yield engine
    engine.dispose()


def _request(company_id=1):
    return SimpleNamespace(state=SimpleNamespace(
        auth={"role": "admin", "sub": "1", "company_id": company_id}
    ))


def _preview(blob, company_id=1):
    return asyncio.run(importer.preview_existing_customer_opening(
        _request(company_id),
        UploadFile(filename="PARASAY_400_Customer_Balances.csv", file=io.BytesIO(blob)),
    ))


def test_parasay_preview_reconciles_400_customers_without_posting(preview_database):
    report = _preview(_csv())
    assert report["can_apply"] is True
    assert report["matched_customers"] == 400
    assert report["nonzero_customers"] == 98
    assert len(report["balances"]) == 98
    assert report["debit"] == "39668475516.00"
    assert report["credit"] == "3888791595.00"
    assert report["net"] == "35779683921.00"
    with preview_database.begin() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM accounting_entries")).scalar() == 0
        assert conn.execute(text("SELECT COUNT(*) FROM customers")).scalar() == 400


def test_parasay_preview_rejects_other_company(preview_database):
    with pytest.raises(HTTPException) as error:
        _preview(_csv(), company_id=2)
    assert error.value.status_code == 403


def test_parasay_preview_blocks_existing_subledger(preview_database):
    with preview_database.begin() as conn:
        conn.execute(text("INSERT INTO accounting_entries (id, customer_id, company_id) VALUES (1, 1, 1)"))
    report = _preview(_csv())
    assert report["can_apply"] is False
    assert any("already has accounting entries" in issue for issue in report["issues"])


def test_parasay_preview_rejects_duplicate_code(preview_database):
    blob = _csv().decode("utf-8-sig")
    lines = blob.splitlines()
    # Deliberately repeat customer code of the first row, preserving all other
    # input fields, so uniqueness enforcement is independently exercised.
    fields = lines[2].split("؛")
    fields[1] = lines[1].split("؛")[1]
    lines[2] = "؛".join(fields)
    report = _preview(("\n".join(lines) + "\n").encode("utf-8-sig"))
    assert report["can_apply"] is False
    assert any("duplicate PARASAY customer code" in issue for issue in report["issues"])
