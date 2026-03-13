"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { defaultLocale, localeCookieName, type Locale } from "@/i18n/config";
import { useAppStore } from "@/store/app-store";

const oneYear = 60 * 60 * 24 * 365;

function setLocaleCookie(locale: Locale) {
  document.cookie = `${localeCookieName}=${locale}; path=/; max-age=${oneYear}; samesite=lax`;
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.25M12 19.25v2.25M4.93 4.93l1.6 1.6M17.47 17.47l1.6 1.6M2.5 12h2.25M19.25 12h2.25M4.93 19.07l1.6-1.6M17.47 6.53l1.6-1.6" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M20.2 14.2A8.5 8.5 0 1 1 9.8 3.8a7 7 0 0 0 10.4 10.4Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ThemeLanguageSwitch() {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const silentRefreshingTargets = useAppStore((state) => state.silentRefreshingTargets);

  const nextLocale: Locale = locale === "zh" ? "en" : defaultLocale;
  const isDark = resolvedTheme === "dark";
  const isRefreshing = silentRefreshingTargets.length > 0;
  const refreshLabel = useMemo(() => {
    if (!isRefreshing) {
      return "";
    }

    return t("silentRefresh.label", { targets: silentRefreshingTargets.join(", ") });
  }, [isRefreshing, silentRefreshingTargets, t]);

  return (
    <div className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full border border-zinc-200/80 bg-white/82 p-2 shadow-lg shadow-black/5 backdrop-blur-md dark:border-white/10 dark:bg-zinc-950/78 sm:right-6 sm:top-6">
      {isRefreshing ? (
        <div
          className="group flex h-9 items-center gap-2 rounded-full border border-sky-200/70 bg-sky-50/90 px-3 text-sky-700 dark:border-sky-400/20 dark:bg-sky-500/10 dark:text-sky-300"
          aria-label={refreshLabel}
          title={refreshLabel}
        >
          <span className="inline-flex h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
          <span className="max-w-0 overflow-hidden whitespace-nowrap text-xs font-medium opacity-0 transition-all duration-200 group-hover:max-w-[16rem] group-hover:opacity-100">
            {refreshLabel}
          </span>
        </div>
      ) : null}
      <button
        type="button"
        aria-label={t("switcher.toggleLanguage")}
        onClick={() => {
          setLocaleCookie(nextLocale);
          router.refresh();
        }}
        className="fridge-button-secondary min-w-10 px-3 py-2 text-xs"
      >
        {locale === "zh" ? t("common.en") : t("common.zh")}
      </button>
      <button
        type="button"
        aria-label={t("switcher.toggleTheme")}
        onClick={() => setTheme(isDark ? "light" : "dark")}
        className="fridge-button-secondary inline-flex h-9 w-9 items-center justify-center p-0"
      >
        {isDark ? <SunIcon /> : <MoonIcon />}
      </button>
    </div>
  );
}
