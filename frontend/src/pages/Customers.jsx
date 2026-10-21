import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStableCallback } from "../hooks/useStableCallback";
import { useDebounce } from "../hooks/useDebounce";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  Search,
  Edit3,
  Save,
  X,
  Trash2,
  Eye,
  Building2,
  Wallet,
  RefreshCcw,
  AlertTriangle,
  Crown,
  PhoneCall,
  CalendarClock,
  ShieldCheck,
  Activity,
  Download,
  FileText,
  FileSpreadsheet,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  LocateFixed,
  UsersRound,
} from "lucide-react";

import { useLanguage } from "../localization/useLanguage";
import {
  getCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  resetAccountingData,
  getSalesReps,
  exportCustomersListPdf,
  exportCustomersListExcel,
  isNetworkError,
  getCustomerConsentHistory,
} from "../services/api";
import { translateApiError } from "../localization/apiErrors";
import { useAuth } from "../auth/AuthContext";

import { getCache, setCache } from "../storage/db";
import { countPending, syncPendingRecords, useOnlineSync } from "../storage/offlineSync";
import { toPersianDigits, toEnglishDigits } from "../localization/helpers";
import { toNumber, crmScore, crmRank, crmStatus, crmTags, followupSuggestion } from "../utils/crmHeuristics";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Notice from "../components/ui/Notice";
import MoneyDisplay from "../components/ui/MoneyDisplay";
import { Input } from "../components/ui/Field";
import { Table, Thead, Tbody, Tr, Th, Td, EmptyRow, SortableTh } from "../components/ui/Table";
import Select from "../components/ui/Select";
import Modal from "../components/ui/Modal";
import Tooltip from "../components/ui/Tooltip";
import PageHeader from "../components/ui/PageHeader";
import { confirmAction } from "../components/ui/confirmService";
import toast from "react-hot-toast";

const CUSTOMERS_CACHE_KEY = "customers";
const PAGE_SIZES = [25, 50, 100];

const emptyForm = {
  name: "",
  phone: "",
  mobile: "",
  telegram_chat_id: "",
  latitude: "",
  longitude: "",
  email: "",
  national_id: "",
  economic_code: "",
  city: "",
  address: "",
  contact_person: "",
  party_type: "customer",
  opening_balance: "",
  credit_limit: "",
  notes: "",
  pricing_group: "retail",
  assigned_rep_id: "",
  marketing_consent: true,
};

function faText(value, fa) {
  if (value === null || value === undefined) return "";
  return fa ? toPersianDigits(value) : String(value);
}

function normalizeNumberInput(value, fa) {
  const cleaned = toEnglishDigits(String(value || ""))
    .replace(/[,،]/g, "")
    .replace(/[^\d.-]/g, "");
  return fa ? toPersianDigits(cleaned) : cleaned;
}

function normalizeParty(item = {}) {
  const balance = toNumber(item.balance);
  return {
    ...emptyForm,
    ...item,
    party_type: item.party_type || item.customer_type || "customer",
    customer_type: item.customer_type || item.party_type || "customer",
    opening_balance: toNumber(item.opening_balance),
    credit_limit: toNumber(item.credit_limit),
    balance,
    debtor: toNumber(item.debit ?? item.debtor ?? (balance > 0 ? balance : 0)),
    creditor: toNumber(item.credit ?? item.creditor ?? (balance < 0 ? Math.abs(balance) : 0)),
  };
}

function balanceLabel(balance, language) {
  if (balance > 0) return language === "fa" ? "بدهکار" : language === "ar" ? "مدين" : language === "tr" ? "Borçlu" : "Debtor";
  if (balance < 0) return language === "fa" ? "بستانکار" : language === "ar" ? "دائن" : language === "tr" ? "Alacaklı" : "Creditor";
  return language === "fa" ? "تسویه" : language === "ar" ? "مسدد" : language === "tr" ? "Kapandı" : "Settled";
}

const DEFAULT_FILTERS = {
  q: "",
  type: "all",
  crm: "all",
  bal: "all",
  balMin: "",
  balMax: "",
  phoneHas: "all",
  city: "all",
  sort: "score",
  dir: "desc",
  page: "1",
  size: "25",
};

function readFilters(searchParams) {
  const result = { ...DEFAULT_FILTERS };
  for (const key of Object.keys(DEFAULT_FILTERS)) {
    const value = searchParams.get(key);
    if (value !== null && value !== "") result[key] = value;
  }
  return result;
}

