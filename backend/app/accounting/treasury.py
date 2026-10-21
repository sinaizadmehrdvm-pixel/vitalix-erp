import csv
import io
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import text

from app.accounting.posting import delete_source_voucher, post_balanced_voucher
from app.database import engine
from app.company_scope import current_company_id

router = APIRouter(prefix="/api/accounting/treasury", tags=["Treasury & Cheques"])
MONEY_STEP = Decimal("0.01")


def _money(value):
    return float(Decimal(str(value or 0)).quantize(MONEY_STEP, rounding=ROUND_HALF_UP))


class ChequeCreate(BaseModel):
    direction: str
    customer_id: int
    amount: float
    cheque_number: str
    bank_name: str = ""
    branch_name: str = ""
    issue_date: date
    due_date: date
    note: str = ""


class ChequeTransition(BaseModel):
    status: str
    event_date: date
    note: str = ""


def _ensure_schema(conn):
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS treasury_cheques (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            direction VARCHAR NOT NULL,
            customer_id INTEGER NOT NULL,
            amount FLOAT NOT NULL,
            cheque_number VARCHAR NOT NULL,
            bank_name VARCHAR DEFAULT '',
            branch_name VARCHAR DEFAULT '',
            issue_date DATE NOT NULL,
            due_date DATE NOT NULL,
            status VARCHAR NOT NULL DEFAULT 'pending',
            note TEXT DEFAULT '',
            customer_entry_id INTEGER,
            reversal_entry_id INTEGER,
            created_at VARCHAR NOT NULL,
            updated_at VARCHAR NOT NULL,
            UNIQUE(direction, cheque_number),
            FOREIGN KEY(customer_id) REFERENCES customers(id)
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS treasury_cheque_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cheque_id INTEGER NOT NULL,
            from_status VARCHAR NOT NULL,
            to_status VARCHAR NOT NULL,
            event_date DATE NOT NULL,
            note TEXT DEFAULT '',
            voucher_id INTEGER,
            created_at VARCHAR NOT NULL,
            FOREIGN KEY(cheque_id) REFERENCES treasury_cheques(id)
        )
    """))
    from app.company_scope import ensure_company_id_column, migrate_treasury_cheques_composite_unique
    ensure_company_id_column(conn, "treasury_cheques")
    ensure_company_id_column(conn, "treasury_cheque_events")
    migrate_treasury_cheques_composite_unique(conn)

    # Phase 1 payment-workflow extension: links a cheque to the specific
    # invoice it was collected against (previously a cheque was only ever
    # linked to a customer, not a document), plus lifecycle-depth fields
    # (custody chain, replacement, physical images, Iran Sayad tracking id)
    # for the widened state machine below.
    cheque_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(treasury_cheques)")).fetchall()}
    for column_name, column_sql in {
        "invoice_id": "invoice_id INTEGER",
        "sayad_id": "sayad_id VARCHAR DEFAULT ''",
        "front_image_path": "front_image_path VARCHAR DEFAULT ''",
        "back_image_path": "back_image_path VARCHAR DEFAULT ''",
        "current_holder": "current_holder VARCHAR DEFAULT ''",
        "replaced_by_cheque_id": "replaced_by_cheque_id INTEGER",
    }.items():
        if column_name not in cheque_columns:
            conn.execute(text(f"ALTER TABLE treasury_cheques ADD COLUMN {column_sql}"))


def _cheque(conn, cheque_id, company_id):
    _ensure_schema(conn)
    row = conn.execute(text("""
        SELECT ch.*, c.name AS customer_name, c.customer_type
        FROM treasury_cheques ch
        JOIN customers c ON c.id=ch.customer_id
        WHERE ch.id=:id AND ch.company_id=:company_id
    """), {"id": cheque_id, "company_id": company_id}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Cheque not found")
    return dict(row)


def _customer_balance(conn, customer_id):
    value = conn.execute(text("""
        SELECT COALESCE(SUM(debit-credit),0)
        FROM accounting_entries WHERE customer_id=:id
    """), {"id": customer_id}).scalar() or 0
    return _money(value)


def _add_customer_entry(conn, cheque, source_type, description, company_id, debit=0, credit=0):
    before = _customer_balance(conn, cheque["customer_id"])
    after = _money(before + debit - credit)
    result = conn.execute(text("""
        INSERT INTO accounting_entries
          (customer_id, source_type, source_id, entry_type, description,
           debit, credit, balance_after, created_at, company_id)
        VALUES
          (:customer_id, :source_type, :source_id, :entry_type, :description,
           :debit, :credit, :balance_after, :created_at, :company_id)
    """), {
        "customer_id": cheque["customer_id"],
        "source_type": source_type,
        "source_id": cheque["id"],
        "entry_type": "debit" if debit >= credit else "credit",
        "description": description,
        "debit": _money(debit),
        "credit": _money(credit),
        "balance_after": after,
        # Naive, matching every other writer of the shared accounting_entries
        # table (e.g. app/database default=datetime.utcnow) - an aware
        # timestamp here breaks any later comparison against those naive
        # values (main.py's report builders sort/filter entries by created_at).
        "created_at": datetime.utcnow().isoformat(),
        "company_id": company_id,
    })
    return result.lastrowid


@router.get("/cheques")
def list_cheques(
    request: Request,
    direction: str = "all",
    status: str = "all",
    upcoming_days: int = Query(default=30, ge=0, le=365),
):
    today = date.today()
    upcoming = today + timedelta(days=upcoming_days)
    with engine.begin() as conn:
        _ensure_schema(conn)
        rows = conn.execute(text("""
            SELECT ch.*, c.name AS customer_name, c.customer_type
            FROM treasury_cheques ch
            JOIN customers c ON c.id=ch.customer_id
            WHERE (:direction='all' OR ch.direction=:direction)
              AND (:status='all' OR ch.status=:status)
              AND ch.company_id=:company_id
            ORDER BY ch.due_date, ch.id DESC
        """), {"direction": direction, "status": status, "company_id": current_company_id(request)}).mappings().all()
        items = []
        for row in rows:
            item = dict(row)
            due = date.fromisoformat(str(row["due_date"])[:10])
            item["amount"] = _money(row["amount"])
            item["days_to_due"] = (due - today).days
            item["overdue"] = row["status"] == "pending" and due < today
            item["due_soon"] = row["status"] == "pending" and today <= due <= upcoming
            items.append(item)
        pending = [item for item in items if item["status"] == "pending"]
        return {
            "summary": {
                "total_count": len(items),
                "pending_count": len(pending),
                "received_pending": _money(sum(item["amount"] for item in pending if item["direction"] == "received")),
                "payable_pending": _money(sum(item["amount"] for item in pending if item["direction"] == "payable")),
                "overdue_count": len([item for item in pending if item["overdue"]]),
                "due_soon_count": len([item for item in pending if item["due_soon"]]),
            },
            "items": items,
        }


@router.get("/cheques/{cheque_id}")
def cheque_detail(cheque_id: int, request: Request):
    with engine.begin() as conn:
        cheque = _cheque(conn, cheque_id, current_company_id(request))
        events = conn.execute(text("""
            SELECT * FROM treasury_cheque_events
            WHERE cheque_id=:id ORDER BY event_date, id
        """), {"id": cheque_id}).mappings().all()
        cheque["amount"] = _money(cheque["amount"])
        cheque["events"] = [dict(row) for row in events]
        return cheque


@router.post("/cheques")
def create_cheque(data: ChequeCreate, request: Request):
    company_id = current_company_id(request)
    direction = data.direction.strip().lower()
    if direction not in {"received", "payable"}:
        raise HTTPException(status_code=400, detail="direction must be received or payable")
    amount = _money(data.amount)
    number = data.cheque_number.strip()
    if amount <= 0 or not number:
        raise HTTPException(status_code=400, detail="Positive amount and cheque number are required")
    if data.due_date < data.issue_date:
        raise HTTPException(status_code=400, detail="Due date cannot precede issue date")
    try:
        with engine.begin() as conn:
            _ensure_schema(conn)
            customer = conn.execute(text("""
                SELECT id, name FROM customers WHERE id=:id AND company_id=:company_id
            """), {"id": data.customer_id, "company_id": company_id}).mappings().first()
            if not customer:
                raise HTTPException(status_code=404, detail="Party not found")
            now = datetime.now(timezone.utc).isoformat()
            result = conn.execute(text("""
                INSERT INTO treasury_cheques
                  (direction, customer_id, amount, cheque_number, bank_name,
                   branch_name, issue_date, due_date, status, note,
                   created_at, updated_at, company_id)
                VALUES
                  (:direction, :customer_id, :amount, :cheque_number, :bank_name,
                   :branch_name, :issue_date, :due_date, 'pending', :note,
                   :now, :now, :company_id)
            """), {
                "direction": direction, "customer_id": data.customer_id,
                "amount": amount, "cheque_number": number,
                "bank_name": data.bank_name.strip(), "branch_name": data.branch_name.strip(),
                "issue_date": data.issue_date.isoformat(), "due_date": data.due_date.isoformat(),
                "note": data.note.strip(), "now": now, "company_id": company_id,
            })
            cheque_id = result.lastrowid
            cheque = {
                "id": cheque_id, "customer_id": data.customer_id,
                "amount": amount, "direction": direction,
            }
            description = (
                f"دریافت چک شماره {number} از {customer['name']}"
                if direction == "received"
                else f"صدور چک شماره {number} برای {customer['name']}"
            )
            if direction == "received":
                lines = [
                    {"account_code": "1104", "debit": amount, "description": description},
                    {"account_code": "1103", "credit": amount, "description": description},
                ]
                entry_id = _add_customer_entry(
                    conn, cheque, "cheque_received", description, company_id, credit=amount
                )
            else:
                lines = [
                    {"account_code": "2101", "debit": amount, "description": description},
                    {"account_code": "2102", "credit": amount, "description": description},
                ]
                entry_id = _add_customer_entry(
                    conn, cheque, "cheque_payable", description, company_id, debit=amount
                )
            voucher_id = post_balanced_voucher(
                "cheque_registration", cheque_id, description, lines, company_id,
                voucher_date=data.issue_date.isoformat(), connection=conn,
            )
            conn.execute(text("""
                UPDATE treasury_cheques SET customer_entry_id=:entry_id WHERE id=:id
            """), {"entry_id": entry_id, "id": cheque_id})
            return {"status": "created", "id": cheque_id, "voucher_id": voucher_id}
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    except Exception as error:
        if "UNIQUE constraint failed" in str(error):
            raise HTTPException(status_code=409, detail="Cheque number already exists for this direction")
        raise


# Full cheque-lifecycle state machine (Phase 1 payment-workflow
# requirement: a cheque must not be treated as confirmed cash until it
# actually clears). Maps direction -> from_status -> {to_status: accounts},
# where accounts is (debit_account, credit_account) for a real GL posting,
# or None for a pure status/custody transition that records an event but
# moves no money (deposited/in_clearing/endorsed/transferred/lost/
# legal_follow_up/archived - these are validated, audited, and tracked via
# treasury_cheque_events, but only cleared/bounced/cancelled/replaced move
# actual ledger balances, since only those change what's collectible).
TRANSITIONS = {
    "received": {
        "pending": {
            "deposited": None, "in_clearing": None,
            "cleared": ("1102", "1104"), "bounced": ("1103", "1104"),
            "cancelled": ("1103", "1104"),
            "endorsed": None, "transferred": None, "lost": None,
        },
        "deposited": {
            "in_clearing": None,
            "cleared": ("1102", "1104"), "bounced": ("1103", "1104"),
            "lost": None,
        },
        "in_clearing": {
            "cleared": ("1102", "1104"), "bounced": ("1103", "1104"),
        },
        "bounced": {
            "replaced": None, "legal_follow_up": None, "archived": None,
        },
        "endorsed": {
            "transferred": None, "collected_by_third_party": None, "archived": None,
        },
        "transferred": {
            "collected_by_third_party": None, "archived": None,
        },
        "cleared": {"archived": None},
        "cancelled": {"archived": None},
    },
    "payable": {
        "pending": {
            "cleared": ("2102", "1102"), "cancelled": ("2102", "2101"),
        },
        "cleared": {"archived": None},
        "cancelled": {"archived": None},
    },
}

# Statuses that actually settle/unsettle money (post a GL voucher +
# customer-ledger reversal) - everything else in TRANSITIONS is a
# custody/pipeline status change only. "replaced" also reverses (the
# original cheque stops being collectible - a NEW cheque row carries the
# receivable forward via replaced_by_cheque_id, created by the caller).
SETTLING_STATUSES = {"cleared", "bounced", "cancelled", "replaced"}


def _transition_cheque(conn, cheque_id: int, target: str, event_date, note: str, company_id: int) -> dict:
    """Core of the cheque state-machine transition, taking an existing
    connection so callers already inside a transaction (e.g. the invoice-
    payment void executor below) can reuse it atomically. The HTTP route
    wraps this with its own `engine.begin()`."""
    cheque = _cheque(conn, cheque_id, company_id)
    current_status = cheque["status"]
    allowed = TRANSITIONS.get(cheque["direction"], {}).get(current_status, {})
    if target not in allowed:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot transition a {cheque['direction']} cheque from '{current_status}' to '{target}'",
        )
    accounts = allowed[target]
    amount = _money(cheque["amount"])
    event_date_str = event_date.isoformat() if hasattr(event_date, "isoformat") else str(event_date)
    description = f"{target}: cheque {cheque['cheque_number']} - {cheque['customer_name']}"
    result = conn.execute(text("""
        INSERT INTO treasury_cheque_events
          (cheque_id, from_status, to_status, event_date, note, created_at, company_id)
        VALUES
          (:cheque_id, :from_status, :target, :event_date, :note, :created_at, :company_id)
    """), {
        "cheque_id": cheque_id, "from_status": current_status, "target": target,
        "event_date": event_date_str, "note": (note or "").strip(),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "company_id": company_id,
    })
    event_id = result.lastrowid
    voucher_id = None
    reversal_id = cheque["reversal_entry_id"]
    if accounts:
        voucher_id = post_balanced_voucher(
            "cheque_event", event_id, description,
            [
                {"account_code": accounts[0], "debit": amount, "description": description},
                {"account_code": accounts[1], "credit": amount, "description": description},
            ],
            company_id,
            voucher_date=event_date_str, connection=conn,
        )
        conn.execute(text("""
            UPDATE treasury_cheque_events SET voucher_id=:voucher_id WHERE id=:id
        """), {"voucher_id": voucher_id, "id": event_id})
    if target in {"bounced", "cancelled", "replaced"}:
        if cheque["direction"] == "received":
            reversal_id = _add_customer_entry(
                conn, cheque, "cheque_reversal", description, company_id, debit=amount
            )
        else:
            reversal_id = _add_customer_entry(
                conn, cheque, "cheque_reversal", description, company_id, credit=amount
            )
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(text("""
        UPDATE treasury_cheques
        SET status=:status, reversal_entry_id=:reversal_id, updated_at=:now
        WHERE id=:id
    """), {
        "status": target, "reversal_id": reversal_id,
        "now": now, "id": cheque_id,
    })
    return {"status": target, "id": cheque_id, "event_id": event_id, "voucher_id": voucher_id}


@router.post("/cheques/{cheque_id}/transition")
def transition_cheque(cheque_id: int, data: ChequeTransition, request: Request):
    company_id = current_company_id(request)
    target = data.status.strip().lower()
    try:
        with engine.begin() as conn:
            return _transition_cheque(conn, cheque_id, target, data.event_date, data.note, company_id)
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))


def create_invoice_cheque_leg(conn, invoice, cheque_data: dict, company_id: int) -> dict:
    """Records a cheque collected as one leg of an invoice's payment at
    creation time (called from main.py's _create_invoice_impl, inside its
    existing transaction). Posts the same 1104/1103 (received) or
    2101/2102 (payable) entries as create_cheque() above, but:
      - sets invoice_id so the cheque is traceable back to its invoice
      - deliberately does NOT call _apply_settlement/create a "receipt"/
        "payment"-typed accounting_entries row, so invoice_settled_amount()
        (which only sums receipt/payment rows) never counts a still-pending
        cheque as confirmed cash - see invoice_settlement_breakdown() in
        app/invoice_payments.py for the separate "pending_cheque_amount".
    Returns {"cheque_id": ..., "entry_id": ...} for the caller to store on
    the new invoice_payment_allocations row.
    """
    _ensure_schema(conn)
    direction = "received" if cheque_data["transaction_type"] == "receipt" else "payable"
    amount = _money(cheque_data["amount"])
    number = (cheque_data.get("cheque_number") or "").strip()
    if amount <= 0 or not number:
        raise ValueError("A positive amount and cheque number are required for a cheque payment")
    now = datetime.now(timezone.utc).isoformat()
    result = conn.execute(text("""
        INSERT INTO treasury_cheques
          (direction, customer_id, amount, cheque_number, bank_name, branch_name,
           issue_date, due_date, status, note, invoice_id, sayad_id,
           created_at, updated_at, company_id)
        VALUES
          (:direction, :customer_id, :amount, :cheque_number, :bank_name, :branch_name,
           :issue_date, :due_date, 'pending', :note, :invoice_id, :sayad_id,
           :now, :now, :company_id)
    """), {
        "direction": direction, "customer_id": invoice.customer_id, "amount": amount,
        "cheque_number": number, "bank_name": (cheque_data.get("bank_name") or "").strip(),
        "branch_name": (cheque_data.get("branch_name") or "").strip(),
        "issue_date": cheque_data.get("issue_date") or now[:10],
        "due_date": cheque_data.get("due_date") or now[:10],
        "note": (cheque_data.get("note") or "").strip(),
        "invoice_id": invoice.id, "sayad_id": (cheque_data.get("sayad_id") or "").strip(),
        "now": now, "company_id": company_id,
    })
    cheque_id = result.lastrowid
    cheque = {"id": cheque_id, "customer_id": invoice.customer_id, "amount": amount}
    description = f"چک بابت فاکتور شماره {invoice.id} - {cheque_data['transaction_type']}"
    if direction == "received":
        lines = [
            {"account_code": "1104", "debit": amount, "description": description},
            {"account_code": "1103", "credit": amount, "description": description},
        ]
        entry_id = _add_customer_entry(conn, cheque, "cheque_received", description, company_id, credit=amount)
    else:
        lines = [
            {"account_code": "2101", "debit": amount, "description": description},
            {"account_code": "2102", "credit": amount, "description": description},
        ]
        entry_id = _add_customer_entry(conn, cheque, "cheque_payable", description, company_id, debit=amount)
    post_balanced_voucher(
        "cheque_registration", cheque_id, description, lines, company_id,
        voucher_date=cheque_data.get("issue_date") or now[:10], connection=conn,
    )
    conn.execute(text("UPDATE treasury_cheques SET customer_entry_id=:entry_id WHERE id=:id"), {"entry_id": entry_id, "id": cheque_id})
    return {"cheque_id": cheque_id, "entry_id": entry_id}


def pending_cheque_amount_for_invoice(conn, invoice_id: int) -> float:
    value = conn.execute(text("""
        SELECT COALESCE(SUM(amount), 0) FROM treasury_cheques
        WHERE invoice_id=:invoice_id AND status='pending'
    """), {"invoice_id": invoice_id}).scalar() or 0
    return _money(value)


@router.delete("/cheques/{cheque_id}")
def delete_pending_cheque(cheque_id: int, request: Request):
    company_id = current_company_id(request)
    try:
        with engine.begin() as conn:
            cheque = _cheque(conn, cheque_id, company_id)
            if cheque["status"] != "pending":
                raise HTTPException(status_code=409, detail="Only pending cheques can be deleted")
            delete_source_voucher("cheque_registration", cheque_id, company_id, connection=conn)
            if cheque["customer_entry_id"]:
                conn.execute(text("""
                    DELETE FROM accounting_entries WHERE id=:id
                """), {"id": cheque["customer_entry_id"]})
            conn.execute(text("DELETE FROM treasury_cheques WHERE id=:id"), {"id": cheque_id})
            return {"status": "deleted", "id": cheque_id}
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))


# PARASAY migration staging is intentionally separate from operational treasury:
# no GL vouchers, no customer entries, and no fake customer for unknown parties.
def _ensure_parasay_opening_cheques(conn):
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS parasay_opening_cheques (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            source_check_id INTEGER NOT NULL,
            cheque_number TEXT NOT NULL,
            due_date_jalali TEXT NOT NULL,
            amount_irr TEXT NOT NULL,
            direction TEXT NOT NULL,
            original_state TEXT NOT NULL,
            bank_name_original TEXT,
            source_party_id TEXT,
            party_name_original TEXT,
            source_bank_id TEXT,
            mapping_status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(company_id, source_check_id)
        )
    """))


