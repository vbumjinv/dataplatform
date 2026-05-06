import Link from "next/link";

const navItems = [
  {
    title: "대시보드",
    href: "/",
    description: "플랫폼 전체 현황과 알림",
  },
  {
    title: "데이터 수집",
    href: "/ingestion",
    description: "소스 연결, 파이프라인, 수집 작업",
  },
  {
    title: "데이터 특성값",
    href: "/profiling",
    description: "기본 통계, 분포, 특성값",
  },
  {
    title: "데이터 품질",
    href: "/quality",
    description: "규칙, 품질 지표, 이슈 관리",
  },
  {
    title: "데이터 시각화",
    href: "/visualization",
    description: "대시보드, 리포트, 공유",
  },
  {
    title: "분석(예정)",
    href: "/analysis",
    description: "모델/노트북 기반 분석 공간",
  },
  {
    title: "AI 분석 테스트",
    href: "/ai-forecast-test",
    description: "시계열 예측 + LLM 요약 PoC",
  },
  {
    title: "AI 분석 테스트 2",
    href: "/ai-forecast-test-2",
    description: "Ollama 직접 예측 PoC",
  },
  {
    title: "AI 분석 테스트 3",
    href: "/ai-forecast-test-3",
    description: "자연어 질의 기반 자동 예측 PoC",
  },
];

export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex min-h-screen">
        <aside className="hidden w-64 flex-col border-r border-slate-200 bg-white px-4 py-6 md:flex">
          <div className="flex items-center justify-between">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Data Platform
            </Link>
            <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-500">
              v0
            </span>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            수집부터 품질, 시각화까지 연결된 데이터 경험을 설계합니다.
          </p>
          <nav className="mt-6 flex flex-1 flex-col gap-2">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-xl border border-transparent px-3 py-2 text-sm transition hover:border-slate-200 hover:bg-slate-50"
              >
                <div className="font-medium text-slate-900">{item.title}</div>
                <div className="text-xs text-slate-500">{item.description}</div>
              </Link>
            ))}
          </nav>
          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
            <p className="font-semibold text-slate-700">워크플로우 옵션</p>
            <p className="mt-1">
              노드 기반 워크플로우는 기능 확장 시 활성화됩니다.
            </p>
            <Link
              href="/workflow"
              className="mt-2 inline-flex items-center text-xs font-semibold text-blue-600 hover:text-blue-700"
            >
              기존 프로토타입 보기 →
            </Link>
          </div>
        </aside>
        <div className="flex min-h-screen flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                Data Platform
              </p>
              <h1 className="text-lg font-semibold text-slate-900">
                데이터 플랫폼 설계 초안
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <button className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700">
                새 파이프라인
              </button>
              <button className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white">
                대시보드 공유
              </button>
            </div>
          </header>
          <main className="flex-1 px-6 py-6">{children}</main>
        </div>
      </div>
    </div>
  );
}

