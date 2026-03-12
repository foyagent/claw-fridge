import { GitConfigPanel } from "@/components/home/git-config-panel";
import { IceBoxList } from "@/components/home/ice-box-list";
import { ProjectStatus } from "@/components/home/project-status";

export default function Home() {
  return (
    <main className="fridge-page">
      <div className="fridge-shell">
        <section className="fridge-hero">
          <div className="relative z-10 flex flex-wrap items-center gap-3 text-sm font-medium">
            <span className="fridge-chip fridge-chip--ocean">Home</span>
            <span className="fridge-chip">Git Config + Ice Boxes</span>
          </div>

          <div className="relative z-10 grid gap-4 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
            <div className="space-y-3">
              <p className="fridge-kicker">Claw-Fridge Console</p>
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">先接仓库，再管理冰盒。</h1>
              <p className="max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-300 sm:text-lg">
                Git 配置和冰盒管理都在这个首页完成。点开任意冰盒，就能直接查看配置、备份历史、恢复和 Skill。
              </p>
            </div>

            <div className="fridge-panel-tint relative z-10 grid gap-2 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
              <p className="font-medium text-zinc-950 dark:text-zinc-50">快速顺序</p>
              <p>1. 连接 Git 仓库</p>
              <p>2. 初始化 <code>fridge-config</code></p>
              <p>3. 创建并展开冰盒</p>
            </div>
          </div>
        </section>

        <ProjectStatus />
        <GitConfigPanel />
        <IceBoxList />

        <section className="fridge-panel grid gap-3">
          <details className="rounded-[24px] border border-zinc-200/80 bg-white/60 p-5 text-sm leading-6 text-zinc-600 dark:border-white/10 dark:bg-white/5 dark:text-zinc-300">
            <summary className="cursor-pointer font-medium text-zinc-950 dark:text-zinc-50">使用帮助</summary>
            <div className="mt-3 grid gap-2">
              <p>先在上面保存并测试仓库连接，再初始化 <code>fridge-config</code>。</p>
              <p>冰盒详情已移到首页列表里，展开后可继续做备份、恢复和 Skill 生成。</p>
              <p>如果某个冰盒显示待同步，先同步到远端，再查看历史或执行恢复。</p>
            </div>
          </details>
        </section>
      </div>
    </main>
  );
}
