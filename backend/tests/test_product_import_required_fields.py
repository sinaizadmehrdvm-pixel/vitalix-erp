"""Regression check for the fresh-install SQLite product import failure.

The product importer uses raw SQL, so SQLAlchemy model defaults are not applied.
This test executes the actual INSERT clause extracted from the importer against
an independent in-memory SQLite table with a required is_active field.
"""
import re
import sqlite3
from pathlib import Path


def test_product_import_sets_required_is_active_on_fresh_sqlite():
    source = (Path(__file__).resolve().parents[1] / "app" / "data_import.py").read_text(encoding="utf-8")
    product_branch = source.split('elif entity == "products":', 1)[1]
    match = re.search(
        r'INSERT INTO products\s*\((.*?)\)\s*VALUES\s*\((.*?)\)',
        product_branch,
        re.DOTALL,
    )
    assert match is not None, "Product import INSERT was not found"
    columns = [part.strip() for part in match.group(1).split(",")]
    assert "is_active" in columns
    assert "company_id" in columns

    sql = f"INSERT INTO products ({match.group(1)}) VALUES ({match.group(2)})"
    values = {
        "name": "Import smoke test",
        "code": "SMOKE-1",
        "barcode": "",
        "barcode2": "",
        "barcode3": "",
        "sku": "",
        "brand": "",
        "unit": "each",
        "buy_price": 100,
        "sell_price": 150,
        "stock": 0,
        "min_stock": 0,
        "count_in_pack": 1,
        "main_category": "",
        "sub_category": "",
        "description": "",
        "company_id": 7,
    }
    connection = sqlite3.connect(":memory:")
    try:
        types = {
            "is_active": "INTEGER NOT NULL",
            "company_id": "INTEGER NOT NULL",
            "name": "TEXT NOT NULL",
            "code": "TEXT",
        }
        definitions = ", ".join(f"{column} {types.get(column, 'TEXT')}" for column in columns)
        connection.execute(f"CREATE TABLE products ({definitions})")
        connection.execute(sql, values)
        row = connection.execute("SELECT is_active, company_id, stock FROM products").fetchone()
        assert row == (1, 7, "0")
    finally:
        connection.close()
