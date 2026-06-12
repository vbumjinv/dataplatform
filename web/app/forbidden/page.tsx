import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
          Access Denied
        </p>
        <h1 className="mt-2 text-xl font-semibold text-slate-900">
          관리자 권한이 필요합니다
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          현재 계정은 관리자 페이지에 접근할 수 없습니다.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Link
            href="/api/auth/logout"
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            다른 계정으로 로그인
          </Link>
        </div>
      </div>
    </div>
  );
}
