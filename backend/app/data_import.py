"""Safe, previewable bulk data import - customers, products, opening GL
trial balances, and historical invoices. The `products` entity has the
fullest feature set (duplicate/update policy, warehouse-aware opening
stock, rollback) since it backs the Product Import Wizard; the other three
entities are intentionally left exactly as they were before that wizard
was added, so nothing about their behavior changes here.
"""
import io
import json
import uuid
from datetime import date as date_cls, datetime, timezone

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session as OrmSession

from app.accounting.integrity import calculate_payment_status, money
from app.accounting.posting import post_balanced_voucher, delete_source_voucher
from app.accounting.posting import _ensure_schema as _ensure_posting_schema
from app.database import SessionLocal, engine
from app.financial_policy import financial_policy_values
from app.warehouses import DEFAULT_WAREHOUSE_NAME, apply_warehouse_delta
from app.warehouses import _ensure_default_warehouse as ensure_default_warehouse
from app.company_scope import current_company_id

router = APIRouter(prefix="/api/data-import", tags=["Safe Data Import"])
MAX_BYTES = 25 * 1024 * 1024
MAX_ROWS = 12000
ENTITY_FIELDS = {
    "customers": {
        "name": ("name", "نام", "نام طرف حساب", "نام طرف‌حساب"),
        "phone": ("phone", "تلفن", "موبایل"),
        "email": ("email", "ایمیل"),
        "address": ("address", "آدرس"),
        "city": ("city", "شهر"),
        "national_id": ("national_id", "شناسه ملی", "کد ملی"),
        "economic_code": ("economic_code", "کد اقتصادی"),
        "contact_person": ("contact_person", "شخص رابط"),
        "customer_type": ("customer_type", "نوع طرف حساب", "نوع طرف‌حساب"),
        "opening_balance": ("opening_balance", "مانده افتتاحیه", "مانده اول دوره"),
        "credit_limit": ("credit_limit", "سقف اعتبار"),
        "notes": ("notes", "یادداشت", "توضیحات"),
    },
    "products": {
        "name": ("name", "نام", "نام کالا", "ProductName", "GoodsName"),
        "code": ("code", "کد", "کد کالا", "ProductCode", "GoodsCode"),
        "barcode": ("barcode", "بارکد", "BarCode", "BarCode1"),
        "barcode2": ("barcode2", "بارکد دوم", "BarCode2"),
        "barcode3": ("barcode3", "بارکد سوم", "BarCode3"),
        "sku": ("sku", "SKU", "StockCode", "شناسه کالا"),
        "brand": ("brand", "برند"),
        "unit": ("unit", "واحد", "UnitName", "Unit"),
        "buy_price": ("buy_price", "قیمت خرید", "PurchasePrice", "BuyPrice"),
        "sell_price": ("sell_price", "قیمت فروش", "SalesPrice", "SellPrice"),
        "stock": ("stock", "موجودی", "موجودی اولیه", "OpeningStock", "FirstAmount", "InitialStock"),
        "min_stock": ("min_stock", "حداقل موجودی"),
        "count_in_pack": ("count_in_pack", "تعداد در بسته", "CountInPack", "PackQuantity"),
        "main_category": ("main_category", "گروه اصلی", "Group", "GroupName", "Category", "CategoryName", "گروه", "دسته‌بندی"),
        "sub_category": ("sub_category", "گروه فرعی"),
        "description": ("description", "توضیحات", "Desc", "Description"),
    },
    "gl_trial_balance": {
        "account_code": ("account_code", "کد حساب", "کد"),
        "account_name": ("account_name", "نام حساب", "شرح حساب"),
        "debit": ("debit", "بدهکار"),
        "credit": ("credit", "بستانکار"),
        "description": ("description", "شرح", "توضیحات"),
    },
    "invoices": {
        "invoice_no": ("invoice_no", "شماره فاکتور", "شماره سند"),
        "date": ("date", "تاریخ", "تاریخ فاکتور"),
        "invoice_type": ("invoice_type", "نوع فاکتور", "نوع سند"),
        "customer_name": ("customer_name", "نام طرف‌حساب", "نام مشتری"),
        "product": ("product", "کالا", "نام یا کد کالا", "نام کالا", "کد کالا"),
        "quantity": ("quantity", "تعداد"),
        "unit_price": ("unit_price", "قیمت واحد", "قیمت فروش واحد"),
        "discount": ("discount", "تخفیف"),
        "paid_amount": ("paid_amount", "مبلغ پرداخت‌شده", "مبلغ دریافتی"),
    },
    # Task 04, Section 20 - the HR module (app/hr.py) now exists, so a real
    # employees entity is a genuine new safe-import target, matching the
    # same "single-required-field, duplicate-detected, admin-only apply"
    # shape as customers above (not the fuller products feature set).
    "employees": {
        "first_name": ("first_name", "نام", "نام کوچک"),
        "last_name": ("last_name", "نام خانوادگی"),
        "employee_number": ("employee_number", "کد پرسنلی", "شماره پرسنلی"),
        "job_title": ("job_title", "سمت", "عنوان شغلی"),
        "department": ("department", "واحد", "دپارتمان"),
        "employment_type": ("employment_type", "نوع همکاری"),
        "phone": ("phone", "تلفن"),
        "mobile": ("mobile", "موبایل"),
        "email": ("email", "ایمیل"),
        "start_date": ("start_date", "تاریخ شروع"),
    },
}
NUMERIC_FIELDS = {
    "opening_balance", "credit_limit", "buy_price", "sell_price", "min_stock",
    "debit", "credit", "quantity", "unit_price", "discount", "paid_amount",
    "stock", "count_in_pack",
}
# Negative values are always rejected for these - "stock" is deliberately
# NOT here: for the products entity a negative opening stock is
# policy-controlled (see negative_stock_policy) rather than an unconditional
# error, since some real-world migrations legitimately start from a known
# shortfall.
ALWAYS_NON_NEGATIVE_FIELDS = {
    "credit_limit", "buy_price", "sell_price", "min_stock", "count_in_pack",
    "debit", "credit", "quantity", "unit_price", "discount", "paid_amount",
}
IDENTIFIER_FIELDS = {"code", "sku", "barcode", "barcode2", "barcode3"}
# Phone-like fields get Persian/Arabic digit normalization even though
# they're stored as text, not a number - a phone number typed on a
# Persian-locale keyboard commonly uses ۰-۹ glyphs.
PHONE_LIKE_FIELDS = {"phone", "mobile"}
REQUIRED_FIELD = {
    "customers": "name",
    "products": "name",
    "gl_trial_balance": "account_code",
    "invoices": "date",
    "employees": "first_name",
}
PRODUCT_MATCH_KEY_FIELDS = {
    "code": ("code",),
    "sku": ("sku",),
    "barcode": ("barcode",),
    "code_or_barcode": ("code", "barcode"),
}
PRODUCT_UPDATABLE_FIELDS = {
    # "code" and "stock" are deliberately excluded: code is the match key
    # itself, and stock follows the same rule as main.py's update_product -
    # once a product exists, on-hand quantity only ever changes through an
    # explicit stock movement, never a silent bulk-update overwrite.
    "barcode", "barcode2", "barcode3", "sku", "brand", "unit", "buy_price",
    "sell_price", "min_stock", "main_category", "sub_category",
    "description", "count_in_pack",
}
# Historical invoice import intentionally supports only sale/return_sale, and
# intentionally never touches Product.stock: current stock is expected to be
# seeded separately via the "products" import, so replaying historical stock
# movements here would double-count inventory. See WINDOWS docs for the full
# migration order and this tradeoff.
SUPPORTED_HISTORICAL_INVOICE_TYPES = {"sale", "return_sale"}
# Preview/inspect/history are readable by anyone who can legitimately handle
# inventory data; apply/rollback stay strictly administrator-only. Only the
# "products" entity gets the wider tier - customers/gl_trial_balance/invoices
# keep the exact admin-only behavior they always had.
PREVIEW_ROLES = {"admin", "accountant", "warehouse"}


class _CsvSheet:
    """Minimal stand-in for an openpyxl worksheet - just enough surface
    (.title, .iter_rows(values_only=True)) for /inspect and /preview to
    keep using the exact same downstream row-processing code for a CSV
    upload as for an .xlsx one, with no per-entity logic duplicated."""

    def __init__(self, rows):
        self._rows = rows
        self.title = "CSV"

    def iter_rows(self, values_only=True):
        return iter(self._rows)


class _CsvWorkbook:
    def __init__(self, rows):
        self.sheetnames = ["CSV"]
        self.active = _CsvSheet(rows)

    def __getitem__(self, _name):
        return self.active


def _parse_csv_rows(raw: bytes):
    import csv as _csv
    for encoding in ("utf-8-sig", "utf-8", "cp1256"):
        try:
            text_data = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise HTTPException(status_code=400, detail="Could not decode the CSV file (expected UTF-8)")
    reader = _csv.reader(text_data.splitlines())
    return [tuple(row) for row in reader]


def _load_workbook_any_format(raw: bytes, filename: str):
    lower = (filename or "").lower()
    if lower.endswith(".csv"):
        return _CsvWorkbook(_parse_csv_rows(raw))
    if lower.endswith(".xlsx"):
        try:
            return load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        except Exception as error:
            raise HTTPException(status_code=400, detail=f"Invalid Excel workbook: {error}")
    if lower.endswith(".xls"):
        raise HTTPException(status_code=400, detail="Legacy .xls is not supported - please save as .xlsx and retry")
    if lower.endswith(".pdf"):
        # Honest per the task spec: no PDF text/table extraction library is
        # installed in this codebase, and no OCR engine is wired up either
        # (app/document_ocr.py is a separate, human-in-the-loop receipt
        # scanner, not a bulk-import parser) - reporting this clearly beats
        # silently failing or pretending to read the file.
        raise HTTPException(
            status_code=400,
            detail="PDF import is not supported - no text/table extraction library is installed, and scanned PDFs "
                   "would require OCR, which is not available. Export the data as .xlsx or .csv instead.",
        )
    raise HTTPException(status_code=400, detail="Only .xlsx or .csv files are accepted")


def _guess_entity_for_headers(headers):
    """Read-only heuristic (Task 04, Section 20) used only by /inspect to
    flag "this sheet/file looks like products/customers/..." when a
    workbook has multiple sheets - each sheet is still imported through
    its own separate /preview+/apply call; this does not merge multiple
    sheets into one job. Deterministic header-overlap scoring, not AI."""
    headers_clean = {_clean(h).lower() for h in headers if _clean(h)}
    if not headers_clean:
        return None
    best_entity, best_score = None, 0
    for entity, aliases in ENTITY_FIELDS.items():
        all_names = {name.lower() for names in aliases.values() for name in names}
        overlap = sum(1 for h in headers_clean if h in all_names)
        if overlap > best_score:
            best_entity, best_score = entity, overlap
    if best_entity and best_score >= 1:
        return {"entity": best_entity, "matched_columns": best_score}
    return None


def _now():
    return datetime.now(timezone.utc).isoformat()


def _actor_id(auth):
    try:
        return int(auth["sub"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid authentication context")


def _require_admin(request):
    auth = getattr(request.state, "auth", {})
    if auth.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required")
    return _actor_id(auth)


def _require_preview_role(request, entity=None):
    auth = getattr(request.state, "auth", {})
    allowed = PREVIEW_ROLES if entity == "products" else {"admin"}
    if auth.get("role") not in allowed:
        raise HTTPException(status_code=403, detail=f"Access requires one of: {', '.join(sorted(allowed))}")
    return _actor_id(auth)


def _ensure_schema(conn):
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS data_import_batches (
            id VARCHAR PRIMARY KEY,
            entity_type VARCHAR NOT NULL,
            file_name VARCHAR NOT NULL,
            status VARCHAR NOT NULL,
            total_rows INTEGER NOT NULL,
            valid_rows INTEGER NOT NULL,
            error_rows INTEGER NOT NULL,
            duplicate_rows INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            result_json TEXT DEFAULT '',
            created_by INTEGER NOT NULL,
            created_at VARCHAR NOT NULL,
            applied_at VARCHAR,
            FOREIGN KEY(created_by) REFERENCES users(id)
        )
    """))
    columns = {row[1] for row in conn.execute(text("PRAGMA table_info(data_import_batches)")).fetchall()}
    if "meta_json" not in columns:
        conn.execute(text("ALTER TABLE data_import_batches ADD COLUMN meta_json TEXT DEFAULT '{}'"))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS data_import_product_links (
            batch_id VARCHAR NOT NULL,
            product_id INTEGER NOT NULL,
            created_at VARCHAR NOT NULL
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS data_import_mapping_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type VARCHAR NOT NULL,
            name VARCHAR NOT NULL,
            mapping_json TEXT NOT NULL,
            created_by INTEGER NOT NULL,
            created_at VARCHAR NOT NULL
        )
    """))
    from app.company_scope import ensure_company_id_column
    ensure_company_id_column(conn, "data_import_batches")
    ensure_company_id_column(conn, "data_import_product_links")
    ensure_company_id_column(conn, "data_import_mapping_profiles")


