import { GitConfigPanel } from "@/components/home/git-config-panel";
import { IceBoxList } from "@/components/home/ice-box-list";
import { ProjectStatus } from "@/components/home/project-status";

const onboardingSteps = [
  {
    title: "连接 Git 仓库",
    description: "先接通存储仓库，首页会直接帮你完成测试与初始化入口。",
  },
  {
    title: "初始化 fridge-config",
    description: "把全局配置和冰盒清单落到专属分支，后续流程才有统一落点。",
  },
  {
    title: "创建冰盒",
    description: "自动生成 machine-id、分支名和 Skill 所需配置。",
  },
  {
    title: "交付 Skill 与恢复入口",
    description: "详情页继续提供 Git / 上传模式说明、历史快照和恢复流程。",
  },
];

export default function Home() {
  return (
    <main className="fridge-page">
      <div className="fridge-shell">
        <section className="fridge-hero">
          <div className="relative z-10 flex flex-wrap items-center gap-3 text-sm font-medium">
            <span className="fridge-chip fridge-chip--ocean">Home</span>
            <span className="fridge-chip">Ocean Blue / Ice White / Coral Pink</span>
            <span className="fridge-chip fridge-chip--coral">Phase 2 UX</span>
          </div>

          <div className="relative z-10 grid gap-5 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
            <div className="space-y-3">
              <p className="fridge-kicker">Claw-Fridge Console</p>
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">先接仓库，再冻住每一台 OpenClaw。</h1>
              <p className="max-w-3xl text-base leading-7 text-zinc-600 dark:text-zinc-300 sm:text-lg">
                首页现在按真实操作顺序把首次配置串起来：测试 Git 仓库、初始化 <code>fridge-config</code>、创建冰盒，再继续进入详情页生成 Skill 文档与恢复方案。
              </p>
            </div>

            <div className="fridge-panel-tint relative z-10 grid gap-3 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
              <p className="font-medium text-zinc-950 dark:text-zinc-50">为什么这样排？</p>
              <p>因为冰盒不是孤立记录，它需要先知道配置写去哪、备份推去哪、恢复从哪拉。</p>
              <p>这版重点不是炫技，是把“第一次上手”和“后续维护”都讲明白。</p>
            </div>
          </div>

          <div className="relative z-10 fridge-step-grid">
            {onboardingSteps.map((step, index) => (
              <div key={step.title} className="fridge-step-card">
                <div className="mb-3 flex items-center gap-3">
                  <span className="fridge-step-number">{index + 1}</span>
                  <p className="font-semibold text-zinc-950 dark:text-zinc-50">{step.title}</p>
                </div>
                <p className="text-zinc-600 dark:text-zinc-300">{step.description}</p>
              </div>
            ))}
          </div>
        </section>

        <ProjectStatus />
        <GitConfigPanel />
        <IceBoxList />
      </div>
    </main>
  );
}
