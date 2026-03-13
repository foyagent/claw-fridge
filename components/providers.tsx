"use client";

import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "next-themes";
import type { PropsWithChildren } from "react";
import type { Locale } from "@/i18n/config";

export function Providers({
  children,
  locale,
  messages,
}: PropsWithChildren<{
  locale: Locale;
  messages: Record<string, unknown>;
}>) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    </ThemeProvider>
  );
}
