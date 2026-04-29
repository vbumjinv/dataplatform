const checks = [
  { name: "표준 단어/용어 매핑", status: "정상", owner: "DQ Team" },
  { name: "전체 Null 컬럼 감지", status: "주의", owner: "ETL Team" },
  { name: "기온 범위 위반", status: "경고", owner: "Analytics" },
];

export default function QualityPage() {
  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold text-slate-900">데이터 품질</h2>
        <p className="mt-2 text-sm text-slate-600">
          수집 단계에서 특성값과 함께 품질 규칙을 자동 적용합니다.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">품질 점수</p>
          <p className="mt-2 text-2xl font-semibold text-emerald-600">
            92 / 100
          </p>
          <p className="mt-1 text-xs text-slate-500">
            파이프라인 자동 점검 결과
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">오류 이벤트</p>
          <p className="mt-2 text-2xl font-semibold text-amber-500">3</p>
          <p className="mt-1 text-xs text-slate-500">
            널 컬럼/표준용어 위반 포함
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">활성 규칙</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">28</p>
          <p className="mt-1 text-xs text-slate-500">팀별 정책 적용</p>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">
            품질 규칙 현황
          </h3>
          <button className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700">
            규칙 추가
          </button>
        </div>
        <div className="mt-4 space-y-3 text-sm text-slate-600">
          {checks.map((check) => (
            <div
              key={check.name}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3"
            >
              <div>
                <p className="font-semibold text-slate-900">{check.name}</p>
                <p className="text-xs text-slate-500">담당: {check.owner}</p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                {check.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

