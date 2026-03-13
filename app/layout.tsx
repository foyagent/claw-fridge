import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { Footer } from "@/components/footer";
import { Providers } from "@/components/providers";
import { SilentRefreshIndicator } from "@/components/silent-refresh-indicator";
import { ThemeLanguageSwitch } from "@/components/theme-language-switch";
import { defaultLocale, isLocale, localeCookieName, type Locale } from "@/i18n/config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Claw-Fridge",
  description: "Git-based OpenClaw configuration backup system",
};

async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const locale = cookieStore.get(localeCookieName)?.value;
  return locale && isLocale(locale) ? locale : defaultLocale;
}

async function getMessages(locale: Locale) {
  return (await import(`@/i18n/messages/${locale}.json`)).default;
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages(locale);

  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} bg-background text-foreground antialiased`}
      >
        <Providers locale={locale} messages={messages}>
          <div className="flex min-h-screen flex-col">
            <ThemeLanguageSwitch />
            <SilentRefreshIndicator />
            <div className="flex-1">{children}</div>
            <Footer />
          </div>
        </Providers>
      </body>
    </html>
  );
}
