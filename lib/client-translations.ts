import en from "@/i18n/messages/en.json";
import zh from "@/i18n/messages/zh.json";
import { defaultLocale, isLocale, localeCookieName, type Locale } from "@/i18n/config";

const catalogs = { en, zh } as const;

function readLocale(): Locale {
  if (typeof document !== "undefined") {
    const cookieMatch = document.cookie.match(new RegExp(`(?:^|; )${localeCookieName}=([^;]+)`));
    const cookieLocale = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
    if (cookieLocale && isLocale(cookieLocale)) {
      return cookieLocale;
    }

    const htmlLocale = document.documentElement.lang;
    if (htmlLocale && isLocale(htmlLocale)) {
      return htmlLocale;
    }
  }

  return defaultLocale;
}

function getValue(path: string, locale: Locale): string | null {
  const parts = path.split(".");
  let current: unknown = catalogs[locale];

  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      current = null;
      break;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return typeof current === "string" ? current : null;
}

export function tr(path: string, values?: Record<string, string | number | null | undefined>): string {
  const locale = readLocale();
  const template = getValue(path, locale) ?? getValue(path, defaultLocale) ?? path;

  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}