def _clean(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _clean_identifier(value):
    """Like _clean(), but for code/sku/barcode columns specifically: Excel
    can hand back a numeric-looking identifier as a float, including
    scientific notation for long digit strings (e.g. a 13-digit barcode
    rendered as 8.901234568e+12). format(value, "f") always renders the
    full integer with no exponent and no precision loss, unlike str()."""
    if value is None:
        return ""
    if isinstance(value, float):
        if value.is_integer():
            return format(value, ".0f")
        return format(value, "f").rstrip("0").rstrip(".")
    return str(value).strip()


# Persian (۰-۹) and Arabic-Indic (٠-٩) digits -> ASCII, same two ranges
# frontend/src/localization/helpers.js's toEnglishDigits() normalizes on
# the client for typed input - real-world spreadsheets exported from
# Persian/Arabic locale software commonly contain these glyphs in numeric
# columns, and float()/strptime() both reject them outright without this.
_DIGIT_TRANSLATION = str.maketrans(
    "۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩",
    "01234567890123456789",
)


def _normalize_digits(value):
    return str(value).translate(_DIGIT_TRANSLATION)


def _number(value, field, row_number, errors):
    if value in (None, ""):
        return 0.0
    try:
        result = float(_normalize_digits(value).replace(",", "").replace("٬", "").strip())
        if field in ALWAYS_NON_NEGATIVE_FIELDS and result < 0:
            errors.append({"row": row_number, "field": field, "message": "Value cannot be negative"})
        return result
    except (TypeError, ValueError):
        errors.append({"row": row_number, "field": field, "message": "Invalid number"})
        return 0.0


def _jalali_to_gregorian(jy, jm, jd):
    """Standard Jalali->Gregorian conversion (verified by round-tripping
    4000 consecutive days against this codebase's own, already-relied-on
    _gregorian_to_jalali in app/export/localization.py, with zero
    mismatches - see Task 04 completion notes). No jdatetime/persiantools
    dependency is installed, so this is a small, self-contained
    implementation rather than a new pip requirement for one function."""
    jy += 1595
    days = -355668 + (365 * jy) + (jy // 33) * 8 + ((jy % 33) + 3) // 4 + jd
    days += (jm - 1) * 31 if jm < 7 else (jm - 7) * 30 + 186
    gy = 400 * (days // 146097)
    days %= 146097
    if days > 36524:
        gy += 100 * ((days - 1) // 36524)
        days = (days - 1) % 36524
        if days >= 365:
            days += 1
    gy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        gy += (days - 1) // 365
        days = (days - 1) % 365
    gd = days + 1
    is_leap = gy % 4 == 0 and (gy % 100 != 0 or gy % 400 == 0)
    month_ends = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366] if is_leap else \
        [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]
    gm = next(i for i in range(1, 13) if gd <= month_ends[i])
    return gy, gm, gd - month_ends[gm - 1]


def _parse_jalali_date(text_value):
    """Only attempted when strict Gregorian YYYY-MM-DD parsing (below)
    fails - a real Jalali date (e.g. from a Persian-locale export, digits
    already normalized by _clean() upstream) such as 1403/05/12 or
    1403-05-12."""
    import re as _re
    # Jalali year prefix: covers 1200-1499 (mid-1800s to mid-2100s in
    # Gregorian) - deliberately not narrowed to "13xx" only, since the
    # current Persian year has already rolled into the 14xx range.
    match = _re.fullmatch(r"(1[234]\d{2})[/-](\d{1,2})[/-](\d{1,2})", text_value.strip())
    if not match:
        return None
    jy, jm, jd = (int(part) for part in match.groups())
    if not (1 <= jm <= 12 and 1 <= jd <= 31):
        return None
    try:
        gy, gm, gd = _jalali_to_gregorian(jy, jm, jd)
        return date_cls(gy, gm, gd)
    except ValueError:
        return None


def _parse_date(value):
    text_value = _normalize_digits(_clean(value))
    try:
        parsed = datetime.strptime(text_value[:10], "%Y-%m-%d").date()
        # A 4-digit leading year in the Jalali range (1200-1499) is
        # ambiguous with the exact same YYYY-MM-DD shape (dash separator)
        # in the Gregorian calendar - real business dates are never in
        # Gregorian year 1200-1499, so treat that shape as Jalali first and
        # only keep the (implausible) literal Gregorian reading if it
        # doesn't actually parse as a valid Jalali date either.
        if parsed.year < 1500:
            jalali = _parse_jalali_date(text_value)
            if jalali:
                return jalali
        return parsed
    except ValueError:
        return _parse_jalali_date(text_value)


def _mapping(headers, entity):
    aliases = ENTITY_FIELDS[entity]
    normalized = {_clean(value).lower(): index for index, value in enumerate(headers)}
    result = {}
    for field, names in aliases.items():
        for name in names:
            if name.lower() in normalized:
                result[field] = normalized[name.lower()]
                break
    required = REQUIRED_FIELD[entity]
    if required not in result:
        raise HTTPException(status_code=400, detail=f"Required '{required}' column is missing")
    return result


def _mapping_confidence(headers, entity):
    """Source field -> suggested VETRIX field -> confidence, for /inspect's
    review UI only (never used to decide what actually gets imported - see
    _mapping() above, which /preview still calls independently). Confidence
    is a plain rule-based score (exact alias match=100, case/whitespace-
    insensitive alias match=90, alias appears as a substring of the header
    or vice versa=60), never labeled "AI" per the task spec's own
    instruction, since no semantic model is involved."""
    aliases = ENTITY_FIELDS[entity]
    headers_clean = [_clean(h) for h in headers]
    normalized_exact = {h.lower(): i for i, h in enumerate(headers_clean)}
    suggestions = {}
    for field, names in aliases.items():
        best = None
        for name in names:
            name_lower = name.lower()
            if name_lower in normalized_exact:
                index = normalized_exact[name_lower]
                confidence = 100 if headers_clean[index] == name else 90
                if best is None or confidence > best["confidence"]:
                    best = {"column_index": index, "column_header": headers_clean[index], "confidence": confidence}
        if best is None:
            for index, header in enumerate(headers_clean):
                header_lower = header.lower().strip()
                if not header_lower:
                    continue
                for name in names:
                    name_lower = name.lower()
                    if name_lower in header_lower or header_lower in name_lower:
                        if best is None or 60 > best["confidence"]:
                            best = {"column_index": index, "column_header": header, "confidence": 60}
        suggestions[field] = best
    return suggestions


def _resolve_mapping_override(headers, entity, override_json):
    try:
        override = json.loads(override_json)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid column_map_json: must be a JSON object")
    if not isinstance(override, dict):
        raise HTTPException(status_code=400, detail="Invalid column_map_json: must be a JSON object")
    normalized = {_clean(value).lower(): index for index, value in enumerate(headers)}
    result = {}
    for field, header_name in override.items():
        if field not in ENTITY_FIELDS[entity]:
            continue
        key = _clean(header_name).lower()
        if key in normalized:
            result[field] = normalized[key]
    required = REQUIRED_FIELD[entity]
    if required not in result:
        raise HTTPException(status_code=400, detail=f"Required '{required}' column is missing from column_map_json")
    return result


def _product_match_key(item, match_keys):
    fields = PRODUCT_MATCH_KEY_FIELDS.get(match_keys) or ("code", "barcode")
    for field in fields:
        value = item.get(field)
        if value:
            return (field, str(value).lower())
    return ("name", str(item.get("name") or "").lower())


def _existing_keys(conn, entity, match_keys=None, company_id=None):
    if entity == "customers":
        rows = conn.execute(
            text("SELECT name, phone, national_id FROM customers WHERE company_id=:company_id"),
            {"company_id": company_id},
        ).mappings()
        return {
            ("national", _clean(row["national_id"]).lower()) if _clean(row["national_id"])
            else ("name_phone", _clean(row["name"]).lower(), _clean(row["phone"]).lower())
            for row in rows
        }
    if entity == "products":
        rows = conn.execute(
            text("SELECT name, code, barcode, sku FROM products WHERE company_id=:company_id"),
            {"company_id": company_id},
        ).mappings()
        if match_keys:
            result = set()
            for row in rows:
                result.add(_product_match_key({k: _clean(v) for k, v in dict(row).items()}, match_keys))
            return result
        return {
            ("code", _clean(row["code"]).lower()) if _clean(row["code"])
            else ("barcode", _clean(row["barcode"]).lower()) if _clean(row["barcode"])
            else ("name", _clean(row["name"]).lower())
            for row in rows
        }
    if entity == "employees":
        rows = conn.execute(
            text("SELECT employee_number, first_name, last_name FROM employees WHERE company_id=:company_id"),
            {"company_id": company_id},
        ).mappings()
        return {
            ("employee_number", _clean(row["employee_number"]).lower()) if _clean(row["employee_number"])
            else ("name", _clean(row["first_name"]).lower(), _clean(row["last_name"]).lower())
            for row in rows
        }
    # gl_trial_balance / invoices: rows are lines, not standalone records -
    # repeats are expected and legitimate (e.g. two lines on the same
    # account, or two lines in the same invoice), so duplicate detection
    # is intentionally skipped via _row_key below.
    return set()


def _existing_product_ids_by_key(conn, match_keys, company_id):
    rows = conn.execute(
        text("SELECT id, name, code, barcode, sku FROM products WHERE company_id=:company_id"),
        {"company_id": company_id},
    ).mappings()
    result = {}
    for row in rows:
        item = {k: _clean(v) for k, v in dict(row).items()}
        result[_product_match_key(item, match_keys)] = row["id"]
    return result


def _row_key(entity, row, row_number=None, match_keys=None):
    if entity == "customers":
        return (
            ("national", row["national_id"].lower())
            if row.get("national_id")
            else ("name_phone", row["name"].lower(), row.get("phone", "").lower())
        )
    if entity == "products":
        if match_keys:
            return _product_match_key(row, match_keys)
        return (
            ("code", row["code"].lower()) if row.get("code")
            else ("barcode", row["barcode"].lower()) if row.get("barcode")
            else ("name", row["name"].lower())
        )
    if entity == "employees":
        return (
            ("employee_number", row["employee_number"].lower())
            if row.get("employee_number")
            else ("name", row.get("first_name", "").lower(), row.get("last_name", "").lower())
        )
    return ("row", row_number)


def _customer_lookup(conn, company_id):
    rows = conn.execute(
        text("SELECT id, name FROM customers WHERE company_id=:company_id"),
        {"company_id": company_id},
    ).mappings()
    return {_clean(row["name"]).lower(): row["id"] for row in rows if _clean(row["name"])}


def _product_lookup(conn, company_id):
    rows = conn.execute(
        text("SELECT id, name, code, buy_price FROM products WHERE company_id=:company_id"),
        {"company_id": company_id},
    ).mappings()
    lookup = {}
    for row in rows:
        buy_price = float(row["buy_price"] or 0)
        if _clean(row["code"]):
            lookup[_clean(row["code"]).lower()] = (row["id"], buy_price)
        if _clean(row["name"]):
            lookup.setdefault(_clean(row["name"]).lower(), (row["id"], buy_price))
    return lookup


@router.get("/template/{entity}")
def download_template(entity: str, request: Request, language: str = "en"):
    _require_preview_role(request, entity=entity)
    if entity not in ENTITY_FIELDS:
        raise HTTPException(status_code=404, detail="Unsupported import entity")
    fa = language == "fa"
    headers = {
        "customers": (
            ["نام طرف‌حساب", "تلفن", "ایمیل", "آدرس", "شهر", "شناسه ملی",
             "کد اقتصادی", "شخص رابط", "نوع طرف‌حساب", "مانده افتتاحیه",
             "سقف اعتبار", "یادداشت"]
            if fa else
            ["name", "phone", "email", "address", "city", "national_id",
             "economic_code", "contact_person", "customer_type", "opening_balance",
             "credit_limit", "notes"]
        ),
        "products": (
            ["نام کالا", "کد کالا", "بارکد", "بارکد دوم", "بارکد سوم", "SKU", "برند", "واحد",
             "قیمت خرید", "قیمت فروش", "موجودی اولیه", "حداقل موجودی", "تعداد در بسته",
             "گروه اصلی", "گروه فرعی", "توضیحات"]
            if fa else
            ["name", "code", "barcode", "barcode2", "barcode3", "sku", "brand", "unit", "buy_price",
             "sell_price", "stock", "min_stock", "count_in_pack", "main_category", "sub_category", "description"]
        ),
        "gl_trial_balance": (
            ["کد حساب", "نام حساب", "بدهکار", "بستانکار", "شرح"]
            if fa else
            ["account_code", "account_name", "debit", "credit", "description"]
        ),
        "invoices": (
            ["شماره فاکتور", "تاریخ (YYYY-MM-DD)", "نوع فاکتور (sale/return_sale)",
             "نام طرف‌حساب", "نام یا کد کالا", "تعداد", "قیمت واحد", "تخفیف", "مبلغ پرداخت‌شده"]
            if fa else
            ["invoice_no", "date (YYYY-MM-DD)", "invoice_type (sale/return_sale)",
             "customer_name", "product (name or code)", "quantity", "unit_price", "discount", "paid_amount"]
        ),
        "employees": (
            ["نام", "نام خانوادگی", "کد پرسنلی", "سمت", "واحد", "نوع همکاری (full_time/part_time/contract/intern/other)",
             "تلفن", "موبایل", "ایمیل", "تاریخ شروع (YYYY-MM-DD)"]
            if fa else
            ["first_name", "last_name", "employee_number", "job_title", "department",
             "employment_type (full_time/part_time/contract/intern/other)", "phone", "mobile", "email", "start_date (YYYY-MM-DD)"]
        ),
    }[entity]
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = {
        "customers": "طرف‌حساب‌ها" if fa else "Customers",
        "products": "کالاها" if fa else "Products",
        "gl_trial_balance": "سند افتتاحیه" if fa else "Opening trial balance",
        "invoices": "فاکتورهای تاریخی" if fa else "Historical invoices",
        "employees": "پرسنل" if fa else "Employees",
    }[entity]
    sheet.sheet_view.rightToLeft = fa
    sheet.append(headers)
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="0F172A")
    if entity == "products":
        # Code/SKU/barcode columns must round-trip through Excel as text -
        # otherwise a leading-zero or long numeric-looking code silently
        # turns into a float (or scientific notation) before the user even
        # gets to typing real data into the template.
        for col_letter in ("B", "C", "D", "E", "F"):
            sheet.column_dimensions[col_letter].number_format = "@"
    sample = {
        "customers": ["نمونه", "09120000000", "sample@example.com", "", "", "", "", "", "customer", 0, 0, ""],
        "products": ["نمونه کالا", "P-001", "", "", "", "", "", "عدد", 0, 0, 0, 0, 1, "", "", ""],
        "gl_trial_balance": ["1101", "صندوق", 1000000, 0, "مانده اول دوره صندوق"],
        "invoices": ["1001", "2025-01-15", "sale", "نمونه مشتری", "P-001", 2, 500000, 0, 1000000],
    }[entity]
    if not fa:
        if entity == "customers":
            sample[0] = "Sample"
        elif entity == "products":
            sample[0] = "Sample product"
            sample[7] = "unit"
        elif entity == "gl_trial_balance":
            sample[1] = "Cash"
            sample[4] = "Opening cash balance"
        elif entity == "invoices":
            sample[3] = "Sample customer"
    sheet.append(sample)
    sheet.freeze_panes = "A2"
    for column in sheet.columns:
        sheet.column_dimensions[column[0].column_letter].width = 22
    guide = workbook.create_sheet("Guide" if not fa else "راهنما")
    guide.sheet_view.rightToLeft = fa
    required_field = REQUIRED_FIELD[entity]
    guide_lines = (
        [
            f"ستون اجباری: {required_field}",
            "بقیه ستون‌ها اختیاری‌اند؛ اگر خالی بمانند، مقدار پیش‌فرض یا خالی ثبت می‌شود.",
            "کد کالا، SKU و بارکد باید به‌صورت متن (Text) نگه داشته شوند تا صفر ابتدایی یا اعداد بزرگ خراب نشوند.",
        ]
        if fa else
        [
            f"Required column: {required_field}",
            "All other columns are optional; blank cells use a default or stay empty.",
            "Keep code/SKU/barcode columns formatted as Text so leading zeros or long digit strings aren't corrupted.",
        ]
    )
    for line in guide_lines:
        guide.append([line])
    output = io.BytesIO()
    workbook.save(output)
    output.seek(0)
    filename = f"vetrix_{entity}_import_{'fa' if fa else 'en'}.xlsx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/inspect")
async def inspect_import_file(
    request: Request,
    file: UploadFile = File(...),
    entity: str = Form("products"),
    sheet_name: str = Form(""),
):
    _require_preview_role(request, entity=entity)
    raw = await file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_BYTES // (1024 * 1024)} MB limit")
    workbook = _load_workbook_any_format(raw, file.filename or "")
    row_counts = {}
    probable_entity_by_sheet = {}
    for name in workbook.sheetnames:
        sheet_rows = list(workbook[name].iter_rows(values_only=True))
        row_counts[name] = max(0, len(sheet_rows) - 1)
        if sheet_rows:
            probable_entity_by_sheet[name] = _guess_entity_for_headers(sheet_rows[0])

    sheet = workbook[sheet_name] if sheet_name and sheet_name in workbook.sheetnames else workbook.active
    rows_iter = sheet.iter_rows(values_only=True)
    headers = next(rows_iter, None) or []
    sample_row = next(rows_iter, None) or []
    headers_clean = [_clean(h) for h in headers]

    suggested_mapping = {}
    mapping_confidence = {}
    if entity in ENTITY_FIELDS:
        try:
            suggested_mapping = _mapping(headers, entity)
        except HTTPException:
            suggested_mapping = {}
        mapping_confidence = _mapping_confidence(headers, entity)

    return {
        "file_name": file.filename,
        "size_bytes": len(raw),
        "sheet_names": workbook.sheetnames,
        "row_counts": row_counts,
        # Read-only hint per sheet ("this looks like products/customers/...")
        # - each sheet is still reviewed/applied as its own separate job,
        # see _guess_entity_for_headers' docstring.
        "probable_entity_by_sheet": probable_entity_by_sheet,
        "active_sheet": sheet.title,
        "headers": headers_clean,
        "sample_row": [_clean(v) for v in sample_row],
        "suggested_mapping": suggested_mapping,
        "mapping_confidence": mapping_confidence,
        "entity_fields": list(ENTITY_FIELDS.get(entity, {}).keys()),
    }


@router.get("/mapping-profiles")
def list_mapping_profiles(request: Request, entity: str = "products"):
    _require_preview_role(request, entity=entity)
    with engine.begin() as conn:
        _ensure_schema(conn)
        rows = conn.execute(text("""
            SELECT id, entity_type, name, mapping_json, created_by, created_at
            FROM data_import_mapping_profiles WHERE entity_type=:entity AND company_id=:company_id ORDER BY created_at DESC
        """), {"entity": entity, "company_id": current_company_id(request)}).mappings().all()
        return [dict(row) for row in rows]


class MappingProfileCreate(BaseModel):
    entity_type: str
    name: str
    mapping: dict


@router.post("/mapping-profiles")
def save_mapping_profile(data: MappingProfileCreate, request: Request):
    actor = _require_preview_role(request, entity=data.entity_type)
    if data.entity_type not in ENTITY_FIELDS:
        raise HTTPException(status_code=404, detail="Unsupported import entity")
    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Profile name is required")
    with engine.begin() as conn:
        _ensure_schema(conn)
        conn.execute(text("""
            INSERT INTO data_import_mapping_profiles (entity_type, name, mapping_json, created_by, created_at, company_id)
            VALUES (:entity, :name, :mapping, :actor, :created_at, :company_id)
        """), {
            "entity": data.entity_type, "name": data.name.strip(),
            "mapping": json.dumps(data.mapping, ensure_ascii=False),
            "actor": actor, "created_at": _now(),
            "company_id": current_company_id(request),
        })
        return {"status": "created"}


@router.post("/preview/{entity}")
async def preview_import(
    entity: str,
    request: Request,
    file: UploadFile = File(...),
    opening_date: str = Form(""),
    sheet_name: str = Form(""),
    column_map_json: str = Form(""),
    duplicate_policy: str = Form("skip"),
    match_keys: str = Form("code_or_barcode"),
    negative_stock_policy: str = Form("block"),
    default_warehouse_id: str = Form(""),
    update_fields: str = Form(""),
    allow_blank_overwrite: bool = Form(False),
):
    actor = _require_preview_role(request, entity=entity)
    if entity not in ENTITY_FIELDS:
        raise HTTPException(status_code=404, detail="Unsupported import entity")
    raw = await file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_BYTES // (1024 * 1024)} MB limit")
    workbook = _load_workbook_any_format(raw, file.filename or "")
    sheet = workbook[sheet_name] if sheet_name and sheet_name in workbook.sheetnames else workbook.active
    rows = sheet.iter_rows(values_only=True)
    try:
        headers = next(rows)
    except StopIteration:
        raise HTTPException(status_code=400, detail="The file has no header row")
    column_map = (
        _resolve_mapping_override(headers, entity, column_map_json)
        if column_map_json else
        _mapping(headers, entity)
    )

    is_products = entity == "products"
    duplicate_policy = duplicate_policy if duplicate_policy in {"skip", "update"} else "skip"
    match_keys = match_keys if match_keys in PRODUCT_MATCH_KEY_FIELDS else "code_or_barcode"
    negative_stock_policy = negative_stock_policy if negative_stock_policy in {"block", "warn"} else "block"
    update_fields_list = [f.strip() for f in update_fields.split(",") if f.strip()] if update_fields else []
    warehouse_id_int = None
    if is_products and default_warehouse_id:
        try:
            warehouse_id_int = int(default_warehouse_id)
        except ValueError:
            warehouse_id_int = None

    parsed, errors, warnings = [], [], []
    seen = set()
    with engine.begin() as conn:
        _ensure_schema(conn)
        if entity == "employees":
            from app.hr import _ensure_schema as _ensure_hr_schema
            _ensure_hr_schema(conn)
        existing = _existing_keys(conn, entity, match_keys=match_keys if is_products else None, company_id=current_company_id(request))
        chart_codes = set()
        customers_map = {}
        products_map = {}
        if entity == "gl_trial_balance":
            _ensure_posting_schema(conn)
            chart_codes = {row[0] for row in conn.execute(text("SELECT code FROM chart_accounts WHERE company_id=:company_id"), {"company_id": current_company_id(request)}).fetchall()}
        if entity == "invoices":
            customers_map = _customer_lookup(conn, current_company_id(request))
            products_map = _product_lookup(conn, current_company_id(request))
        total_debit = 0.0
        total_credit = 0.0
        for row_number, values in enumerate(rows, start=2):
            if row_number - 1 > MAX_ROWS:
                raise HTTPException(status_code=400, detail=f"Maximum {MAX_ROWS} data rows allowed")
            if not any(value not in (None, "") for value in values):
                continue
            item = {}
            row_errors = []
            row_warnings = []
            for field in ENTITY_FIELDS[entity]:
                value = values[column_map[field]] if field in column_map and column_map[field] < len(values) else ""
                if field in NUMERIC_FIELDS:
                    item[field] = _number(value, field, row_number, row_errors)
                elif field in IDENTIFIER_FIELDS:
                    item[field] = _clean_identifier(value)
                elif field in PHONE_LIKE_FIELDS:
                    item[field] = _normalize_digits(_clean(value))
                else:
                    item[field] = _clean(value)
            required = REQUIRED_FIELD[entity]
            if not item.get(required):
                row_errors.append({"row": row_number, "field": required, "message": f"{required} is required"})

            if entity == "customers":
                if item["customer_type"] not in {"", "customer", "supplier", "both"}:
                    row_errors.append({"row": row_number, "field": "customer_type", "message": "Use customer, supplier, or both"})
                item["customer_type"] = item.get("customer_type") or "customer"
            elif entity == "products":
                item["unit"] = item.get("unit") or "عدد"
                if not item.get("sell_price"):
                    row_warnings.append({"row": row_number, "field": "sell_price", "message": "Sell price is empty or zero"})
                if item.get("stock", 0) < 0:
                    if negative_stock_policy == "block":
                        row_errors.append({"row": row_number, "field": "stock", "message": "Negative stock is not allowed"})
                    else:
                        row_warnings.append({"row": row_number, "field": "stock", "message": "Negative stock accepted (policy: warn)"})
            elif entity == "gl_trial_balance":
                debit, credit = item.get("debit") or 0, item.get("credit") or 0
                if debit and credit:
                    row_errors.append({"row": row_number, "field": "debit", "message": "Only one of debit/credit is allowed per row"})
                elif not debit and not credit:
                    row_errors.append({"row": row_number, "field": "debit", "message": "A debit or credit amount is required"})
                if item.get("account_code") and item["account_code"] not in chart_codes:
                    row_errors.append({"row": row_number, "field": "account_code", "message": "Unknown account code"})
                total_debit += debit
                total_credit += credit
            elif entity == "invoices":
                item["invoice_type"] = (item.get("invoice_type") or "sale").strip().lower()
                if item["invoice_type"] not in SUPPORTED_HISTORICAL_INVOICE_TYPES:
                    row_errors.append({"row": row_number, "field": "invoice_type", "message": "Only sale or return_sale is supported for historical import"})
                if item.get("date") and not _parse_date(item["date"]):
                    row_errors.append({"row": row_number, "field": "date", "message": "Invalid date, use YYYY-MM-DD"})
                if not item.get("customer_name"):
                    row_errors.append({"row": row_number, "field": "customer_name", "message": "Customer name is required"})
                elif item["customer_name"].lower() not in customers_map:
                    row_errors.append({"row": row_number, "field": "customer_name", "message": "Customer not found - import customers first"})
                if not item.get("product"):
                    row_errors.append({"row": row_number, "field": "product", "message": "Product is required"})
                elif item["product"].lower() not in products_map:
                    row_errors.append({"row": row_number, "field": "product", "message": "Product not found - import products first"})
                if not item.get("quantity") or item["quantity"] <= 0:
                    row_errors.append({"row": row_number, "field": "quantity", "message": "Quantity must be greater than zero"})
            elif entity == "employees":
                from app.hr import EMPLOYMENT_TYPES as _EMPLOYMENT_TYPES
                item["employment_type"] = (item.get("employment_type") or "full_time").strip().lower()
                if item["employment_type"] not in _EMPLOYMENT_TYPES:
                    row_errors.append({"row": row_number, "field": "employment_type", "message": f"Must be one of: {', '.join(sorted(_EMPLOYMENT_TYPES))}"})
                if item.get("start_date"):
                    parsed_start_date = _parse_date(item["start_date"])
                    if not parsed_start_date:
                        row_errors.append({"row": row_number, "field": "start_date", "message": "Invalid date, use YYYY-MM-DD (or a Jalali date)"})
                    else:
                        # Normalize to ISO storage format - a Jalali source
                        # value is converted here, not silently left as-is,
                        # and the converted value is what the preview and
                        # apply step both show/use.
                        item["start_date"] = parsed_start_date.isoformat()

            key = _row_key(entity, item, row_number, match_keys=match_keys if is_products else None)
            is_dup_key = bool(key) and (key in seen or key in existing) and entity in {"customers", "products", "employees"}
            updatable = is_dup_key and is_products and duplicate_policy == "update"
            duplicate = is_dup_key and not updatable
            if is_dup_key:
                warnings.append({
                    "row": row_number, "field": "duplicate",
                    "message": "Duplicate row will be updated" if updatable else "Duplicate row will be skipped",
                })
            seen.add(key)
            parsed.append({
                "row": row_number, "data": item, "errors": row_errors,
                "duplicate": duplicate, "updatable": updatable, "warnings": row_warnings,
            })
            errors.extend(row_errors)
            warnings.extend(row_warnings)
        if entity == "gl_trial_balance" and parsed:
            rounded_debit = round(total_debit, 2)
            rounded_credit = round(total_credit, 2)
            if rounded_debit != rounded_credit:
                warnings.append({
                    "row": 0, "field": "balance",
                    "message": f"Trial balance is not balanced: debit={rounded_debit}, credit={rounded_credit}. Fix before applying.",
                })
        batch_id = str(uuid.uuid4())
        valid = sum(not row["errors"] and not row["duplicate"] for row in parsed)
        updatable_rows = sum(row["updatable"] for row in parsed)
        balanced = entity != "gl_trial_balance" or round(total_debit, 2) == round(total_credit, 2)
        meta = {
            "opening_date": opening_date or datetime.utcnow().date().isoformat(),
            "duplicate_policy": duplicate_policy,
            "match_keys": match_keys,
            "negative_stock_policy": negative_stock_policy,
            "default_warehouse_id": warehouse_id_int,
            "update_fields": update_fields_list,
            "allow_blank_overwrite": bool(allow_blank_overwrite),
        }
        conn.execute(text("""
            INSERT INTO data_import_batches
              (id, entity_type, file_name, status, total_rows, valid_rows,
               error_rows, duplicate_rows, payload_json, meta_json, created_by, created_at, company_id)
            VALUES
              (:id, :entity, :file_name, 'previewed', :total, :valid,
               :errors, :duplicates, :payload, :meta, :actor, :created_at, :company_id)
        """), {
            "id": batch_id, "entity": entity, "file_name": file.filename or "import.xlsx",
            "total": len(parsed), "valid": valid,
            "errors": sum(bool(row["errors"]) for row in parsed),
            "duplicates": sum(row["duplicate"] for row in parsed),
            "payload": json.dumps(parsed, ensure_ascii=False),
            "meta": json.dumps(meta, ensure_ascii=False),
            "actor": actor, "created_at": _now(),
            "company_id": current_company_id(request),
        })
    return {
        "batch_id": batch_id, "entity": entity, "total_rows": len(parsed),
        "valid_rows": valid, "error_rows": sum(bool(row["errors"]) for row in parsed),
        "duplicate_rows": sum(row["duplicate"] for row in parsed),
        "updatable_rows": updatable_rows,
        # Full per-row detail (up to MAX_ROWS) so the wizard's preview table
        # can filter/sort/paginate client-side over the whole file, not just
        # a truncated slice - each row already carries its own errors/
        # warnings sublist, so capping the flat summary arrays below doesn't
        # lose any per-row detail.
        "errors": errors[:500], "warnings": warnings[:500], "preview": parsed,
        "can_apply": valid > 0 and not errors and balanced,
    }


def _post_customer_opening(conn, customer_id, name, balance, policy, company_id):
    amount = float(money(abs(balance), policy["decimal_places"], policy["rounding_mode"]))
    if not amount:
        return
    description = f"Imported opening balance: {name}"
    # Both sides are required: the GL voucher (chart_accounts/trial balance)
    # AND this customer's own accounting_entries subledger row - the latter
    # is what customer_balance()/the customer ledger and aging report
    # actually read. Posting only the GL side (as this used to) left every
    # imported customer's own balance silently at zero.
    if balance > 0:
        _insert_accounting_entry(conn, customer_id, "opening_balance", customer_id, description, amount, 0, datetime.utcnow(), company_id)
        lines = [{"account_code": "1103", "debit": amount}, {"account_code": "3101", "credit": amount}]
    else:
        _insert_accounting_entry(conn, customer_id, "opening_balance", customer_id, description, 0, amount, datetime.utcnow(), company_id)
        lines = [{"account_code": "3101", "debit": amount}, {"account_code": "2101", "credit": amount}]
    post_balanced_voucher("customer_opening", customer_id, description, lines, company_id, connection=conn)
    _rebuild_customer_balance(conn, customer_id)


def _post_product_opening(conn, product_id, name, stock, buy_price, policy, company_id):
    amount = float(money(stock * buy_price, policy["decimal_places"], policy["rounding_mode"]))
    if not amount:
        return
    description = f"Imported opening inventory: {name}"
    post_balanced_voucher("product_opening", product_id, description, [
        {"account_code": "1201", "debit": amount},
        {"account_code": "3101", "credit": amount},
    ], company_id, connection=conn)


def _insert_opening_stock_movement(conn, product_id, product_name, quantity, batch_id, warehouse_id):
    warehouse_name = DEFAULT_WAREHOUSE_NAME
    if warehouse_id:
        row = conn.execute(text("SELECT name FROM warehouses WHERE id=:id"), {"id": warehouse_id}).first()
        if row:
            warehouse_name = row[0]
    now = datetime.utcnow()
    conn.execute(text("""
        INSERT INTO stock_movements
          (warehouse, product_id, product_name, quantity, movement_type, movement_date, note, created_at, warehouse_id)
        VALUES
          (:warehouse, :product_id, :product_name, :quantity, 'opening_import', :movement_date, :note, :created_at, :warehouse_id)
    """), {
        "warehouse": warehouse_name, "product_id": product_id, "product_name": product_name,
        "quantity": quantity, "movement_date": now.date().isoformat(),
        "note": f"Import batch {batch_id}", "created_at": now.isoformat(), "warehouse_id": warehouse_id,
    })


def _apply_product_update(conn, product_id, item, update_fields, allow_blank_overwrite):
    if not update_fields:
        return
    set_clauses = []
    params = {"id": product_id}
    for field in update_fields:
        if field not in PRODUCT_UPDATABLE_FIELDS:
            continue
        value = item.get(field)
        is_blank = value in (None, "", 0, 0.0)
        if is_blank and not allow_blank_overwrite:
            continue
        set_clauses.append(f"{field} = :{field}")
        params[field] = value
    if not set_clauses:
        return
    conn.execute(text(f"UPDATE products SET {', '.join(set_clauses)} WHERE id = :id"), params)


def _insert_accounting_entry(conn, customer_id, source_type, source_id, description, debit, credit, created_at_dt, company_id):
    entry_type = "debit" if debit >= credit else "credit"
    conn.execute(text("""
        INSERT INTO accounting_entries
          (customer_id, source_type, source_id, entry_type, description, debit, credit, balance_after, created_at, company_id)
        VALUES
          (:customer_id, :source_type, :source_id, :entry_type, :description, :debit, :credit, 0, :created_at, :company_id)
    """), {
        "customer_id": customer_id, "source_type": source_type, "source_id": source_id,
        "entry_type": entry_type, "description": description, "debit": debit, "credit": credit,
        "created_at": created_at_dt, "company_id": company_id,
    })


def _rebuild_customer_balance(conn, customer_id):
    rows = conn.execute(text("""
        SELECT id, debit, credit FROM accounting_entries
        WHERE customer_id=:cid ORDER BY created_at ASC, id ASC
    """), {"cid": customer_id}).fetchall()
    balance = 0.0
    for entry_id, debit, credit in rows:
        balance += float(debit or 0) - float(credit or 0)
        conn.execute(text("UPDATE accounting_entries SET balance_after=:b WHERE id=:id"), {"b": balance, "id": entry_id})


def _post_historical_invoice(conn, invoice_id, customer_id, invoice_type, total_amount, paid_amount, invoice_dt, policy, company_id):
    amount = float(money(total_amount, policy["decimal_places"], policy["rounding_mode"]))
    if amount <= 0:
        return
    voucher_date = invoice_dt.date().isoformat()
    description = f"Imported historical invoice #{invoice_id}"
    is_return = invoice_type == "return_sale"
    debit = 0 if is_return else amount
    credit = amount if is_return else 0
    _insert_accounting_entry(conn, customer_id, "invoice", invoice_id, description, debit, credit, invoice_dt, company_id)
    if is_return:
        lines = [
            {"account_code": "4102", "debit": amount, "description": description},
            {"account_code": "1103", "credit": amount, "description": description},
        ]
    else:
        lines = [
            {"account_code": "1103", "debit": amount, "description": description},
            {"account_code": "4101", "credit": amount, "description": description},
        ]
    post_balanced_voucher("invoice", invoice_id, description, lines, company_id, voucher_date=voucher_date, connection=conn)

    paid = float(money(min(max(paid_amount, 0), amount), policy["decimal_places"], policy["rounding_mode"]))
    if paid > 0:
        receipt_description = f"Imported settlement for historical invoice #{invoice_id}"
        if is_return:
            _insert_accounting_entry(conn, customer_id, "payment", invoice_id, receipt_description, paid, 0, invoice_dt, company_id)
            post_balanced_voucher("payment", invoice_id, receipt_description, [
                {"account_code": "1103", "debit": paid, "description": receipt_description},
                {"account_code": "1102", "credit": paid, "description": receipt_description},
            ], company_id, voucher_date=voucher_date, connection=conn)
        else:
            _insert_accounting_entry(conn, customer_id, "receipt", invoice_id, receipt_description, 0, paid, invoice_dt, company_id)
            post_balanced_voucher("receipt", invoice_id, receipt_description, [
                {"account_code": "1102", "debit": paid, "description": receipt_description},
                {"account_code": "1103", "credit": paid, "description": receipt_description},
            ], company_id, voucher_date=voucher_date, connection=conn)
    _rebuild_customer_balance(conn, customer_id)


@router.post("/apply/{batch_id}")
def apply_import(batch_id: str, request: Request):
    actor = _require_admin(request)
    company_id = current_company_id(request)
    with engine.begin() as conn:
        _ensure_schema(conn)
        batch = conn.execute(text(
            "SELECT * FROM data_import_batches WHERE id=:id AND company_id=:company_id"
        ), {"id": batch_id, "company_id": company_id}).mappings().first()
        if not batch:
            raise HTTPException(status_code=404, detail="Import batch not found")
        if batch["created_by"] != actor:
            raise HTTPException(status_code=403, detail="Only the preview creator can apply this batch")
        if batch["status"] != "previewed":
            raise HTTPException(status_code=409, detail="Import batch has already been applied")
        rows = json.loads(batch["payload_json"])
        if any(row["errors"] for row in rows):
            raise HTTPException(status_code=409, detail="Resolve validation errors before applying")
        meta = json.loads(batch["meta_json"] or "{}")
        policy = financial_policy_values(conn, company_id)
        entity = batch["entity_type"]
        inserted = skipped = updated = 0

        if entity == "customers":
            existing = _existing_keys(conn, entity, company_id=company_id)
            for row in rows:
                item = row["data"]
                if row["duplicate"] or _row_key(entity, item) in existing:
                    skipped += 1
                    continue
                # portal_access_enabled/pricing_group/etc. are NOT NULL
                # columns with only an ORM-level (not DB-level) default,
                # so a fresh database (Base.metadata.create_all, e.g. a
                # brand-new install) rejects an INSERT that omits them -
                # unlike an older DB where they were added via an ALTER
                # TABLE ... DEFAULT. Set them explicitly to stay correct
                # on both.
                result = conn.execute(text("""
                    INSERT INTO customers
                      (name, phone, email, address, city, national_id, economic_code,
                       contact_person, customer_type, opening_balance, credit_limit, notes, created_at,
                       portal_access_enabled, portal_token_generation, pricing_group,
                       supplier_portal_access_enabled, supplier_portal_token_generation, marketing_consent, company_id)
                    VALUES
                      (:name, :phone, :email, :address, :city, :national_id, :economic_code,
                       :contact_person, :customer_type, :opening_balance, :credit_limit, :notes, :created_at,
                       0, 0, 'retail', 0, 0, 0, :company_id)
                """), {**item, "created_at": datetime.utcnow(), "company_id": company_id})
                _post_customer_opening(conn, result.lastrowid, item["name"], item["opening_balance"], policy, company_id)
                existing.add(_row_key(entity, item))
                inserted += 1

        elif entity == "employees":
            from app.hr import _ensure_schema as _ensure_hr_schema
            _ensure_hr_schema(conn)
            existing = _existing_keys(conn, entity, company_id=company_id)
            for row in rows:
                item = row["data"]
                if row["duplicate"] or _row_key(entity, item) in existing:
                    skipped += 1
                    continue
                conn.execute(text("""
                    INSERT INTO employees
                      (employee_number, first_name, last_name, job_title, department, employment_type,
                       status, phone, mobile, email, start_date, created_at, updated_at, company_id)
                    VALUES
                      (:employee_number, :first_name, :last_name, :job_title, :department, :employment_type,
                       'active', :phone, :mobile, :email, :start_date, :created_at, :created_at, :company_id)
                """), {**item, "start_date": item.get("start_date") or None, "created_at": _now(), "company_id": company_id})
                existing.add(_row_key(entity, item))
                inserted += 1

        elif entity == "products":
            duplicate_policy = meta.get("duplicate_policy", "skip")
            match_keys = meta.get("match_keys", "code_or_barcode")
            update_fields = meta.get("update_fields") or []
            allow_blank_overwrite = bool(meta.get("allow_blank_overwrite"))
            warehouse_id = meta.get("default_warehouse_id")

            if warehouse_id:
                # Guarantee the default ("Main") warehouse row exists via an
                # independent session BEFORE the main transaction touches
                # apply_warehouse_delta - its lazy-create path calls db.commit()
                # internally when the row is missing, which would otherwise
                # prematurely commit this batch's own transaction.
                standalone = SessionLocal()
                try:
                    ensure_default_warehouse(standalone, company_id)
                finally:
                    standalone.close()

            existing_by_key = _existing_product_ids_by_key(conn, match_keys, company_id)
            orm_session = OrmSession(bind=conn) if warehouse_id else None

            for row in rows:
                item = row["data"]
                key = _row_key(entity, item, match_keys=match_keys)
                existing_id = existing_by_key.get(key)

                if existing_id and duplicate_policy != "update":
                    skipped += 1
                    continue

                if existing_id and duplicate_policy == "update":
                    _apply_product_update(conn, existing_id, item, update_fields, allow_blank_overwrite)
                    updated += 1
                    continue

                result = conn.execute(text("""
                    INSERT INTO products
                      (name, code, barcode, barcode2, barcode3, sku, brand, unit, buy_price, sell_price,
                       price, stock, min_stock, count_in_pack, main_category, sub_category, image, description, is_active, company_id)
                    VALUES
                      (:name, :code, :barcode, :barcode2, :barcode3, :sku, :brand, :unit, :buy_price, :sell_price,
                       :sell_price, :stock, :min_stock, :count_in_pack, :main_category, :sub_category, '', :description, 1, :company_id)
                """), {**item, "company_id": company_id})
                product_id = result.lastrowid
                _post_product_opening(conn, product_id, item["name"], item["stock"], item["buy_price"], policy, company_id)

                if item.get("stock"):
                    _insert_opening_stock_movement(conn, product_id, item["name"], item["stock"], batch_id, warehouse_id)
                    if orm_session is not None:
                        apply_warehouse_delta(orm_session, warehouse_id, product_id, item["stock"], company_id)

                conn.execute(text("""
                    INSERT INTO data_import_product_links (batch_id, product_id, created_at)
                    VALUES (:batch_id, :product_id, :created_at)
                """), {"batch_id": batch_id, "product_id": product_id, "created_at": _now()})

                existing_by_key[key] = product_id
                inserted += 1

            if orm_session is not None:
                orm_session.flush()

        elif entity == "gl_trial_balance":
            _ensure_posting_schema(conn)
            lines = []
            for row in rows:
                item = row["data"]
                debit, credit = item.get("debit") or 0, item.get("credit") or 0
                if not debit and not credit:
                    continue
                lines.append({
                    "account_code": item["account_code"],
                    "debit": debit, "credit": credit,
                    "description": item.get("description") or item.get("account_name") or "Imported opening balance",
                })
            try:
                post_balanced_voucher(
                    f"gl_opening_{batch_id[:12]}", None,
                    "Imported opening trial balance", lines, company_id,
                    voucher_date=meta.get("opening_date"), connection=conn,
                )
            except ValueError as error:
                raise HTTPException(status_code=400, detail=str(error))
            inserted = len(lines)

        elif entity == "invoices":
            customers_map = _customer_lookup(conn, company_id)
            products_map = _product_lookup(conn, company_id)
            groups = {}
            for row in rows:
                item = row["data"]
                group_key = item.get("invoice_no") or f"__row_{row['row']}"
                groups.setdefault(group_key, []).append(item)
            for lines_for_invoice in groups.values():
                first = lines_for_invoice[0]
                customer_id = customers_map.get(_clean(first["customer_name"]).lower())
                invoice_date = _parse_date(first["date"])
                if not customer_id or not invoice_date:
                    skipped += len(lines_for_invoice)
                    continue
                line_payload = []
                ok = True
                for entry in lines_for_invoice:
                    product = products_map.get(_clean(entry["product"]).lower())
                    if not product:
                        ok = False
                        break
                    product_id, _buy_price = product
                    quantity = float(entry.get("quantity") or 0)
                    unit_price = float(entry.get("unit_price") or 0)
                    discount = float(entry.get("discount") or 0)
                    line_total = max(0.0, quantity * unit_price - discount)
                    line_payload.append((product_id, quantity, unit_price, line_total))
                if not ok or not line_payload:
                    skipped += len(lines_for_invoice)
                    continue
                total_amount = round(sum(item[3] for item in line_payload), 2)
                paid_amount = min(float(first.get("paid_amount") or 0), total_amount)
                payment_status = calculate_payment_status(total_amount, paid_amount, policy["decimal_places"], policy["rounding_mode"])
                created_at_dt = datetime.combine(invoice_date, datetime.min.time())
                result = conn.execute(text("""
                    INSERT INTO invoices
                      (invoice_type, customer_id, subtotal, discount_percent, discount_amount,
                       tax_percent, tax_amount, shipping_cost, total_amount, payment_status,
                       status, payment_terms_days, due_date, invoice_note, qr_enabled, created_at, company_id)
                    VALUES
                      (:invoice_type, :customer_id, :subtotal, 0, 0,
                       0, 0, 0, :total_amount, :payment_status,
                       'final', 0, '', :note, 0, :created_at, :company_id)
                """), {
                    "invoice_type": first["invoice_type"], "customer_id": customer_id,
                    "subtotal": total_amount, "total_amount": total_amount,
                    "payment_status": payment_status,
                    "note": "Imported historical invoice",
                    "created_at": created_at_dt,
                    "company_id": company_id,
                })
                invoice_id = result.lastrowid
                for product_id, quantity, unit_price, line_total in line_payload:
                    conn.execute(text("""
                        INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, total_price, company_id)
                        VALUES (:invoice_id, :product_id, :quantity, :unit_price, :total_price, :company_id)
                    """), {
                        "invoice_id": invoice_id, "product_id": product_id, "quantity": quantity,
                        "unit_price": unit_price, "total_price": line_total,
                        "company_id": company_id,
                    })
                _post_historical_invoice(
                    conn, invoice_id, customer_id, first["invoice_type"],
                    total_amount, paid_amount, created_at_dt, policy, company_id,
                )
                inserted += len(lines_for_invoice)

        result = {"inserted": inserted, "updated": updated, "skipped": skipped, "applied_by": actor}
        conn.execute(text("""
            UPDATE data_import_batches
            SET status='applied', result_json=:result, applied_at=:applied_at
            WHERE id=:id
        """), {"result": json.dumps(result), "applied_at": _now(), "id": batch_id})
        return {"status": "applied", "batch_id": batch_id, **result}


@router.post("/rollback/{batch_id}")
def rollback_import_batch(batch_id: str, request: Request):
    actor = _require_admin(request)
    company_id = current_company_id(request)
    with engine.begin() as conn:
        _ensure_schema(conn)
        batch = conn.execute(text(
            "SELECT * FROM data_import_batches WHERE id=:id AND company_id=:company_id"
        ), {"id": batch_id, "company_id": company_id}).mappings().first()
        if not batch:
            raise HTTPException(status_code=404, detail="Import batch not found")
        if batch["entity_type"] != "products":
            raise HTTPException(status_code=400, detail="Rollback is only supported for product import batches")
        if batch["status"] != "applied":
            raise HTTPException(status_code=409, detail=f"Batch cannot be rolled back from status '{batch['status']}'")

        product_ids = [
            row[0] for row in conn.execute(text("""
                SELECT product_id FROM data_import_product_links WHERE batch_id=:batch_id
            """), {"batch_id": batch_id}).fetchall()
        ]
        if not product_ids:
            raise HTTPException(status_code=409, detail="No newly-created products are linked to this batch - nothing to roll back")

        note = f"Import batch {batch_id}"
        removed, skipped_report = [], []
        for product_id in product_ids:
            product = conn.execute(text("SELECT id, name FROM products WHERE id=:id"), {"id": product_id}).mappings().first()
            if not product:
                continue
            invoice_ref = conn.execute(text(
                "SELECT id FROM invoice_items WHERE product_id=:id LIMIT 1"
            ), {"id": product_id}).first()
            if invoice_ref:
                skipped_report.append({"product_id": product_id, "name": product["name"], "reason": "Used on an invoice since import"})
                continue
            other_movement = conn.execute(text("""
                SELECT id FROM stock_movements
                WHERE product_id=:id AND NOT (movement_type='opening_import' AND note=:note)
                LIMIT 1
            """), {"id": product_id, "note": note}).first()
            if other_movement:
                skipped_report.append({"product_id": product_id, "name": product["name"], "reason": "Stock adjusted after import"})
                continue

            movement = conn.execute(text("""
                SELECT warehouse_id, quantity FROM stock_movements
                WHERE product_id=:id AND movement_type='opening_import' AND note=:note
            """), {"id": product_id, "note": note}).mappings().first()
            if movement and movement["warehouse_id"]:
                orm_session = OrmSession(bind=conn)
                apply_warehouse_delta(orm_session, movement["warehouse_id"], product_id, -float(movement["quantity"] or 0), company_id)
                orm_session.flush()
            conn.execute(text("""
                DELETE FROM stock_movements WHERE product_id=:id AND movement_type='opening_import' AND note=:note
            """), {"id": product_id, "note": note})
            try:
                delete_source_voucher("product_opening", product_id, company_id, connection=conn)
            except ValueError as error:
                skipped_report.append({"product_id": product_id, "name": product["name"], "reason": str(error)})
                continue
            conn.execute(text("DELETE FROM products WHERE id=:id"), {"id": product_id})
            conn.execute(text(
                "DELETE FROM data_import_product_links WHERE batch_id=:batch_id AND product_id=:id"
            ), {"batch_id": batch_id, "id": product_id})
            removed.append({"product_id": product_id, "name": product["name"]})

        new_status = "rolled_back" if not skipped_report else "partially_rolled_back"
        result = {"removed": removed, "skipped": skipped_report, "rolled_back_by": actor}
        conn.execute(text("""
            UPDATE data_import_batches SET status=:status, result_json=:result WHERE id=:id
        """), {"status": new_status, "result": json.dumps(result, ensure_ascii=False), "id": batch_id})
        return {"status": new_status, "batch_id": batch_id, **result}


@router.get("/batches")
def list_import_batches(request: Request):
    _require_preview_role(request, entity="products")
    with engine.begin() as conn:
        _ensure_schema(conn)
        rows = conn.execute(text("""
            SELECT id, entity_type, file_name, status, total_rows, valid_rows,
                   error_rows, duplicate_rows, result_json, created_by, created_at, applied_at
            FROM data_import_batches WHERE company_id=:company_id ORDER BY created_at DESC LIMIT 100
        """), {"company_id": current_company_id(request)}).mappings().all()
        return [dict(row) for row in rows]


@router.delete("/batches/{batch_id}")
def delete_import_batch(batch_id: str, request: Request):
    """Admin-only cleanup of an import batch's stored history/preview data
    (the parsed row payload, kept for audit/report purposes, can grow large
    for big files). Only ever deletes the history record itself - never the
    products/customers/etc. it already created; use /rollback for that."""
    _require_admin(request)
    with engine.begin() as conn:
        _ensure_schema(conn)
        batch = conn.execute(text(
            "SELECT id, status FROM data_import_batches WHERE id=:id AND company_id=:company_id"
        ), {"id": batch_id, "company_id": current_company_id(request)}).mappings().first()
        if not batch:
            raise HTTPException(status_code=404, detail="Import batch not found")
        if batch["status"] == "applied":
            raise HTTPException(
                status_code=409,
                detail="Applied batches must be rolled back (or left as an audit record) before their history can be deleted",
            )
        conn.execute(text("DELETE FROM data_import_batches WHERE id=:id"), {"id": batch_id})
        conn.execute(text("DELETE FROM data_import_product_links WHERE batch_id=:id"), {"id": batch_id})
        return {"status": "deleted", "batch_id": batch_id}



# Existing-customer PARASAY opening balances. Deliberately separate from
# /preview/customers: that route INSERTS new customers and cannot update
# existing subledgers. Preview performs no accounting writes.
@router.post("/customer-opening/preview")
async def preview_existing_customer_opening(
    request: Request,
    file: UploadFile = File(...),
    opening_date: str = Form("2026-10-21"),
    source_cutoff: str = Form("1405/07/29"),
):
    import csv
    from decimal import Decimal, InvalidOperation
    actor = _require_admin(request)
    company_id = current_company_id(request)
    if opening_date != "2026-10-21" or source_cutoff != "1405/07/29":
        raise HTTPException(status_code=400, detail="PARASAY source snapshot is fixed at 1405/07/29 (2026-10-21)")
    raw = await file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large")
    try:
        data = raw.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(data), delimiter="؛")
        mandatory = {"CustomerID", "CustomerCode", "AccountID", "BalanceAmount", "BalanceState", "VerifiedNetBalance"}
        if not mandatory.issubset(reader.fieldnames or ()):
            raise HTTPException(status_code=400, detail="Expected original PARASAY_400_Customer_Balances.csv with semicolon-Persian delimiter")
        source_rows = list(reader)
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="CSV must be UTF-8")
    if len(source_rows) != 400:
        raise HTTPException(status_code=400, detail="Expected exactly 400 source customers")
    parsed, issues, codes = [], [], set()
    debit_total = credit_total = 0
    from decimal import Decimal
    for idx, row in enumerate(source_rows, 2):
        code = _clean(row.get("CustomerCode"))
        if not code or code in codes:
            issues.append(f"row {idx}: missing/duplicate PARASAY customer code")
            continue
        codes.add(code)
        try:
            amount = Decimal(str(row["BalanceAmount"]))
            signed = Decimal(str(row["VerifiedNetBalance"]))
            if not amount.is_finite() or not signed.is_finite() or amount < 0:
                raise ValueError("invalid amount")
        except (ValueError, InvalidOperation, TypeError):
            issues.append(f"row {idx}: invalid amount")
            continue
        state = _clean(row.get("BalanceState"))
        expected = amount if state == "بد" else -amount if state == "بس" else Decimal(0) if amount == 0 else None
        if expected is None or expected != signed:
            issues.append(f"row {idx}: account balance disagrees with verified ledger")
            continue
        cents = signed * 100
        if cents != cents.to_integral_value():
            issues.append(f"row {idx}: unsupported fraction of a cent")
            continue
        if signed > 0: debit_total += signed
        if signed < 0: credit_total -= signed
        parsed.append({"code": code, "account_id": _clean(row.get("AccountID")),
                       "amount": str(signed)})
    if len(codes) != 400 or debit_total != Decimal("39668475516") or credit_total != Decimal("3888791595"):
        issues.append("Source control totals or unique customer count do not match verified PARASAY snapshot")
    with engine.begin() as conn:
        _ensure_schema(conn)
        company = conn.execute(text("SELECT name, is_active FROM companies WHERE id=:cid"),
                               {"cid": company_id}).mappings().first()
        if not company or not company["is_active"] or "هایپر" not in (company["name"] or ""):
            raise HTTPException(status_code=403, detail="PARASAY opening is restricted to active Hyper Doctor company")
        # Company selection is taken solely from authenticated request context,
        # not a company name supplied in an uploaded file.
        customer_rows = conn.execute(text("""
            SELECT id, name, notes FROM customers WHERE company_id=:company_id
        """), {"company_id": company_id}).mappings().all()
        import re
        by_code = {}
        ambiguous = set()
        for cust in customer_rows:
            match = re.search(r"کد\s*پاراسای\s*:\s*([0-9۰-۹٠-٩]+)", cust["notes"] or "")
            if not match:
                continue
            code = _normalize_digits(match.group(1))
            if code in by_code:
                ambiguous.add(code)
            by_code[code] = {"id": cust["id"], "name": cust["name"]}
        matched, nonzero = [], []
        for item in parsed:
            code = item["code"]
            cust = by_code.get(code)
            if not cust or code in ambiguous:
                issues.append(f"PARASAY code {code}: missing or ambiguous customer in active company")
                continue
            signed = Decimal(item["amount"])
            record = {**item, "customer_id": cust["id"], "name": cust["name"]}
            matched.append(record)
            if signed:
                exists = conn.execute(text("""
                    SELECT COUNT(*) FROM accounting_entries
                    WHERE company_id=:company_id AND customer_id=:customer_id
                """), {"company_id":company_id,"customer_id":cust["id"]}).scalar()
                if exists:
                    issues.append(f"PARASAY code {code}: customer already has accounting entries; opening not safe")
                nonzero.append(record)
        # Opening must belong to the populated Hyper Doctor company, not
        # another company that happens to contain matching customer notes.
        if len(customer_rows) != 400:
            issues.append("Active company must have exactly 400 matching imported customers")
        if len(matched) != 400 or len(nonzero) != 98:
            issues.append("Expected 400 matched customers and 98 with a nonzero balance")
        prior = conn.execute(text("""
            SELECT COUNT(*) FROM data_import_batches
            WHERE company_id=:company_id AND entity_type='existing_customer_opening'
              AND status='applied'
        """), {"company_id": company_id}).scalar()
        if prior:
            issues.append("An existing-customer opening batch was already applied for this company")
        batch_id = str(uuid.uuid4())
        conn.execute(text("""
            INSERT INTO data_import_batches
              (id, entity_type, file_name, status, total_rows, valid_rows, error_rows,
               duplicate_rows, payload_json, result_json, created_by, created_at, meta_json, company_id)
            VALUES
              (:id, 'existing_customer_opening', :name, 'previewed', :total, :valid,
               :errors, 0, :payload, '', :actor, :created, :meta, :company)
        """), {"id":batch_id,"name":file.filename or "PARASAY balances",
               "total":len(source_rows),"valid":len(matched),"errors":len(issues),
               "payload":json.dumps(nonzero,ensure_ascii=False),
               "actor":actor,"created":_now(),"company":company_id,
               "meta":json.dumps({"opening_date":opening_date,"source_cutoff":source_cutoff,
                                  "debit":str(debit_total),"credit":str(credit_total),
                                  "issues":issues},ensure_ascii=False)})
    return {"batch_id":batch_id,"company_id":company_id,"source_cutoff":source_cutoff,
            "matched_customers":len(matched),"nonzero_customers":len(nonzero),
            "debit":str(debit_total),"credit":str(credit_total),
            "net":str(debit_total-credit_total),
            "issues":issues,"can_apply":not issues,
            "balances":[{"code":x["code"],"name":x["name"],"amount":x["amount"]} for x in nonzero],
            "instruction":"Do not apply until the company and all 98 balances have been reviewed."}