export default function Customers() {
  const { t, language, n, money, dir, locale } = useLanguage();
  const fa = language === "fa";
  const ar = language === "ar";
  const tr = language === "tr";
  const { user } = useAuth();
  const navigate = useNavigate();

  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readFilters(searchParams);
  const [searchInput, setSearchInput] = useState(filters.q);
  const debouncedSearch = useDebounce(searchInput, 300);

  function patchFilters(patch, { resetPage = true } = {}) {
    const next = { ...readFilters(searchParams), ...patch };
    if (resetPage) next.page = "1";
    const params = new URLSearchParams();
    for (const key of Object.keys(DEFAULT_FILTERS)) {
      if (next[key] !== DEFAULT_FILTERS[key]) params.set(key, next[key]);
    }
    setSearchParams(params, { replace: false });
  }

  useEffect(() => {
    if (debouncedSearch !== filters.q) patchFilters({ q: debouncedSearch });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const [parties, setParties] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [consentHistoryOpen, setConsentHistoryOpen] = useState(false);
  const [consentHistory, setConsentHistory] = useState([]);
  const [consentHistoryLoading, setConsentHistoryLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [offlineMode, setOfflineMode] = useState(false);
  const [salesReps, setSalesReps] = useState([]);
  const [myOnly, setMyOnly] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportAllScope, setExportAllScope] = useState(false);
  const tableTopRef = useRef(null);
  const exportMenuRef = useRef(null);

  async function saveCache(items) {
    const normalized = Array.isArray(items) ? items.map(normalizeParty) : [];
    await setCache(CUSTOMERS_CACHE_KEY, normalized);
    setParties(normalized);
  }

  async function load() {
    setLoading(true);
    setMessage("");
    setOfflineMode(false);

    try {
      const serverParties = await getCustomers(myOnly && user ? user.id : undefined);
      const normalized = Array.isArray(serverParties)
        ? serverParties.map(normalizeParty)
        : [];

      await saveCache(normalized);
    } catch (error) {
      console.error("Customers loading error:", error);

      const cached = await getCache(CUSTOMERS_CACHE_KEY);

      if (Array.isArray(cached)) {
        setParties(cached.map(normalizeParty));
        setOfflineMode(true);
        setMessage(
          fa
            ? "اتصال به سرور برقرار نشد؛ طرف‌حساب‌ها از حافظه آفلاین نمایش داده شدند."
            : language === "ar"
            ? "تعذّر الاتصال بالخادم؛ تم عرض الأطراف من الذاكرة المؤقتة غير المتصلة."
            : language === "tr"
            ? "Sunucuya bağlanılamadı; cariler çevrimdışı önbellekten yüklendi."
            : "Server unavailable; parties loaded from offline cache."
        );
      } else {
        setMessage(
          fa
            ? "خطا در دریافت طرف‌حساب‌ها از سرور و کش آفلاین موجود نیست"
            : language === "ar"
            ? "خطأ في جلب الأطراف من الخادم ولا توجد ذاكرة مؤقتة غير متصلة"
            : language === "tr"
            ? "Cariler sunucudan alınamadı ve çevrimdışı önbellek bulunamadı"
            : "Error loading parties and no offline cache found"
        );
      }
    } finally {
      setLoading(false);
    }
  }

  const stableLoad = useStableCallback(load);

  // Always refetches on mount/language/myOnly change - this is the primary
  // source of truth (the IndexedDB cache is only ever read as an
  // error-fallback inside load()'s catch block above), so records added via
  // the Data Import Center are visible here on the very next visit/refresh
  // without any extra cache-invalidation wiring.
  useEffect(() => {
    const timer = setTimeout(() => { void stableLoad(); }, 0);
    return () => clearTimeout(timer);
  }, [language, stableLoad, myOnly]);

  useEffect(() => {
    const timer = setTimeout(() => {
      getSalesReps().then((rows) => setSalesReps(Array.isArray(rows) ? rows : [])).catch(() => setSalesReps([]));
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    function onDocClick(event) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target)) setExportMenuOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setExportMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  function partyTypeLabel(type) {
    const map = {
      customer: t("customerParty"),
      supplier: t("supplierParty"),
      partner: t("partnerParty"),
      staff: t("staffParty"),
      company: t("companyParty"),
      doctor: t("doctorParty"),
      other: t("otherParty"),
      regular: t("customerParty"),
      vip: "VIP",
    };
    return map[type] || "-";
  }

  const balanceOf = useCallback((item) => toNumber(item.balance), []);
  const debtorOf = useCallback((item) => Math.max(balanceOf(item), 0), [balanceOf]);
  const creditorOf = useCallback((item) => Math.max(-balanceOf(item), 0), [balanceOf]);

  const summary = useMemo(() => {
    return parties.reduce(
      (acc, item) => {
        acc.totalDebtor += debtorOf(item);
        acc.totalCreditor += creditorOf(item);
        acc.totalBalance += balanceOf(item);
        const score = crmScore(item);
        const status = crmStatus(item, language);
        if (score >= 85) acc.vipCount += 1;
        if (status.key === "over_limit" || status.key === "debtor") acc.followupCount += 1;
        if (status.key === "over_limit") acc.riskCount += 1;
        acc.scoreSum += score;
        return acc;
      },
      { totalDebtor: 0, totalCreditor: 0, totalBalance: 0, vipCount: 0, followupCount: 0, riskCount: 0, scoreSum: 0 }
    );
  }, [parties, language, balanceOf, debtorOf, creditorOf]);

  const cityOptions = useMemo(() => {
    const set = new Set();
    for (const item of parties) if (item.city) set.add(item.city);
    return [...set].sort((a, b) => a.localeCompare(b, locale));
  }, [parties, locale]);

  function scrollToTable() {
    tableTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function applyCardFilter(patch) {
    patchFilters(patch);
    scrollToTable();
  }

  const matched = useMemo(() => {
    const keyword = toEnglishDigits(filters.q).toLowerCase().trim();
    const balMin = filters.balMin ? toNumber(filters.balMin) : null;
    const balMax = filters.balMax ? toNumber(filters.balMax) : null;

    return parties.filter((item) => {
      const score = crmScore(item);
      const rank = crmRank(score);
      const status = crmStatus(item, language);
      const tags = crmTags(item, language).join(" ");
      const balance = balanceOf(item);
      const absBalance = Math.abs(balance);

      const matchesText = !keyword || [
        item.name,
        item.phone,
        item.mobile,
        item.email,
        item.address,
        item.city,
        item.national_id,
        item.economic_code,
        item.contact_person,
        item.notes,
        rank.key,
        status.label,
        tags,
      ]
        .join(" ")
        .toLowerCase()
        .includes(keyword);

      const matchesType = filters.type === "all" || item.party_type === filters.type || item.customer_type === filters.type;

      const matchesCrm =
        filters.crm === "all" ||
        (filters.crm === "vip" && score >= 85) ||
        (filters.crm === "followup" && ["debtor", "over_limit"].includes(status.key)) ||
        (filters.crm === "risk" && status.key === "over_limit") ||
        (filters.crm === "settled" && status.key === "healthy");

      const matchesBalanceKind =
        filters.bal === "all" ||
        (filters.bal === "debtor" && balance > 0) ||
        (filters.bal === "creditor" && balance < 0) ||
        (filters.bal === "zero" && balance === 0) ||
        (filters.bal === "has_balance" && balance !== 0);

      const matchesBalanceRange =
        (balMin === null || absBalance >= balMin) && (balMax === null || absBalance <= balMax);

      const matchesPhone =
        filters.phoneHas === "all" ||
        (filters.phoneHas === "yes" && Boolean(item.phone || item.mobile)) ||
        (filters.phoneHas === "no" && !item.phone && !item.mobile);

      const matchesCity = filters.city === "all" || item.city === filters.city;

      return matchesText && matchesType && matchesCrm && matchesBalanceKind && matchesBalanceRange && matchesPhone && matchesCity;
    });
  }, [parties, filters.q, filters.type, filters.crm, filters.bal, filters.balMin, filters.balMax, filters.phoneHas, filters.city, language, balanceOf]);

  const collator = useMemo(() => new Intl.Collator(locale, { sensitivity: "base", numeric: true }), [locale]);

  const filtered = useMemo(() => {
    const list = [...matched];
    const dirMul = filters.dir === "asc" ? 1 : -1;
    const field = filters.sort;

    const comparators = {
      name: (a, b) => collator.compare(String(a.name || ""), String(b.name || "")),
      type: (a, b) => collator.compare(partyTypeLabel(a.party_type || a.customer_type), partyTypeLabel(b.party_type || b.customer_type)),
      phone: (a, b) => collator.compare(String(a.phone || a.mobile || ""), String(b.phone || b.mobile || "")),
      debtor: (a, b) => debtorOf(a) - debtorOf(b),
      creditor: (a, b) => creditorOf(a) - creditorOf(b),
      balance: (a, b) => balanceOf(a) - balanceOf(b),
      score: (a, b) => crmScore(a) - crmScore(b),
      status: (a, b) => collator.compare(crmStatus(a, language).label, crmStatus(b, language).label),
      created_at: (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime(),
    };

    const cmp = comparators[field] || comparators.score;
    list.sort((a, b) => dirMul * cmp(a, b));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matched, filters.sort, filters.dir, collator, language, debtorOf, creditorOf, balanceOf]);

  const pageSize = Math.max(1, Number(filters.size) || 25);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(1, Number(filters.page) || 1), pageCount);
  const pageStart = (page - 1) * pageSize;
  const paged = useMemo(() => filtered.slice(pageStart, pageStart + pageSize), [filtered, pageStart, pageSize]);

  function setSort(field, sortDir) {
    if (!field) return patchFilters({ sort: DEFAULT_FILTERS.sort, dir: DEFAULT_FILTERS.dir }, { resetPage: false });
    patchFilters({ sort: field, dir: sortDir }, { resetPage: false });
  }

  function setPage(nextPage) {
    patchFilters({ page: String(Math.min(Math.max(1, nextPage), pageCount)) }, { resetPage: false });
  }

  const activeChips = useMemo(() => {
    const chips = [];
    if (filters.q) chips.push({ key: "q", label: `${fa ? "جستجو" : ar ? "بحث" : tr ? "Arama" : "Search"}: ${filters.q}` });
    if (filters.type !== "all") chips.push({ key: "type", label: partyTypeLabel(filters.type) });
    if (filters.crm !== "all") {
      const crmLabels = {
        vip: "VIP",
        followup: fa ? "نیازمند پیگیری" : ar ? "بحاجة إلى متابعة" : tr ? "Takip gerekiyor" : "Needs follow-up",
        risk: fa ? "ریسک اعتباری" : ar ? "مخاطر ائتمانية" : tr ? "Kredi riski" : "Credit risk",
        settled: fa ? "تسویه" : ar ? "مسدد" : tr ? "Kapandı" : "Settled",
      };
      chips.push({ key: "crm", label: crmLabels[filters.crm] });
    }
    if (filters.bal !== "all") {
      const balLabels = {
        debtor: fa ? "فقط بدهکار" : ar ? "مدين فقط" : tr ? "Sadece borçlu" : "Debtors only",
        creditor: fa ? "فقط بستانکار" : ar ? "دائن فقط" : tr ? "Sadece alacaklı" : "Creditors only",
        zero: fa ? "بی‌حساب" : ar ? "بدون رصيد" : tr ? "Bakiyesiz" : "Zero balance",
        has_balance: fa ? "دارای مانده" : ar ? "لديه رصيد" : tr ? "Bakiyesi olan" : "Has balance",
      };
      chips.push({ key: "bal", label: balLabels[filters.bal] });
    }
    if (filters.balMin) chips.push({ key: "balMin", label: `${fa ? "حداقل" : ar ? "الحد الأدنى" : tr ? "En az" : "Min"}: ${money(toNumber(filters.balMin))}` });
    if (filters.balMax) chips.push({ key: "balMax", label: `${fa ? "حداکثر" : ar ? "الحد الأقصى" : tr ? "En çok" : "Max"}: ${money(toNumber(filters.balMax))}` });
    if (filters.phoneHas !== "all") chips.push({ key: "phoneHas", label: filters.phoneHas === "yes" ? (fa ? "دارای شماره تماس" : ar ? "لديه رقم" : tr ? "Numarası var" : "Has phone") : (fa ? "بدون شماره تماس" : ar ? "بلا رقم" : tr ? "Numarası yok" : "No phone") });
    if (filters.city !== "all") chips.push({ key: "city", label: filters.city });
    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.q, filters.type, filters.crm, filters.bal, filters.balMin, filters.balMax, filters.phoneHas, filters.city, language]);

  function removeChip(key) {
    if (key === "q") setSearchInput("");
    patchFilters({ [key]: DEFAULT_FILTERS[key] });
  }

  function clearAllFilters() {
    setSearchInput("");
    setSearchParams(new URLSearchParams());
  }

  function payloadFromForm() {
    return {
      name: form.name.trim(),
      phone: toEnglishDigits(form.phone || form.mobile || ""),
      mobile: toEnglishDigits(form.mobile || ""),
      telegram_chat_id: toEnglishDigits((form.telegram_chat_id || "").trim()),
      latitude: form.latitude === "" || form.latitude === null || form.latitude === undefined ? null : toNumber(form.latitude),
      longitude: form.longitude === "" || form.longitude === null || form.longitude === undefined ? null : toNumber(form.longitude),
      email: form.email || "",
      address: form.address || "",
      city: form.city || "",
      national_id: toEnglishDigits(form.national_id || ""),
      economic_code: toEnglishDigits(form.economic_code || ""),
      contact_person: form.contact_person || "",
      customer_type: form.party_type || "customer",
      party_type: form.party_type || "customer",
      opening_balance: toNumber(form.opening_balance),
      credit_limit: toNumber(form.credit_limit),
      notes: form.notes || "",
      pricing_group: form.pricing_group || "retail",
      assigned_rep_id: form.assigned_rep_id ? Number(form.assigned_rep_id) : null,
      marketing_consent: form.marketing_consent !== false,
    };
  }

  async function save() {
    if (!form.name.trim()) {
      toast.error(fa ? "نام طرف‌حساب را وارد کن" : language === "ar" ? "أدخل اسم الطرف" : language === "tr" ? "Cari adını girin" : "Enter party name");
      return;
    }

    const payload = payloadFromForm();

    try {
      if (editingId) {
        await updateCustomer(editingId, payload);
      } else {
        await createCustomer(payload);
      }

      setEditingId(null);
      setForm(emptyForm);
      await load();
    } catch (error) {
      console.error("Save customer error:", error);

      // The server was reached and rejected the request (RBAC, validation,
      // duplicate, ...) - retrying later would fail identically, so this
      // must NOT be queued offline. Surface the real reason immediately;
      // the form is left as-is so the user can fix it and resubmit.
      if (!isNetworkError(error)) {
        toast.error(translateApiError(error.message, language) || (fa ? "خطا در ذخیره طرف‌حساب" : language === "ar" ? "خطأ في حفظ الطرف" : language === "tr" ? "Cari kaydedilirken hata oluştu" : "Error saving party"));
        return;
      }

      const current = Array.isArray(parties) ? [...parties] : [];

      if (editingId) {
        const updated = current.map((item) =>
          String(item.id) === String(editingId)
            ? normalizeParty({
                ...item,
                ...payload,
                id: item.id,
                pending_sync: true,
                offline_updated_at: new Date().toISOString(),
              })
            : item
        );

        await saveCache(updated);
      } else {
        const offlineItem = normalizeParty({
          ...payload,
          id: Date.now(),
          balance: toNumber(payload.opening_balance),
          created_at: new Date().toISOString(),
          pending_sync: true,
          offline_created: true,
        });

        await saveCache([offlineItem, ...current]);
      }

      setOfflineMode(true);
      setMessage(
        fa
          ? "سرور در دسترس نبود؛ تغییرات طرف‌حساب در حافظه آفلاین ذخیره شد."
          : language === "ar"
          ? "تعذّر الوصول إلى الخادم؛ تم حفظ تغييرات الطرف في وضع عدم الاتصال."
          : language === "tr"
          ? "Sunucuya ulaşılamadı; cari değişiklikleri çevrimdışı kaydedildi."
          : "Server unavailable; party changes saved offline."
      );

      setEditingId(null);
      setForm(emptyForm);
    }
  }

  function extractCustomerPayload(item) {
    return {
      name: item.name || "",
      phone: toEnglishDigits(item.phone || item.mobile || ""),
      mobile: toEnglishDigits(item.mobile || ""),
      email: item.email || "",
      address: item.address || "",
      city: item.city || "",
      national_id: toEnglishDigits(item.national_id || ""),
      economic_code: toEnglishDigits(item.economic_code || ""),
      contact_person: item.contact_person || "",
      customer_type: item.party_type || item.customer_type || "customer",
      party_type: item.party_type || item.customer_type || "customer",
      opening_balance: toNumber(item.opening_balance),
      credit_limit: toNumber(item.credit_limit),
      notes: item.notes || "",
      pricing_group: item.pricing_group || "retail",
      marketing_consent: item.marketing_consent !== false,
      marketing_consent_source: item.marketing_consent_source || "default",
      marketing_consent_recorded_at: item.marketing_consent_recorded_at || null,
    };
  }

  function mergeCustomerResult(item, serverResult, payload) {
    return normalizeParty({
      ...item,
      ...payload,
      id: item.offline_created ? serverResult.id : item.id,
      pending_sync: false,
      offline_created: false,
    });
  }

  async function createCustomerForSync(payload) {
    const result = await createCustomer(payload);
    if (result?.status !== "created") throw new Error(result?.message || "sync failed");
    return result;
  }

  async function updateCustomerForSync(id, payload) {
    const result = await updateCustomer(id, payload);
    if (result?.status === "error") throw new Error(result.message);
    return result;
  }

  async function syncPendingParties() {
    if (countPending(parties) === 0) return;
    const { items: updated, syncedCount } = await syncPendingRecords(parties, {
      extractPayload: extractCustomerPayload,
      create: createCustomerForSync,
      update: updateCustomerForSync,
      mergeResult: mergeCustomerResult,
    });
    await saveCache(updated);
    if (syncedCount > 0) {
      setMessage(
        fa
          ? `${toPersianDigits(syncedCount)} طرف‌حساب آفلاین همگام‌سازی شد.`
          : language === "ar"
          ? `تمت مزامنة ${syncedCount} من سجلات العملاء غير المتصلة.`
          : language === "tr"
          ? `${syncedCount} çevrimdışı cari kaydı senkronize edildi.`
          : `${syncedCount} offline customer record(s) synced.`
      );
    }
  }

  useOnlineSync(syncPendingParties);

  function edit(item) {
    setEditingId(item.id);
    setForm({
      ...emptyForm,
      ...item,
      party_type: item.party_type || item.customer_type || "customer",
      phone: faText(item.phone || "", fa),
      mobile: faText(item.mobile || "", fa),
      telegram_chat_id: faText(item.telegram_chat_id || "", fa),
      latitude: item.latitude === null || item.latitude === undefined || item.latitude === "" ? "" : faText(String(item.latitude), fa),
      longitude: item.longitude === null || item.longitude === undefined || item.longitude === "" ? "" : faText(String(item.longitude), fa),
      national_id: faText(item.national_id || "", fa),
      economic_code: faText(item.economic_code || "", fa),
      opening_balance:
        toNumber(item.opening_balance) === 0
          ? ""
          : faText(String(item.opening_balance), fa),
      credit_limit:
        toNumber(item.credit_limit) === 0
          ? ""
          : faText(String(item.credit_limit), fa),
    });
  }

  async function remove(id) {
    const ok = await confirmAction(
      fa
        ? "آیا از حذف این طرف‌حساب مطمئنی؟"
        : "Are you sure you want to delete this party?",
      { danger: true }
    );
    if (!ok) return;

    try {
      await deleteCustomer(id);

      if (String(editingId) === String(id)) {
        setEditingId(null);
        setForm(emptyForm);
      }

      await load();
    } catch (error) {
      console.error("Delete customer error:", error);

      // The server was reached and rejected the delete (linked invoices,
      // RBAC, ...) - hiding the party locally while claiming it was
      // "removed from offline cache" would be misleading since it still
      // exists on the server. Only a genuine connectivity failure should
      // fall back to a local-only removal.
      if (!isNetworkError(error)) {
        toast.error(translateApiError(error.message, language) || (fa ? "خطا در حذف طرف‌حساب" : language === "ar" ? "خطأ في حذف الطرف" : language === "tr" ? "Cari silinirken hata oluştu" : "Error deleting party"));
        return;
      }

      const filteredItems = parties.filter((item) => String(item.id) !== String(id));
      await saveCache(filteredItems);

      if (String(editingId) === String(id)) {
        setEditingId(null);
        setForm(emptyForm);
      }

      setOfflineMode(true);
      setMessage(
        fa
          ? "سرور در دسترس نبود؛ طرف‌حساب فقط از حافظه آفلاین حذف شد."
          : "Server unavailable; party removed from offline cache only."
      );
    }
  }

  async function resetAllAccounting() {
    const ok = await confirmAction(
      fa
        ? "همه طرف‌حساب‌ها، فاکتورها، دریافت‌ها و پرداخت‌ها حذف شوند؟ این کار برگشت ندارد."
        : "Delete all parties, invoices, receipts and payments? This cannot be undone.",
      { danger: true }
    );
    if (!ok) return;

    try {
      await resetAccountingData();
      await saveCache([]);
      setEditingId(null);
      setForm(emptyForm);
      toast.success(fa ? "اطلاعات حسابداری پاک شد" : language === "ar" ? "تم مسح البيانات المحاسبية" : language === "tr" ? "Muhasebe verileri temizlendi" : "Accounting data cleared");
    } catch (error) {
      toast.error(error.message || (fa ? "خطا در پاکسازی اطلاعات" : language === "ar" ? "خطأ في مسح البيانات" : language === "tr" ? "Verileri temizleme başarısız oldu" : "Reset failed"));
    }
  }

  function exportCrmCsv() {
    const rows = [
      [
        "ID",
        fa ? "نام" : language === "ar" ? "الاسم" : language === "tr" ? "Ad" : "Name",
        fa ? "نوع" : language === "ar" ? "النوع" : language === "tr" ? "Tür" : "Type",
        fa ? "تلفن" : language === "ar" ? "الهاتف" : language === "tr" ? "Telefon" : "Phone",
        fa ? "امتیاز CRM" : language === "ar" ? "درجة CRM" : language === "tr" ? "CRM Puanı" : "CRM Score",
        fa ? "رتبه" : language === "ar" ? "الرتبة" : language === "tr" ? "Derece" : "Rank",
        fa ? "وضعیت" : language === "ar" ? "الحالة" : language === "tr" ? "Durum" : "Status",
        fa ? "بدهکار" : language === "ar" ? "مدين" : language === "tr" ? "Borçlu" : "Debtor",
        fa ? "بستانکار" : language === "ar" ? "دائن" : language === "tr" ? "Alacaklı" : "Creditor",
        fa ? "مانده" : language === "ar" ? "الرصيد" : language === "tr" ? "Bakiye" : "Balance",
        fa ? "پیشنهاد پیگیری" : language === "ar" ? "اقتراح المتابعة" : language === "tr" ? "Takip Önerisi" : "Follow-up Suggestion",
      ],
      ...filtered.map((item) => {
        const score = crmScore(item);
        const rank = crmRank(score);
        const status = crmStatus(item, language);
        const balance = balanceOf(item);
        return [
          item.id,
          item.name || "",
          partyTypeLabel(item.party_type || item.customer_type),
          item.phone || item.mobile || "",
          score,
          rank.key,
          status.label,
          debtorOf(item),
          creditorOf(item),
          balance,
          followupSuggestion(item, language),
        ];
      }),
    ];

    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vetrix-crm-customers.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const exportLabels = {
    button: fa ? "گزارش" : ar ? "تقرير" : tr ? "Rapor" : "Report",
    pdf: fa ? "خروجی PDF" : ar ? "تصدير PDF" : tr ? "PDF olarak indir" : "Export PDF",
    excel: fa ? "خروجی Excel" : ar ? "تصدير Excel" : tr ? "Excel olarak indir" : "Export Excel",
    csv: fa ? "خروجی CRM (CSV)" : ar ? "تصدير CRM (CSV)" : tr ? "CRM dışa aktar (CSV)" : "CRM export (CSV)",
    scopeAll: fa ? "شامل همه رکوردها (نه فقط فیلترشده)" : ar ? "جميع السجلات (وليس فقط المصفّاة)" : tr ? "Tüm kayıtlar (yalnızca filtrelenenler değil)" : "All records (not just filtered)",
  };

  function filtersLabel() {
    return activeChips.map((chip) => chip.label).join(" | ") || (fa ? "بدون فیلتر" : ar ? "بدون فلاتر" : tr ? "Filtre yok" : "No filters");
  }

  const reportTitle = fa ? "فهرست طرف‌حساب‌ها" : ar ? "قائمة الأطراف" : tr ? "Cari listesi" : "Customers list";
  const headerLabels = {
    row: fa ? "ردیف" : ar ? "#" : tr ? "#" : "#",
    name: fa ? "نام" : ar ? "الاسم" : tr ? "Ad" : "Name",
    type: t("partyType"),
    phone: t("phone"),
    city: fa ? "شهر" : ar ? "المدينة" : tr ? "Şehir" : "City",
    debtor: t("debtor"),
    creditor: t("creditor"),
    balance: t("balance"),
    balanceStatus: fa ? "وضعیت مانده" : ar ? "حالة الرصيد" : tr ? "Bakiye durumu" : "Balance status",
    score: fa ? "امتیاز CRM" : ar ? "درجة CRM" : tr ? "CRM puanı" : "CRM score",
    status: fa ? "وضعیت پیگیری" : ar ? "حالة المتابعة" : tr ? "Takip durumu" : "Follow-up status",
    lastActivity: fa ? "تاریخ ایجاد" : ar ? "تاريخ الإنشاء" : tr ? "Oluşturulma tarihi" : "Created at",
  };

  async function runExport(kind) {
    const rowsSource = exportAllScope ? parties : filtered;
    if (!rowsSource.length) {
      toast.error(fa ? "رکوردی برای خروجی گرفتن وجود ندارد" : ar ? "لا توجد سجلات للتصدير" : tr ? "Dışa aktarılacak kayıt yok" : "No records to export");
      return;
    }
    setExportBusy(true);
    setExportMenuOpen(false);
    try {
      const headers = [
        headerLabels.row, headerLabels.name, headerLabels.type, headerLabels.phone, headerLabels.city,
        headerLabels.debtor, headerLabels.creditor, headerLabels.balance, headerLabels.balanceStatus,
        headerLabels.score, headerLabels.status, headerLabels.lastActivity,
      ];
      const now = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");

      if (kind === "pdf") {
        const rows = rowsSource.map((item, index) => {
          const status = crmStatus(item, language);
          return [
            String(index + 1),
            item.name || "-",
            partyTypeLabel(item.party_type || item.customer_type),
            item.phone || item.mobile || "-",
            item.city || "-",
            money(debtorOf(item)),
            money(creditorOf(item)),
            money(Math.abs(balanceOf(item))),
            balanceLabel(balanceOf(item), language),
            n(crmScore(item)),
            status.label,
            item.created_at ? String(item.created_at).slice(0, 10) : "-",
          ];
        });
        await exportCustomersListPdf(
          { headers, rows, title: reportTitle, subtitle: exportAllScope ? undefined : filtersLabel(), filters_label: exportAllScope ? undefined : filtersLabel(), language },
          `vetrix-customers-${now}.pdf`
        );
      } else {
        const numericColumns = [0, 5, 6, 7, 9];
        const rows = rowsSource.map((item, index) => {
          const status = crmStatus(item, language);
          return [
            index + 1,
            item.name || "-",
            partyTypeLabel(item.party_type || item.customer_type),
            item.phone || item.mobile || "-",
            item.city || "-",
            debtorOf(item),
            creditorOf(item),
            Math.abs(balanceOf(item)),
            balanceLabel(balanceOf(item), language),
            crmScore(item),
            status.label,
            item.created_at ? String(item.created_at).slice(0, 10) : "-",
          ];
        });
        await exportCustomersListExcel(
          { headers, rows, numeric_columns: numericColumns, title: reportTitle, language, column_widths: [7, 24, 14, 16, 14, 16, 16, 16, 14, 10, 20, 14] },
          `vetrix-customers-${now}.xlsx`
        );
      }
    } catch (error) {
      toast.error(error.message || (fa ? "خروجی گرفتن ناموفق بود" : ar ? "فشل التصدير" : tr ? "Dışa aktarma başarısız oldu" : "Export failed"));
    } finally {
      setExportBusy(false);
    }
  }

  function openCustomer(id, event) {
    if (event) {
      const interactive = event.target.closest("a,button,input,select,textarea,[data-stop-row-click]");
      if (interactive) return;
    }
    navigate(`/customers/${id}/360`);
  }

  return (
    <div dir={dir} className="space-y-6" style={{ direction: dir }}>
      <PageHeader
        icon={UsersRound}
        title={t("parties")}
        description={
          fa
            ? "مدیریت طرف‌حساب‌ها، بدهکار، بستانکار، مانده حساب و پرونده مالی"
            : "Manage parties, debtors, creditors, balances and financial profiles"
        }
        secondaryActions={
          <>
            <Button variant="secondary" icon={Download} onClick={exportCrmCsv}>
              {exportLabels.csv}
            </Button>
            <Button variant="danger" icon={AlertTriangle} onClick={resetAllAccounting}>
              {fa ? "پاکسازی تست‌ها" : language === "ar" ? "مسح بيانات الاختبار" : language === "tr" ? "Test verilerini temizle" : "Clear test data"}
            </Button>
          </>
        }
        primaryAction={
          <Button variant="secondary" icon={RefreshCcw} onClick={load}>
            {fa ? "به‌روزرسانی" : language === "ar" ? "تحديث" : language === "tr" ? "Yenile" : "Refresh"}
          </Button>
        }
      />

      {message && (
        <Notice tone={offlineMode ? "warning" : "danger"}>{message}</Notice>
      )}

      {countPending(parties) > 0 && (
        <Notice tone="warning" className="flex flex-wrap items-center justify-between gap-3">
          <span>
            {fa
              ? `${toPersianDigits(countPending(parties))} طرف‌حساب آفلاین در انتظار همگام‌سازی است.`
              : `${countPending(parties)} offline customer record(s) waiting to sync.`}
          </span>
          <Button variant="primary" size="sm" onClick={() => void syncPendingParties()}>
            {fa ? "همگام‌سازی الان" : language === "ar" ? "مزامنة الآن" : language === "tr" ? "Şimdi senkronize et" : "Sync now"}
          </Button>
        </Notice>
      )}

      <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <SummaryCard
          icon={<Wallet size={22} />}
          title={t("debtor")}
          value={summary.totalDebtor}
          colorClassName="text-[var(--erp-danger)]"
          onClick={() => applyCardFilter({ bal: "debtor" })}
          active={filters.bal === "debtor"}
          ariaLabel={fa ? "نمایش فقط طرف‌حساب‌های بدهکار" : "Show debtors only"}
        />
        <SummaryCard
          icon={<Wallet size={22} />}
          title={t("creditor")}
          value={summary.totalCreditor}
          colorClassName="text-[var(--erp-success)]"
          onClick={() => applyCardFilter({ bal: "creditor" })}
          active={filters.bal === "creditor"}
          ariaLabel={fa ? "نمایش فقط طرف‌حساب‌های بستانکار" : "Show creditors only"}
        />
        <SummaryCard
          icon={<Building2 size={22} />}
          title={t("balance")}
          value={Math.abs(summary.totalBalance)}
          suffix={balanceLabel(summary.totalBalance, language)}
          color="var(--erp-accent)"
          onClick={() => applyCardFilter({ bal: "has_balance" })}
          active={filters.bal === "has_balance"}
          ariaLabel={fa ? "نمایش طرف‌حساب‌های دارای مانده" : "Show parties with a balance"}
        />
        <SummaryCard
          icon={<Crown size={22} />}
          title={fa ? "مشتریان VIP" : language === "ar" ? "عملاء VIP" : language === "tr" ? "VIP müşteriler" : "VIP customers"}
          value={summary.vipCount}
          isCount
          color="var(--erp-accent-2)"
          onClick={() => applyCardFilter({ crm: "vip" })}
          active={filters.crm === "vip"}
          ariaLabel={fa ? "نمایش فقط مشتریان VIP" : "Show VIP customers only"}
        />
        <SummaryCard
          icon={<PhoneCall size={22} />}
          title={fa ? "نیازمند پیگیری" : language === "ar" ? "بحاجة إلى متابعة" : language === "tr" ? "Takip gerekiyor" : "Need follow-up"}
          value={summary.followupCount}
          isCount
          color="var(--erp-warning)"
          onClick={() => applyCardFilter({ crm: "followup" })}
          active={filters.crm === "followup"}
          ariaLabel={fa ? "نمایش پرونده‌های نیازمند پیگیری" : "Show parties needing follow-up"}
        />
        <SummaryCard
          icon={<ShieldCheck size={22} />}
          title={fa ? "ریسک اعتباری" : language === "ar" ? "مخاطر ائتمانية" : language === "tr" ? "Kredi riski" : "Credit risk"}
          value={summary.riskCount}
          isCount
          color="var(--erp-danger)"
          onClick={() => applyCardFilter({ crm: "risk" })}
          active={filters.crm === "risk"}
          ariaLabel={fa ? "نمایش طرف‌حساب‌های دارای ریسک اعتباری" : "Show parties with credit risk"}
        />
      </div>

      <CrmOverview
        fa={fa}
        language={language}
        n={n}
        parties={parties}
        summary={summary}
      />

      <div className="bg-[var(--erp-bg-soft)] border border-[var(--erp-border)] rounded-[var(--erp-radius-lg)] p-5" style={{ boxShadow: "var(--erp-shadow), inset 0 1px 0 0 var(--erp-surface-highlight)" }}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Input
            placeholder={t("party")}
            value={faText(form.name, fa)}
            onChange={(e) => setForm({ ...form, name: faText(e.target.value, fa) })}
          />

          <Select
            value={form.party_type}
            onChange={(value) => setForm({ ...form, party_type: value })}
            options={[
              { value: "customer", label: t("customerParty") },
              { value: "supplier", label: t("supplierParty") },
              { value: "partner", label: t("partnerParty") },
              { value: "staff", label: t("staffParty") },
              { value: "company", label: t("companyParty") },
              { value: "doctor", label: t("doctorParty") },
              { value: "other", label: t("otherParty") },
            ]}
          />

          <Select
            value={form.pricing_group}
            onChange={(value) => setForm({ ...form, pricing_group: value })}
            options={[
              { value: "retail", label: fa ? "خرده‌فروشی" : language === "ar" ? "بيع بالتجزئة" : language === "tr" ? "Perakende" : "Retail" },
              { value: "wholesale", label: fa ? "عمده‌فروشی" : language === "ar" ? "بيع بالجملة" : language === "tr" ? "Toptan" : "Wholesale" },
            ]}
          />

          <Select
            value={form.assigned_rep_id || ""}
            onChange={(value) => setForm({ ...form, assigned_rep_id: value })}
            options={[
              { value: "", label: fa ? "بدون کارشناس فروش" : language === "ar" ? "بدون مندوب مبيعات" : language === "tr" ? "Satış temsilcisi yok" : "No sales rep" },
              ...salesReps.map((rep) => ({ value: rep.id, label: rep.full_name || rep.username })),
            ]}
          />

          <div className="flex flex-col gap-1 self-center">
            <label className="flex items-center gap-2 font-bold">
              <input
                type="checkbox"
                checked={form.marketing_consent !== false}
                onChange={(e) => setForm({ ...form, marketing_consent: e.target.checked })}
              />
              {fa ? "رضایت به دریافت پیام‌های تبلیغاتی" : language === "ar" ? "الموافقة على تلقي الرسائل الترويجية" : language === "tr" ? "Tanıtım mesajlarını almayı kabul ediyorum" : "Consents to marketing messages"}
            </label>
            {editingId && (
              <div className="flex items-center gap-2 text-xs opacity-70">
                <span>
                  {form.marketing_consent_source === "explicit"
                    ? (fa ? `ثبت‌شده صریح${form.marketing_consent_recorded_at ? " — " + String(form.marketing_consent_recorded_at).slice(0, 10) : ""}` : ar ? `مسجّل صراحةً${form.marketing_consent_recorded_at ? " — " + String(form.marketing_consent_recorded_at).slice(0, 10) : ""}` : tr ? `Açıkça kaydedildi${form.marketing_consent_recorded_at ? " — " + String(form.marketing_consent_recorded_at).slice(0, 10) : ""}` : `Explicitly recorded${form.marketing_consent_recorded_at ? " — " + String(form.marketing_consent_recorded_at).slice(0, 10) : ""}`)
                    : (fa ? "وضعیت پیش‌فرض — هرگز صراحتاً ثبت نشده" : ar ? "الحالة الافتراضية — لم يتم تسجيلها صراحةً أبدًا" : tr ? "Varsayılan durum — hiç açıkça kaydedilmedi" : "Default status — never explicitly recorded")}
                </span>
                <button
                  type="button"
                  className="underline erp-accent"
                  onClick={async () => {
                    setConsentHistoryOpen(true);
                    setConsentHistoryLoading(true);
                    try {
                      const res = await getCustomerConsentHistory(editingId);
                      setConsentHistory(res.items || []);
                    } catch {
                      setConsentHistory([]);
                    } finally {
                      setConsentHistoryLoading(false);
                    }
                  }}
                >
                  {fa ? "تاریخچه" : ar ? "السجل" : tr ? "Geçmiş" : "History"}
                </button>
              </div>
            )}
          </div>

          <Input
            placeholder={t("phone")}
            value={faText(form.phone, fa)}
            onChange={(e) => setForm({ ...form, phone: faText(e.target.value, fa) })}
          />

          <Input
            placeholder={t("mobile")}
            value={faText(form.mobile, fa)}
            onChange={(e) => setForm({ ...form, mobile: faText(e.target.value, fa) })}
          />

          <Input
            placeholder={fa ? "شناسه چت تلگرام (اختیاری)" : language === "ar" ? "معرّف دردشة تيليجرام (اختياري)" : language === "tr" ? "Telegram sohbet kimliği (isteğe bağlı)" : "Telegram chat ID (optional)"}
            value={faText(form.telegram_chat_id, fa)}
            onChange={(e) => setForm({ ...form, telegram_chat_id: faText(e.target.value, fa) })}
          />

          <div style={{ display: "flex", gap: 8, gridColumn: "span 1" }}>
            <Input
              placeholder={fa ? "عرض جغرافیایی" : language === "ar" ? "خط العرض" : language === "tr" ? "Enlem" : "Latitude"}
              value={faText(form.latitude, fa)}
              onChange={(e) => setForm({ ...form, latitude: faText(e.target.value, fa) })}
            />
            <Input
              placeholder={fa ? "طول جغرافیایی" : language === "ar" ? "خط الطول" : language === "tr" ? "Boylam" : "Longitude"}
              value={faText(form.longitude, fa)}
              onChange={(e) => setForm({ ...form, longitude: faText(e.target.value, fa) })}
            />
            <Tooltip
              side="top"
              label={fa ? "استفاده از موقعیت فعلی" : language === "ar" ? "استخدام الموقع الحالي" : language === "tr" ? "Mevcut konumu kullan" : "Use my current location"}
            >
              <button
                type="button"
                aria-label={fa ? "استفاده از موقعیت فعلی" : language === "ar" ? "استخدام الموقع الحالي" : language === "tr" ? "Mevcut konumu kullan" : "Use my current location"}
                onClick={() => {
                  if (!navigator.geolocation) return;
                  navigator.geolocation.getCurrentPosition(
                    (pos) => setForm((prev) => ({ ...prev, latitude: faText(String(pos.coords.latitude), fa), longitude: faText(String(pos.coords.longitude), fa) })),
                    () => {},
                    { enableHighAccuracy: true, timeout: 10000 }
                  );
                }}
                className="shrink-0 px-3 rounded-xl border border-[var(--erp-border)] bg-[var(--erp-panel-solid)] text-[var(--erp-accent)]"
              >
                <LocateFixed size={16} />
              </button>
            </Tooltip>
          </div>

          <Input
            placeholder={t("email")}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />

          <Input
            placeholder={t("nationalId")}
            value={faText(form.national_id, fa)}
            onChange={(e) =>
              setForm({ ...form, national_id: faText(e.target.value, fa) })
            }
          />

          <Input
            placeholder={t("economicCode")}
            value={faText(form.economic_code, fa)}
            onChange={(e) =>
              setForm({ ...form, economic_code: faText(e.target.value, fa) })
            }
          />

          <Input
            placeholder={t("city")}
            value={faText(form.city, fa)}
            onChange={(e) => setForm({ ...form, city: faText(e.target.value, fa) })}
          />

          <Input
            placeholder={t("contactPerson")}
            value={faText(form.contact_person, fa)}
            onChange={(e) =>
              setForm({ ...form, contact_person: faText(e.target.value, fa) })
            }
          />

          <Input
            type="text"
            inputMode="numeric"
            placeholder={t("openingBalance")}
            value={form.opening_balance}
            onChange={(e) =>
              setForm({
                ...form,
                opening_balance: normalizeNumberInput(e.target.value, fa),
              })
            }
          />

          <Input
            type="text"
            inputMode="numeric"
            placeholder={t("creditLimit")}
            value={form.credit_limit}
            onChange={(e) =>
              setForm({
                ...form,
                credit_limit: normalizeNumberInput(e.target.value, fa),
              })
            }
          />

          <Input
            placeholder={t("address")}
            value={faText(form.address, fa)}
            onChange={(e) =>
              setForm({ ...form, address: faText(e.target.value, fa) })
            }
            className="xl:col-span-2"
          />

          <Input
            placeholder={t("notes")}
            value={faText(form.notes, fa)}
            onChange={(e) =>
              setForm({ ...form, notes: faText(e.target.value, fa) })
            }
            className="xl:col-span-2"
          />
        </div>

        <div className="flex gap-3 flex-wrap mt-5">
          <Button variant="primary" icon={editingId ? Save : Plus} onClick={save}>
            {editingId ? t("saveCustomer") : t("addCustomer")}
          </Button>

          {editingId && (
            <Button
              variant="secondary"
              icon={X}
              onClick={() => {
                setEditingId(null);
                setForm(emptyForm);
              }}
            >
              {t("cancelEdit")}
            </Button>
          )}
        </div>
      </div>

      <div ref={tableTopRef} className="bg-[var(--erp-bg-soft)] border border-[var(--erp-border)] rounded-[var(--erp-radius-lg)] p-5" style={{ boxShadow: "var(--erp-shadow), inset 0 1px 0 0 var(--erp-surface-highlight)" }}>
        {/* Row 1: dominant, full-width search. Focus ring lives on this
            rounded outer group via :focus-within (.vitalix-input-group in
            index.css) - the inner <input> gives up its own outline/border/
            box-shadow so it never shows the browser's square focus box
            inside the pill. */}
        <label className="vitalix-input-group flex items-center gap-2.5 mb-3" style={{ padding: "0 16px" }}>
          <Search size={20} className="text-[var(--erp-accent)] shrink-0" aria-hidden="true" />
          <input
            value={faText(searchInput, fa)}
            onChange={(e) => setSearchInput(faText(e.target.value, fa))}
            placeholder={
              fa
                ? "جستجو بر اساس نام، تلفن، کد ملی، کد اقتصادی، ایمیل یا شهر..."
                : ar
                ? "بحث بالاسم أو الهاتف أو الرقم الضريبي أو البريد أو المدينة..."
                : tr
                ? "Ad, telefon, vergi no, e-posta veya şehre göre ara..."
                : "Search by name, phone, national ID, tax code, email or city..."
            }
            aria-label={fa ? "جستجوی مشتریان" : ar ? "بحث العملاء" : tr ? "Müşteri ara" : "Search customers"}
            className="min-w-0 flex-1"
            style={{ color: "var(--erp-text)", padding: "13px 0" }}
          />
        </label>

        {/* Row 2: filters + report action. Grid on mobile/tablet so
            controls wrap into balanced 2-3 columns without overflow; flex
            at desktop width restores each Select's natural compact width,
            with the export action pushed to the row end via ms-auto so it
            reads as an action, not another filter. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:flex lg:flex-wrap items-center gap-3 mb-3">
          <Select
            value={filters.type}
            onChange={(value) => patchFilters({ type: value })}
            className="w-full lg:w-40 shrink-0"
            options={[
              { value: "all", label: fa ? "همه انواع" : language === "ar" ? "كل الأنواع" : language === "tr" ? "Tüm türler" : "All types" },
              { value: "customer", label: t("customerParty") },
              { value: "supplier", label: t("supplierParty") },
              { value: "partner", label: t("partnerParty") },
              { value: "staff", label: t("staffParty") },
              { value: "company", label: t("companyParty") },
              { value: "doctor", label: t("doctorParty") },
              { value: "other", label: t("otherParty") },
            ]}
          />

          <Select
            value={filters.bal}
            onChange={(value) => patchFilters({ bal: value })}
            className="w-full lg:w-44 shrink-0"
            options={[
              { value: "all", label: fa ? "همه وضعیت مالی" : ar ? "كل الحالات المالية" : tr ? "Tüm bakiyeler" : "All balances" },
              { value: "debtor", label: fa ? "فقط بدهکار" : ar ? "مدين فقط" : tr ? "Sadece borçlu" : "Debtors only" },
              { value: "creditor", label: fa ? "فقط بستانکار" : ar ? "دائن فقط" : tr ? "Sadece alacaklı" : "Creditors only" },
              { value: "zero", label: fa ? "بی‌حساب / صفر" : ar ? "بدون رصيد" : tr ? "Sıfır bakiye" : "Zero balance" },
              { value: "has_balance", label: fa ? "دارای مانده" : ar ? "لديه رصيد" : tr ? "Bakiyesi olan" : "Has balance" },
            ]}
          />

          <Select
            value={filters.crm}
            onChange={(value) => patchFilters({ crm: value })}
            className="w-full lg:w-40 shrink-0"
            options={[
              { value: "all", label: fa ? "همه CRM" : language === "ar" ? "كل CRM" : language === "tr" ? "Tüm CRM" : "All CRM" },
              { value: "vip", label: "VIP" },
              { value: "followup", label: fa ? "نیازمند پیگیری" : language === "ar" ? "بحاجة إلى متابعة" : language === "tr" ? "Takip gerekiyor" : "Needs follow-up" },
              { value: "risk", label: fa ? "ریسک اعتباری" : language === "ar" ? "مخاطر ائتمانية" : language === "tr" ? "Kredi riski" : "Credit risk" },
              { value: "settled", label: fa ? "تسویه" : language === "ar" ? "مسدد" : language === "tr" ? "Kapandı" : "Settled" },
            ]}
          />

          <Select
            value={filters.phoneHas}
            onChange={(value) => patchFilters({ phoneHas: value })}
            className="w-full lg:w-48 shrink-0"
            options={[
              { value: "all", label: fa ? "شماره تماس: همه" : ar ? "رقم الهاتف: الكل" : tr ? "Telefon: hepsi" : "Phone: all" },
              { value: "yes", label: fa ? "دارای شماره تماس" : ar ? "لديه رقم" : tr ? "Numarası var" : "Has phone" },
              { value: "no", label: fa ? "بدون شماره تماس" : ar ? "بلا رقم" : tr ? "Numarası yok" : "No phone" },
            ]}
          />

          {cityOptions.length > 0 && (
            <Select
              value={filters.city}
              onChange={(value) => patchFilters({ city: value })}
              className="w-full lg:w-36 shrink-0"
              options={[
                { value: "all", label: fa ? "همه شهرها" : ar ? "كل المدن" : tr ? "Tüm şehirler" : "All cities" },
                ...cityOptions.map((city) => ({ value: city, label: city })),
              ]}
            />
          )}

          {user && (
            <Button
              type="button"
              variant={myOnly ? "primary" : "secondary"}
              onClick={() => setMyOnly((v) => !v)}
              className="w-full lg:w-auto"
            >
              {fa ? "مشتریان من" : language === "ar" ? "عملائي" : language === "tr" ? "Müşterilerim" : "My customers"}
            </Button>
          )}

          <div className="relative col-span-2 sm:col-span-3 lg:col-span-1 lg:ms-auto" ref={exportMenuRef}>
            <Button
              variant="secondary"
              icon={Download}
              onClick={() => setExportMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              loading={exportBusy}
              className="w-full lg:w-auto"
            >
              {exportLabels.button}
              <ChevronDown size={14} />
            </Button>
            {exportMenuOpen && (
              <div
                role="menu"
                className="absolute z-20 mt-2 min-w-[260px] rounded-[var(--erp-radius-md)] border border-[var(--erp-border)] bg-[var(--erp-panel-solid)] p-2"
                style={{ insetInlineEnd: 0, boxShadow: "var(--erp-shadow)" }}
              >
                <label className="flex items-center gap-2 px-2 py-2 text-sm text-[var(--erp-text)] cursor-pointer">
                  <input type="checkbox" checked={exportAllScope} onChange={(e) => setExportAllScope(e.target.checked)} />
                  {exportLabels.scopeAll}
                </label>
                <div className="h-px bg-[var(--erp-border)] my-1" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runExport("pdf")}
                  className="w-full flex items-center gap-2 px-2 py-2 rounded-[var(--erp-radius-sm)] text-sm text-[var(--erp-text)] hover:bg-[var(--erp-glow)]"
                >
                  <FileText size={16} className="text-[var(--erp-accent)]" />
                  {exportLabels.pdf}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runExport("excel")}
                  className="w-full flex items-center gap-2 px-2 py-2 rounded-[var(--erp-radius-sm)] text-sm text-[var(--erp-text)] hover:bg-[var(--erp-glow)]"
                >
                  <FileSpreadsheet size={16} className="text-emerald-400" />
                  {exportLabels.excel}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-[var(--erp-muted)]" />
            <Input
              type="text"
              inputMode="numeric"
              placeholder={fa ? "حداقل مانده" : ar ? "الحد الأدنى للرصيد" : tr ? "En az bakiye" : "Min balance"}
              value={filters.balMin}
              onChange={(e) => patchFilters({ balMin: normalizeNumberInput(e.target.value, fa) })}
              className="!w-32"
            />
            <span className="text-[var(--erp-muted)]">-</span>
            <Input
              type="text"
              inputMode="numeric"
              placeholder={fa ? "حداکثر مانده" : ar ? "الحد الأقصى للرصيد" : tr ? "En çok bakiye" : "Max balance"}
              value={filters.balMax}
              onChange={(e) => patchFilters({ balMax: normalizeNumberInput(e.target.value, fa) })}
              className="!w-32"
            />
          </div>

          {activeChips.map((chip) => (
            <Badge
              key={chip.key}
              tone="info"
              className="cursor-pointer erp-focus"
              tabIndex={0}
              role="button"
              aria-label={fa ? `حذف فیلتر ${chip.label}` : `Remove filter ${chip.label}`}
              onClick={() => removeChip(chip.key)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                removeChip(chip.key);
              }}
            >
              {chip.label}
              <X size={12} />
            </Badge>
          ))}

          {activeChips.length > 0 && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="text-xs font-bold text-[var(--erp-danger)] underline underline-offset-2"
            >
              {fa ? "پاک‌کردن همه فیلترها" : ar ? "مسح كل الفلاتر" : tr ? "Tüm filtreleri temizle" : "Clear all filters"}
            </button>
          )}

          <span className="text-xs text-[var(--erp-muted)] ms-auto">
            {fa
              ? `${toPersianDigits(filtered.length)} نتیجه از ${toPersianDigits(parties.length)}`
              : `${filtered.length} of ${parties.length} results`}
          </span>
        </div>

        <Table>
          <Thead>
            <Th className="w-12">{headerLabels.row}</Th>
            <SortableTh field="name" sortField={filters.sort} sortDir={filters.dir} onSort={setSort}>{t("party")}</SortableTh>
            <Th>{fa ? "CRM" : "CRM"}</Th>
            <SortableTh field="type" sortField={filters.sort} sortDir={filters.dir} onSort={setSort}>{t("partyType")}</SortableTh>
            <SortableTh field="phone" sortField={filters.sort} sortDir={filters.dir} onSort={setSort}>{t("phone")}</SortableTh>
            <SortableTh field="debtor" sortField={filters.sort} sortDir={filters.dir} onSort={setSort}>{t("debtor")}</SortableTh>
            <SortableTh field="creditor" sortField={filters.sort} sortDir={filters.dir} onSort={setSort}>{t("creditor")}</SortableTh>
            <SortableTh field="balance" sortField={filters.sort} sortDir={filters.dir} onSort={setSort}>{t("balance")}</SortableTh>
            <Th>{t("actions")}</Th>
          </Thead>

          <Tbody>
            {loading && paged.length === 0 && (
              Array.from({ length: 6 }).map((_, index) => <SkeletonRow key={index} />)
            )}

            {paged.map((item, index) => {
              const balance = balanceOf(item);
              const debtor = debtorOf(item);
              const creditor = creditorOf(item);
              const score = crmScore(item);
              const rank = crmRank(score);
              const status = crmStatus(item, language);
              const tags = crmTags(item, language);
              const rowNumber = pageStart + index + 1;

              return (
                <Tr
                  key={item.id}
                  tabIndex={0}
                  role="link"
                  aria-label={fa ? `باز کردن پرونده ${item.name}` : `Open ${item.name}'s profile`}
                  onClick={(event) => openCustomer(item.id, event)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") openCustomer(item.id, event);
                  }}
                  className="cursor-pointer erp-focus"
                  style={{ borderBottom: "1px solid var(--erp-border)" }}
                >
                  <Td className="text-[var(--erp-muted)] font-bold">{n(rowNumber)}</Td>
                  <Td className="font-black">
                    <div>
                      {faText(item.name, fa)}
                      {item.pending_sync && (
                        <Badge tone="warning" className="mx-2">
                          {fa ? "آفلاین" : language === "ar" ? "غير متصل" : language === "tr" ? "Çevrimdışı" : "Offline"}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-[var(--erp-muted)]">ID #{n(item.id)}</div>
                  </Td>

                  <Td className="min-w-[220px]">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge tone={rank.tone}>{rank.key}</Badge>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className="text-xs text-[var(--erp-muted)]">{n(score)}/{n(100)}</span>
                    </div>
                    <div className="h-2 bg-[var(--erp-panel-solid)] rounded-full overflow-hidden mb-2">
                      <div
                        className="h-full bg-gradient-to-r from-rose-400 via-amber-300 to-emerald-400"
                        style={{ width: `${score}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {tags.map((tag, tagIndex) => (
                        <Badge key={tagIndex} tone="neutral">{tag}</Badge>
                      ))}
                    </div>
                  </Td>

                  <Td>
                    <Badge tone="info">{partyTypeLabel(item.party_type || item.customer_type)}</Badge>
                  </Td>

                  <Td>{faText(item.phone || item.mobile || "-", fa)}</Td>

                  <Td>
                    <MoneyDisplay value={debtor} tone="var(--erp-danger)" fontSize="clamp(12px,1.1vw,14px)" className="font-black" />
                  </Td>

                  <Td>
                    <MoneyDisplay value={creditor} tone="var(--erp-success)" fontSize="clamp(12px,1.1vw,14px)" className="font-black" />
                  </Td>

                  <Td>
                    <MoneyDisplay value={Math.abs(balance)} tone="var(--erp-accent)" fontSize="clamp(12px,1.1vw,14px)" className="font-black" />
                    <div className="text-xs font-normal" style={{ color: "var(--erp-muted)" }}>
                      {balanceLabel(balance, language)}
                    </div>
                  </Td>

                  <Td>
                    <div className="text-xs text-[var(--erp-muted)] mb-2 flex items-center gap-1">
                      <CalendarClock size={13} />
                      {followupSuggestion(item, language)}
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <Link
                        to={`/customers/${item.id}/360`}
                        data-stop-row-click
                        className="px-3 py-2 bg-[var(--erp-panel-solid)] text-[var(--erp-text)] rounded-[var(--erp-radius-sm)] flex items-center gap-1"
                      >
                        <Eye size={15} />
                        {fa ? "پرونده ۳۶۰°" : language === "ar" ? "ملف 360°" : language === "tr" ? "360° Profil" : "360° Profile"}
                      </Link>

                      <Button variant="ghost" size="sm" icon={Edit3} data-stop-row-click onClick={() => edit(item)}>
                        {t("edit")}
                      </Button>

                      <Button variant="danger" size="sm" icon={Trash2} data-stop-row-click onClick={() => remove(item.id)}>
                        {t("delete")}
                      </Button>
                    </div>
                  </Td>
                </Tr>
              );
            })}

            {!loading && filtered.length === 0 && (
              <EmptyRow colSpan={9}>
                {parties.length === 0
                  ? (fa ? "طرف‌حسابی ثبت نشده است" : language === "ar" ? "لا يوجد أطراف حساب" : language === "tr" ? "Cari bulunamadı" : "No parties found")
                  : (
                    <span className="flex flex-col items-center gap-2">
                      {fa ? "با این فیلترها موردی یافت نشد." : ar ? "لا توجد نتائج بهذه الفلاتر." : tr ? "Bu filtrelerle sonuç bulunamadı." : "No results match these filters."}
                      <button type="button" onClick={clearAllFilters} className="text-[var(--erp-accent)] underline underline-offset-2 text-xs font-bold">
                        {fa ? "پاک‌کردن فیلترها" : ar ? "مسح الفلاتر" : tr ? "Filtreleri temizle" : "Clear filters"}
                      </button>
                    </span>
                  )}
              </EmptyRow>
            )}
          </Tbody>
        </Table>

        {filtered.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4 border-t border-[var(--erp-border)]">
            <div className="flex items-center gap-2 text-sm text-[var(--erp-muted)]">
              <span>{fa ? "ردیف در هر صفحه:" : ar ? "صفوف لكل صفحة:" : tr ? "Sayfa başına satır:" : "Rows per page:"}</span>
              <Select
                value={String(pageSize)}
                onChange={(value) => patchFilters({ size: value })}
                options={PAGE_SIZES.map((size) => ({ value: String(size), label: n(size) }))}
                className="w-24"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setPage(page - 1)}
                disabled={page <= 1}
                className="p-2 rounded-[var(--erp-radius-sm)] bg-[var(--erp-panel-solid)] text-[var(--erp-text)] disabled:opacity-40 erp-focus"
                aria-label={fa ? "صفحه قبل" : "Previous page"}
              >
                {dir === "rtl" ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              </button>
              <span className="text-sm text-[var(--erp-text)] font-bold">
                {fa ? `صفحه ${toPersianDigits(page)} از ${toPersianDigits(pageCount)}` : `Page ${page} of ${pageCount}`}
              </span>
              <button
                type="button"
                onClick={() => setPage(page + 1)}
                disabled={page >= pageCount}
                className="p-2 rounded-[var(--erp-radius-sm)] bg-[var(--erp-panel-solid)] text-[var(--erp-text)] disabled:opacity-40 erp-focus"
                aria-label={fa ? "صفحه بعد" : "Next page"}
              >
                {dir === "rtl" ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal open={consentHistoryOpen} onClose={() => setConsentHistoryOpen(false)} maxWidthClassName="max-w-md">
        <div className="p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="font-bold">
              {fa ? "تاریخچه رضایت بازاریابی" : ar ? "سجل موافقة التسويق" : tr ? "Pazarlama izni geçmişi" : "Marketing consent history"}
            </h3>
            <button type="button" onClick={() => setConsentHistoryOpen(false)} className="erp-focus" aria-label={fa ? "بستن" : "Close"}>
              <X size={18} />
            </button>
          </div>
          {consentHistoryLoading ? (
            <div className="text-sm text-[var(--erp-muted)]">{fa ? "در حال بارگذاری..." : "Loading..."}</div>
          ) : consentHistory.length === 0 ? (
            <div className="text-sm text-[var(--erp-muted)]">
              {fa ? "هیچ تغییری صراحتاً ثبت نشده است." : ar ? "لم يتم تسجيل أي تغيير صراحةً." : tr ? "Açıkça kaydedilmiş bir değişiklik yok." : "No explicit change has been recorded."}
            </div>
          ) : (
            <ul className="flex flex-col gap-2 max-h-80 overflow-y-auto">
              {consentHistory.map((h) => (
                <li key={h.id} className="text-sm border-b border-[var(--erp-border)] pb-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={h.new_value ? "success" : "neutral"}>
                      {h.new_value
                        ? (fa ? "موافقت" : ar ? "موافقة" : tr ? "İzin verildi" : "Opted in")
                        : (fa ? "عدم موافقت" : ar ? "رفض" : tr ? "İzin verilmedi" : "Opted out")}
                    </Badge>
                    <span className="opacity-70">
                      {h.old_value === null || h.old_value === undefined
                        ? (fa ? "(اولین ثبت)" : ar ? "(أول تسجيل)" : tr ? "(ilk kayıt)" : "(first record)")
                        : (h.old_value ? (fa ? "از: موافقت" : "from: opted-in") : (fa ? "از: عدم موافقت" : "from: opted-out"))}
                    </span>
                  </div>
                  <div className="text-xs text-[var(--erp-muted)] mt-1">
                    {h.changed_at ? String(h.changed_at).slice(0, 19).replace("T", " ") : "-"}
                    {h.changed_by_name ? ` — ${h.changed_by_name}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    </div>
  );
}

function SkeletonRow() {
  return (
    <Tr>
      {Array.from({ length: 9 }).map((_, index) => (
        <Td key={index}>
          <div className="h-4 rounded bg-[var(--erp-panel-solid)] animate-pulse" style={{ width: `${50 + (index % 3) * 15}%` }} />
        </Td>
      ))}
    </Tr>
  );
}

function CrmOverview({ fa, language, n, parties, summary }) {
  const navigate = useNavigate();
  const ar = language === "ar";
  const tr = language === "tr";
  const topCustomers = [...parties]
    .sort((a, b) => crmScore(b) - crmScore(a))
    .slice(0, 4);
  const averageScore = parties.length ? Math.round(summary.scoreSum / parties.length) : 0;

  return (
    <div
      className="bg-[var(--erp-bg-soft)] border border-[var(--erp-border)] rounded-[var(--erp-radius-lg)] p-5"
      style={{ boxShadow: "var(--erp-elevation-2), inset 0 1px 0 0 var(--erp-surface-highlight)" }}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div>
          <h2 className="text-2xl font-black text-[var(--erp-accent)] flex items-center gap-2">
            <Activity size={22} />
            {fa ? "مرکز هوشمند ارتباط با مشتری" : ar ? "مركز ذكاء علاقات العملاء" : tr ? "Müşteri Zeka Merkezi" : "Customer Intelligence Center"}
          </h2>
          <p className="text-[var(--erp-muted)] text-sm mt-1">
            {fa
              ? "امتیازدهی، اولویت پیگیری، اعتبار و ارزش مشتری‌ها در یک نگاه"
              : ar
              ? "تقييم العملاء وأولوية المتابعة والائتمان وقيمة العميل في لمحة واحدة"
              : tr
              ? "Müşteri puanlaması, takip önceliği, kredi ve müşteri değeri tek bakışta"
              : "Customer scoring, follow-up priority, credit and customer value at a glance"}
          </p>
        </div>
        <div className="rounded-[var(--erp-radius-md)] bg-[var(--erp-glow)] border border-[var(--erp-border)] px-5 py-3">
          <div className="text-[var(--erp-muted)] text-xs font-bold">{fa ? "میانگین امتیاز" : ar ? "متوسط النقاط" : tr ? "Ortalama puan" : "Average score"}</div>
          <div className="text-[var(--erp-accent)] text-2xl font-black">{n(averageScore)}/{n(100)}</div>
        </div>
      </div>

      {topCustomers.length === 0 ? (
        <EmptyState
          message={fa ? "هنوز مشتری ثبت نشده است." : ar ? "لا يوجد عملاء بعد." : tr ? "Henüz müşteri yok." : "No customers yet."}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
          {topCustomers.map((item) => {
            const score = crmScore(item);
            const rank = crmRank(score);
            const status = crmStatus(item, language);
            const hasValidId = item.id !== undefined && item.id !== null;

            return (
              <div
                key={item.id ?? item.name}
                role="button"
                tabIndex={hasValidId ? 0 : -1}
                aria-label={fa ? `باز کردن پرونده ${item.name}` : `Open ${item.name}'s profile`}
                onClick={() => {
                  if (!hasValidId) return toast.error(fa ? "شناسه معتبر برای این طرف‌حساب یافت نشد." : "No valid ID found for this party.");
                  navigate(`/customers/${item.id}/360`);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  if (!hasValidId) return toast.error(fa ? "شناسه معتبر برای این طرف‌حساب یافت نشد." : "No valid ID found for this party.");
                  navigate(`/customers/${item.id}/360`);
                }}
                className={`rounded-[var(--erp-radius-md)] bg-[var(--erp-panel-solid)] border border-[var(--erp-border)] p-4 text-start w-full erp-focus ${hasValidId ? "cursor-pointer hover:border-[var(--erp-accent)]" : "cursor-not-allowed opacity-60"}`}
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="font-black text-[var(--erp-text)] truncate">{item.name || "-"}</div>
                  <Badge tone={rank.tone}>{rank.key}</Badge>
                </div>
                <div className="text-xs text-[var(--erp-muted)] mb-3">{faText(item.phone || item.mobile, fa) || (fa ? "بدون شماره" : ar ? "بلا رقم" : tr ? "Numara yok" : "No phone")}</div>
                <div className="h-2 bg-[var(--erp-bg-soft)] rounded-full overflow-hidden mb-3">
                  <div className="h-full" style={{ width: `${score}%`, background: "var(--erp-accent)" }} />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <MoneyDisplay value={Math.abs(toNumber(item.balance))} className="font-bold text-[var(--erp-muted)]" fontSize="12px" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyState({ message }) {
  return <div className="text-[var(--erp-muted)] col-span-full text-center py-6">{message}</div>;
}

function AutoFitSummaryMoney({ value, color }) {
  const { money } = useLanguage();
  const wrapperRef = useRef(null);
  const textRef = useRef(null);
  const formatted = money(Number(value || 0));

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const text = textRef.current;
    if (!wrapper || !text) return undefined;

    const fit = () => {
      // Measure the actual rendered, localized amount at its preferred size.
      // Do not abbreviate, round or truncate the number to fit.
      text.style.fontSize = "26px";
      const available = wrapper.clientWidth;
      const required = text.scrollWidth;
      if (!available || !required) return;
      const next = Math.max(6, Math.min(26, Math.floor(26 * available / (required + 2))));
      text.style.fontSize = next + "px";
    };

    const observer = new ResizeObserver(fit);
    observer.observe(wrapper);
    fit();
    return () => observer.disconnect();
  }, [formatted]);

  return (
    <span ref={wrapperRef} style={{ display: "block", width: "100%", minWidth: 0, overflow: "hidden" }} title={formatted} aria-label={formatted}>
      <span ref={textRef} style={{ display: "inline-block", width: "max-content", maxWidth: "none", whiteSpace: "nowrap", fontSize: 26, fontWeight: 900, lineHeight: 1.4, fontVariantNumeric: "tabular-nums", color }}>
        {formatted}
      </span>
    </span>
  );
}

function SummaryCard({ icon, title, value, suffix, color, colorClassName, isCount, onClick, active, ariaLabel }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onClick?.();
      }}
      aria-label={ariaLabel}
      aria-pressed={active}
      className="bg-[var(--erp-bg-soft)] border rounded-[var(--erp-radius-lg)] p-6 cursor-pointer transition-colors erp-focus hover:border-[var(--erp-accent)]"
      style={{
        borderColor: active ? "var(--erp-accent)" : "var(--erp-border)",
        boxShadow: "var(--erp-elevation-1), inset 0 1px 0 0 var(--erp-surface-highlight)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div className="text-[var(--erp-muted)] text-sm font-bold">{title}</div>
        <div className="w-10 h-10 shrink-0 rounded-[var(--erp-radius-md)] flex items-center justify-center bg-[var(--erp-glow)] text-[var(--erp-accent)]">
          {icon}
        </div>
      </div>
      <div className={`mt-3 font-black${colorClassName ? ` ${colorClassName}` : ""}`} style={{ minWidth: 0, width: "100%" }}>
        {isCount ? (
          <span style={{ fontVariantNumeric: "tabular-nums", fontSize: "clamp(18px, 2vw, 26px)", color }}>
            <NumberOnly value={value} />
          </span>
        ) : (
          <span style={{ display: "block", minWidth: 0, width: "100%" }}>
            <AutoFitSummaryMoney value={value} color={color} />
            {suffix && <span className="text-xs font-normal" style={{ color: "var(--erp-muted)" }}>{suffix}</span>}
          </span>
        )}
      </div>
div>
    </div>
  );
}

function NumberOnly({ value }) {
  const { n } = useLanguage();
  return n(value);
}
