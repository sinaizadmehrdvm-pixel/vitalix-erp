"""Isolated PARASAY source chart and opening tests; in-memory SQLite only."""
import json
import unittest
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

import app.data_import as migration


def auth(company=1):
    return SimpleNamespace(state=SimpleNamespace(
        auth={"role":"admin","sub":"1","company_id":company}))


class ParasayFinalizeTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite+pysqlite:///:memory:",
                                    connect_args={"check_same_thread":False},
                                    poolclass=StaticPool)
        with self.engine.begin() as conn:
            for stmt in [
                "CREATE TABLE companies (id INTEGER PRIMARY KEY,name TEXT,is_active INTEGER)",
                "CREATE TABLE products (id INTEGER PRIMARY KEY,code TEXT,name TEXT,stock REAL,company_id INTEGER)",
                "CREATE TABLE data_import_batches (company_id INTEGER,entity_type TEXT,status TEXT)",
                "CREATE TABLE parasay_opening_cheques (company_id INTEGER)",
                "CREATE TABLE chart_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT,company_id INTEGER,code TEXT,name TEXT,account_type TEXT,level TEXT,normal_balance TEXT,description TEXT,is_active INTEGER,created_at TEXT,updated_at TEXT,parent_id INTEGER)",
                "CREATE TABLE accounting_vouchers (id INTEGER PRIMARY KEY,company_id INTEGER,source_type TEXT)",
                "CREATE TABLE accounting_voucher_lines (voucher_id INTEGER,account_code TEXT,debit REAL,credit REAL)",
                "CREATE TABLE stock_movements (warehouse TEXT,product_id INTEGER,product_name TEXT,quantity REAL,movement_type TEXT,movement_date TEXT,note TEXT,created_at TEXT,warehouse_id INTEGER)",
            ]:
                conn.execute(text(stmt))
            conn.execute(text("INSERT INTO companies VALUES (1,'هایپر دکتر',1),(2,'تنفسی',1)"))
            conn.execute(text("INSERT INTO data_import_batches VALUES (1,'existing_customer_opening','applied')"))
            conn.execute(text("INSERT INTO accounting_vouchers VALUES (1,1,'parasay_customer_opening')"))
            conn.execute(text("INSERT INTO accounting_voucher_lines VALUES (1,'3101',0,35779683921)"))
            conn.execute(text("INSERT INTO parasay_opening_cheques VALUES (1)"),[{} for _ in range(28)])
            conn.execute(text("INSERT INTO products VALUES (:id,:code,:name,0,1)"),
                         [{"id":i,"code":str(i),"name":"کالا "+str(i)} for i in range(1,1491)])
            migration._ensure_parasay_stage(conn)
            total=[{"ID":str(i),"Code":str(1100+i),"AccountName":"کل"} for i in range(100,143)]
            moien=[{"ID":str(i),"Code":str(i if i<283 else 282),
                    "AccountName":"معین","TotalBookID":"100"} for i in range(1,284)]
            goods=[{"ID":str(i),"Code":str(i),"NowAmount":str(-1 if i in (1,2) else
                        19585 if i==3 else 1 if i<=440 else 0)} for i in range(1,1491)]
            banks=[{"BankAccountID":str(i),"NetBalance":str(22036831119 if i==1 else 1)}
                   for i in range(1,19)]
            amounts={104:22036831136,117:3509040000,130:56508836736,193:-26415000000}
            amounts.update({i:1 for i in range(1,8)})
            amounts[9]=-91419391800
            residual=[{"MoienID":str(i),"MoienCode":str(i),
                       "OtherNetBalance":str(amounts.get(i,0))}
                      for i in range(1,284)]
            for kind, rows, name in [
                ("chart_total",total,"ID"),("chart_moien",moien,"ID"),
                ("inventory",goods,"ID"),("banks",banks,"BankAccountID"),
                ("gl_residual",residual,"MoienID"),
            ]:
                conn.execute(text("""
                    INSERT INTO parasay_migration_staging
                    (company_id,kind,source_id,payload_json,created_at)
                    VALUES (1,:kind,:id,:data,'now')
                """),[{"kind":kind,"id":row[name],"data":json.dumps(row,ensure_ascii=False)}
                     for row in rows])
        self.engine_patch=patch.object(migration,"engine",self.engine)
        self.schema_patch=patch.object(migration,"_ensure_posting_schema",lambda conn:None)
        self.engine_patch.start()
        self.schema_patch.start()

    def tearDown(self):
        self.schema_patch.stop()
        self.engine_patch.stop()
        self.engine.dispose()

    def test_source_chart_is_unique_and_326_accounts(self):
        preview=migration.preview_parasay_finalization(auth())
        self.assertEqual(preview["source_duplicate_moien_codes"],1)
        self.assertFalse(preview["chart_finalized"])
        result=migration.finalize_parasay_chart(auth(),confirm="CREATE_PARASAY_CHART_BY_SOURCE_ID")
        self.assertEqual(result["chart_accounts_created"],326)
        with self.engine.begin() as conn:
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM chart_accounts")).scalar(),326)
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM chart_accounts WHERE code IN ('PS-M-282','PS-M-283')")).scalar(),2)
        with self.assertRaises(HTTPException) as exc:
            migration.finalize_parasay_chart(auth(),confirm="CREATE_PARASAY_CHART_BY_SOURCE_ID")
        self.assertEqual(exc.exception.status_code,409)

    def test_stock_and_residual_gl_are_atomic_and_balanced(self):
        migration.finalize_parasay_chart(auth(),confirm="CREATE_PARASAY_CHART_BY_SOURCE_ID")
        review=migration.preview_parasay_finalization(auth())
        self.assertTrue(review["can_finalize"],review["blockers"])
        self.assertEqual(review["negative_stock"][0]["qty"],"-1")
        self.assertEqual(review["product_total_quantity"],"20020")
        calls=[]
        def fake_post(source_type, source_id, title, lines, company_id, **kwargs):
            debit=sum(Decimal(str(x.get("debit",0))) for x in lines)
            credit=sum(Decimal(str(x.get("credit",0))) for x in lines)
            self.assertEqual(debit,credit)
            self.assertEqual(len(lines),13)
            self.assertEqual(company_id,1)
            calls.append(lines)
            return 99
        with patch.object(migration,"post_balanced_voucher",fake_post):
            output=migration.finalize_parasay_stock_and_ledger(
                auth(),confirm="APPLY_PARASAY_STOCK_GL_14050729",
                accept_source_negative_stock=True,acknowledge_bank_7579=True)
            self.assertEqual(output["stock_updated"],440)
            self.assertEqual(len(calls),1)
        with self.engine.begin() as conn:
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM stock_movements")).scalar(),440)
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM bank_accounts")).scalar(),18)
            self.assertEqual(conn.execute(text("SELECT SUM(opening_balance) FROM bank_accounts")).scalar(),22036831136)
            self.assertEqual(conn.execute(text("SELECT SUM(stock) FROM products")).scalar(),20020)
            self.assertEqual(conn.execute(text("SELECT stock FROM products WHERE id=1")).scalar(),-1)
            self.assertEqual(conn.execute(text(
                "SELECT COUNT(*) FROM parasay_migration_finalizations WHERE scope='opening'")).scalar(),1)
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM parasay_opening_cheques")).scalar(),28)
        with self.assertRaises(HTTPException) as exc:
            migration.finalize_parasay_stock_and_ledger(
                auth(),confirm="APPLY_PARASAY_STOCK_GL_14050729",
                accept_source_negative_stock=True,acknowledge_bank_7579=True)
        self.assertEqual(exc.exception.status_code,409)

    def test_wrong_company_is_rejected(self):
        with self.assertRaises(HTTPException) as exc:
            migration.preview_parasay_finalization(auth(2))
        self.assertEqual(exc.exception.status_code,403)


if __name__=="__main__":
    unittest.main()
