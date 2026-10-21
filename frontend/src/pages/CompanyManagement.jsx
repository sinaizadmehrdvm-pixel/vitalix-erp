import { useEffect, useState } from "react";
import { Building2, Check, Pencil, Plus, RefreshCw, Users, X } from "lucide-react";
import toast from "react-hot-toast";
import { useAuth } from "../auth/AuthContext";
import { useLanguage } from "../localization/useLanguage";
import { toPersianDigits, toEnglishDigits } from "../localization/helpers";
import { createCompany, getCompanies, updateCompany } from "../services/companiesApi";
import { translateApiError } from "../localization/apiErrors";

export default function CompanyManagement() {
  const { user } = useAuth();
  const { language, dir, n, date } = useLanguage();
  const fa = language === "fa";
  const ar = language === "ar";
  const trk = language === "tr";
  const tr = (a, b, c, d) => (fa ? a : ar ? b : trk ? c : d);
  const pd = (value) => (fa ? toPersianDigits(value) : value);
  const isSuperAdmin = !!user?.is_super_admin;

  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const t = {
    title: tr("مدیریت شرکت‌ها", "إدارة الشركات", "Şirket Yönetimi", "Company Management"),
    subtitle: tr(
      "پایه چندشرکتی VITALIX — هر کاربر فعلاً عضو یک شرکت است.",
      "أساس تعدد الشركات في VITALIX - كل مستخدم حاليًا عضو في شركة واحدة.",
      "VITALIX'in çok şirketli temeli - her kullanıcı şu anda tek bir şirkete üyedir.",
      "Foundation of VITALIX's multi-company support — each user currently belongs to one company."
    ),
    denied: tr("این بخش فقط برای مدیر سیستم قابل دسترسی است.", "هذا القسم مقتصر على المسؤولين.", "Bu alan yalnızca yöneticilere açıktır.", "This area is restricted to administrators."),
    name: tr("نام شرکت جدید", "اسم الشركة الجديدة", "Yeni şirket adı", "New company name"),
    create: tr("ایجاد شرکت", "إنشاء شركة", "Şirket oluştur", "Create company"),
    refresh: tr("به‌روزرسانی", "تحديث", "Yenile", "Refresh"),
    users: tr("کاربر", "مستخدم", "kullanıcı", "users"),
    createdAt: tr("تاریخ ایجاد", "تاريخ الإنشاء", "Oluşturulma tarihi", "Created at"),
    empty: tr("هنوز شرکتی ثبت نشده است.", "لم يتم تسجيل أي شركة بعد.", "Henüz şirket kaydedilmedi.", "No companies yet."),
    created: tr("شرکت ایجاد شد", "تم إنشاء الشركة", "Şirket oluşturuldu", "Company created"),
    edit: tr("ویرایش", "تعديل", "Düzenle", "Edit"),
    save: tr("ذخیره", "حفظ", "Kaydet", "Save"),
    cancel: tr("انصراف", "إلغاء", "Vazgeç", "Cancel"),
    active: tr("فعال", "نشطة", "Aktif", "Active"),
    inactive: tr("غیرفعال", "غير نشطة", "Devre dışı", "Inactive"),
    updated: tr("شرکت به‌روزرسانی شد", "تم تحديث الشركة", "Şirket güncellendi", "Company updated"),
  };

  async function load() {
    setLoading(true);
    try {
      setCompanies(await getCompanies());
    } catch (error) {
      toast.error(translateApiError(error.message, language) || error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isSuperAdmin) return;
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [isSuperAdmin]);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await createCompany(name.trim());
      toast.success(t.created);
      setName("");
      await load();
      window.dispatchEvent(new Event("vitalix:companies-updated"));
    } catch (error) {
      toast.error(translateApiError(error.message, language) || error.message);
    } finally {
      setCreating(false);
    }
  }

  function startEdit(company) {
    setEditingId(company.id);
    setEditName(company.name);
    setEditActive(!!company.is_active);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditActive(true);
  }

  async function handleSaveEdit(companyId) {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      await updateCompany(companyId, { name: editName.trim(), is_active: editActive });
      toast.success(t.updated);
      cancelEdit();
      await load();
      window.dispatchEvent(new Event("vitalix:companies-updated"));
    } catch (error) {
      toast.error(translateApiError(error.message, language) || error.message);
    } finally {
      setSaving(false);
    }
  }

  if (!isSuperAdmin) {
    return (
      <div dir={dir} style={{ direction: dir }} className="p-8">
        <div className="bg-rose-500/15 border border-rose-400/30 rounded-2xl p-5 text-rose-100">{t.denied}</div>
      </div>
    );
  }

  const card = { background: "var(--erp-panel-solid)", border: "1px solid var(--erp-border)", borderRadius: 24, boxShadow: "0 18px 55px rgba(2,6,23,.28)" };

  return (
    <div dir={dir} style={{ maxWidth: 1100, margin: "0 auto", color: "var(--erp-text)", direction: dir }}>
      <header style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 18 }}>
        <div style={{ width: 58, height: 58, borderRadius: 18, display: "grid", placeItems: "center", background: "linear-gradient(135deg,var(--erp-accent),var(--erp-accent-2))", color: "#071028" }}>
          <Building2 size={30} />
        </div>
        <div>
          <h1 style={{ margin: 0, color: "var(--erp-accent)", fontSize: "clamp(28px,4vw,40px)" }}>{t.title}</h1>
          <p style={{ color: "var(--erp-muted)", margin: "6px 0 0" }}>{t.subtitle}</p>
        </div>
      </header>

      <section style={{ ...card, padding: 18, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            value={pd(name)}
            onChange={(e) => setName(toEnglishDigits(e.target.value))}
            placeholder={t.name}
            style={{ flex: 1, minWidth: 220, padding: 12, borderRadius: 13, background: "var(--erp-bg)", color: "var(--erp-text)", border: "1px solid var(--erp-border)" }}
          />
          <button
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            style={{ padding: "12px 18px", borderRadius: 13, fontWeight: 900, border: 0, background: "var(--erp-accent)", color: "#071028", opacity: !name.trim() || creating ? 0.5 : 1 }}
          >
            <Plus size={17} style={{ display: "inline", marginInlineEnd: 7 }} />
            {t.create}
          </button>
          <button
            onClick={load}
            style={{ padding: "12px 18px", borderRadius: 13, fontWeight: 900, background: "var(--erp-panel-solid)", color: "var(--erp-accent)", border: "1px solid var(--erp-border)" }}
          >
            <RefreshCw size={17} className={loading ? "animate-spin" : ""} style={{ display: "inline", marginInlineEnd: 7 }} />
            {t.refresh}
          </button>
        </div>
      </section>

      <section style={{ ...card, padding: 18 }}>
        {!companies.length && !loading && <p style={{ color: "var(--erp-muted)" }}>{t.empty}</p>}
        <div style={{ display: "grid", gap: 10 }}>
          {companies.map((company) => {
            const isEditing = editingId === company.id;
            return (
              <div
                key={company.id}
                style={{ padding: 16, borderRadius: 16, background: "var(--erp-bg)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}
              >
                {isEditing ? (
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", flex: 1 }}>
                    <input
                      value={pd(editName)}
                      onChange={(e) => setEditName(toEnglishDigits(e.target.value))}
                      style={{ flex: 1, minWidth: 200, padding: 10, borderRadius: 12, background: "var(--erp-panel-solid)", color: "var(--erp-text)", border: "1px solid var(--erp-border)" }}
                      autoFocus
                    />
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--erp-muted)", cursor: "pointer" }}>
                      <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
                      {editActive ? t.active : t.inactive}
                    </label>
                    <button
                      onClick={() => handleSaveEdit(company.id)}
                      disabled={!editName.trim() || saving}
                      style={{ padding: "8px 14px", borderRadius: 11, fontWeight: 900, border: 0, background: "var(--erp-accent)", color: "#071028", display: "flex", alignItems: "center", gap: 6, opacity: !editName.trim() || saving ? 0.5 : 1 }}
                    >
                      <Check size={15} /> {t.save}
                    </button>
                    <button
                      onClick={cancelEdit}
                      style={{ padding: "8px 14px", borderRadius: 11, fontWeight: 900, background: "var(--erp-panel-solid)", color: "var(--erp-muted)", border: "1px solid var(--erp-border)", display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <X size={15} /> {t.cancel}
                    </button>
                  </div>
                ) : (
                  <>
                    <div>
                      <div style={{ fontWeight: 900, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}>
                        {pd(company.name)}
                        {!company.is_active && (
                          <span style={{ fontSize: 11, fontWeight: 800, padding: "3px 9px", borderRadius: 999, background: "rgba(244,63,94,.15)", color: "#fb7185" }}>
                            {t.inactive}
                          </span>
                        )}
                      </div>
                      <div style={{ color: "var(--erp-muted)", fontSize: 12, marginTop: 4 }}>{t.createdAt}: {date(company.created_at)}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, background: "var(--erp-glow)", color: "var(--erp-accent)", fontWeight: 800, fontSize: 13 }}>
                        <Users size={14} /> {n(company.user_count)} {t.users}
                      </span>
                      <button
                        onClick={() => startEdit(company)}
                        style={{ padding: "8px 14px", borderRadius: 11, fontWeight: 800, background: "var(--erp-panel-solid)", color: "var(--erp-accent)", border: "1px solid var(--erp-border)", display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}
                      >
                        <Pencil size={14} /> {t.edit}
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