@router.post("/customer-opening/apply/{batch_id}")
def apply_existing_customer_opening(batch_id: str, request: Request, confirm: str):
    from decimal import Decimal
    actor = _require_admin(request)
    company_id = current_company_id(request)
    if confirm != "APPLY_1405_07_29":
        raise HTTPException(status_code=400, detail="Explicit cutoff confirmation required")
    with engine.begin() as conn:
        _ensure_schema(conn)
        company = conn.execute(text("SELECT name, is_active FROM companies WHERE id=:cid"),
                               {"cid": company_id}).mappings().first()
        if not company or not company["is_active"] or "هایپر" not in (company["name"] or ""):
            raise HTTPException(status_code=403, detail="PARASAY opening is restricted to active Hyper Doctor company")
        batch = conn.execute(text("""
            SELECT * FROM data_import_batches WHERE id=:id AND company_id=:company_id
              AND entity_type='existing_customer_opening'
        """), {"id":batch_id,"company_id":company_id}).mappings().first()
        if not batch or batch["created_by"] != actor:
            raise HTTPException(status_code=404, detail="Opening batch not found for current operator/company")
        if batch["status"] != "previewed":
            raise HTTPException(status_code=409, detail="Batch was already applied")
        meta = json.loads(batch["meta_json"])
        if batch["error_rows"] or meta["issues"]:
            raise HTTPException(status_code=409, detail="Preview errors must be resolved")
        prior = conn.execute(text("""
            SELECT COUNT(*) FROM data_import_batches
            WHERE company_id=:cid AND entity_type='existing_customer_opening' AND status='applied'
        """), {"cid":company_id}).scalar()
        if prior:
            raise HTTPException(status_code=409, detail="Opening was already imported")
        rows = json.loads(batch["payload_json"])
        if len(rows) != 98:
            raise HTTPException(status_code=409, detail="Nonzero count has changed")
        # Recheck all affected accounts inside the same write transaction.
        for item in rows:
            matched = conn.execute(text("""
                SELECT id, notes FROM customers WHERE id=:id AND company_id=:cid
            """), {"id":item["customer_id"],"cid":company_id}).mappings().first()
            import re
            code_match = re.search(r"کد\s*پاراسای\s*:\s*([0-9۰-۹٠-٩]+)", (matched or {}).get("notes") or "")
            exact_match = bool(code_match and _normalize_digits(code_match.group(1)) == item["code"])
            has_entries = conn.execute(text("""
                SELECT COUNT(*) FROM accounting_entries WHERE company_id=:cid AND customer_id=:id
            """), {"cid":company_id,"id":item["customer_id"]}).scalar()
            if not exact_match or has_entries:
                raise HTTPException(status_code=409, detail="Customer code mapping or opening state has changed; preview again")
        _ensure_posting_schema(conn)
        created = datetime(2026, 10, 21, 23, 59, 59)
        debit_total = credit_total = Decimal("0")
        for item in rows:
            amount = Decimal(item["amount"])
            debit = amount if amount > 0 else Decimal("0")
            credit = -amount if amount < 0 else Decimal("0")
            debit_total += debit
            credit_total += credit
            _insert_accounting_entry(
                conn, item["customer_id"], "parasay_opening_14050729",
                item["customer_id"], "PARASAY opening through 1405/07/29",
                float(debit), float(credit), created, company_id,
            )
            _rebuild_customer_balance(conn, item["customer_id"])
        if debit_total != Decimal(meta["debit"]) or credit_total != Decimal(meta["credit"]):
            raise HTTPException(status_code=409, detail="Opening control totals changed")
        lines = [
            {"account_code":"1103","debit":float(debit_total),"description":"PARASAY customer receivables opening"},
            {"account_code":"2101","credit":float(credit_total),"description":"PARASAY customer advances / payables opening"},
            {"account_code":"3101","credit":float(debit_total-credit_total),"description":"PARASAY opening balance clearing; exclude from any later GL import"},
        ]
        try:
            post_balanced_voucher(
                "parasay_customer_opening", None,
                "PARASAY opening customer subledgers through 1405/07/29",
                lines, company_id, voucher_date="2026-10-21", connection=conn,
            )
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error))
        result = {"inserted":len(rows),"debit":str(debit_total),"credit":str(credit_total),
                  "net":str(debit_total-credit_total),"company_id":company_id}
        conn.execute(text("""
            UPDATE data_import_batches SET status='applied', result_json=:result, applied_at=:now
            WHERE id=:id AND company_id=:cid
        """), {"result":json.dumps(result),"now":_now(),"id":batch_id,"cid":company_id})
        return result


