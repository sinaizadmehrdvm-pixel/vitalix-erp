"""Safety checks for opening cash (never touches actual user data)."""
import unittest
from unittest.mock import patch
from sqlalchemy import create_engine,text
from sqlalchemy.pool import StaticPool
from app import data_import as di


class CashOpeningChecks(unittest.TestCase):
    def setUp(self):
        self.engine=create_engine("sqlite+pysqlite:///:memory:",
           connect_args={"check_same_thread":False},poolclass=StaticPool)
        with self.engine.begin() as c:
            c.execute(text("CREATE TABLE accounting_vouchers (id INTEGER PRIMARY KEY,company_id INTEGER)"))
            c.execute(text("CREATE TABLE accounting_voucher_lines (id INTEGER PRIMARY KEY,voucher_id INTEGER,account_code TEXT)"))
            c.execute(text("CREATE TABLE chart_accounts (id INTEGER PRIMARY KEY,company_id INTEGER,code TEXT,is_active INTEGER)"))
            c.execute(text("INSERT INTO chart_accounts VALUES (1,1,'1101',1),(2,1,'3101',1),(3,2,'1101',1),(4,2,'3101',1)"))

    def tearDown(self):
        self.engine.dispose()

    def test_ready_with_no_cash_posting(self):
        with patch.object(di,"_ensure_posting_schema"), self.engine.begin() as c:
            status=di._quick_cash_opening_check(c,1,27000000,"2026-10-21")
            self.assertTrue(status["can_apply"])
            self.assertEqual(status["amount_irr"],27000000)

    def test_existing_company_cash_activity_blocks_new_opening(self):
        with patch.object(di,"_ensure_posting_schema"),self.engine.begin() as c:
            c.execute(text("INSERT INTO accounting_vouchers VALUES(4,1)"))
            c.execute(text("INSERT INTO accounting_voucher_lines VALUES(6,4,'1101')"))
            result=di._quick_cash_opening_check(c,1,27000000,"2026-10-21")
            self.assertFalse(result["can_apply"])
            self.assertEqual(result["cash_ledger_lines"],1)
            other=di._quick_cash_opening_check(c,2,1000,"2026-10-21")
            self.assertTrue(other["can_apply"])

    def test_repeat_apply_blocks_and_bad_amount_date_rejected(self):
        with patch.object(di,"_ensure_posting_schema"),self.engine.begin() as c:
            c.execute(text("INSERT INTO quick_start_cash_openings VALUES(1,27000000,9,'2026-10-21','now')")) if False else None
            di._quick_cash_opening_check(c,1,27000000,"2026-10-21")
            c.execute(text("INSERT INTO quick_start_cash_openings VALUES(1,27000000,9,'2026-10-21','now')"))
            result=di._quick_cash_opening_check(c,1,27000000,"2026-10-21")
            self.assertFalse(result["can_apply"])
            with self.assertRaises(Exception):
                di._quick_cash_opening_check(c,1,0,"2026-10-21")
            with self.assertRaises(Exception):
                di._quick_cash_opening_check(c,1,27000000,"2026-99-99")


if __name__=="__main__":
    unittest.main()
