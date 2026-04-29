import Link from "next/link";

const highlights = [
  {
    title: "데이터 수집 파이프라인",
    description: "소스 연결, 스케줄링, 오류 모니터링을 한 화면에서 관리.",
    href: "/ingestion",
    meta: "12개 연결 • 2개 경고",
  },
  {
    title: "데이터 특성값",
    description: "최대값, 평균, IQR 등 핵심 통계를 자동 산출.",
    href: "/profiling",
    meta: "최근 7일 기준",
  },
  {
    title: "데이터 품질",
    description: "품질 규칙, 이상치, 결측률을 추적.",
    href: "/quality",
    meta: "품질 점수 92/100",
  },
  {
    title: "데이터 시각화",
    description: "지표 대시보드 및 리포트를 빠르게 공유.",
    href: "/visualization",
    meta: "5개 대시보드",
  },
];

export default function PlatformHome() {
  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-white via-white to-slate-100 p-6">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-400">
            Platform Overview
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">
            데이터 플랫폼의 핵심 흐름을 한눈에 정리합니다.
          </h2>
          <p className="mt-3 text-sm text-slate-600">
            수집 → 특성값/통계 → 품질 점검 → 시각화로 이어지는 기반 화면을
            구성하고, 필요한 경우 워크플로우를 확장할 수 있습니다.
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-500">
            <span className="rounded-full bg-white px-3 py-1 shadow-sm">
              데이터 수집
            </span>
            <span className="rounded-full bg-white px-3 py-1 shadow-sm">
              통계/프로파일링
            </span>
            <span className="rounded-full bg-white px-3 py-1 shadow-sm">
              품질 체크
            </span>
            <span className="rounded-full bg-white px-3 py-1 shadow-sm">
              시각화
            </span>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {highlights.map((card) => (
          <Link
            key={card.title}
            href={card.href}
            className="group rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-1 hover:border-slate-300 hover:shadow-md"
          >
            <div className="flex items-start justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                {card.title}
              </h3>
              <span className="text-xs text-slate-400">{card.meta}</span>
            </div>
            <p className="mt-2 text-sm text-slate-600">{card.description}</p>
            <span className="mt-4 inline-flex text-xs font-semibold text-blue-600 group-hover:text-blue-700">
              상세 보기 →
            </span>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5">
          <h4 className="text-sm font-semibold text-slate-900">오늘의 알림</h4>
          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            <li>실시간 수집 작업 2건 진행 중</li>
            <li>품질 규칙 1건이 임계치를 초과</li>
            <li>대시보드 공유 요청 3건</li>
          </ul>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5">
          <h4 className="text-sm font-semibold text-slate-900">최근 활동</h4>
          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            <li>신규 소스 연결: CRM_DB</li>
            <li>프로파일링 리포트 업데이트</li>
            <li>시각화 템플릿 1건 생성</li>
          </ul>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5">
          <h4 className="text-sm font-semibold text-slate-900">다음 단계</h4>
          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            <li>데이터 수집 파이프라인 설계</li>
            <li>품질 규칙 템플릿 정의</li>
            <li>분석 화면 요구사항 수집</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