# PARASAY migration workbench: immutable, source-id-keyed raw staging.
# Deliberately does NOT issue vouchers, update stock, or create bank accounts.
# The original ledger contains period P&L and an existing VITALIX customer
# opening clearing voucher; importing any of those as GL a second time would
# double post. Keep source snapshots inspectable pending an approved crosswalk.
_PARASAY_STAGE_DEFS = {
    "inventory": {"required": ("ID", "Code", "Name", "NowAmount"),
                  "expected": 1490},
    "banks": {"required": ("BankAccountID", "BankName", "NetBalance"),
              "expected": 18},
    "gl_residual": {"required": ("MoienID", "MoienCode", "MoienName", "OtherNetBalance"),
                    "expected": 283},
    "chart_total": {"required": ("ID", "Code", "AccountName"), "expected": 43},
    "chart_moien": {"required": ("ID", "Code", "AccountName", "TotalBookID"), "expected": 283},
}


def _parasay_stage_validate(kind, raw):
    import csv
    from decimal import Decimal, InvalidOperation
    if kind not in _PARASAY_STAGE_DEFS:
        raise HTTPException(404, "Unknown PARASAY source category")
    try:
        decoded = raw.decode("utf-8-sig")
        lines = csv.DictReader(io.StringIO(decoded), delimiter="؛")
        header = lines.fieldnames or []
        required = _PARASAY_STAGE_DEFS[kind]["required"]
        if not all(col in header for col in required):
            raise ValueError("Missing original PARASAY columns: " + ", ".join(set(required)-set(header)))
        rows = list(lines)
        if len(rows) != _PARASAY_STAGE_DEFS[kind]["expected"]:
            raise ValueError("Unexpected original PARASAY row count")
        identifiers = []
        if kind in ("chart_total", "chart_moien"):
            for row in rows:
                if not row["ID"].isdigit() or not row["Code"].strip():
                    raise ValueError("Invalid account identity")
                identifiers.append(row["ID"])
            if len(set(identifiers)) != len(identifiers):
                raise ValueError("Duplicate account source IDs")
            return rows, {"count": len(rows), "nonzero": 0, "source_total": "0",
                          "code_duplicates": len(rows)-len({r["Code"] for r in rows}),
                          "is_accounting_posted": False}
        nonzero = 0
        total = Decimal(0)
        negative_stock = 0
        for row in rows:
            identifier = row["ID"] if kind == "inventory" else (
                row["BankAccountID"] if kind == "banks" else row["MoienID"])
            if not identifier or not str(identifier).isdigit():
                raise ValueError("Missing or nonnumeric original identifier")
            identifiers.append(identifier)
            value_key = ("NowAmount" if kind == "inventory"
                         else "NetBalance" if kind == "banks" else "OtherNetBalance")
            value = Decimal(row.get(value_key) or "0")
            if not value.is_finite():
                raise ValueError("Non-finite amount or quantity")
            total += value
            nonzero += value != 0
            if kind == "inventory":
                negative_stock += value < 0
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("Duplicate source IDs")
        expected_nonzero = {"inventory": 440, "banks": 18, "gl_residual": 12}
        if nonzero != expected_nonzero[kind]:
            raise ValueError("Control number of nonzero source rows did not match")
        control_totals = {"inventory": Decimal("20020"),
                          "banks": Decimal("22036831136"),
                          "gl_residual": Decimal("-35779683921")}
        if total != control_totals[kind]:
            raise ValueError("Source totals did not reconcile")
        return rows, {"count": len(rows), "nonzero": nonzero, "source_total": str(total),
                      "negative_stock_count": negative_stock,
                      "is_accounting_posted": False}
    except (UnicodeError, ValueError, InvalidOperation, csv.Error) as error:
        raise HTTPException(status_code=422, detail=str(error))


