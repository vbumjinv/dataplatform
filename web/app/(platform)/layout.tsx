import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth-session";

const navItems = [
  {
    title: "대시보드",
    href: "/",
    description: "플랫폼 전체 현황과 알림",
  },
  {
    title: "사용자 관리",
    href: "/users",
    description: "사용자 계정 및 권한 관리",
  },
  {
    title: "DB 설정",
    href: "/db-settings",
    description: "DB 연결 정보 저장 및 관리",
  },
  {
    title: "데이터 수집",
    href: "/ingestion",
    description: "소스 연결, 파이프라인, 수집 작업",
  },
  {
    title: "데이터 시각화",
    href: "/visualization",
    description: "대시보드, 리포트, 공유",
  },
  {
    title: "코스피 예측",
    href: "/analysis",
    description: "뉴스 기반 KOSPI 예측 실행",
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
    title: "AI 분석 테스트 2.1",
    href: "/ai-forecast-test-2-1",
    description: "OpenAI 전용 직접 예측 PoC",
  },
  {
    title: "AI 분석 테스트 2.2",
    href: "/ai-forecast-test-2-2",
    description: "Ollama + OpenAI 직접 예측 PoC",
  },
  {
    title: "AI 분석 테스트 3",
    href: "/ai-forecast-test-3",
    description: "자연어 질의 기반 자동 예측 PoC",
  },
];

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  if (!session) {
    redirect("/login");
  }
  if (session.role !== "admin") {
    redirect("/forbidden");
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex min-h-screen">
        <aside className="hidden w-64 flex-col border-r border-slate-200 bg-white px-4 py-6 md:flex">
          <div className="flex items-center justify-between">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              FinJump
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
                FinJump
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600">
                {session.email}
              </span>
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                {session.role}
              </span>
              {/* 일반 <a> 로 둔다. next/link 로 두면 프로덕션에서 자동 프리페치되어
                  페이지 진입만 해도 로그아웃 GET 이 호출돼 세션이 지워진다. */}
              <a
                href="/api/auth/logout"
                className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
              >
                로그아웃
              </a>
            </div>
          </header>
          <main className="flex-1 px-6 py-6">{children}</main>
        </div>
      </div>
    </div>
  );
}

