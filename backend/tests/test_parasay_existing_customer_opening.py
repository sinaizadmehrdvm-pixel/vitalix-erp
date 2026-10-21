"""Isolated PARASAY opening tests using the project's unittest runner.
Only an in-memory SQLite database is written.
"""
import asyncio
import csv
import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

import app.data_import as importer


def source_csv():
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


def auth_request(company_id=1):
    return SimpleNamespace(state=SimpleNamespace(
        auth={"role": "admin", "sub": "1", "company_id": company_id}
    ))


class ParasayExistingOpeningTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )
        with self.engine.begin() as conn:
            conn.execute(text("CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT, is_active INTEGER)"))
            conn.execute(text("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, notes TEXT, company_id INTEGER)"))
            conn.execute(text("CREATE TABLE accounting_entries (id INTEGER PRIMARY KEY, customer_id INTEGER, company_id INTEGER)"))
            conn.execute(text("INSERT INTO companies VALUES (1, 'هایپر دکتر', 1), (2, 'تنفسی', 1)"))
            conn.execute(text("INSERT INTO customers (id, name, notes, company_id) VALUES (:id, :name, :notes, 1)"), [
                {"id": i + 1, "name": "مشتری " + str(i + 1),
                 "notes": "کد پاراسای: " + str(21001 + i) + " | وارد شده از پاراسای"}
                for i in range(400)
            ])
        self.engine_patch = patch.object(importer, "engine", self.engine)
        self.engine_patch.start()

    def tearDown(self):
        self.engine_patch.stop()
        self.engine.dispose()

    def preview(self, blob=None, company=1):
        return asyncio.run(importer.preview_existing_customer_opening(
            auth_request(company),
            UploadFile(filename="PARASAY_400_Customer_Balances.csv",
                       file=io.BytesIO(blob if blob is not None else source_csv())),
        ))

    def test_preview_400_codes_98_balances_without_writes(self):
        report = self.preview()
        self.assertTrue(report["can_apply"])
        self.assertEqual(report["matched_customers"], 400)
        self.assertEqual(report["nonzero_customers"], 98)
        self.assertEqual(len(report["balances"]), 98)
        self.assertEqual(report["debit"], "39668475516.00")
        self.assertEqual(report["credit"], "3888791595.00")
        self.assertEqual(report["net"], "35779683921.00")
        with self.engine.begin() as conn:
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM accounting_entries")).scalar(), 0)
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM customers")).scalar(), 400)

    def test_wrong_company_rejected(self):
        with self.assertRaises(HTTPException) as error:
            self.preview(company=2)
        self.assertEqual(error.exception.status_code, 403)

    def test_existing_ledger_blocks_preview(self):
        with self.engine.begin() as conn:
            conn.execute(text("INSERT INTO accounting_entries (id, customer_id, company_id) VALUES (1, 1, 1)"))
        report = self.preview()
        self.assertFalse(report["can_apply"])
        self.assertTrue(any("already has accounting entries" in issue for issue in report["issues"]))

    def test_duplicate_source_code_blocks_preview(self):
        lines = source_csv().decode("utf-8-sig").splitlines()
        fields = lines[2].split("؛")
        fields[1] = lines[1].split("؛")[1]
        lines[2] = "؛".join(fields)
        report = self.preview(("\n".join(lines) + "\n").encode("utf-8-sig"))
        self.assertFalse(report["can_apply"])
        self.assertTrue(any("duplicate PARASAY customer code" in issue for issue in report["issues"]))

    def test_apply_once_balanced_and_company_scoped(self):
        report = self.preview()
        posted = []

        def insert_entry(conn, customer_id, source_type, source_id, description,
                         debit, credit, created_at, company_id):
            conn.execute(text("INSERT INTO accounting_entries (customer_id, company_id) VALUES (:customer, :company)"),
                         {"customer": customer_id, "company": company_id})

        def post_voucher(source_type, source_id, description, lines, company_id, **kwargs):
            self.assertEqual(company_id, 1)
            self.assertEqual(sum(x.get("debit", 0) for x in lines),
                             sum(x.get("credit", 0) for x in lines))
            posted.append((source_type, lines))

        with patch.object(importer, "financial_policy_values", return_value={}), \
             patch.object(importer, "_ensure_posting_schema"), \
             patch.object(importer, "_rebuild_customer_balance"), \
             patch.object(importer, "_insert_accounting_entry", side_effect=insert_entry), \
             patch.object(importer, "post_balanced_voucher", side_effect=post_voucher):
            applied = importer.apply_existing_customer_opening(
                report["batch_id"], auth_request(), confirm="APPLY_1405_07_29")
            self.assertEqual(applied["inserted"], 98)
            self.assertEqual(applied["net"], "35779683921.00")
            with self.assertRaises(HTTPException) as error:
                importer.apply_existing_customer_opening(
                    report["batch_id"], auth_request(), confirm="APPLY_1405_07_29")
            self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(len(posted), 1)
        self.assertEqual(posted[0][0], "parasay_customer_opening")
        with self.engine.begin() as conn:
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM accounting_entries WHERE company_id=1")).scalar(), 98)
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM accounting_entries WHERE company_id=2")).scalar(), 0)

    def test_apply_rechecks_activity_after_preview(self):
        report = self.preview()
        with self.engine.begin() as conn:
            conn.execute(text("INSERT INTO accounting_entries (customer_id, company_id) VALUES (1, 1)"))
        with patch.object(importer, "financial_policy_values", return_value={}):
            with self.assertRaises(HTTPException) as error:
                importer.apply_existing_customer_opening(
                    report["batch_id"], auth_request(), confirm="APPLY_1405_07_29")
        self.assertEqual(error.exception.status_code, 409)
        with self.engine.begin() as conn:
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM accounting_entries")).scalar(), 1)


if __name__ == "__main__":
    unittest.main()
