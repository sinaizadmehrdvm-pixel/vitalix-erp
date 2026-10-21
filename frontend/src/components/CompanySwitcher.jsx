import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import toast from "react-hot-toast";
import { useAuth } from "../auth/AuthContext";
import { useLanguage } from "../localization/useLanguage";
import { getCompanies, switchCompany } from "../services/companiesApi";
import Select from "./ui/Select";
import Tooltip from "./ui/Tooltip";

// Milestone 4: only a super-admin can act inside more than one company's
// context. Everyone else is permanently bound to their own company via
// their JWT, so this control simply doesn't render for them.
export default function CompanySwitcher() {
  const { user, activeCompany, switchCompanyContext } = useAuth();
  const { language } = useLanguage();
  const fa = language === "fa";
  const ar = language === "ar";
  const trk = language === "tr";
  const [companies, setCompanies] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user?.is_super_admin) return;
    let mounted = true;
    const refreshCompanies = () => {
      getCompanies().then((items) => { if (mounted) setCompanies(items); }).catch(() => {});
    };
    refreshCompanies();
    window.addEventListener("vitalix:companies-updated", refreshCompanies);
    return () => {
      mounted = false;
      window.removeEventListener("vitalix:companies-updated", refreshCompanies);
    };
  }, [user?.is_super_admin]);

  if (!user?.is_super_admin) return null;

  async function handleChange(value) {
    const companyId = Number(value);
    if (!companyId || companyId === activeCompany?.id) return;
    setBusy(true);
    try {
      const result = await switchCompany(companyId);
      await switchCompanyContext(result);
      window.location.reload();
    } catch (error) {
      toast.error(error.message);
      setBusy(false);
    }
  }

  return (
    <Tooltip
      side="end"
      label={fa ? "سوپرادمین: سوییچ کانتکست شرکت" : ar ? "مسؤول عام: تبديل سياق الشركة" : trk ? "Süper yönetici: şirket bağlamını değiştir" : "Super-admin: switch company context"}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          color: "var(--erp-text)",
        }}
      >
        <Building2 size={16} color="var(--erp-accent)" style={{ flexShrink: 0 }} />
        <Select
          variant="flush"
          value={activeCompany?.id || ""}
          disabled={busy || !companies.length}
          onChange={handleChange}
          options={companies.map((company) => ({ value: company.id, label: company.name }))}
          className="min-w-0"
        />
      </div>
    </Tooltip>
  );
}