def _ensure_parasay_stage(conn):
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS parasay_migration_staging (
            company_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(company_id, kind, source_id)
        )
    """))


def _parasay_company(conn, request):
    company_id = current_company_id(request)
    company = conn.execute(text(
        "SELECT name FROM companies WHERE id=:company AND is_active=1"
    ), {"company": company_id}).mappings().first()
    if not company or "هایپر" not in (company["name"] or ""):
        raise HTTPException(403, "PARASAY migration is Hyper Doctor only")
    return company_id


@router.post("/parasay-stage/{kind}/preview")
async def preview_parasay_source(kind: str, request: Request, file: UploadFile = File(...)):
    _require_admin(request)
    raw = await file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "File too large")
    rows, summary = _parasay_stage_validate(kind, raw)
    with engine.begin() as conn:
        company = _parasay_company(conn, request)
        _ensure_parasay_stage(conn)
        current = conn.execute(text("""
            SELECT COUNT(*) FROM parasay_migration_staging
            WHERE company_id=:company AND kind=:kind
        """), {"company": company, "kind": kind}).scalar()
    return {"kind": kind, "company_id": company, **summary,
            "existing_staged": current, "can_apply": current == 0,
            "warning": "Review only. No accounting or inventory movements are posted."}


@router.post("/parasay-stage/{kind}/apply")
async def apply_parasay_source(kind: str, request: Request, file: UploadFile = File(...),
                              confirm: str = ""):
    _require_admin(request)
    if confirm != "STAGE_WITHOUT_POSTING":
        raise HTTPException(400, "Staging-only confirmation required")
    raw = await file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "File too large")
    rows, summary = _parasay_stage_validate(kind, raw)
    with engine.begin() as conn:
        company = _parasay_company(conn, request)
        _ensure_parasay_stage(conn)
        existing = conn.execute(text("""
            SELECT COUNT(*) FROM parasay_migration_staging
            WHERE company_id=:company AND kind=:kind
        """), {"company": company, "kind": kind}).scalar()
        if existing:
            raise HTTPException(409, "PARASAY source was already staged. No duplicate import.")
        id_name = {"inventory": "ID", "banks": "BankAccountID", "gl_residual": "MoienID"}[kind]
        now = _now()
        for row in rows:
            conn.execute(text("""
                INSERT INTO parasay_migration_staging
                   (company_id,kind,source_id,payload_json,created_at)
                VALUES (:company,:kind,:source_id,:payload,:created)
            """), {"company": company, "kind": kind, "source_id": row[id_name],
                   "payload": json.dumps(row, ensure_ascii=False), "created": now})
    return {"status": "staged", "kind": kind, **summary,
            "no_gl_posting": True, "no_stock_posting": True}


@router.get("/parasay-stage/status")
def parasay_staging_status(request: Request):
    _require_admin(request)
    with engine.begin() as conn:
        company = _parasay_company(conn, request)
        _ensure_parasay_stage(conn)
        counts = conn.execute(text("""
            SELECT kind, COUNT(*) AS staged_count FROM parasay_migration_staging
            WHERE company_id=:company GROUP BY kind
        """), {"company": company}).mappings().all()
    return {"company_id": company,
            "staged_counts": {r["kind"]: r["staged_count"] for r in counts},
            "financial_posting_performed": False,
            "warning": "Only source snapshots staged. GL/stock movements require reconciled crosswalk."}


# Single-upload PARASAY source package: all four sources are validated first;
# application is one SQLite transaction. No operational financial writes.
_PARASAY_PACKAGE_FILES = {
    "inventory": "PARASAY7_ALL_GOODS.csv",
    "banks": "PARASAY_Bank_Final_Balances.csv",
    "gl_residual": "PARASAY_Other_Accounts_1405-07-29.csv",
    "chart_total": "PARASAY_TotalBookAccounts.csv",
    "chart_moien": "PARASAY_MoienBookAccounts.csv",
    "cheques": "VITALIX_PARASAY_28_OPEN_CHECKS_STAGING.csv",
}


def _read_parasay_package(raw):
    import zipfile
    import hashlib
    from app.accounting.treasury import _validate_parasay_cheques
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = set(archive.namelist())
            if not set(_PARASAY_PACKAGE_FILES.values()).issubset(names) or "manifest.json" not in names:
                raise ValueError("Missing files from official PARASAY package")
            manifest = json.loads(archive.read("manifest.json"))
            if (manifest.get("company") != "Hyper Doctor"
                    or manifest.get("cutoff_jalali") != "1405/07/29"
                    or manifest.get("mode") != "staging_only_no_financial_posting"):
                raise ValueError("Invalid company/cutoff/posting mode")
            validated, summary = {}, {}
            for kind, filename in _PARASAY_PACKAGE_FILES.items():
                info = archive.getinfo(filename)
                if info.file_size > MAX_BYTES or info.file_size < 1:
                    raise ValueError("Invalid source file size")
                source = archive.read(filename)
                expected = manifest["files"][filename]["sha256"]
                if hashlib.sha256(source).hexdigest() != expected:
                    raise ValueError("Package checksum error: " + filename)
                if kind == "cheques":
                    rows, counts, totals = _validate_parasay_cheques(source)
                    validated[kind] = rows
                    summary[kind] = {"count": len(rows), "received": counts["received"],
                                     "payable": counts["payable"],
                                     "received_irr": str(totals["received"]),
                                     "payable_irr": str(totals["payable"]),
                                     "unknown_party": sum(r["mapping_status"] == "PARTY_UNKNOWN" for r in rows)}
                else:
                    rows, checks = _parasay_stage_validate(kind, source)
                    validated[kind] = rows
                    summary[kind] = checks
            return validated, summary
    except (OSError, KeyError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        raise HTTPException(422, detail=str(error))


def _parasay_package_existing(conn, company):
    from app.accounting.treasury import _ensure_parasay_opening_cheques
    _ensure_parasay_stage(conn)
    _ensure_parasay_opening_cheques(conn)
    existing = {
        row["kind"]: row["total"]
        for row in conn.execute(text("""
            SELECT kind, COUNT(*) AS total FROM parasay_migration_staging
            WHERE company_id=:company GROUP BY kind
        """), {"company": company}).mappings()
    }
    existing["cheques"] = conn.execute(text("""
        SELECT COUNT(*) FROM parasay_opening_cheques WHERE company_id=:company
    """), {"company": company}).scalar()
    return existing


@router.post("/parasay-package/preview")
async def preview_parasay_package(request: Request, file: UploadFile = File(...)):
    _require_admin(request)
    raw = await file.read(MAX_BYTES+1)
    if len(raw)>MAX_BYTES:
        raise HTTPException(413, "Package too large")
    records, summary = _read_parasay_package(raw)
    with engine.begin() as conn:
        company = _parasay_company(conn, request)
        existing = _parasay_package_existing(conn, company)
    return {"company_id": company, "summary": summary,
            "existing": existing, "can_apply": not any(existing.values()),
            "no_accounting_posting": True,
            "warning": "Only source snapshots will be staged. Two negative stocks, 12 unmapped cheques, and ambiguous bank account 7579 require review."}


@router.post("/parasay-package/apply")
async def apply_parasay_package(request: Request, file: UploadFile = File(...),
                               confirm: str = ""):
    _require_admin(request)
    if confirm != "STAGE_FOUR_SOURCES_NO_FINANCIAL_CHANGES":
        raise HTTPException(400, "Explicit no-posting confirmation required")
    raw = await file.read(MAX_BYTES+1)
    if len(raw)>MAX_BYTES:
        raise HTTPException(413, "Package too large")
    records, summary = _read_parasay_package(raw)
    from app.accounting.treasury import _ensure_parasay_opening_cheques
    with engine.begin() as conn:
        company = _parasay_company(conn, request)
        if any(_parasay_package_existing(conn, company).values()):
            raise HTTPException(409, "At least one PARASAY source already staged; duplicate package blocked")
        now = _now()
        id_columns = {"inventory": "ID", "banks": "BankAccountID", "gl_residual": "MoienID",
                      "chart_total": "ID", "chart_moien": "ID"}
        for kind in id_columns:
            for item in records[kind]:
                conn.execute(text("""
                    INSERT INTO parasay_migration_staging
                        (company_id,kind,source_id,payload_json,created_at)
                    VALUES (:company,:kind,:id,:payload,:now)
                """), {"company": company, "kind": kind, "id": item[id_columns[kind]],
                       "payload": json.dumps(item, ensure_ascii=False), "now": now})
        _ensure_parasay_opening_cheques(conn)
        for item in records["cheques"]:
            conn.execute(text("""
                INSERT INTO parasay_opening_cheques
                    (company_id,source_check_id,cheque_number,due_date_jalali,
                     amount_irr,direction,original_state,bank_name_original,
                     source_party_id,party_name_original,source_bank_id,
                     mapping_status,created_at)
                VALUES
                    (:company,:id,:number,:due,:amount,:direction,:state,
                     :bank,:party,:partyname,:bankid,:mapping,:now)
            """), {"company": company, "id": int(item["source_check_id"]),
                   "number": item["cheque_number"], "due": item["due_date_jalali"],
                   "amount": item["amount_irr"], "direction": item["direction"],
                   "state": item["original_state"], "bank": item.get("bank_name_original", ""),
                   "party": item["source_party_id"], "partyname": item.get("party_name_original", ""),
                   "bankid": item.get("source_bank_id", ""), "mapping": item["mapping_status"],
                   "now": now})
    return {"status": "staged", "company_id": company, "summary": summary,
            "no_gl_posting": True, "no_inventory_changes": True,
            "no_customer_balance_changes": True}


# Approved source-chart crosswalk. PARASAY Moien code 211130 is duplicated
# for two different Account IDs; PS-M-<source_id> preserves both identities.
def _parasay_staged_rows(conn, company, kind, count):
    rows = conn.execute(text("""
        SELECT source_id, payload_json FROM parasay_migration_staging
        WHERE company_id=:company AND kind=:kind
        ORDER BY CAST(source_id AS INTEGER)
    """), {"company": company, "kind": kind}).mappings().all()
    if len(rows) != count:
        raise HTTPException(409, f"PARASAY {kind}: expected {count} staged records, found {len(rows)}")
    return [json.loads(r["payload_json"]) for r in rows]


def _ensure_parasay_finalize_table(conn):
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS parasay_migration_finalizations (
            company_id INTEGER NOT NULL,
            scope TEXT NOT NULL,
            details_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(company_id,scope)
        )
    """))


