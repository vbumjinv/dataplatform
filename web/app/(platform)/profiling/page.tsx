const stats = [
  { label: "최대값", value: "38.7", unit: "°C" },
  { label: "최소값", value: "-12.3", unit: "°C" },
  { label: "평균", value: "18.4", unit: "°C" },
  { label: "IQR", value: "9.8", unit: "°C" },
];

const features = [
  "기온 범위(-40~40°C) 기준 이상치 탐지",
  "필드별 분포/왜도/결측률 자동 계산",
  "파이프라인 수집 단계에서 즉시 산출",
];

export default function ProfilingPage() {
  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold text-slate-900">
          데이터 특성값 및 통계
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          수집 단계에서 기준값을 적용해 통계를 자동으로 계산합니다.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-3xl border border-slate-200 bg-white p-5"
          >
            <p className="text-xs text-slate-500">{stat.label}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {stat.value}
              <span className="ml-1 text-sm text-slate-400">{stat.unit}</span>
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6">
          <h3 className="text-base font-semibold text-slate-900">
            프로파일링 요약
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            <li>기상청 API 수집 데이터 38개 컬럼 분석</li>
            <li>기온 기준 범위 위반 2건 감지</li>
            <li>특성값 계산 완료 후 품질 단계로 전달</li>
          </ul>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-6">
          <h3 className="text-base font-semibold text-slate-900">자동화 기능</h3>
          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            {features.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

