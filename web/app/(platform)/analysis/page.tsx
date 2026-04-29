export default function AnalysisPage() {
  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <h2 className="text-xl font-semibold text-slate-900">
          데이터 분석 화면 (예정)
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          모델 실험, 노트북 실행, 분석 결과 공유를 위한 영역입니다.
        </p>
      </header>

      <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
        <p className="font-semibold text-slate-900">준비 중</p>
        <p className="mt-2">
          향후 분석 워크플로우와 결과 공유를 위한 설계를 이 영역에
          추가합니다.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold text-slate-700">
              실험 추적 및 모델 관리
            </p>
            <p className="mt-2 text-xs text-slate-500">
              ML 실험 로그, 모델 버전, 배포 상태를 확인합니다.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold text-slate-700">
              협업형 노트북
            </p>
            <p className="mt-2 text-xs text-slate-500">
              데이터 탐색과 분석 결과를 팀과 공유합니다.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

