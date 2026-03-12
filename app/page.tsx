"use client";

import { FridgeInitPanel } from "@/components/home/fridge-init-panel";
import { GitConfigPanel } from "@/components/home/git-config-panel";
import { IceBoxList } from "@/components/home/ice-box-list";
import { useMounted } from "@/hooks/use-mounted";
import { useAppStore } from "@/store/app-store";

type HomeStep = "git-config" | "fridge-init" | "ice-boxes";

function HomeSkeleton() {
  return (
    <main className="fridge-page">
      <div className="fridge-shell">
        <section className="fridge-panel">
          <div className="grid gap-3">
            <div className="h-8 w-32 animate-pulse rounded-full bg-zinc-200/80 dark:bg-white/10" />
            <div className="h-10 animate-pulse rounded-2xl bg-zinc-100 dark:bg-white/5" />
            <div className="h-32 animate-pulse rounded-2xl bg-zinc-100 dark:bg-white/5" />
          </div>
        </section>
      </div>
    </main>
  );
}

export default function Home() {
  const mounted = useMounted();
  const gitConfig = useAppStore((state) => state.gitConfig);
  const hasInitializedFridgeConfig = useAppStore((state) => state.hasInitializedFridgeConfig);

  if (!mounted) {
    return <HomeSkeleton />;
  }

  const hasGitConfig = Boolean(gitConfig.repository.trim());
  const step: HomeStep = !hasGitConfig ? "git-config" : hasInitializedFridgeConfig ? "ice-boxes" : "fridge-init";

  return (
    <main className="fridge-page">
      <div className="fridge-shell">
        {step === "git-config" ? <GitConfigPanel /> : null}
        {step === "fridge-init" ? <FridgeInitPanel /> : null}
        {step === "ice-boxes" ? <IceBoxList /> : null}
      </div>
    </main>
  );
}
