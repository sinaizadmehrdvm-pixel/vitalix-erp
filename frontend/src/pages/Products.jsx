import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  Package,
  Search,
  Plus,
  RefreshCw,
  AlertTriangle,
  Edit3,
  Save,
  X,
  ImagePlus,
  Boxes,
  Trash2,
  ScanBarcode,
} from "lucide-react";

import toast from "react-hot-toast";
import { useLanguage } from "../localization/useLanguage";
import { useAuth } from "../auth/AuthContext";
import { confirmAction } from "../components/ui/confirmService";
import {
  createProduct,
  getProductCategories,
  getProducts,
  updateProduct,
  deleteProduct,
  isNetworkError,
} from "../services/api";

import { getCache, setCache } from "../storage/db";
import { countPending, syncPendingRecords, useOnlineSync } from "../storage/offlineSync";
import { toPersianDigits, toEnglishDigits } from "../localization/helpers";
import { translateApiError } from "../localization/apiErrors";
import BarcodeScannerModal from "../components/BarcodeScannerModal";
import ProductBatchesPanel from "../components/ProductBatchesPanel";
import { Table, Thead, Tbody, Tr, Th, Td, EmptyRow, SortableTh } from "../components/ui/Table";
import MoneyDisplay from "../components/ui/MoneyDisplay";
import Select from "../components/ui/Select";

const PRODUCTS_CACHE_KEY = "products";

const empty = {
  name: "",
  code: "",
  barcode: "",
  sku: "",
  brand: "",
  unit: "",
  buy_price: "",
  sell_price: "",
  stock: "",
  min_stock: "",
  main_category: "",
  sub_category: "",
  image: "",
  is_active: true,
};

const unitOptionsFa = [
  "عدد",
  "دستگاه",
  "کارتن",
  "بسته",
  "جعبه",
  "ست",
  "جفت",
  "کیلوگرم",
  "گرم",
  "متر",
  "لیتر",
  "بطری",
  "رول",
  "شاخه",
];

const unitOptionsEn = [
  "pcs",
  "device",
  "carton",
  "pack",
  "box",
  "set",
  "pair",
  "kg",
  "g",
  "m",
  "liter",
  "bottle",
  "roll",
  "branch",
];

const unitOptionsAr = [
  "قطعة",
  "جهاز",
  "كرتون",
  "عبوة",
  "صندوق",
  "طقم",
  "زوج",
  "كيلوغرام",
  "غرام",
  "متر",
  "لتر",
  "زجاجة",
  "لفة",
  "فرع",
];

const unitOptionsTr = [
  "Adet",
  "Cihaz",
  "Koli",
  "Paket",
  "Kutu",
  "Set",
  "Çift",
  "kg",
  "g",
  "m",
  "litre",
  "Şişe",
  "Rulo",
  "Dal",
];

const inputClass =
  "bg-[var(--erp-panel-solid)] text-[var(--erp-text)] placeholder-[var(--erp-muted)] border border-[var(--erp-border)] focus:border-[var(--erp-accent)] rounded-2xl p-4 outline-none transition-all w-full";

function toNumber(value) {
  const cleaned = toEnglishDigits(String(value ?? ""))
    .replace(/[,،]/g, "")
    .replace(/[^\d.-]/g, "");
  return Number(cleaned || 0);
}

function faText(value, fa) {
  if (value === null || value === undefined) return "";
  return fa ? toPersianDigits(String(value)) : String(value);
}

function normalizeNumberInput(value, fa) {
  const cleaned = toEnglishDigits(String(value || ""))
    .replace(/[,،]/g, "")
    .replace(/[^\d.-]/g, "");
  return fa ? toPersianDigits(cleaned) : cleaned;
}

function productKey(item = {}) {
  return String(item.id || item.barcode || item.code || item.name || "");
}

function normalizeProduct(item = {}) {
  const sell = item.sell_price ?? item.price ?? 0;

  return {
    ...empty,
    ...item,
    code: item.code || item.barcode || "",
    barcode: item.barcode || item.code || "",
    sell_price: sell,
    price: item.price ?? sell,
    buy_price: item.buy_price ?? item.purchase_price ?? 0,
    stock: item.stock ?? 0,
    min_stock: item.min_stock ?? item.minimum_stock ?? 0,
    unit: item.unit || "عدد",
    brand: item.brand || "",
    sku: item.sku || "",
    main_category: item.main_category || "",
    sub_category: item.sub_category || "",
    image: item.image || "",
    is_active: item.is_active !== false,
  };
}

function mergeServerWithCache(serverItems = [], cachedItems = []) {
  // The server is authoritative whenever online. Never restore stale cached
  // prices, stock, or metadata over a freshly fetched server record.
  // Only retain genuinely pending offline changes for later synchronization.
  const merged = serverItems.map(normalizeProduct);
  const pending = cachedItems.map(normalizeProduct).filter((item) => item.pending_sync);
  for (const item of pending) {
    const index = merged.findIndex((server) =>
      (item.id && String(server.id) === String(item.id)) ||
      (item.code && server.code === item.code)
    );
    if (index >= 0) merged[index] = item;
    else merged.push(item);
  }
  return merged;
}

function Field({ label, children, hint }) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-bold text-[var(--erp-accent)] block">{label}</label>
      {children}
      {hint ? <div className="text-xs text-[var(--erp-muted)]">{hint}</div> : null}
    </div>
  );
}