def _parasay_account_type(code):
    first = str(code or "")[:1]
    return {"1":"asset","2":"liability","3":"equity",
            "4":"revenue","5":"expense","6":"expense","9":"equity"}.get(first,"asset")


@router.get("/parasay-finalize/preview")
def preview_parasay_finalization(request: Request):
    from decimal import Decimal
    _require_admin(request)
    with engine.begin() as conn:
        company = _parasay_company(conn, request)
        _ensure_parasay_stage(conn)
        _ensure_parasay_finalize_table(conn)
        totals = _parasay_staged_rows(conn, company, "chart_total", 43)
        moien = _parasay_staged_rows(conn, company, "chart_moien", 283)
        goods = _parasay_staged_rows(conn, company, "inventory", 1490)
        banks = _parasay_staged_rows(conn, company, "banks", 18)
        residual = _parasay_staged_rows(conn, company, "gl_residual", 283)
        source_checks = conn.execute(text("""
            SELECT COUNT(*) FROM parasay_opening_cheques WHERE company_id=:c
        """), {"c":company}).scalar()
        prior_opening = conn.execute(text("""
            SELECT COUNT(*) FROM data_import_batches
            WHERE company_id=:c AND entity_type='existing_customer_opening'
              AND status='applied'
        """), {"c":company}).scalar()
        done = conn.execute(text("""
            SELECT scope FROM parasay_migration_finalizations WHERE company_id=:c
        """), {"c":company}).scalars().all()
        total_ids = {int(x["ID"]) for x in totals}
        parent_missing = [x["ID"] for x in moien if int(x["TotalBookID"]) not in total_ids]
        code_duplicates = len(moien)-len({x["Code"] for x in moien})
        source_by_code = {x["Code"]: x for x in goods}
        product_rows = conn.execute(text("""
            SELECT id, code, stock FROM products WHERE company_id=:c
        """), {"c":company}).mappings().all()
        missing_codes = [c for c in source_by_code if c not in {str(p["code"]) for p in product_rows}]
        qty_changes = [
            {"source_id": x["ID"], "code":x["Code"],"qty":x["NowAmount"]}
            for x in goods if Decimal(x["NowAmount"] or "0") < 0
        ]
        total_stock = sum((Decimal(x["NowAmount"] or "0") for x in goods),Decimal(0))
        net_residual = sum((Decimal(x["OtherNetBalance"] or "0") for x in residual),Decimal(0))
        bank_total = sum((Decimal(x["NetBalance"] or "0") for x in banks),Decimal(0))
        existing_nonzero_stock = sum(Decimal(str(p["stock"] or 0)) != 0 for p in product_rows)
        gl_nonzero = sum(Decimal(x["OtherNetBalance"] or "0") != 0 for x in residual)
        blockers = []
        if not prior_opening:
            blockers.append("Customer opening has not been applied")
        if parent_missing:
            blockers.append("Unresolved source chart parent IDs")
        if missing_codes or len(product_rows) != 1490:
            blockers.append("All 1490 existing VITALIX product codes must match PARASAY")
        if existing_nonzero_stock:
            blockers.append("Existing nonzero inventory detected; avoid replacing live stock")
        if source_checks != 28:
            blockers.append("28 opening cheques must first be staged")
        if code_duplicates != 1:
            blockers.append("Unexpected change to duplicated PARASAY Moien code")
        if total_stock != Decimal("20020") or net_residual != Decimal("-35779683921"):
            blockers.append("Source inventory or GL controls changed")
        if bank_total != Decimal("22036831136") or gl_nonzero != 12:
            blockers.append("Bank or GL source controls changed")
        if "opening" in done:
            blockers.append("PARASAY opening stock and GL have already been posted")
    return {
        "company_id":company, "source_total_accounts":len(totals),
        "source_moien_accounts":len(moien), "source_duplicate_moien_codes":code_duplicates,
        "source_product_count":len(goods), "matched_products":len(goods)-len(missing_codes),
        "product_total_quantity":str(total_stock), "negative_stock":qty_changes,
        "bank_accounts":len(banks), "bank_total_irr":str(bank_total),
        "gl_nonzero_accounts":gl_nonzero, "residual_net_irr":str(net_residual),
        "cheques_staged":source_checks, "customer_opening_applied":bool(prior_opening),
        "already_finalized":done, "chart_finalized":"chart" in done,
        "opening_finalized":"opening" in done, "blockers":blockers,
        "can_finalize":not blockers and "chart" in done,
        "warning":"Two negative product quantities and PARASAY bank 7579 personal account require explicit manual review. The GL is a snapshot including income/expense through the cutoff."}


