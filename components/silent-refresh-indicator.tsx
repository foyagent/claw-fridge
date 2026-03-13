"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { useAppStore } from "@/store/app-store";

export function SilentRefreshIndicator() {
  const t = useTranslations();
  const silentRefreshingTargets = useAppStore((state) => state.silentRefreshingTargets);

  const label = useMemo(() => {
    if (silentRefreshingTargets.length === 0) {
      return "";
    }

    return t("silentRefresh.label", { targets: silentRefreshingTargets.join(", ") });
  }, [silentRefreshingTargets, t]);

  if (silentRefreshingTargets.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 sm:right-6 sm:top-6">
      <div className="pointer-events-auto group flex items-center justify-end">
        <div className="flex h-11 w-11 items-center justify-center rounded-full border border-zinc-200/80 bg-white/88 text-sky-600 shadow-lg shadow-sky-500/10 backdrop-blur-md transition-all duration-200 group-hover:w-auto group-hover:max-w-[22rem] group-hover:gap-3 group-hover:rounded-2xl group-hover:px-4 dark:border-white/10 dark:bg-zinc-950/88 dark:text-sky-300">
          <span className="inline-flex h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
          <span className="max-w-0 overflow-hidden whitespace-nowrap text-sm text-zinc-700 opacity-0 transition-all duration-200 group-hover:max-w-[18rem] group-hover:opacity-100 dark:text-zinc-200">
            {label}
          </span>
        </div>
      </div>
    </div>
  );
}
