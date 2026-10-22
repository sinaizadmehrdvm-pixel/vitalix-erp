import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, History, LayoutTemplate, Save, Trash2, Upload } from "lucide-react";
import toast from "react-hot-toast";
import { useLanguage } from "../localization/useLanguage";
import { API_URL, getAuthHeaders } from "../services/api";
import { toPersianDigits, toEnglishDigits } from "../localization/helpers";
import { confirmAction } from "../components/ui/confirmService";
import {
  applyImport, deleteImportBatch, downloadImportTemplate, getImportBatches, previewImport,
  inspectImportFile, getMappingProfiles, saveMappingProfile,
  previewExistingCustomerOpening, applyExistingCustomerOpening,
} from "../services/dataImportApi";
import ProductImportWizard from "./dataImport/ProductImportWizard";
import JalaliDateField from "../components/forms/JalaliDateField";
import { toJalali } from "../utils/date";
import Select from "../components/ui/Select";

// Mirrors backend/app/data_import.py's REQUIRED_FIELD - used only to mark
// the required column with an asterisk in the mapping table.
const REQUIRED_FIELD_LABEL = {
  customers: "name",
  gl_trial_balance: "account_code",
  invoices: "date",
  employees: "first_name",
};

export default function DataImportCenter() {
  const { language, dir, n, date } = useLanguage();
  const tr = (faText, arText, trText, enText) =>
    language === "fa" ? faText : language === "ar" ? arText : language === "tr" ? trText : enText;
  const pd = (value) => (language === "fa" ? toPersianDigits(value) : value);
  const [entity, setEntity] = useState("customers");
  const [file, setFile] = useState(null);
  const [parasayFiles, setParasayFiles] = useState({});
  const [parasayPreviews, setParasayPreviews] = useState({});
  const [parasayStaged, setParasayStaged] = useState({});
  const [parasayBusy, setParasayBusy] = useState(false);
  const [quickStartReport, setQuickStartReport] = useState(null);
  const [stockPreflight, setStockPreflight] = useState(null);
  const [directStockFile, setDirectStockFile] = useState(null);
  const [directStockPreview, setDirectStockPreview] = useState(null);
  const [directBankPreview, setDirectBankPreview] = useState(null);
  const [cashOpeningIrr, setCashOpeningIrr] = useState("");
  const [cashOpeningCutoff, setCashOpeningCutoff] = useState("");
  const [cashOpeningPreview, setCashOpeningPreview] = useState(null);
  const [parasayPackage, setParasayPackage] = useState(null);
  const [parasayPackagePreview, setParasayPackagePreview] = useState(null);
  const [parasayStageStatus, setParasayStageStatus] = useState(null);
  const [parasayPackageApplied, setParasayPackageApplied] = useState(false);
  const [parasayFinalReview, setParasayFinalReview] = useState(null);
  const [parasayNegativeAcknowledged, setParasayNegativeAcknowledged] = useState(false);
  const [parasayPersonalAcknowledged, setParasayPersonalAcknowledged] = useState(false);
  const [openingDate, setOpeningDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState(null);
  const [customerOpeningPreview, setCustomerOpeningPreview] = useState(null);
  const [batches, setBatches] = useState([]);
  const [busy, setBusy] = useState(false);
  const [inspectData, setInspectData] = useState(null);
  const [mappingOverride, setMappingOverride] = useState({});
  const [profiles, setProfiles] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const t = {
    title: tr("ورود گروهی امن اطلاعات و مهاجرت داده", "استيراد آمن للبيانات بالجملة", "Güvenli toplu veri içe aktarma", "Safe Bulk Data Import & Migration"),
    sub: tr(
      "فایل ابتدا بررسی می‌شود و تا تأیید شما هیچ داده‌ای ثبت نخواهد شد.",
      "يتم التحقق من الملف أولاً، ولن يتم تسجيل أي بيانات حتى تؤكد ذلك.",
      "Dosya önce doğrulanır; siz onaylayana kadar hiçbir veri kaydedilmez.",
      "Files are validated first; nothing is written until you approve."
    ),
    order: tr(
      "ترتیب پیشنهادی مهاجرت: ۱) طرف‌حساب‌ها (با مانده افتتاحیه) ۲) کالاها (با موجودی اولیه) ۳) سند افتتاحیه کلی (فقط برای حساب‌هایی مثل صندوق/بانک که در مرحله ۱ و ۲ پوشش داده نشدند) ۴) فاکتورهای تاریخی. مانده افتتاحیه یک مشتری را که فاکتور تاریخی برایش وارد می‌کنید صفر بگذارید تا مبلغ دو بار حساب نشود.",
      null, null,
      "Suggested migration order: 1) Parties (with opening balance) 2) Products (with opening stock) 3) Opening trial balance (only for accounts like cash/bank not covered in step 1-2) 4) Historical invoices. Leave a customer's opening_balance at zero if you're importing historical invoices for them, to avoid double counting."
    ),
    customers: tr("طرف‌حساب‌ها", "الأطراف", "Cariler", "Parties"),
    products: tr("کالاها", "المنتجات", "Ürünler", "Products"),
    gl_trial_balance: tr("سند افتتاحیه کلی (تراز آزمایشی)", "ميزان المراجعة الافتتاحي", "Açılış mizanı", "Opening trial balance"),
    invoices: tr("فاکتورهای تاریخی (فروش)", "فواتير المبيعات السابقة", "Geçmiş satış faturaları", "Historical sales invoices"),
    employees: tr("پرسنل", "الموظفون", "Personel", "Employees"),
    openingDateLabel: tr("تاریخ سند افتتاحیه", "تاريخ الافتتاح", "Açılış tarihi", "Opening date"),
    template: tr("دانلود الگوی Excel", "تنزيل قالب Excel", "Excel şablonunu indir", "Download Excel template"),
    choose: tr("انتخاب فایل Excel", "اختر ملف Excel", "Excel dosyası seçin", "Choose Excel file"),
    preview: tr("بررسی و پیش‌نمایش", "التحقق والمعاينة", "Doğrula ve önizle", "Validate and preview"),
    apply: tr("تأیید و ثبت نهایی", "تأكيد وتطبيق نهائي", "Onayla ve uygula", "Approve and apply"),
    total: tr("کل ردیف‌ها", "إجمالي الصفوف", "Toplam satır", "Total rows"),
    valid: tr("معتبر", "صالح", "Geçerli", "Valid"),
    errors: tr("خطادار", "به خطأ", "Hatalı", "Errors"),
    duplicate: tr("تکراری", "مكرر", "Yinelenen", "Duplicates"),
    history: tr("تاریخچه ورود اطلاعات", "سجل استيراد البيانات", "Veri içe aktarma geçmişi", "Import history"),
    status: tr("وضعیت", "الحالة", "Durum", "Status"),
    file: tr("فایل", "الملف", "Dosya", "File"),
    no: tr("هنوز دسته‌ای ثبت نشده است.", "لم يتم تسجيل أي دفعة بعد.", "Henüz içe aktarma grubu yok.", "No import batches yet."),
    deleteBatch: tr("حذف این سابقه", "حذف هذا السجل", "Bu kaydı sil", "Delete this record"),
    deleteBatchConfirm: tr("این سابقه ورود اطلاعات حذف شود؟ داده‌های واقعاً ثبت‌شده تغییری نمی‌کند.", "هل تريد حذف سجل الاستيراد هذا؟ البيانات المُسجَّلة فعليًا لن تتغير.", "Bu içe aktarma kaydı silinsin mi? Gerçekten yazılan veriler değişmez.", "Delete this import record? Data that was actually written is unaffected."),
    deleteBatchDone: tr("سابقه حذف شد", "تم حذف السجل", "Kayıt silindi", "Record deleted"),
    mappingTitle: tr(
      "مدل انتقال (نگاشت ستون‌ها)",
      "نموذج النقل (تخطيط الأعمدة)",
      "Aktarım modeli (sütun eşleme)",
      "Migration template (column mapping)"
    ),
    mappingHint: tr(
      "ستون‌های فایل شما به‌صورت خودکار تشخیص داده شد. اگر فایل از برنامه دیگری صادر شده و نام ستون‌ها متفاوت است، نگاشت را اصلاح و به‌عنوان یک مدل جدید ذخیره کنید تا دفعات بعد با یک کلیک همان مدل را انتخاب کنید.",
      "تم اكتشاف أعمدة ملفك تلقائيًا. إذا كان الملف مُصدَّرًا من برنامج آخر بأسماء أعمدة مختلفة، عدّل التخطيط واحفظه كنموذج جديد لاستخدامه لاحقًا بنقرة واحدة.",
      "Dosyanızın sütunları otomatik algılandı. Dosya başka bir programdan farklı sütun adlarıyla dışa aktarıldıysa eşlemeyi düzenleyip yeni bir model olarak kaydedin; sonraki seferlerde tek tıkla seçebilirsiniz.",
      "Your file's columns were auto-detected. If the file was exported from another program with different column names, adjust the mapping and save it as a new template to reuse with one click next time."
    ),
    loadTemplate: tr("مدل ذخیره‌شده:", "النموذج المحفوظ:", "Kayıtlı model:", "Saved template:"),
    autoDetected: tr("تشخیص خودکار (پیش‌فرض سیستم)", "الاكتشاف التلقائي (افتراضي النظام)", "Otomatik algılama (sistem varsayılanı)", "Auto-detected (system default)"),
    yourColumn: tr("ستون فایل شما", "عمود ملفك", "Dosya sütunu", "Your file column"),
    sample: tr("نمونه مقدار", "قيمة نموذجية", "Örnek değer", "Sample value"),
    unmapped: tr("— نگاشت نشده —", "— غير مطابق —", "— eşlenmedi —", "— unmapped —"),
    saveTemplateName: tr("نام مدل جدید", "اسم النموذج الجديد", "Yeni model adı", "New template name"),
    saveTemplate: tr("ذخیره به‌عنوان مدل", "حفظ كنموذج", "Model olarak kaydet", "Save as template"),
    templateSaved: tr("مدل ذخیره شد", "تم حفظ النموذج", "Model kaydedildi", "Template saved"),
    templateNameRequired: tr("نامی برای مدل وارد کنید", "أدخل اسمًا للنموذج", "Model için bir ad girin", "Enter a name for the template"),
    templateCorrupted: tr("این مدل خراب است", "هذا النموذج تالف", "Bu model bozuk", "This template is corrupted"),
    warning: tr(
      "ردیف‌های تکراری ثبت نمی‌شوند. اگر هر ردیف خطا داشته باشد، Apply تا رفع خطا مسدود است.",
      "لن يتم تسجيل الصفوف المكررة. إذا كان هناك أي صف يحتوي على خطأ، يُحظر التطبيق حتى يتم إصلاحه.",
      "Yinelenen satırlar kaydedilmez. Herhangi bir satırda hata varsa, hata giderilene kadar Uygula engellenir.",
      "Duplicates are skipped. Apply is blocked while any row has validation errors."
    ),
  };
  async function load() { try { setBatches(await getImportBatches()); } catch (error) { toast.error(error.message); } }
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (entity === "products") return;
    getMappingProfiles(entity).then(setProfiles).catch(() => setProfiles([]));
  }, [entity]);
  async function onFileChosen(chosenFile) {
    setFile(chosenFile);
    setPreview(null);
    setInspectData(null);
    setMappingOverride({});
    setSelectedProfileId("");
    if (!chosenFile) return;
    try { setInspectData(await inspectImportFile(chosenFile, entity)); } catch (error) { toast.error(error.message); }
  }
  function headerForField(field) {
    if (mappingOverride[field] !== undefined) return mappingOverride[field];
    const index = inspectData?.suggested_mapping?.[field];
    return index !== undefined && inspectData ? inspectData.headers[index] : "";
  }
  function sampleForField(field) {
    if (!inspectData) return "";
    const header = headerForField(field);
    const index = inspectData.headers.indexOf(header);
    return index >= 0 ? inspectData.sample_row[index] ?? "" : "";
  }
  const columnMapJson = useMemo(() => {
    if (!inspectData) return "";
    const map = {};
    for (const field of inspectData.entity_fields) {
      const header = headerForField(field);
      if (header) map[field] = header;
    }
    return JSON.stringify(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectData, mappingOverride]);
  function loadProfile(id) {
    setSelectedProfileId(id);
    if (!id) { setMappingOverride({}); return; }
    const profile = profiles.find((p) => String(p.id) === String(id));
    if (!profile) return;
    try { setMappingOverride(JSON.parse(profile.mapping_json)); }
    catch { toast.error(t.templateCorrupted); }
  }
  async function saveCurrentMapping() {
    if (!profileName.trim()) return toast.error(t.templateNameRequired);
    try {
      const map = {};
      for (const field of inspectData.entity_fields) {
        const header = headerForField(field);
        if (header) map[field] = header;
      }
      await saveMappingProfile(entity, profileName.trim(), map);
      toast.success(t.templateSaved);
      setProfiles(await getMappingProfiles(entity));
      setProfileName("");
    } catch (error) { toast.error(error.message); }
  }
  async function runCustomerOpeningPreview() {
    if (!file) return toast.error("فایل اصلی CSV مانده‌های پاراسای را انتخاب کنید");
    setBusy(true);
    try { setCustomerOpeningPreview(await previewExistingCustomerOpening(file)); }
    catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }
  async function runCustomerOpeningApply() {
    if (!customerOpeningPreview?.can_apply || busy) return;
    const approved = await confirmAction("آیا از ثبت قطعی ۹۸ مانده مشتریان شرکت فعال تا ۱۴۰۵/۰۷/۲۹ مطمئن هستید؟ این عملیات سند حسابداری و ریزحساب ایجاد می‌کند و قابل اجرای مجدد نیست.", { danger: true });
    if (!approved) return;
    setBusy(true);
    try {
      const result = await applyExistingCustomerOpening(customerOpeningPreview.batch_id);
      toast.success(`${result.inserted} مانده افتتاحیه ثبت شد`);
      setCustomerOpeningPreview(null); setFile(null); await load();
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }
  async function runPreview() {
    if (!file) return toast.error(t.choose);
    setBusy(true);
    try {
      const options = entity === "gl_trial_balance" ? { opening_date: openingDate } : {};
      if (columnMapJson) options.column_map_json = columnMapJson;
      setPreview(await previewImport(entity, file, options));
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }
  async function runApply() {
    if (!preview?.can_apply) return;
    setBusy(true);
    try {
      const result = await applyImport(preview.batch_id);
      toast.success(tr(`${n(result.inserted)} ردیف ثبت شد.`, `تم تسجيل ${n(result.inserted)} صف.`, `${n(result.inserted)} satır içe aktarıldı.`, `${n(result.inserted)} rows imported.`));
      setPreview(null); setFile(null); await load();
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }
  async function parasayFinalizeRequest(path, method="GET") {
    const response=await fetch(`${API_URL}/api/data-import/parasay-finalize/${path}`, {
      method, headers:getAuthHeaders(),
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(typeof result.detail==="string"?result.detail:"خطا در کنترل افتتاحیه پاراسای");
    return result;
  }
  async function reviewParasayFinal(){
    setParasayBusy(true);
    try{
      const report=await parasayFinalizeRequest("preview");
      setParasayFinalReview(report);
      toast.success("کنترل اطلاعات و مانده‌ها انجام شد");
    }catch(error){toast.error(error.message)}
    finally{setParasayBusy(false)}
  }
  async function finalizeParasayChart(){
    if(!parasayFinalReview||parasayFinalReview.chart_finalized)return;
    if(!window.confirm("کدینگ ۴۳ کل و ۲۸۳ معین پاراسای با شناسه یکتای مبدأ ایجاد شود؟ هیچ سند مالی ثبت نمی‌شود."))return;
    setParasayBusy(true);
    try{
      const result=await parasayFinalizeRequest("chart?confirm=CREATE_PARASAY_CHART_BY_SOURCE_ID","POST");
      toast.success(`${result.chart_accounts_created} حساب با کد یکتا ایجاد شد`);
      const report=await parasayFinalizeRequest("preview");setParasayFinalReview(report);
    }catch(error){toast.error(error.message)}
    finally{setParasayBusy(false)}
  }
  async function finalizeParasayOpening(){
    if(!parasayFinalReview?.can_finalize||!parasayNegativeAcknowledged||!parasayPersonalAcknowledged)return;
    if(!window.confirm("ثبت قطعی و غیرقابل‌تکرار: موجودی ۴۴۰ کالا، شامل دو موجودی منفی مبدأ، و سند مانده ۱۲ معین با تسویه دقیق ۳۱۰۱. آیا بکاپ پایگاه داده را گرفته‌اید و ادامه را تأیید می‌کنید؟"))return;
    setParasayBusy(true);
    try{
      const result=await parasayFinalizeRequest("opening?confirm=APPLY_PARASAY_STOCK_GL_14050729&accept_source_negative_stock=true&acknowledge_bank_7579=true","POST");
      toast.success(`موجودی ${result.stock_updated} کالا و ${result.gl_lines} ردیف افتتاحیه ثبت شد`);
      const report=await parasayFinalizeRequest("preview");setParasayFinalReview(report);
    }catch(error){toast.error(error.message)}
    finally{setParasayBusy(false)}
  }
  async function directStockAction(action){
    if(!directStockFile)return toast.error("فایل موجودی را انتخاب کنید");
    if(action==="apply" && (!directStockPreview?.can_import || !window.confirm(
      "تنها موجودی مثبت کالاهای فعلی وارد می‌شود؛ دو موجودی منفی کنار گذاشته می‌شوند. هیچ سند مالی ایجاد نمی‌شود. بکاپ کامل تهیه شده است؟")))return;
    setParasayBusy(true);
    try{
      const fd=new FormData();fd.append("file",directStockFile);
      const headers=getAuthHeaders();delete headers["Content-Type"];delete headers["content-type"];
      const res=await fetch(`${API_URL}/api/data-import/quick-start/direct-stock/${action}${action==="apply"?"?confirm=IMPORT_POSITIVE_STOCK_ONLY":""}`,{method:"POST",headers,body:fd});
      const payload=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(typeof payload.detail==="string"?payload.detail:JSON.stringify(payload.detail||"ثبت موجودی ناموفق بود"));
      if(action==="preview")setDirectStockPreview(payload);
      else{setDirectStockPreview(null);toast.success(`موجودی ${payload.stocked_products} کالا ثبت شد؛ موجودی منفی وارد نشد`);await inspectQuickStart();}
    }catch(error){toast.error(error.message);}
    finally{setParasayBusy(false);}
  }
  async function cashOpeningAction(action){
    const amount=Number(toEnglishDigits(String(cashOpeningIrr)).replace(/[,،٬\s]/g,""));
    const cutoff=toEnglishDigits(cashOpeningCutoff).trim();
    if(!Number.isSafeInteger(amount)||amount<=0||!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)){
      toast.error(tr("مبلغ معتبر به ریال و تاریخ شمسی معتبر را وارد کنید","أدخل المبلغ والتاريخ الصحيحين","Geçerli tutar ve tarih girin","Enter a valid amount and date"));return;
    }
    if(action==="apply" && (!cashOpeningPreview?.can_apply ||
      Number(cashOpeningPreview.amount_irr)!==amount ||cashOpeningPreview.cutoff!==cutoff ||
      !window.confirm(`ثبت مانده افتتاحیه صندوق ${pd(amount)} ریال در ${pd(language === "fa" ? toJalali(cutoff) : cutoff)}: بدهکار ۱۱۰۱، بستانکار تسویه افتتاحیه ۳۱۰۱. بدون دریافت نقدی جدید. تأیید می‌کنید؟`)))return;
    setParasayBusy(true);
    try{
      const qs=new URLSearchParams({amount_irr:String(amount),cutoff});
      if(action==="apply")qs.set("confirm",`POST_CASH_${amount}_${cutoff}`);
      const res=await fetch(`${API_URL}/api/data-import/quick-start/cash-opening/${action}?${qs}`,{
        method:action==="apply"?"POST":"GET",headers:getAuthHeaders()
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(typeof data.detail==="string"?data.detail:JSON.stringify(data.detail||"خطا در صندوق"));
      if(action==="preview")setCashOpeningPreview(data);
      else{setCashOpeningPreview(null);toast.success("سند مانده افتتاحیه صندوق ثبت شد");}
    }catch(err){toast.error(err.message)}
    finally{setParasayBusy(false)}
  }
  async function directBanksAction(action){
    if(!directStockFile)return toast.error("همان فایل ZIP را انتخاب کنید");
    if(action==="apply" && (!directBankPreview?.can_import || !window.confirm("۱۷ حساب بانکی واقعی با مانده روز ثبت می‌شوند؛ آورده شخصی وارد بانک نمی‌شود و سند حسابداری ثبت نمی‌شود. تأیید؟")))return;
    setParasayBusy(true);
    try{
      const fd=new FormData();fd.append("file",directStockFile);
      const headers=getAuthHeaders();delete headers["Content-Type"];delete headers["content-type"];
      const res=await fetch(`${API_URL}/api/data-import/quick-start/direct-banks/${action}${action==="apply"?"?confirm=REGISTER_REAL_BANKS_NO_GL":""}`,{method:"POST",headers,body:fd});
      const payload=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(typeof payload.detail==="string"?payload.detail:JSON.stringify(payload.detail||"خطا در بررسی مانده بانک"));
      if(action==="preview")setDirectBankPreview(payload);
      else{setDirectBankPreview(null);toast.success(`${payload.accounts_registered} حساب بانکی ثبت شد؛ سند حسابداری صادر نشد`);await inspectQuickStart();}
    }catch(error){toast.error(error.message)}
    finally{setParasayBusy(false)}
  }
  async function inspectQuickStartStock(){
    try{
      const res=await fetch(`${API_URL}/api/data-import/quick-start/stock-preview`,{headers:getAuthHeaders()});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(typeof data.detail==="string"?data.detail:"کنترل موجودی انجام نشد");
      setStockPreflight(data);
    }catch(error){toast.error(error.message)}
  }
  async function inspectQuickStart(){
    try{
      const res=await fetch(`${API_URL}/api/data-import/quick-start/readiness`,{headers:getAuthHeaders()});
      const report=await res.json();
      if(!res.ok)throw new Error(typeof report.detail==="string"?report.detail:"بررسی وضعیت امکان‌پذیر نیست");
      setQuickStartReport(report);
    }catch(e){toast.error(e.message)}
  }
  async function inspectParasayStage() {
    setParasayBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/data-import/parasay-stage/status`, {headers:getAuthHeaders()});
      const info = await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(typeof info.detail==="string"?info.detail:"بررسی وضعیت ناموفق بود");
      const checks=await fetch(`${API_URL}/api/accounting/treasury/parasay-opening-cheques`,{headers:getAuthHeaders()});
      const chequeData=await checks.json().catch(()=>({}));
      if(!checks.ok)throw new Error(typeof chequeData.detail==="string"?chequeData.detail:"بررسی چک‌های انتقالی ناموفق بود");
      setParasayStageStatus({...info,cheques:(chequeData.items||[]).length});
    } catch(error){toast.error(error.message);}
    finally{setParasayBusy(false);}
  }
  async function parasayPackageAction(action) {
    if (!parasayPackage) return toast.error("ابتدا بسته ZIP را انتخاب کنید");
    if (action === "apply") {
      if (!parasayPackagePreview?.can_apply) return;
      if (!window.confirm("شش مجموعه پاراسای با هم ذخیره می‌شوند؛ هیچ سند مالی، موجودی کالا یا مانده مشتری تغییر نمی‌کند. تأیید؟")) return;
    }
    setParasayBusy(true);
    try {
      const fd = new FormData(); fd.append("file", parasayPackage);
      const headers = getAuthHeaders();delete headers["Content-Type"];delete headers["content-type"];
      const endpoint = `${API_URL}/api/data-import/parasay-package/${action}${action === "apply"?"?confirm=STAGE_FOUR_SOURCES_NO_FINANCIAL_CHANGES":""}`;
      const response = await fetch(endpoint,{method:"POST",headers,body:fd});
      const result = await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(typeof result.detail==="string"?result.detail:"خطا در کنترل بسته مهاجرت");
      if(action==="preview"){setParasayPackagePreview(result);toast.success("تمام شش مجموعه کنترل شدند");}
      else{setParasayPackageApplied(true);setParasayPackagePreview(x=>({...x,can_apply:false}));toast.success("تمام شش مجموعه بدون ثبت مالی ذخیره شدند");}
    } catch(error){toast.error(error.message);}
    finally{setParasayBusy(false);}
  }
  async function stageParasayRequest(kind, action, fileToSend) {
    const form = new FormData();
    if (fileToSend) form.append("file", fileToSend);
    const headers = getAuthHeaders();
    delete headers["Content-Type"];
    delete headers["content-type"];
    const result = await fetch(`${API_URL}/api/data-import/parasay-stage/${kind}/${action}${action==="apply"?"?confirm=STAGE_WITHOUT_POSTING":""}`, {
      method: "POST", headers, body: form,
    });
    const response = await result.json().catch(() => ({}));
    if (!result.ok) throw new Error(typeof response.detail === "string" ? response.detail : "خطا در بررسی اطلاعات پاراسای");
    return response;
  }
  async function previewParasayKind(kind) {
    if (!parasayFiles[kind]) return toast.error("فایل منبع را انتخاب کنید");
    setParasayBusy(true);
    try {
      const preview = await stageParasayRequest(kind, "preview", parasayFiles[kind]);
      setParasayPreviews(x => ({...x, [kind]: preview}));
      toast.success("کنترل داده‌ها بدون ثبت انجام شد");
    } catch (error) { toast.error(error.message); }
    finally {setParasayBusy(false);}
  }
  async function applyParasayKind(kind) {
    const preview = parasayPreviews[kind];
    if (!preview?.can_apply || !parasayFiles[kind]) return;
    if (!window.confirm("این کار فقط نسخه‌ای از داده‌های مبدأ را برای تطبیق ذخیره می‌کند. هیچ موجودی یا سند حسابداری ثبت نمی‌شود. تأیید؟")) return;
    setParasayBusy(true);
    try {
      const answer = await stageParasayRequest(kind, "apply", parasayFiles[kind]);
      setParasayStaged(x => ({ ...x, [kind]: answer.count }));
      setParasayPreviews(x => ({ ...x, [kind]: { ...preview, can_apply: false, existing_staged: answer.count }}));
      toast.success("اطلاعات بدون ثبت مالی ذخیره شد");
    } catch (error) { toast.error(error.message); }
    finally {setParasayBusy(false);}
  }
  const card = { background: "var(--erp-panel-solid)", border: "1px solid var(--erp-border)", borderRadius: 24, boxShadow: "0 18px 55px rgba(2,6,23,.28)" };
  return <div dir={dir} style={{ maxWidth: 1500, margin: "0 auto", color: "var(--erp-text)" }}>
    <header style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 18 }}>
      <div style={{ width: 58, height: 58, borderRadius: 18, display: "grid", placeItems: "center", background: "linear-gradient(135deg,var(--erp-accent),var(--erp-accent-2))", color: "#071028" }}><FileSpreadsheet size={30}/></div>
      <div><h1 style={{ margin: 0, color: "var(--erp-accent)", fontSize: "clamp(28px,4vw,40px)" }}>{t.title}</h1><p style={{ color: "var(--erp-muted)", margin: "6px 0 0" }}>{t.sub}</p></div>
    </header>
    <section style={{ ...card, padding: 18, marginBottom: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 10 }}>
        <Select
          value={entity}
          onChange={value => { setEntity(value); setPreview(null); setCustomerOpeningPreview(null); setFile(null); setInspectData(null); setMappingOverride({}); setSelectedProfileId(""); }}
          options={[
            { value: "customers", label: t.customers },
            { value: "products", label: t.products },
          ]}
        />
      </div>
      <p style={{ color: "var(--erp-muted)", fontSize: 13, marginBottom: 0 }}>{t.order}</p>
    </section>

    <section style={{ ...card, padding: 16, marginBottom: 14 }}>
      <p style={{ margin: 0, lineHeight: 1.9 }}>
        فقط اطلاعات موردنیاز شروع کار را وارد کنید: طرف‌حساب‌ها همراه مانده بدهکار/بستانکار و کالاها. در فایل طرف‌حساب‌ها ستون «مانده افتتاحیه» را وارد کنید: عدد مثبت برای بدهکار و عدد منفی برای بستانکار.
        اطلاعاتی که قبلاً ثبت شده‌اند دوباره وارد نشوند. سوابق ثبت‌شده و اسناد حسابداری حفظ می‌شوند.
      </p>
    </section>

    {entity === "products" ? (
      <section style={{ marginBottom: 14 }}>
        <ProductImportWizard />
      </section>
    ) : (
      <>
        <section style={{ ...card, padding: 18, marginBottom: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 10 }}>
            <button onClick={() => downloadImportTemplate(entity, language)} style={{ padding: 12, borderRadius: 13, fontWeight: 900, background: "#164e63", color: "#cffafe", border: 0 }}><Download size={17} style={{ display: "inline", marginInlineEnd: 7 }}/>{t.template}</button>
            <label style={{ padding: 12, borderRadius: 13, border: "1px dashed var(--erp-accent)", cursor: "pointer" }}><Upload size={17} style={{ display: "inline", marginInlineEnd: 7 }}/>{file?.name || t.choose}<input hidden type="file" accept=".xlsx,.csv" onChange={e => onFileChosen(e.target.files?.[0] || null)}/></label>
            {entity === "gl_trial_balance" && (
              <label style={{ padding: 12, borderRadius: 13, border: "1px solid var(--erp-border)", display: "flex", alignItems: "center", gap: 8 }}>
                {t.openingDateLabel}
                <JalaliDateField value={openingDate} onChange={(iso) => setOpeningDate(iso)} fa={language === "fa"} language={language} style={{ background: "transparent", color: "var(--erp-text)", border: 0, outline: "none" }}/>
              </label>
            )}
            <button disabled={!file || busy} onClick={runPreview} style={{ padding: 12, borderRadius: 13, fontWeight: 900, border: 0, background: "var(--erp-accent)", color: "#071028", opacity: !file || busy ? .5 : 1 }}>{busy ? "..." : t.preview}</button>
          </div>
          <p style={{ color: "#fbbf24", marginBottom: 0 }}><AlertTriangle size={17} style={{ display: "inline", marginInlineEnd: 7 }}/>{t.warning}</p>
        </section>

        {inspectData && (
          <section style={{ ...card, padding: 18, marginBottom: 14 }}>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 0, fontSize: 17 }}>
              <LayoutTemplate size={19} />{t.mappingTitle}
            </h2>
            <p style={{ color: "var(--erp-muted)", fontSize: 13 }}>{t.mappingHint}</p>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
              <label style={{ fontSize: 13, color: "var(--erp-muted)" }}>{t.loadTemplate}</label>
              <Select
                value={selectedProfileId}
                onChange={(value) => loadProfile(value)}
                options={[
                  { value: "", label: t.autoDetected },
                  ...profiles.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </div>

            <div style={{ overflowX: "auto", marginBottom: 14 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "start" }}>
                    <th style={{ padding: 8, color: "var(--erp-muted)", fontSize: 12 }}>{tr("فیلد VITALIX", "حقل VITALIX", "VITALIX alanı", "VITALIX field")}</th>
                    <th style={{ padding: 8, color: "var(--erp-muted)", fontSize: 12 }}>{t.yourColumn}</th>
                    <th style={{ padding: 8, color: "var(--erp-muted)", fontSize: 12 }}>{tr("اطمینان", "الثقة", "Güven", "Confidence")}</th>
                    <th style={{ padding: 8, color: "var(--erp-muted)", fontSize: 12 }}>{t.sample}</th>
                  </tr>
                </thead>
                <tbody>
                  {inspectData.entity_fields.map((field) => {
                    const header = headerForField(field);
                    const confidence = inspectData.mapping_confidence?.[field]?.confidence;
                    const confidenceColor = confidence >= 90 ? "#4ade80" : confidence >= 60 ? "#fbbf24" : "var(--erp-muted)";
                    return (
                      <tr key={field} style={{ borderTop: "1px solid var(--erp-border)" }}>
                        <td style={{ padding: 8, fontWeight: 700 }}>
                          {field}{field === REQUIRED_FIELD_LABEL[entity] && <span style={{ color: "var(--erp-danger)" }}> *</span>}
                        </td>
                        <td style={{ padding: 8 }}>
                          <Select
                            value={header}
                            onChange={(value) => setMappingOverride((prev) => ({ ...prev, [field]: value }))}
                            className="w-full"
                            options={[
                              { value: "", label: t.unmapped },
                              ...inspectData.headers.map((h) => ({ value: h, label: h })),
                            ]}
                          />
                        </td>
                        <td style={{ padding: 8, fontSize: 12, fontWeight: 800, color: confidenceColor }}>
                          {confidence !== undefined && confidence !== null ? `${n(confidence)}%` : "—"}
                        </td>
                        <td style={{ padding: 8, color: "var(--erp-muted)", fontSize: 13 }}>{String(sampleForField(field) ?? "")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder={t.saveTemplateName}
                value={pd(profileName)}
                onChange={(e) => setProfileName(toEnglishDigits(e.target.value))}
                style={{ flex: 1, minWidth: 200, padding: 10, borderRadius: 11, background: "var(--erp-bg)", color: "var(--erp-text)", border: "1px solid var(--erp-border)" }}
              />
              <button onClick={saveCurrentMapping} style={{ padding: "10px 16px", borderRadius: 11, fontWeight: 800, background: "var(--erp-panel-solid)", color: "var(--erp-accent)", border: "1px solid var(--erp-border)" }}>
                <Save size={15} style={{ display: "inline", marginInlineEnd: 7 }}/>{t.saveTemplate}
              </button>
            </div>
          </section>
        )}

        {preview && <section aria-live="polite" style={{ ...card, padding: 18, marginBottom: 14 }}>
          <div className="erp-import-metrics">
            {[[t.total,preview.total_rows],[t.valid,preview.valid_rows],[t.errors,preview.error_rows],[t.duplicate,preview.duplicate_rows]].map(([label,value]) => <div key={label} style={{ padding: 13, borderRadius: 15, background: "var(--erp-bg)" }}><small style={{ color: "var(--erp-muted)" }}>{label}</small><strong style={{ display: "block", fontSize: 24 }}>{n(value)}</strong></div>)}
          </div>
          {preview.warnings.filter(w => w.row === 0).map((w, i) => (
            <p key={i} style={{ color: "#f87171", fontWeight: 700 }}><AlertTriangle size={16} style={{ display: "inline", marginInlineEnd: 6 }}/>{w.message}</p>
          ))}
          <div className="erp-table-scroll"><table className="erp-data-table"><thead><tr><th>#</th><th>{tr("نام", "الاسم", "Ad", "Name")}</th><th>{t.status}</th><th>{tr("جزئیات", "التفاصيل", "Ayrıntılar", "Details")}</th></tr></thead><tbody>{preview.preview.map(row => <tr key={row.row}><td>{n(row.row)}</td><td>{row.data.name || row.data.account_code || `${row.data.customer_name || ""} · ${row.data.product || ""}`}</td><td>{row.errors.length ? t.errors : row.duplicate ? t.duplicate : t.valid}</td><td>{row.errors.map(x => x.message).join(" · ") || "—"}</td></tr>)}</tbody></table></div>
          <button disabled={!preview.can_apply || busy} onClick={runApply} style={{ marginTop: 13, padding: "12px 18px", borderRadius: 13, border: 0, fontWeight: 900, background: "var(--erp-success-solid)", color: "var(--erp-success-solid-text)", opacity: !preview.can_apply || busy ? .5 : 1 }}><CheckCircle2 size={18} style={{ display: "inline", marginInlineEnd: 7 }}/>{t.apply}</button>
        </section>}
      </>
    )}
    <section style={{ ...card, padding: 18 }}><h2><History size={21} style={{ display: "inline", marginInlineEnd: 8 }}/>{t.history}</h2>
      {!batches.length && <p style={{ color: "var(--erp-muted)" }}>{t.no}</p>}
      <div style={{ display: "grid", gap: 8 }}>{batches.map(batch => <div key={batch.id} style={{ padding: 13, borderRadius: 15, background: "var(--erp-bg)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong>{batch.file_name}</strong><span>{batch.entity_type}</span><span>{t.status}: {batch.status}</span><span>{date(batch.created_at)}</span>
        {batch.status !== "applied" && (
          <button
            title={t.deleteBatch}
            onClick={async () => {
              if (!(await confirmAction(t.deleteBatchConfirm, { danger: true }))) return;
              try { await deleteImportBatch(batch.id); toast.success(t.deleteBatchDone); await load(); }
              catch (error) { toast.error(error.message); }
            }}
            style={{ padding: 8, borderRadius: 10, background: "rgba(239,68,68,.12)", color: "#f87171", border: 0, cursor: "pointer" }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>)}</div>
    </section>
  </div>;
}
