import { useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Sidebar from "../components/Sidebar";
import OfflineStatusBanner from "../components/OfflineStatusBanner";
import ContextualHelp from "../components/ContextualHelp";
import { useLanguage } from "../localization/useLanguage";

export default function MainLayout() {
  const { dir, language } = useLanguage();
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  // The whole Field Sales module (/visitor, /visitor/visits) shares one
  // FieldSalesProvider mounted by the nested "visitor" layout route in
  // App.jsx, specifically so the active visit's timer/draft/recorded
  // orders survive switching between its two routes. Keying this
  // transition by the full pathname would force React to unmount/remount
  // everything below <Outlet/> - including that provider - on every such
  // switch, silently resetting the in-progress visit. Collapsing both
  // routes to one transition key keeps every other route's per-page
  // animation exactly as it was.
  const transitionKey = location.pathname.startsWith("/visitor") ? "/visitor" : location.pathname;
  const [navigationOpen, setNavigationOpen] = useState(false);
  const menuButtonRef = useRef(null);
  const menuLabel =
    language === "fa"
      ? "بازکردن منوی اصلی"
      : language === "ar"
      ? "فتح القائمة الرئيسية"
      : language === "tr"
      ? "Ana menüyü aç"
      : "Open main navigation";

  function closeNavigation({ restoreFocus = false } = {}) {
    setNavigationOpen(false);
    // The trigger button unmounts while the drawer is open (see below), so
    // this only has something to focus once it remounts on the next
    // render - requestAnimationFrame gives that remount a chance to commit
    // first.
    if (restoreFocus) window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  }

  useEffect(() => {
    if (!navigationOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") closeNavigation({ restoreFocus: true });
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [navigationOpen]);

  return (
    <div className="erp-layout" dir={dir}>
      <a className="erp-skip-link" href="#main-content">
        {language === "fa"
          ? "پرش به محتوای اصلی"
          : language === "ar"
          ? "الانتقال إلى المحتوى الرئيسي"
          : language === "tr"
          ? "Ana içeriğe geç"
          : "Skip to main content"}
      </a>
      {/* Hidden while the drawer is open - Sidebar renders its own close
          (X) control in that state, so the two never show at once. */}
      {!navigationOpen && (
        <button
          ref={menuButtonRef}
          type="button"
          className="erp-mobile-menu"
          onClick={() => setNavigationOpen(true)}
          aria-label={menuLabel}
          aria-expanded={navigationOpen}
          aria-controls="erp-primary-navigation"
        >
          <Menu size={22} aria-hidden="true" />
          <span>
            {language === "fa"
              ? "منو"
              : language === "ar"
              ? "القائمة"
              : language === "tr"
              ? "Menü"
              : "Menu"}
          </span>
        </button>
      )}

      {navigationOpen && (
        <button
          type="button"
          className="erp-sidebar-backdrop"
          onClick={() => closeNavigation({ restoreFocus: true })}
          aria-label={
            language === "fa"
              ? "بستن منو"
              : language === "ar"
              ? "إغلاق القائمة"
              : language === "tr"
              ? "Menüyü kapat"
              : "Close navigation"
          }
        />
      )}

      <Sidebar
        mobileOpen={navigationOpen}
        onNavigate={() => closeNavigation()}
        onCloseDrawer={() => closeNavigation({ restoreFocus: true })}
      />

      <main id="main-content" className="erp-main" tabIndex={-1}>
        <OfflineStatusBanner />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={transitionKey}
            initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -8 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>
      <ContextualHelp />
    </div>
  );
}
