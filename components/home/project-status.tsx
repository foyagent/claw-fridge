"use client";

import { useAppStore } from "@/store/app-store";

export function ProjectStatus() {
  const projectName = useAppStore((state) => state.projectName);
  const initializedAt = useAppStore((state) => state.initializedAt);
  const integrations = useAppStore((state) => state.integrations);

  return (
    <section className="fridge-panel grid gap-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <span className="fridge-kicker">Project Snapshot</span>
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{projectName}</h2>
            <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
              初始化时间：{new Date(initializedAt).toLocaleString("zh-CN", { hour12: false })}
            </p>
          </div>
        </div>

        <div className="fridge-panel-muted max-w-xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">
          当前页面重点是把仓库配置、冰盒管理、Skill 交付和恢复路径放到同一条清晰流程里。
        </div>
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
    </section>
  );
}
