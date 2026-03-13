"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { defaultLocale, localeCookieName, type Locale } from "@/i18n/config";

const oneYear = 60 * 60 * 24 * 365;

function setLocaleCookie(locale: Locale) {
  document.cookie = `${localeCookieName}=${locale}; path=/; max-age=${oneYear}; samesite=lax`;
}

export function ThemeLanguageSwitch() {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();

  const nextLocale: Locale = locale === "zh" ? "en" : defaultLocale;
  const isDark = resolvedTheme === "dark";

  return (
    <div className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full border border-zinc-200/80 bg-white/80 p-2 shadow-lg shadow-black/5 backdrop-blur dark:border-white/10 dark:bg-zinc-950/70 sm:right-6 sm:top-6">
      <button
        type="button"
        aria-label={t("switcher.toggleLanguage")}
        onClick={() => {
          setLocaleCookie(nextLocale);
          router.refresh();
        }}
        className="fridge-button-secondary px-3 py-2 text-xs"
      >
        {locale === "zh" ? t("common.en") : t("common.zh")}
      </button>
      <button
        type="button"
        aria-label={t("switcher.toggleTheme")}
        onClick={() => setTheme(isDark ? "light" : "dark")}
        className="fridge-button-secondary px-3 py-2 text-xs"
      >
        {isDark ? t("common.light") : t("common.dark")}
      </button>
    </div>
  );
}