@router.post("/parasay-finalize/chart")
def finalize_parasay_chart(request: Request, confirm: str = ""):
    _require_admin(request)
    if confirm != "CREATE_PARASAY_CHART_BY_SOURCE_ID":
        raise HTTPException(400, "Explicit source-ID chart confirmation required")
    with engine.begin() as conn:
        company = _parasay_company(conn, request)
        _ensure_parasay_stage(conn)
        _ensure_parasay_finalize_table(conn)
        totals = _parasay_staged_rows(conn, company, "chart_total", 43)
        moien = _parasay_staged_rows(conn, company, "chart_moien", 283)
        found = conn.execute(text("""
            SELECT COUNT(*) FROM parasay_migration_finalizations
            WHERE company_id=:c AND scope='chart'
        """), {"c":company}).scalar()
        if found:
            raise HTTPException(409, "PARASAY source chart already created")
        _ensure_posting_schema(conn)
        existing = {row[0] for row in conn.execute(text("""
            SELECT code FROM chart_accounts WHERE company_id=:c AND
                (code LIKE 'PS-T-%' OR code LIKE 'PS-M-%')
        """), {"c":company}).all()}
        if existing:
            raise HTTPException(409, "Some PARASAY chart codes already exist; no duplicate inserts")
        total_ids = {str(row["ID"]) for row in totals}
        if len(total_ids)!=43 or any(str(row["TotalBookID"]) not in total_ids for row in moien):
            raise HTTPException(409, "Invalid chart hierarchy")
        now = _now()
        total_row_ids = {}
        for row in totals:
            result = conn.execute(text("""
                INSERT INTO chart_accounts
                (company_id,code,name,account_type,level,normal_balance,description,is_active,created_at,updated_at)
                VALUES (:c,:code,:name,:type,'ledger',:normal,:desc,1,:now,:now)
            """), {"c":company,"code":"PS-T-"+str(row["ID"]),
                   "name":row["Code"]+" | "+row["AccountName"],
                   "type":_parasay_account_type(row["Code"]),
                   "normal":"credit" if _parasay_account_type(row["Code"]) in ("liability","equity","revenue") else "debit",
                   "desc":"PARASAY TotalBook ID="+str(row["ID"])+" original code="+str(row["Code"]),
                   "now":now})
            total_row_ids[str(row["ID"])] = result.lastrowid
        for row in moien:
            account_type = _parasay_account_type(row["Code"])
            conn.execute(text("""
                INSERT INTO chart_accounts
                (company_id,code,name,account_type,level,parent_id,normal_balance,description,is_active,created_at,updated_at)
                VALUES (:c,:code,:name,:type,'subsidiary',:parent,:normal,:desc,1,:now,:now)
            """), {"c":company,"code":"PS-M-"+str(row["ID"]),
                   "name":str(row["Code"])+" | "+row["AccountName"],
                   "type":account_type,"parent":total_row_ids[str(row["TotalBookID"])],
                   "normal":"credit" if account_type in ("liability","equity","revenue") else "debit",
                   "desc":"PARASAY Moien ID="+str(row["ID"])+" original code="+str(row["Code"]),
                   "now":now})
        result={"total":43,"moien":283,"duplicate_source_code_handling":"source ID mapping"}
        conn.execute(text("""
            INSERT INTO parasay_migration_finalizations
            (company_id,scope,details_json,created_at) VALUES (:c,'chart',:data,:now)
        """),{"c":company,"data":json.dumps(result),"now":now})
    return {"status":"applied","chart_accounts_created":326,
            "no_gl_posting":True,"no_customer_balance_changes":True}


