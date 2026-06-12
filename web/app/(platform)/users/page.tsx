"use client";

import { useEffect, useMemo, useState } from "react";

type UserItem = {
  id: number;
  email: string;
  name: string | null;
  phoneNo: string | null;
  role: string;
  emailVerified: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type AccessLogItem = {
  accessLogId: number;
  userId: number | null;
  email: string | null;
  action: string;
  status: string;
  ipAddress: string | null;
  detail: string | null;
  createdAt: string;
};

type UsersApiResponse = {
  ok: boolean;
  users?: UserItem[];
  accessLogs?: AccessLogItem[];
  error?: string;
};

type AdminTab = "users" | "logs";

const USERS_PER_PAGE = 10;

const toDateTime = (value: string | null) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ko-KR");
};

export default function UsersPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [accessLogs, setAccessLogs] = useState<AccessLogItem[]>([]);
  const [activeTab, setActiveTab] = useState<AdminTab>("users");
  const [userPage, setUserPage] = useState(1);

  const adminCount = useMemo(
    () => users.filter((u) => u.role === "admin").length,
    [users],
  );
  const totalUserPages = useMemo(
    () => Math.max(1, Math.ceil(users.length / USERS_PER_PAGE)),
    [users.length],
  );
  const pagedUsers = useMemo(() => {
    const start = (userPage - 1) * USERS_PER_PAGE;
    return users.slice(start, start + USERS_PER_PAGE);
  }, [userPage, users]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/users", {
        cache: "no-store",
      });
      const payload = (await response.json()) as UsersApiResponse;
      if (!response.ok || !payload.ok) {
        setError(payload.error ?? "사용자 목록을 불러오지 못했습니다.");
        setUsers([]);
        setAccessLogs([]);
        return;
      }
      setUsers(payload.users ?? []);
      setAccessLogs(payload.accessLogs ?? []);
    } catch {
      setError("사용자 관리 데이터를 가져오는 중 오류가 발생했습니다.");
      setUsers([]);
      setAccessLogs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (userPage > totalUserPages) {
      setUserPage(totalUserPages);
    }
  }, [totalUserPages, userPage]);

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">사용자 관리</h2>
            <p className="mt-2 text-sm text-slate-600">
              사용자 목록과 최근 로그인 접속 이력을 확인할 수 있습니다.
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            새로고침
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-500">
          <span className="rounded-full bg-slate-100 px-3 py-1">
            전체 사용자 {users.length}명
          </span>
          <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-700">
            관리자 {adminCount}명
          </span>
          <span className="rounded-full bg-blue-100 px-3 py-1 text-blue-700">
            최근 로그 {accessLogs.length}건
          </span>
        </div>
        {error ? (
          <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
          <button
            onClick={() => setActiveTab("users")}
            className={
              activeTab === "users"
                ? "rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white"
                : "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            }
          >
            사용자 목록
          </button>
          <button
            onClick={() => setActiveTab("logs")}
            className={
              activeTab === "logs"
                ? "rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white"
                : "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            }
          >
            최근접속 로그
          </button>
        </div>

        {activeTab === "users" ? (
          <div className="mt-4 space-y-4">
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="px-2 py-2">ID</th>
                    <th className="px-2 py-2">이메일</th>
                    <th className="px-2 py-2">이름</th>
                    <th className="px-2 py-2">전화번호</th>
                    <th className="px-2 py-2">권한</th>
                    <th className="px-2 py-2">이메일인증</th>
                    <th className="px-2 py-2">생성일</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td className="px-2 py-3 text-slate-500" colSpan={7}>
                        불러오는 중...
                      </td>
                    </tr>
                  ) : users.length === 0 ? (
                    <tr>
                      <td className="px-2 py-3 text-slate-500" colSpan={7}>
                        사용자 데이터가 없습니다.
                      </td>
                    </tr>
                  ) : (
                    pagedUsers.map((user) => (
                      <tr key={user.id} className="border-b border-slate-100">
                        <td className="px-2 py-2">{user.id}</td>
                        <td className="px-2 py-2">{user.email}</td>
                        <td className="px-2 py-2">{user.name ?? "-"}</td>
                        <td className="px-2 py-2">{user.phoneNo ?? "-"}</td>
                        <td className="px-2 py-2">
                          <span
                            className={
                              user.role === "admin"
                                ? "rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-700"
                                : "rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
                            }
                          >
                            {user.role}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          {user.emailVerified === null
                            ? "-"
                            : user.emailVerified
                              ? "Y"
                              : "N"}
                        </td>
                        <td className="px-2 py-2">{toDateTime(user.createdAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-500">
                페이지 {userPage} / {totalUserPages}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setUserPage((prev) => Math.max(1, prev - 1))}
                  disabled={loading || userPage === 1}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  이전
                </button>
                <button
                  onClick={() =>
                    setUserPage((prev) => Math.min(totalUserPages, prev + 1))
                  }
                  disabled={loading || userPage >= totalUserPages}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  다음
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="px-2 py-2">시간</th>
                  <th className="px-2 py-2">이메일</th>
                  <th className="px-2 py-2">상태</th>
                  <th className="px-2 py-2">액션</th>
                  <th className="px-2 py-2">IP</th>
                  <th className="px-2 py-2">상세</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td className="px-2 py-3 text-slate-500" colSpan={6}>
                      불러오는 중...
                    </td>
                  </tr>
                ) : accessLogs.length === 0 ? (
                  <tr>
                    <td className="px-2 py-3 text-slate-500" colSpan={6}>
                      접속 로그가 없습니다. (마이그레이션 적용 후 로그인 시 누적됩니다.)
                    </td>
                  </tr>
                ) : (
                  accessLogs.map((log) => (
                    <tr key={log.accessLogId} className="border-b border-slate-100">
                      <td className="px-2 py-2">{toDateTime(log.createdAt)}</td>
                      <td className="px-2 py-2">{log.email ?? "-"}</td>
                      <td className="px-2 py-2">
                        <span
                          className={
                            log.status === "success"
                              ? "rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700"
                              : "rounded-full bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-700"
                          }
                        >
                          {log.status}
                        </span>
                      </td>
                      <td className="px-2 py-2">{log.action}</td>
                      <td className="px-2 py-2">{log.ipAddress ?? "-"}</td>
                      <td className="px-2 py-2">{log.detail ?? "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
