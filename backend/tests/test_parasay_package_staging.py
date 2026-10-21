"""Safety tests for atomic PARASAY package staging (no GL/stock writes)."""
import asyncio
import csv
import hashlib
import io
import json
import unittest
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

import app.data_import as migration


def _csv(rows, fieldnames, delimiter="؛"):
    stream = io.StringIO()
    writer = csv.DictWriter(stream, fieldnames=fieldnames, delimiter=delimiter)
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8-sig")


def _build_zip():
    goods = [{"ID": str(i), "Code": str(i), "Name": "کالا " + str(i),
              "NowAmount": str(-1 if i in (1, 2) else (20022 if i == 3 else 1 if i <= 440 else 0))}
             for i in range(1, 1491)]
    # Total = -2 + 20022 + 437 = 20457; adjust single bucket to exactly 20020.
    goods[2]["NowAmount"] = str(19585)
    banks = [{"BankAccountID": str(i), "BankName": "بانک " + str(i),
              "NetBalance": "22036831119" if i == 1 else "1"}
             for i in range(1, 19)]
    gl = [{"MoienID": str(i), "MoienCode": "111001", "MoienName": "حساب",
           "OtherNetBalance": str(-35779683932 if i == 1 else 1 if i <= 12 else 0)}
          for i in range(1, 284)]
    total = [{"ID": str(i), "Code": str(i), "AccountName": "کل"} for i in range(1, 44)]
    moien = [{"ID": str(i), "Code": str(i if i < 283 else 282),
              "AccountName": "معین", "TotalBookID": "1"} for i in range(1, 284)]
    cheques = []
    for i in range(1, 29):
        received = i <= 10
        amount = (3509040000 - 9 if i == 1 else 1) if received else (26415000000 - 17 if i == 11 else 1)
        cheques.append({
            "source_check_id": str(i), "cheque_number": str(1000 + i),
            "due_date_jalali": "1405/09/01", "amount_irr": str(amount),
            "direction": "received" if received else "payable",
            "original_state": "در جریان وصول" if received else "در اختیار اشخاص",
            "source_party_id": "-1" if i <= 12 else str(7400 + i),
            "party_name_original": "", "migration_cutoff": "1405/07/29",
            "mapping_status": "PARTY_UNKNOWN",
        })
    files = {
        "PARASAY7_ALL_GOODS.csv": _csv(goods, list(goods[0])),
        "PARASAY_Bank_Final_Balances.csv": _csv(banks, list(banks[0])),
        "PARASAY_Other_Accounts_1405-07-29.csv": _csv(gl, list(gl[0])),
        "PARASAY_TotalBookAccounts.csv": _csv(total, list(total[0])),
        "PARASAY_MoienBookAccounts.csv": _csv(moien, list(moien[0])),
        "VITALIX_PARASAY_28_OPEN_CHECKS_STAGING.csv":
            _csv(cheques, list(cheques[0]), delimiter=","),
    }
    manifest = {
        "company": "Hyper Doctor", "cutoff_jalali": "1405/07/29",
        "mode": "staging_only_no_financial_posting",
        "files": {name: {"sha256": hashlib.sha256(data).hexdigest()} for name, data in files.items()},
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
        z.writestr("manifest.json", json.dumps(manifest))
    return buffer.getvalue()


def _request(company=1):
    return SimpleNamespace(state=SimpleNamespace(auth={
        "role": "admin", "sub": "1", "company_id": company
    }))


class ParsayPackageStagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.blob = _build_zip()

    def setUp(self):
        self.engine = create_engine("sqlite+pysqlite:///:memory:", poolclass=StaticPool,
                                    connect_args={"check_same_thread": False})
        with self.engine.begin() as conn:
            conn.execute(text("CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT, is_active INTEGER)"))
            conn.execute(text("INSERT INTO companies VALUES (1, 'هایپر دکتر', 1), (2, 'تنفسی', 1)"))
        self.engine_patch = patch.object(migration, "engine", self.engine)
        self.engine_patch.start()

    def tearDown(self):
        self.engine_patch.stop()
        self.engine.dispose()

    def _file(self, contents=None):
        return UploadFile(filename="PARASAY.zip",
                          file=io.BytesIO(contents if contents is not None else self.blob))

    def test_preview_and_apply_are_atomic_and_no_financial_writes(self):
        result = asyncio.run(migration.preview_parasay_package(_request(), self._file()))
        self.assertTrue(result["can_apply"])
        self.assertEqual(result["summary"]["inventory"]["nonzero"], 440)
        self.assertEqual(result["summary"]["banks"]["source_total"], "22036831136")
        self.assertEqual(result["summary"]["gl_residual"]["source_total"], "-35779683921")
        with self.engine.begin() as conn:
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM parasay_migration_staging")).scalar(), 0)

        saved = asyncio.run(migration.apply_parasay_package(
            _request(), self._file(), confirm="STAGE_FOUR_SOURCES_NO_FINANCIAL_CHANGES"))
        self.assertTrue(saved["no_gl_posting"])
        self.assertTrue(saved["no_inventory_changes"])
        with self.engine.begin() as conn:
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM parasay_migration_staging")).scalar(), 2117)
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM parasay_opening_cheques")).scalar(), 28)
            self.assertEqual(conn.execute(text(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='accounting_vouchers'")).scalar(), 0)
        with self.assertRaises(HTTPException) as exc:
            asyncio.run(migration.apply_parasay_package(
                _request(), self._file(), confirm="STAGE_FOUR_SOURCES_NO_FINANCIAL_CHANGES"))
        self.assertEqual(exc.exception.status_code, 409)

    def test_wrong_company_blocked(self):
        with self.assertRaises(HTTPException) as exc:
            asyncio.run(migration.preview_parasay_package(_request(2), self._file()))
        self.assertEqual(exc.exception.status_code, 403)

    def test_corrupted_zip_rejected_without_writes(self):
        with self.assertRaises(HTTPException):
            asyncio.run(migration.preview_parasay_package(_request(), self._file(b"not a zip")))


if __name__ == "__main__":
    unittest.main()