def _opening_company(conn, request):
    company_id = current_company_id(request)
    company = conn.execute(text(
        "SELECT name FROM companies WHERE id=:id AND is_active=1"
    ), {"id": company_id}).mappings().first()
    if not company or "هایپر" not in (company["name"] or ""):
        raise HTTPException(status_code=403, detail="PARASAY opening only for Hyper Doctor")
    return company_id


def _validate_parasay_cheques(raw):
    try:
        body = raw.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(body))
        expected = {"source_check_id", "cheque_number", "due_date_jalali",
                    "amount_irr", "direction", "original_state",
                    "source_party_id", "mapping_status", "migration_cutoff"}
        if not expected.issubset(reader.fieldnames or []):
            raise ValueError("Wrong PARASAY staging CSV columns")
        rows = list(reader)
        if len(rows) != 28:
            raise ValueError("Expected exactly 28 opening cheques")
        if len({r["source_check_id"] for r in rows}) != 28:
            raise ValueError("Duplicate source CheckID")
        totals = {"received": Decimal(0), "payable": Decimal(0)}
        counts = {"received": 0, "payable": 0}
        for row in rows:
            direction = row["direction"]
            if direction not in totals:
                raise ValueError("Unexpected direction")
            if row["migration_cutoff"] != "1405/07/29":
                raise ValueError("Wrong cutoff")
            if not row["source_check_id"].isdigit() or not row["cheque_number"]:
                raise ValueError("Invalid source cheque identity")
            amount = Decimal(row["amount_irr"])
            if not amount.is_finite() or amount <= 0 or amount != amount.quantize(Decimal("0.01")):
                raise ValueError("Invalid amount")
            if not row["due_date_jalali"].startswith("1405/"):
                raise ValueError("Unexpected Jalali due date")
            counts[direction] += 1
            totals[direction] += amount
            row["mapping_status"] = (
                "PARTY_UNKNOWN" if row["source_party_id"] in ("", "-1")
                else "VERIFY_PARTY_MAPPING"
            )
        if (counts != {"received": 10, "payable": 18}
                or totals["received"] != Decimal("3509040000")
                or totals["payable"] != Decimal("26415000000")):
            raise ValueError("PARASAY 28-cheque reconciliation controls failed")
        return rows, counts, totals
    except (UnicodeError, csv.Error, ValueError, ArithmeticError, KeyError) as error:
        raise HTTPException(status_code=422, detail=str(error))