@router.post("/parasay-finalize/opening")
def finalize_parasay_stock_and_ledger(request: Request,
                                      confirm: str = "",
                                      accept_source_negative_stock: bool = False,
                                      acknowledge_bank_7579: bool = False):
    """Atomic PARASAY stock snapshot + source residual GL.
    The prior customer-opening voucher's 3101 clearing credit is reversed
    by a 3101 debit in THIS voucher; no customer subledger is touched.
    All operational stock and ledger writes roll back on any failure.
    """
    from decimal import Decimal
    _require_admin(request)
    if confirm != "APPLY_PARASAY_STOCK_GL_14050729":
        raise HTTPException(400, "Explicit company/date confirmation required")
    if not accept_source_negative_stock or not acknowledge_bank_7579:
        raise HTTPException(409, "Review both negative stock items and the personal bank account 7579 first")
    with engine.begin() as conn:
        company = _parasay_company(conn, request)
        _ensure_parasay_stage(conn)
        _ensure_parasay_finalize_table(conn)
        found = conn.execute(text("""
            SELECT COUNT(*) FROM parasay_migration_finalizations
            WHERE company_id=:c AND scope='opening'
        """),{"c":company}).scalar()
        if found:
            raise HTTPException(409, "Opening snapshot has already been posted")
        chart_done = conn.execute(text("""
            SELECT COUNT(*) FROM parasay_migration_finalizations
            WHERE company_id=:c AND scope='chart'
        """),{"c":company}).scalar()
        if not chart_done:
            raise HTTPException(409, "PARASAY source chart must be finalized first")
        goods = _parasay_staged_rows(conn, company, "inventory", 1490)
        residual = _parasay_staged_rows(conn, company, "gl_residual", 283)
        banks = _parasay_staged_rows(conn, company, "banks", 18)
        if sum(Decimal(x["NetBalance"]) for x in banks) != Decimal("22036831136"):
            raise HTTPException(409, "Bank total changed")
        amount_by_id = {int(x["MoienID"]): Decimal(x["OtherNetBalance"]) for x in residual}
        nonzero = {key:value for key,value in amount_by_id.items() if value}
        if len(nonzero)!=12 or sum(nonzero.values()) != Decimal("-35779683921"):
            raise HTTPException(409, "Unreconciled PARASAY residual GL; cannot post")
        if amount_by_id.get(104) != Decimal("22036831136"):
            raise HTTPException(409, "PARASAY bank Moien does not match bank account detail")
        if amount_by_id.get(117) != Decimal("3509040000") or amount_by_id.get(193) != Decimal("-26415000000"):
            raise HTTPException(409, "PARASAY cheque GL does not match 28 cheque detail rows")
        prior = conn.execute(text("""
            SELECT COUNT(*) FROM data_import_batches
            WHERE company_id=:c AND entity_type='existing_customer_opening' AND status='applied'
        """),{"c":company}).scalar()
        if prior != 1:
            raise HTTPException(409, "Expected one applied prior customer-opening batch")
        _ensure_posting_schema(conn)
        clearing = conn.execute(text("""
            SELECT COALESCE(SUM(l.credit-l.debit), 0)
            FROM accounting_voucher_lines l
            INNER JOIN accounting_vouchers v ON v.id=l.voucher_id
            WHERE v.company_id=:c AND v.source_type='parasay_customer_opening'
              AND l.account_code='3101'
        """),{"c":company}).scalar()
        if abs(Decimal(str(clearing or 0)) - Decimal("35779683921")) > Decimal("0.01"):
            raise HTTPException(409, "Previous customer-opening GL clearing is missing or altered")
        prior_final = conn.execute(text("""
            SELECT COUNT(*) FROM accounting_vouchers
            WHERE company_id=:c AND source_type='parasay_source_residual_14050729'
        """),{"c":company}).scalar()
        if prior_final:
            raise HTTPException(409, "PARASAY residual GL voucher already exists")
        charts = {
            row[0] for row in conn.execute(text("""
                SELECT code FROM chart_accounts
                WHERE company_id=:c AND code LIKE 'PS-M-%'
            """),{"c":company}).all()
        }
        if len(charts) != 283 or any("PS-M-"+str(id) not in charts for id in nonzero):
            raise HTTPException(409, "PARASAY chart is incomplete")
        products = conn.execute(text("""
            SELECT id, code, name, stock FROM products WHERE company_id=:c
        """),{"c":company}).mappings().all()
        by_code={}
        for product in products:
            key=str(product["code"] or "")
            if key in by_code:
                raise HTTPException(409, "Duplicate target product code")
            by_code[key]=product
        if len(products)!=1490:
            raise HTTPException(409, "Expected exactly 1490 imported products")
        if any(Decimal(str(p["stock"] or 0)) != 0 for p in products):
            raise HTTPException(409, "Some target stock is not zero; stopping to avoid overwrite")
        codes = [g["Code"] for g in goods]
        if len(set(codes))!=1490 or set(codes)!=set(by_code):
            raise HTTPException(409, "PARASAY and VITALIX goods codes do not match")
        quantities = [Decimal(g["NowAmount"] or "0") for g in goods]
        if sum(quantities) != Decimal("20020") or sum(x!=0 for x in quantities)!=440:
            raise HTTPException(409, "Source inventory quantities changed")
        if sum(x<0 for x in quantities)!=2:
            raise HTTPException(409, "Unexpected source negative stock rows")
        # Count any prior movement in this company, regardless of whether
        # a product's current stock has returned to zero since that movement.
        movement_exists = conn.execute(text("""
            SELECT COUNT(*) FROM stock_movements m
            INNER JOIN products p ON p.id=m.product_id
            WHERE p.company_id=:c
        """),{"c":company}).scalar()
        if movement_exists:
            raise HTTPException(409, "Existing inventory movements require manual reconciliation")
        lines=[]
        for source_id, value in sorted(nonzero.items()):
            lines.append({
                "account_code": "PS-M-"+str(source_id),
                "debit": float(value) if value>0 else 0,
                "credit": float(-value) if value<0 else 0,
                "description": "PARASAY Moien ID "+str(source_id)+" opening through 1405/07/29",
            })
        lines.append({
            "account_code": "3101", "debit": 35779683921.0,
            "description": "Clear exactly the customer-opening 3101 credit (no second customer entry)",
        })
        voucher_id=post_balanced_voucher(
            "parasay_source_residual_14050729", None,
            "PARASAY remaining GL snapshot, excludes prior customer subledgers",
            lines, company, voucher_date="2026-10-21", connection=conn,
        )
        now=_now()
        for good in goods:
            product=by_code[good["Code"]]
            quantity=Decimal(good["NowAmount"] or "0")
            if quantity==0:
                continue
            updated=conn.execute(text("""
                UPDATE products SET stock=:quantity
                WHERE company_id=:company AND id=:id AND COALESCE(stock,0)=0
            """),{"quantity":float(quantity),"company":company,"id":product["id"]})
            if updated.rowcount!=1:
                raise HTTPException(409,"Product stock changed during opening import")
            conn.execute(text("""
                INSERT INTO stock_movements
                 (warehouse,product_id,product_name,quantity,movement_type,
                  movement_date,note,created_at,warehouse_id)
                VALUES
                 (:warehouse,:product_id,:product_name,:quantity,'opening_import',
                  '2026-10-21',:note,:now,NULL)
            """),{"warehouse":DEFAULT_WAREHOUSE_NAME,"product_id":product["id"],
                   "product_name":product["name"],"quantity":float(quantity),
                   "note":"PARASAY physical stock snapshot 1405/07/29; valuation is separate GL snapshot",
                   "now":now})
        result={"voucher_id":voucher_id,"gl_lines":len(lines),
                "stock_updated":440,"stock_negative":2,
                "stock_total": "20020", "gl_residual_net":"-35779683921",
                "customer_opening_clearing_debit":"35779683921",
                "source_cutoff":"1405/07/29"}
        conn.execute(text("""
            INSERT INTO parasay_migration_finalizations
            (company_id,scope,details_json,created_at)
            VALUES (:c,'opening',:data,:now)
        """),{"c":company,"data":json.dumps(result),"now":now})
    return {"status":"applied","company_id":company,**result,
            "customer_opening_untouched":True,
            "cheque_staging_untouched":True,
            "bank_subaccounts_still_require_mapping":True}
