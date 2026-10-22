"""Read-only safety invariants for one-file quick start.

These tests use disposable SQLite; no business data or real bank movements.
"""
import unittest
from decimal import Decimal
from unittest.mock import patch

from sqlalchemy import create_engine,text
from sqlalchemy.pool import StaticPool

import app.data_import as migration


class QuickStartSafetyTests(unittest.TestCase):
    def setUp(self):
        self.engine=create_engine("sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread":False},poolclass=StaticPool)
        with self.engine.begin() as conn:
            conn.execute(text("CREATE TABLE products (id INTEGER PRIMARY KEY,company_id INTEGER,code TEXT,name TEXT,stock FLOAT)"))
            conn.execute(text("CREATE TABLE stock_movements (id INTEGER PRIMARY KEY,product_id INTEGER,quantity FLOAT)"))
            conn.execute(text("INSERT INTO products VALUES (1,1,'A','First',0),(2,1,'B','Second',0),(3,2,'C','Other company',99)"))

    def tearDown(self):
        self.engine.dispose()

    def test_stock_company_isolation_and_negative_skipping(self):
        source=[{"Code":"A","NowAmount":"12"},{"Code":"B","NowAmount":"-1"}]
        with self.engine.begin() as conn:
            blocked=migration._quick_stock_check(conn,1,source)
            self.assertEqual(blocked["matching"],2)
            self.assertIn("Negative source stock requires explicit skip",blocked["errors"])
            permitted=migration._quick_stock_check(conn,1,source,allow_negative=True)
            self.assertTrue(permitted["can_import"])
            self.assertEqual(permitted["operational_nonzero"],0)
            self.assertEqual(permitted["movement_count"],0)
            self.assertEqual(len(permitted["negative"]),1)

    def test_stock_blocks_existing_movements_even_if_stock_is_zero(self):
        with self.engine.begin() as conn:
            conn.execute(text("INSERT INTO stock_movements (id,product_id,quantity) VALUES (1,1,0)"))
            check=migration._quick_stock_check(conn,1,
                [{"Code":"A","NowAmount":"5"},{"Code":"B","NowAmount":"0"}],allow_negative=True)
            self.assertFalse(check["can_import"])
            self.assertEqual(check["movement_count"],1)

    def test_stock_blocks_duplicate_or_wrong_company_codes(self):
        with self.engine.begin() as conn:
            check=migration._quick_stock_check(conn,1,
                [{"Code":"A","NowAmount":"3"},{"Code":"C","NowAmount":"0"}],allow_negative=True)
            self.assertFalse(check["can_import"])
            self.assertIn("Unknown product codes",check["errors"])

    def test_bank_personal_source_excluded_without_touching_other_company(self):
        with self.engine.begin() as conn:
            conn.execute(text("""CREATE TABLE chart_accounts (
                id INTEGER PRIMARY KEY,company_id INTEGER,code TEXT,
                account_type TEXT)"""))
            conn.execute(text("INSERT INTO chart_accounts VALUES (1,1,'1102','asset'),(2,2,'1102','asset')"))
            rows=[{"BankAccountID":str(i),"BankName":"Bank "+str(i),
                   "NetBalance":"100"} for i in range(1,18)]
            rows.append({"BankAccountID":"7579","BankName":"آورده شخصي(ساير بانک ها)","NetBalance":"19413842927"})
            check=migration._quick_bank_checks(conn,1,rows)
            self.assertTrue(check["can_import"])
            self.assertEqual(check["real_bank_accounts"],17)
            self.assertEqual(check["personal_excluded"],1)
            self.assertEqual(Decimal(check["real_bank_total_irr"]),Decimal("1700"))
            conn.execute(text("""INSERT INTO bank_accounts
                (name,bank_name,account_number,iban,ledger_account_code,
                opening_balance,active,company_id)
                VALUES ('Other company','Other','','','1102',0,1,2)"""))
            check=migration._quick_bank_checks(conn,1,rows)
            self.assertTrue(check["can_import"])

    def test_bank_rejects_ambiguous_personal_row(self):
        with self.engine.begin() as conn:
            conn.execute(text("CREATE TABLE chart_accounts (id INTEGER PRIMARY KEY,company_id INTEGER,code TEXT,account_type TEXT)"))
            conn.execute(text("INSERT INTO chart_accounts VALUES (1,1,'1102','asset')"))
            rows=[{"BankAccountID":str(i),"BankName":"Bank "+str(i),"NetBalance":"100"} for i in range(1,19)]
            check=migration._quick_bank_checks(conn,1,rows)
            self.assertFalse(check["can_import"])
            self.assertIn("Personal-contribution bank row cannot be identified safely",check["errors"])


if __name__=="__main__":
    unittest.main()