@router.post("/parasay-opening-cheques/preview")
async def preview_parasay_opening_cheques(request: Request, file: UploadFile = File(...)):
    contents = await file.read()
    if len(contents) > 1_000_000:
        raise HTTPException(status_code=413, detail="Opening file too large")
    with engine.begin() as conn:
        company_id = _opening_company(conn, request)
        _ensure_parasay_opening_cheques(conn)
        existing = conn.execute(text(
            "SELECT COUNT(*) FROM parasay_opening_cheques WHERE company_id=:company"
        ), {"company": company_id}).scalar()
    rows, counts, totals = _validate_parasay_cheques(contents)
    return {"company_id": company_id, "count": len(rows),
            "received_count": counts["received"], "payable_count": counts["payable"],
            "received_irr": str(totals["received"]), "payable_irr": str(totals["payable"]),
            "unknown_party_count": sum(r["mapping_status"] == "PARTY_UNKNOWN" for r in rows),
            "already_staged": existing, "can_apply": existing == 0,
            "note": "Staging only: no customer balance or ledger posts."}


@router.post("/parasay-opening-cheques/apply")
async def apply_parasay_opening_cheques(request: Request, file: UploadFile = File(...), confirm: str = ""):
    if confirm != "STAGE_PARASAY_28_NO_GL":
        raise HTTPException(status_code=400, detail="Explicit staging confirmation required")
    raw = await file.read()
    if len(raw) > 1_000_000:
        raise HTTPException(status_code=413, detail="Opening file too large")
    rows, counts, totals = _validate_parasay_cheques(raw)
    with engine.begin() as conn:
        company_id = _opening_company(conn, request)
        _ensure_parasay_opening_cheques(conn)
        existing = conn.execute(text(
            "SELECT COUNT(*) FROM parasay_opening_cheques WHERE company_id=:company"
        ), {"company": company_id}).scalar()
        if existing:
            raise HTTPException(status_code=409, detail="PARASAY cheque batch already staged")
        now = datetime.now(timezone.utc).isoformat()
        for row in rows:
            conn.execute(text("""
                INSERT INTO parasay_opening_cheques
                    (company_id, source_check_id, cheque_number, due_date_jalali,
                     amount_irr, direction, original_state, bank_name_original,
                     source_party_id, party_name_original, source_bank_id,
                     mapping_status, created_at)
                VALUES (:company, :id, :number, :due, :amount, :direction, :state,
                        :bank, :party, :partyname, :bankid, :mapping, :created)
            """), {"company": company_id, "id": int(row["source_check_id"]),
                   "number": row["cheque_number"], "due": row["due_date_jalali"],
                   "amount": row["amount_irr"], "direction": row["direction"],
                   "state": row["original_state"], "bank": row.get("bank_name_original", ""),
                   "party": row["source_party_id"], "partyname": row.get("party_name_original", ""),
                   "bankid": row.get("source_bank_id", ""), "mapping": row["mapping_status"],
                   "created": now})
    return {"status": "staged", "inserted": 28, "no_gl_posting": True,
            "received_irr": str(totals["received"]), "payable_irr": str(totals["payable"])}


@router.get("/parasay-opening-cheques")
def list_parasay_opening_cheques(request: Request):
    with engine.begin() as conn:
        company_id = _opening_company(conn, request)
        _ensure_parasay_opening_cheques(conn)
        rows = conn.execute(text("""
            SELECT source_check_id, cheque_number, due_date_jalali, amount_irr,
                   direction, original_state, bank_name_original, source_party_id,
                   party_name_original, mapping_status
            FROM parasay_opening_cheques
            WHERE company_id=:company ORDER BY due_date_jalali, source_check_id
        """), {"company": company_id}).mappings().all()
    return {"items": [dict(r) for r in rows], "no_gl_posting": True}