export default function Products() {
  const { language, n, money, dir } = useLanguage();
  const fa = language === "fa";
  const tr = (faText, arText, trText, enText) =>
    language === "fa" ? faText : language === "ar" ? arText : language === "tr" ? trText : enText;
  const unitOptions =
    language === "fa"
      ? unitOptionsFa
      : language === "ar"
      ? unitOptionsAr
      : language === "tr"
      ? unitOptionsTr
      : unitOptionsEn;

  const { activeCompany, user } = useAuth();
  const productsCacheKey = `${PRODUCTS_CACHE_KEY}:${activeCompany?.id || user?.company_id || "default"}`;
  const [products, setProducts] = useState([]);
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get("q") || "");
  const [form, setForm] = useState({
    ...empty,
    unit:
      language === "fa"
        ? "عدد"
        : language === "ar"
        ? "قطعة"
        : language === "tr"
        ? "Adet"
        : "pcs",
  });
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [offlineMode, setOfflineMode] = useState(false);
  const [categories, setCategories] = useState([]);
  const [brandFilter, setBrandFilter] = useState("all");
  const [unitFilter, setUnitFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [subCategoryFilter, setSubCategoryFilter] = useState("all");
  const [activeFilter, setActiveFilter] = useState("all");
  const [stockStatusFilter, setStockStatusFilter] = useState("all");
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  useEffect(() => {
    getProductCategories()
      .then((data) => setCategories(Array.isArray(data) ? data : []))
      .catch(() => setCategories([]));
  }, []);

  const mainCategoryOptions = useMemo(() => {
    const names = Array.from(new Set(categories.map((c) => c.main_category).filter(Boolean)));
    if (form.main_category && !names.includes(form.main_category)) names.unshift(form.main_category);
    return names;
  }, [categories, form.main_category]);

  const subCategoryOptions = useMemo(() => {
    const names = Array.from(
      new Set(
        categories
          .filter((c) => c.main_category === form.main_category)
          .map((c) => c.sub_category)
          .filter(Boolean)
      )
    );
    if (form.sub_category && !names.includes(form.sub_category)) names.unshift(form.sub_category);
    return names;
  }, [categories, form.main_category, form.sub_category]);

  const label = {
    title: tr("کالاها و خدمات", "المنتجات والخدمات", "Ürünler ve Hizmetler", "Products & Services"),
    subtitle: tr(
      "تعریف کالا، قیمت فروش، قیمت خرید، موجودی، بارکد و حداقل موجودی",
      "تعريف المنتج، سعر البيع، سعر الشراء، المخزون، الباركود والحد الأدنى للمخزون",
      "Ürün, satış fiyatı, alış fiyatı, stok, barkod ve minimum stok tanımı",
      "Define products, sale price, buy price, inventory, barcode and minimum stock"
    ),
    name: tr("نام کالا / خدمت", "اسم المنتج / الخدمة", "Ürün / Hizmet adı", "Product / Service name"),
    code: tr("کد کالا", "كود المنتج", "Ürün kodu", "Product code"),
    barcode: tr("بارکد", "الباركود", "Barkod", "Barcode"),
    sku: tr("SKU / شناسه داخلی", "SKU / الرمز الداخلي", "SKU / Dahili kod", "SKU / Internal code"),
    row: tr("ردیف", "#", "#", "#"),
    active: tr("فعال", "نشط", "Aktif", "Active"),
    inactive: tr("غیرفعال", "غير نشط", "Pasif", "Inactive"),
    brand: tr("برند", "العلامة التجارية", "Marka", "Brand"),
    unit: tr("واحد", "الوحدة", "Birim", "Unit"),
    buy: tr("قیمت خرید", "سعر الشراء", "Alış fiyatı", "Buy price"),
    sell: tr("قیمت فروش", "سعر البيع", "Satış fiyatı", "Sell price"),
    stock: tr("موجودی فعلی", "المخزون الحالي", "Mevcut stok", "Current stock"),
    minStock: tr("حداقل موجودی هشدار", "الحد الأدنى لتنبيه المخزون", "Minimum uyarı stoğu", "Minimum alert stock"),
    mainCategory: tr("گروه اصلی", "التصنيف الرئيسي", "Ana kategori", "Main category"),
    subCategory: tr("زیرگروه", "التصنيف الفرعي", "Alt kategori", "Sub category"),
    uploadImage: tr("تصویر کالا", "صورة المنتج", "Ürün görseli", "Product image"),
    add: tr("ثبت کالا", "إضافة منتج", "Ürün ekle", "Add product"),
    save: tr("ذخیره ویرایش", "حفظ التعديل", "Değişiklikleri kaydet", "Save changes"),
    cancel: tr("لغو ویرایش", "إلغاء التعديل", "Düzenlemeyi iptal et", "Cancel edit"),
    search: tr(
      "جستجوی نام، کد، بارکد، برند یا گروه...",
      "بحث بالاسم أو الكود أو الباركود أو العلامة التجارية أو التصنيف...",
      "Ad, kod, barkod, marka veya kategoriye göre ara...",
      "Search name, code, barcode, brand or category..."
    ),
    noData: tr("هنوز کالایی ثبت نشده است.", "لم يتم تسجيل أي منتج بعد.", "Henüz hiç ürün eklenmedi.", "No product has been created yet."),
    nameRequired: tr("نام کالا را وارد کن", "أدخل اسم المنتج", "Ürün adını girin", "Enter product name"),
  };

  async function saveCache(items) {
    const normalized = Array.isArray(items) ? items.map(normalizeProduct) : [];
    await setCache(productsCacheKey, normalized);
    setProducts(normalized);
  }

  async function load() {
    try {
      setLoading(true);
      setMessage("");
      setOfflineMode(false);

      // Server data must not be blocked by an unavailable or incompatible
      // browser cache; it is the authoritative source while connected.
      let cached = [];
      try {
        cached = (await getCache(productsCacheKey)) || [];
      } catch (cacheError) {
        console.warn("Offline product cache unavailable:", cacheError);
      }
      const data = await getProducts();
      const merged = mergeServerWithCache(
        Array.isArray(data) ? data : [],
        Array.isArray(cached) ? cached : []
      );
      setProducts(merged);
      try {
        await setCache(productsCacheKey, merged);
      } catch (cacheError) {
        console.warn("Could not update offline product cache:", cacheError);
      }
    } catch (e) {
      console.error("Products loading error:", e);

      let cached = null;
      try {
        cached = await getCache(productsCacheKey);
      } catch (cacheError) {
        console.warn("Offline product cache unavailable:", cacheError);
      }

      if (Array.isArray(cached)) {
        setProducts(cached.map(normalizeProduct));
        setOfflineMode(true);
        setMessage(
          tr(
            "اتصال به سرور برقرار نشد؛ کالاها از حافظه آفلاین نمایش داده شدند.",
            "تعذّر الاتصال بالخادم؛ تم عرض المنتجات من الذاكرة غير المتصلة.",
            "Sunucuya bağlanılamadı; ürünler çevrimdışı önbellekten yüklendi.",
            "Server unavailable; products loaded from offline cache."
          )
        );
      } else {
        setMessage(
          tr(
            "خطا در دریافت کالاها از سرور و کش آفلاین موجود نیست",
            "خطأ في تحميل المنتجات من الخادم ولا توجد ذاكرة غير متصلة",
            "Ürünler sunucudan alınamadı ve çevrimdışı önbellek bulunamadı",
            "Error loading products and no offline cache found"
          )
        );
      }
    } finally {
      setLoading(false);
    }
  }

  const stableLoad = useStableCallback(load);

  useEffect(() => {
    const timer = setTimeout(() => { void stableLoad(); }, 0);
    return () => clearTimeout(timer);
  }, [language, stableLoad]);

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerMode, setScannerMode] = useState("form");

  function handleBarcodeDetected(code) {
    setScannerOpen(false);
    if (scannerMode === "search") {
      setSearch(faText(code, fa));
      return;
    }
    setForm((prev) => ({
      ...prev,
      barcode: code,
      code: prev.code || code,
    }));
  }

  function reset() {
    setEditingId(null);
    setForm({ ...empty, unit: tr("عدد", "قطعة", "Adet", "pcs") });
  }

  function buildPayload() {
    return {
      name: form.name.trim(),
      code: toEnglishDigits(form.code || ""),
      barcode: toEnglishDigits(form.barcode || form.code || form.sku || ""),
      sku: toEnglishDigits(form.sku || ""),
      brand: form.brand || "",
      unit: form.unit || tr("عدد", "قطعة", "Adet", "pcs"),
      buy_price: toNumber(form.buy_price),
      purchase_price: toNumber(form.buy_price),
      sell_price: toNumber(form.sell_price),
      price: toNumber(form.sell_price),
      stock: toNumber(form.stock),
      min_stock: toNumber(form.min_stock),
      minimum_stock: toNumber(form.min_stock),
      main_category: form.main_category || "",
      sub_category: form.sub_category || "",
      image: form.image || "",
      is_active: form.is_active !== false,
    };
  }

  async function save() {
    if (!form.name.trim()) {
      toast.error(label.nameRequired);
      return;
    }

    const payload = buildPayload();

    const optimisticItem = normalizeProduct({
      ...payload,
      id: editingId || Date.now(),
      created_at: new Date().toISOString(),
    });

    try {
      const current = Array.isArray(products) ? [...products] : [];

      const optimisticList = editingId
        ? current.map((item) =>
            String(item.id) === String(editingId)
              ? normalizeProduct({ ...item, ...optimisticItem, id: item.id })
              : item
          )
        : [optimisticItem, ...current];

      await saveCache(optimisticList);

      const result = editingId
        ? await updateProduct(editingId, payload)
        : await createProduct(payload);

      if (result?.status === "error") {
        throw new Error(result.message || tr("خطا در ذخیره کالا", "خطأ في حفظ المنتج", "Ürün kaydedilirken hata oluştu", "Error saving product"));
      }

      const serverItem = normalizeProduct({
        ...optimisticItem,
        ...result,
        id: result?.id || optimisticItem.id,
        buy_price: payload.buy_price,
        min_stock: payload.min_stock,
        unit: payload.unit,
        brand: payload.brand,
        sku: payload.sku,
        main_category: payload.main_category,
        sub_category: payload.sub_category,
        image: payload.image,
      });

      const afterServer = editingId
        ? optimisticList.map((item) =>
            String(item.id) === String(editingId) ? serverItem : item
          )
        : optimisticList.map((item, index) => (index === 0 ? serverItem : item));

      await saveCache(afterServer);

      reset();
      await load();
    } catch (e) {
      console.error("Save product error:", e);

      const current = Array.isArray(products) ? [...products] : [];

      // The server was actually reached and rejected the request (403 role
      // restriction, validation error, ...) - retrying later would just
      // fail the same way, so this must NOT be queued as offline_created.
      // `current` here is still the pre-optimistic list (this closure was
      // captured before this save() call's setProducts), so re-saving it
      // as-is rolls back the optimistic add/edit cleanly either way.
      if (!isNetworkError(e)) {
        await saveCache(current);
        setOfflineMode(false);
        setMessage(translateApiError(e.message, language) || tr("خطا در ذخیره کالا", "خطأ في حفظ المنتج", "Ürün kaydedilirken hata oluştu", "Error saving product"));
        return;
      }

      const offlineItem = normalizeProduct({
        ...payload,
        id: editingId || Date.now(),
        pending_sync: true,
        offline_created: !editingId,
        offline_updated_at: new Date().toISOString(),
      });

      const next = editingId
        ? current.map((item) =>
            String(item.id) === String(editingId)
              ? normalizeProduct({ ...item, ...offlineItem, id: item.id })
              : item
          )
        : [offlineItem, ...current];

      await saveCache(next);

      setOfflineMode(true);
      setMessage(
        tr(
          "سرور در دسترس نبود؛ کالا در حافظه آفلاین ذخیره شد.",
          "الخادم غير متاح؛ تم حفظ المنتج في الذاكرة غير المتصلة.",
          "Sunucuya ulaşılamadı; ürün çevrimdışı olarak kaydedildi.",
          "Server unavailable; product saved offline."
        )
      );

      reset();
    }
  }

  function extractProductPayload(item) {
    return {
      name: item.name || "",
      code: toEnglishDigits(item.code || ""),
      barcode: toEnglishDigits(item.barcode || item.code || item.sku || ""),
      sku: toEnglishDigits(item.sku || ""),
      brand: item.brand || "",
      unit: item.unit || tr("عدد", "قطعة", "Adet", "pcs"),
      buy_price: toNumber(item.buy_price),
      purchase_price: toNumber(item.buy_price),
      sell_price: toNumber(item.sell_price),
      price: toNumber(item.sell_price),
      stock: toNumber(item.stock),
      min_stock: toNumber(item.min_stock),
      minimum_stock: toNumber(item.min_stock),
      main_category: item.main_category || "",
      sub_category: item.sub_category || "",
      image: item.image || "",
    };
  }

  function mergeProductResult(item, serverResult, payload) {
    return normalizeProduct({
      ...item,
      ...payload,
      id: item.offline_created ? serverResult?.id || item.id : item.id,
      pending_sync: false,
      offline_created: false,
    });
  }

  async function createProductForSync(payload) {
    const result = await createProduct(payload);
    if (result?.status === "error") throw new Error(result.message || "sync failed");
    return result;
  }

  async function updateProductForSync(id, payload) {
    const result = await updateProduct(id, payload);
    if (result?.status === "error") throw new Error(result.message || "sync failed");
    return result;
  }

  async function syncPendingProducts() {
    if (countPending(products) === 0) return;
    const { items: updated, syncedCount } = await syncPendingRecords(products, {
      extractPayload: extractProductPayload,
      create: createProductForSync,
      update: updateProductForSync,
      mergeResult: mergeProductResult,
    });
    await saveCache(updated);
    if (syncedCount > 0) {
      setMessage(
        tr(
          `${toPersianDigits(syncedCount)} کالای آفلاین همگام‌سازی شد.`,
          `تمت مزامنة ${syncedCount} منتج غير متصل.`,
          `${syncedCount} çevrimdışı ürün eşitlendi.`,
          `${syncedCount} offline product(s) synced.`
        )
      );
    }
  }

  useOnlineSync(syncPendingProducts);

  async function handleDeleteProduct(product) {
    const ok = await confirmAction(
      tr(
        `کالای «${product.name || ""}» حذف شود؟`,
        `هل تريد حذف المنتج «${product.name || ""}»؟`,
        `«${product.name || ""}» ürünü silinsin mi?`,
        `Delete "${product.name || ""}"?`
      ),
      { danger: true }
    );
    if (!ok) return;

    try {
      const result = await deleteProduct(product.id);

      if (result?.status === "error") {
        throw new Error(result.message || tr("خطا در حذف کالا", "خطأ في حذف المنتج", "Ürün silinirken hata oluştu", "Error deleting product"));
      }

      if (String(editingId) === String(product.id)) reset();
      await load();
    } catch (e) {
      console.error("Delete product error:", e);

      // The server was reached and rejected the delete (linked invoices,
      // RBAC, ...) - hiding the product locally while claiming it was
      // "removed from offline cache" would be misleading since it still
      // exists on the server. Only a genuine connectivity failure should
      // fall back to a local-only removal.
      if (!isNetworkError(e)) {
        setOfflineMode(false);
        setMessage(translateApiError(e.message, language) || tr("خطا در حذف کالا", "خطأ في حذف المنتج", "Ürün silinirken hata oluştu", "Error deleting product"));
        return;
      }

      const filteredItems = products.filter(
        (item) => String(item.id) !== String(product.id)
      );

      await saveCache(filteredItems);

      if (String(editingId) === String(product.id)) reset();

      setOfflineMode(true);
      setMessage(
        tr(
          "سرور در دسترس نبود؛ کالا فقط از حافظه آفلاین حذف شد.",
          "الخادم غير متاح؛ تم حذف المنتج من الذاكرة غير المتصلة فقط.",
          "Sunucuya ulaşılamadı; ürün yalnızca çevrimdışı önbellekten kaldırıldı.",
          "Server unavailable; product removed from offline cache only."
        )
      );
    }
  }

  function edit(product) {
    const item = normalizeProduct(product);

    setEditingId(item.id);
    setForm({
      ...empty,
      ...item,
      code: faText(item.code || item.barcode || "", fa),
      barcode: faText(item.barcode || item.code || "", fa),
      sku: faText(item.sku || "", fa),
      brand: faText(item.brand || "", fa),
      sell_price: toNumber(item.sell_price ?? item.price) === 0 ? "" : faText(item.sell_price ?? item.price, fa),
      buy_price: toNumber(item.buy_price) === 0 ? "" : faText(item.buy_price, fa),
      stock: toNumber(item.stock) === 0 ? "" : faText(item.stock, fa),
      min_stock: toNumber(item.min_stock) === 0 ? "" : faText(item.min_stock, fa),
      unit: item.unit || tr("عدد", "قطعة", "Adet", "pcs"),
      main_category: faText(item.main_category || "", fa),
      sub_category: faText(item.sub_category || "", fa),
      image: item.image || "",
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function imageChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => setField("image", reader.result);
    reader.readAsDataURL(file);
  }

  const brandOptions = useMemo(
    () => Array.from(new Set(products.map((p) => p.brand).filter(Boolean))).sort(),
    [products]
  );
  const unitOptionsFromData = useMemo(
    () => Array.from(new Set(products.map((p) => p.unit).filter(Boolean))).sort(),
    [products]
  );
  const categoryFilterOptions = useMemo(
    () => Array.from(new Set(products.map((p) => p.main_category).filter(Boolean))).sort(),
    [products]
  );
  // Constrained to the selected main category, same hierarchy the create/
  // edit form already uses (categories is the product_categories list).
  const subCategoryFilterOptions = useMemo(() => {
    if (categoryFilter === "all") {
      return Array.from(new Set(products.map((p) => p.sub_category).filter(Boolean))).sort();
    }
    return Array.from(
      new Set(
        products
          .filter((p) => p.main_category === categoryFilter)
          .map((p) => p.sub_category)
          .filter(Boolean)
      )
    ).sort();
  }, [products, categoryFilter]);

  function onSort(field, dir) {
    setSortField(field);
    setSortDir(dir);
  }

  const filtered = useMemo(() => {
    const q = toEnglishDigits(search).toLowerCase();

    const matched = products.filter((p) => {
      const matchesSearch = [
        p.name,
        p.code,
        p.barcode,
        p.sku,
        p.brand,
        p.main_category,
        p.sub_category,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
      const matchesBrand = brandFilter === "all" || p.brand === brandFilter;
      const matchesUnit = unitFilter === "all" || p.unit === unitFilter;
      const matchesCategory = categoryFilter === "all" || p.main_category === categoryFilter;
      const matchesSubCategory = subCategoryFilter === "all" || p.sub_category === subCategoryFilter;
      const matchesActive =
        activeFilter === "all" || (activeFilter === "active" ? p.is_active !== false : p.is_active === false);
      const stock = toNumber(p.stock);
      const minStock = toNumber(p.min_stock);
      const matchesStockStatus =
        stockStatusFilter === "all" ||
        (stockStatusFilter === "out_of_stock" && stock <= 0) ||
        (stockStatusFilter === "low_stock" && stock > 0 && minStock > 0 && stock <= minStock) ||
        (stockStatusFilter === "in_stock" && stock > 0 && (minStock <= 0 || stock > minStock));
      return matchesSearch && matchesBrand && matchesUnit && matchesCategory && matchesSubCategory && matchesActive && matchesStockStatus;
    });

    if (!sortField) return matched;

    const dirMul = sortDir === "asc" ? 1 : -1;
    return [...matched].sort((a, b) => {
      if (sortField === "name" || sortField === "brand") {
        return dirMul * String(a[sortField] || "").localeCompare(String(b[sortField] || ""), fa ? "fa" : language);
      }
      const numericField = sortField === "sell_price" ? (a) => toNumber(a.sell_price ?? a.price) : (a) => toNumber(a[sortField]);
      return dirMul * (numericField(a) - numericField(b));
    });
  }, [products, search, brandFilter, unitFilter, categoryFilter, subCategoryFilter, activeFilter, stockStatusFilter, sortField, sortDir, fa, language]);

  const activeChips = [
    search.trim() && { key: "search", label: `${tr("جستجو", "بحث", "Arama", "Search")}: ${search.trim()}`, clear: () => setSearch("") },
    brandFilter !== "all" && { key: "brand", label: `${label.brand}: ${brandFilter}`, clear: () => setBrandFilter("all") },
    unitFilter !== "all" && { key: "unit", label: `${label.unit}: ${unitFilter}`, clear: () => setUnitFilter("all") },
    categoryFilter !== "all" && { key: "category", label: `${tr("گروه", "المجموعة", "Grup", "Group")}: ${categoryFilter}`, clear: () => { setCategoryFilter("all"); setSubCategoryFilter("all"); } },
    subCategoryFilter !== "all" && { key: "subCategory", label: `${tr("زیرگروه", "المجموعة الفرعية", "Alt grup", "Subcategory")}: ${subCategoryFilter}`, clear: () => setSubCategoryFilter("all") },
    activeFilter !== "all" && { key: "active", label: activeFilter === "active" ? tr("فعال", "نشط", "Aktif", "Active") : tr("غیرفعال", "غير نشط", "Pasif", "Inactive"), clear: () => setActiveFilter("all") },
    stockStatusFilter !== "all" && {
      key: "stockStatus",
      label: stockStatusFilter === "out_of_stock" ? tr("ناموجود", "نفد المخزون", "Stok yok", "Out of stock") : stockStatusFilter === "low_stock" ? tr("موجودی کم", "مخزون منخفض", "Az stok", "Low stock") : tr("موجود", "متوفر", "Stokta", "In stock"),
      clear: () => setStockStatusFilter("all"),
    },
  ].filter(Boolean);

  function clearAllFilters() {
    setSearch("");
    setBrandFilter("all");
    setUnitFilter("all");
    setCategoryFilter("all");
    setSubCategoryFilter("all");
    setActiveFilter("all");
    setStockStatusFilter("all");
  }

  const totalStock = products.reduce((sum, p) => sum + toNumber(p.stock), 0);

  const lowStock = products.filter(
    (p) => toNumber(p.min_stock) > 0 && toNumber(p.stock) <= toNumber(p.min_stock)
  ).length;

  const stockValue = products.reduce(
    (sum, p) => sum + toNumber(p.stock) * toNumber(p.sell_price ?? p.price),
    0
  );

  return (
    <div className="space-y-6 vitalix-products-page" dir={dir} style={{ direction: dir }}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-black text-[var(--erp-accent)]">{label.title}</h1>
          <p className="text-[var(--erp-muted)] mt-2">{label.subtitle}</p>
        </div>

        <button
          type="button"
          onClick={load}
          className="px-4 py-3 rounded-2xl bg-[var(--erp-panel-solid)] text-[var(--erp-accent)] font-bold flex items-center gap-2 border border-[var(--erp-border)]"
        >
          <RefreshCw size={18} />
          {tr("به‌روزرسانی", "تحديث", "Yenile", "Refresh")}
        </button>
      </div>

      {message && (
        <div
          className={`rounded-2xl p-4 flex items-center gap-2 ${
            offlineMode
              ? "bg-amber-500/15 border border-amber-400/30 text-amber-100"
              : "bg-red-500/15 border border-red-400/30 text-red-200"
          }`}
        >
          <AlertTriangle size={20} />
          {message}
        </div>
      )}

      {countPending(products) > 0 && (
        <div className="rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 bg-amber-500/15 border border-amber-400/30 text-amber-100">
          <span>
            {tr(
              `${toPersianDigits(countPending(products))} کالای آفلاین در انتظار همگام‌سازی است.`,
              `${countPending(products)} منتج غير متصل بانتظار المزامنة.`,
              `${countPending(products)} çevrimdışı ürün eşitleme bekliyor.`,
              `${countPending(products)} offline product(s) waiting to sync.`
            )}
          </span>
          <button
            type="button"
            onClick={() => void syncPendingProducts()}
            className="px-3 py-2 rounded-xl bg-amber-400 text-black font-bold text-sm"
          >
            {tr("همگام‌سازی الان", "مزامنة الآن", "Şimdi eşitle", "Sync now")}
          </button>
        </div>
      )}

      <div className="vitalix-products-summary grid gap-5">
        <Summary icon={<Package />} title={tr("تعداد کالا", "عدد المنتجات", "Ürün sayısı", "Products")} value={n(products.length)} />
        <Summary icon={<Boxes />} title={tr("موجودی کل", "إجمالي المخزون", "Toplam stok", "Total stock")} value={n(totalStock)} />
        <Summary
          icon={<AlertTriangle />}
          title={tr("ارزش موجودی فروش", "قيمة المخزون البيعية", "Stok satış değeri", "Stock sale value")}
          value={money(stockValue)}
          danger={lowStock > 0}
          subtitle={
            lowStock
              ? tr(
                  `${n(lowStock)} کالا زیر حداقل`,
                  `${n(lowStock)} منتج تحت الحد الأدنى`,
                  `${n(lowStock)} ürün minimum altında`,
                  `${n(lowStock)} low-stock items`
                )
              : ""
          }
        />
      </div>

      <div className="bg-[var(--erp-bg-soft)] border border-[var(--erp-border)] rounded-3xl p-5">
        <div className="vitalix-products-form-grid grid gap-4">
          <Field label={label.name}>
            <input className={inputClass} value={faText(form.name, fa)} onChange={(e) => setField("name", faText(e.target.value, fa))} placeholder={label.name} />
          </Field>

          <Field label={label.code}>
            <input className={inputClass} value={faText(form.code, fa)} onChange={(e) => setField("code", faText(e.target.value, fa))} placeholder={label.code} />
          </Field>

          <Field label={label.barcode}>
            <div className="flex gap-2">
              <input className={inputClass} value={faText(form.barcode, fa)} onChange={(e) => setField("barcode", faText(e.target.value, fa))} placeholder={label.barcode} />
              <button
                type="button"
                onClick={() => { setScannerMode("form"); setScannerOpen(true); }}
                className="px-3 rounded-xl bg-[var(--erp-glow)] text-[var(--erp-accent)] flex items-center justify-center"
                title={tr("اسکن بارکد", "مسح الباركود", "Barkod tara", "Scan barcode")}
              >
                <ScanBarcode size={18} />
              </button>
            </div>
          </Field>

          <Field label={label.sku}>
            <input className={inputClass} value={faText(form.sku, fa)} onChange={(e) => setField("sku", faText(e.target.value, fa))} placeholder={label.sku} />
          </Field>

          <Field label={label.brand}>
            <input className={inputClass} value={faText(form.brand, fa)} onChange={(e) => setField("brand", faText(e.target.value, fa))} placeholder={label.brand} />
          </Field>

          <Field label={label.unit}>
            <Select
              className="w-full"
              triggerClassName="!rounded-2xl !p-4"
              value={form.unit || tr("عدد", "قطعة", "Adet", "pcs")}
              onChange={(value) => setField("unit", value)}
              options={unitOptions.map((unit) => ({ value: unit, label: unit }))}
            />
          </Field>

          <Field label={label.buy}>
            <input type="text" inputMode="numeric" className={inputClass} value={form.buy_price} onChange={(e) => setField("buy_price", normalizeNumberInput(e.target.value, fa))} placeholder={fa ? "۰" : "0"} />
          </Field>

          <Field label={label.sell}>
            <input type="text" inputMode="numeric" className={inputClass} value={form.sell_price} onChange={(e) => setField("sell_price", normalizeNumberInput(e.target.value, fa))} placeholder={fa ? "۰" : "0"} />
          </Field>

          <Field label={label.stock}>
            <input type="text" inputMode="numeric" className={inputClass} value={form.stock} onChange={(e) => setField("stock", normalizeNumberInput(e.target.value, fa))} placeholder={fa ? "۰" : "0"} />
          </Field>

          <Field label={label.minStock}>
            <input type="text" inputMode="numeric" className={inputClass} value={form.min_stock} onChange={(e) => setField("min_stock", normalizeNumberInput(e.target.value, fa))} placeholder={fa ? "۰" : "0"} />
          </Field>

          <Field
            label={label.mainCategory}
            hint={tr(
              "دسته‌بندی‌های جدید را از صفحه «دسته‌بندی کالا» اضافه کن",
              "أضف تصنيفات جديدة من صفحة «تصنيفات المنتجات»",
              "Yeni kategorileri «Ürün Kategorileri» sayfasından ekleyin",
              "Add new categories from the Product Categories page"
            )}
          >
            <Select
              className="w-full"
              triggerClassName="!rounded-2xl !p-4"
              value={form.main_category}
              onChange={(value) => { setField("main_category", value); setField("sub_category", ""); }}
              options={[
                { value: "", label: tr("بدون گروه اصلی", "بدون تصنيف رئيسي", "Ana kategori yok", "No main category") },
                ...mainCategoryOptions.map((name) => ({ value: name, label: name })),
              ]}
            />
          </Field>

          <Field label={label.subCategory}>
            <Select
              className="w-full"
              triggerClassName="!rounded-2xl !p-4"
              value={form.sub_category}
              onChange={(value) => setField("sub_category", value)}
              disabled={!form.main_category}
              options={[
                { value: "", label: tr("بدون زیرگروه", "بدون تصنيف فرعي", "Alt kategori yok", "No sub category") },
                ...subCategoryOptions.map((name) => ({ value: name, label: name })),
              ]}
            />
          </Field>

          <label className="bg-[var(--erp-panel-solid)] rounded-2xl p-4 outline-none flex items-center gap-2 cursor-pointer border border-[var(--erp-border)]">
            <ImagePlus size={18} />
            {label.uploadImage}
            <input type="file" accept="image/*" onChange={imageChange} className="hidden" />
          </label>

          <Field label={label.active}>
            <label className="bg-[var(--erp-panel-solid)] rounded-2xl p-4 flex items-center gap-2 cursor-pointer border border-[var(--erp-border)]">
              <input type="checkbox" checked={form.is_active !== false} onChange={(e) => setField("is_active", e.target.checked)} />
              <span className="text-sm text-[var(--erp-text)]">{form.is_active !== false ? label.active : label.inactive}</span>
            </label>
          </Field>
        </div>

        {form.image && (
          <img src={form.image} alt="product" className="mt-4 w-24 h-24 object-cover rounded-2xl border border-[var(--erp-border)]" />
        )}

        {editingId && (
          <div className="mt-5">
            <ProductBatchesPanel productId={editingId} />
          </div>
        )}

        <div className="flex gap-3 flex-wrap mt-5">
          <button type="button" onClick={save} className="px-5 py-3 rounded-2xl bg-[var(--erp-accent)] text-slate-950 font-black flex items-center gap-2">
            {editingId ? <Save size={18} /> : <Plus size={18} />}
            {editingId ? label.save : label.add}
          </button>

          {editingId && (
            <button type="button" onClick={reset} className="px-5 py-3 rounded-2xl bg-[var(--erp-panel-solid)] text-[var(--erp-text)] font-black flex items-center gap-2">
              <X size={18} />
              {label.cancel}
            </button>
          )}
        </div>
      </div>

      <div className="bg-[var(--erp-bg-soft)] border border-[var(--erp-border)] rounded-3xl p-5">
        {/* Search: shared .vitalix-input-group pattern (focus ring on the
            rounded outer container via :focus-within, not the bare
            <input>) - !rounded-2xl matches this page's own control radius
            (inputClass/the Select overrides below) rather than the
            group's 12px default, so it stays coherent with the rest of
            Products.jsx's chrome instead of introducing a second radius. */}
        <div className="vitalix-input-group !rounded-2xl flex items-center gap-2 mb-3 flex-wrap" style={{ padding: "0 16px" }}>
          <Search size={18} className="text-[var(--erp-accent)] shrink-0" aria-hidden="true" />
          <input
            value={faText(search, fa)}
            onChange={(e) => setSearch(faText(e.target.value, fa))}
            placeholder={label.search}
            aria-label={label.search}
            className="min-w-0 flex-1"
            style={{ color: "var(--erp-text)", padding: "16px 0" }}
          />
          <button
            type="button"
            onClick={() => { setScannerMode("search"); setScannerOpen(true); }}
            className="text-[var(--erp-accent)] flex items-center justify-center shrink-0"
            title={tr("اسکن بارکد برای جستجو", "مسح الباركود للبحث", "Aramak için barkod tara", "Scan barcode to search")}
          >
            <ScanBarcode size={18} />
          </button>
        </div>

        <div className="vitalix-products-filters flex items-center gap-2 flex-wrap mb-5">
          <Select
            value={brandFilter}
            onChange={(value) => setBrandFilter(value)}
            className="w-40 shrink-0"
            triggerClassName="!rounded-2xl !p-4"
            options={[
              { value: "all", label: tr("همه برندها", "كل العلامات", "Tüm markalar", "All brands") },
              ...brandOptions.map((b) => ({ value: b, label: b })),
            ]}
          />
          <Select
            value={unitFilter}
            onChange={(value) => setUnitFilter(value)}
            className="w-36 shrink-0"
            triggerClassName="!rounded-2xl !p-4"
            options={[
              { value: "all", label: tr("همه واحدها", "كل الوحدات", "Tüm birimler", "All units") },
              ...unitOptionsFromData.map((u) => ({ value: u, label: u })),
            ]}
          />
          {categoryFilterOptions.length > 0 && (
            <Select
              value={categoryFilter}
              onChange={(value) => { setCategoryFilter(value); setSubCategoryFilter("all"); }}
              className="w-48 shrink-0"
              triggerClassName="!rounded-2xl !p-4"
              options={[
                { value: "all", label: tr("همه گروه‌های اصلی", "كل التصنيفات الرئيسية", "Tüm ana kategoriler", "All main categories") },
                ...categoryFilterOptions.map((c) => ({ value: c, label: c })),
              ]}
            />
          )}
          {subCategoryFilterOptions.length > 0 && (
            <Select
              value={subCategoryFilter}
              onChange={(value) => setSubCategoryFilter(value)}
              className="w-44 shrink-0"
              triggerClassName="!rounded-2xl !p-4"
              options={[
                { value: "all", label: tr("همه زیرگروه‌ها", "كل المجموعات الفرعية", "Tüm alt gruplar", "All subcategories") },
                ...subCategoryFilterOptions.map((c) => ({ value: c, label: c })),
              ]}
            />
          )}
          <Select
            value={stockStatusFilter}
            onChange={(value) => setStockStatusFilter(value)}
            className="w-48 shrink-0"
            triggerClassName="!rounded-2xl !p-4"
            options={[
              { value: "all", label: tr("هر وضعیت موجودی", "أي حالة مخزون", "Her stok durumu", "Any stock status") },
              { value: "in_stock", label: tr("موجود", "متوفر", "Stokta", "In stock") },
              { value: "low_stock", label: tr("موجودی کم", "مخزون منخفض", "Az stok", "Low stock") },
              { value: "out_of_stock", label: tr("ناموجود", "نفد المخزون", "Stok yok", "Out of stock") },
            ]}
          />
          <Select
            value={activeFilter}
            onChange={(value) => setActiveFilter(value)}
            className="w-44 shrink-0"
            triggerClassName="!rounded-2xl !p-4"
            options={[
              { value: "all", label: tr("فعال و غیرفعال", "نشط وغير نشط", "Aktif ve pasif", "Active & inactive") },
              { value: "active", label: tr("فقط فعال", "نشط فقط", "Sadece aktif", "Active only") },
              { value: "inactive", label: tr("فقط غیرفعال", "غير نشط فقط", "Sadece pasif", "Inactive only") },
            ]}
          />
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <div className="flex items-center gap-2 flex-wrap">
            {activeChips.length > 0 ? (
              <>
                {activeChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={chip.clear}
                    className="flex items-center gap-1 px-3 py-1 rounded-full bg-[var(--erp-accent)]/15 text-[var(--erp-accent)] text-xs font-bold"
                  >
                    {chip.label}
                    <X size={12} />
                  </button>
                ))}
                <button type="button" onClick={clearAllFilters} className="text-xs font-bold text-[var(--erp-muted)] underline">
                  {tr("پاک کردن همه فیلترها", "مسح كل الفلاتر", "Tüm filtreleri temizle", "Clear all filters")}
                </button>
              </>
            ) : (
              <span className="text-xs text-[var(--erp-muted)]">{tr("بدون فیلتر فعال", "لا توجد فلاتر نشطة", "Aktif filtre yok", "No active filters")}</span>
            )}
          </div>
          <span className="text-xs font-bold text-[var(--erp-muted)]">
            {tr(`${n(filtered.length)} نتیجه`, `${n(filtered.length)} نتيجة`, `${n(filtered.length)} sonuç`, `${n(filtered.length)} results`)}
          </span>
        </div>

        <BarcodeScannerModal
          open={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onDetected={handleBarcodeDetected}
          fa={fa}
        />

        <Table className="vitalix-products-table">
          <Thead>
            <Th className="w-12">{label.row}</Th>
            <SortableTh field="name" sortField={sortField} sortDir={sortDir} onSort={onSort}>{tr("کالا", "المنتج", "Ürün", "Product")}</SortableTh>
            <SortableTh field="brand" sortField={sortField} sortDir={sortDir} onSort={onSort}>{label.brand}</SortableTh>
            <SortableTh field="buy_price" sortField={sortField} sortDir={sortDir} onSort={onSort}>{label.buy}</SortableTh>
            <SortableTh field="sell_price" sortField={sortField} sortDir={sortDir} onSort={onSort}>{label.sell}</SortableTh>
            <SortableTh field="stock" sortField={sortField} sortDir={sortDir} onSort={onSort}>{label.stock}</SortableTh>
            <SortableTh field="min_stock" sortField={sortField} sortDir={sortDir} onSort={onSort}>{label.minStock}</SortableTh>
            <Th>{tr("عملیات", "الإجراءات", "İşlemler", "Actions")}</Th>
          </Thead>

          <Tbody>
            {loading ? (
              <EmptyRow colSpan={8}>{tr("در حال دریافت...", "جارٍ التحميل...", "Yükleniyor...", "Loading...")}</EmptyRow>
            ) : filtered.length === 0 ? (
              <EmptyRow colSpan={8}>
                {products.length === 0
                  ? label.noData
                  : tr("با این فیلترها کالایی پیدا نشد.", "لا توجد منتجات مطابقة لهذه الفلاتر.", "Bu filtrelerle eşleşen ürün bulunamadı.", "No products match these filters.")}
              </EmptyRow>
            ) : (
              filtered.map((raw, index) => {
                const item = normalizeProduct(raw);
                const isLow = toNumber(item.min_stock) > 0 && toNumber(item.stock) <= toNumber(item.min_stock);

                return (
                  <Tr key={item.id} className="hover:bg-cyan-500/5">
                    <Td className="text-[var(--erp-muted)] font-bold">{n(index + 1)}</Td>
                    <Td>
                      <div className="vitalix-products-name flex items-center gap-3">
                        <div className="w-12 h-12 rounded-xl bg-[var(--erp-glow)] flex items-center justify-center overflow-hidden shrink-0">
                          {item.image ? <img src={item.image} className="w-full h-full object-cover" alt="" /> : <Package size={18} />}
                        </div>

                        <div className="min-w-0">
                          <b className="block break-words">
                            {faText(item.name, fa)}
                            {item.is_active === false && <span className="mx-2 text-xs px-2 py-0.5 rounded-full bg-[var(--erp-muted)]/20 text-[var(--erp-muted)]">{label.inactive}</span>}
                            {item.pending_sync && <span className="mx-2 text-xs text-amber-300">{tr("آفلاین", "غير متصل", "Çevrimdışı", "Offline")}</span>}
                          </b>
                          <div className="text-[var(--erp-muted)] text-xs">
                            {faText(item.barcode || item.code || "-", fa)} • {!fa && item.unit === "عدد" ? tr("", "قطعة", "Adet", "pcs") : faText(item.unit || "-", fa)}
                          </div>
                        </div>
                      </div>
                    </Td>

                    <Td>{faText(item.brand || "-", fa)}</Td>
                    <Td><MoneyDisplay value={item.buy_price || 0} /></Td>
                    <Td><MoneyDisplay value={item.sell_price ?? item.price ?? 0} /></Td>

                    <Td className={isLow ? "text-red-300 font-black" : "text-[var(--erp-accent)] font-bold"}>
                      {n(item.stock || 0)}
                    </Td>

                    <Td>{n(item.min_stock || 0)}</Td>

                    <Td>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button type="button" onClick={() => edit(item)} className="px-3 py-2 rounded-xl bg-[var(--erp-glow)] text-[var(--erp-accent)] inline-flex items-center gap-2">
                          <Edit3 size={16} />
                          {tr("ویرایش", "تعديل", "Düzenle", "Edit")}
                        </button>

                        <button type="button" onClick={() => handleDeleteProduct(item)} className="px-3 py-2 rounded-xl bg-red-500/20 text-red-300 inline-flex items-center gap-2">
                          <Trash2 size={16} />
                          {tr("حذف", "حذف", "Sil", "Delete")}
                        </button>
                      </div>
                    </Td>
                  </Tr>
                );
              })
            )}
          </Tbody>
        </Table>
      </div>
    </div>
  );
}

function Summary({ icon, title, value, subtitle, danger }) {
  return (
    <div className="bg-[var(--erp-bg-soft)] border border-[var(--erp-border)] rounded-3xl p-5">
      <div className="flex items-center gap-3 text-[var(--erp-accent)] mb-3">
        {icon}
        <span className="text-[var(--erp-muted)] font-bold">{title}</span>
      </div>

      <div className={`text-3xl font-black ${danger ? "text-red-300" : "text-[var(--erp-accent)]"}`}>
        {value}
      </div>

      {subtitle && <div className="text-xs text-amber-300 mt-2">{subtitle}</div>}
    </div>
  );
}
