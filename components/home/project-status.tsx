"use client";

import { useLocale, useTranslations } from "next-intl";
import { useAppStore } from "@/store/app-store";

export function ProjectStatus() {
  const t = useTranslations();
  const locale = useLocale();
  const projectName = useAppStore((state) => state.projectName);
  const initializedAt = useAppStore((state) => state.initializedAt);
  const integrations = useAppStore((state) => state.integrations);

  return (
    <section className="fridge-panel grid gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <span className="fridge-kicker">{t("projectStatus.kicker")}</span>
          <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{projectName}</h2>
          <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            {t("projectStatus.initializedAt", {
              value: new Date(initializedAt).toLocaleString(locale, { hour12: false }),
            })}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {integrations.map((integration, index) => (
            <span
              key={integration}
              className={[
                "fridge-chip",
                index % 3 === 0
                  ? "fridge-chip--ocean"
                  : index % 3 === 1
                    ? "fridge-chip--coral"
                    : "fridge-chip--success",
              ].join(" ")}
            >
              {integration}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
