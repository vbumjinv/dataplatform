"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type DbSetting = {
  id: number;
  settingName: string;
  dbType: "postgres";
  host: string;
  port: number | null;
  url: string;
  database: string;
  user: string;
  password: string;
  hasPassword: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

type DbSettingsResponse = {
  ok: boolean;
  settings?: DbSetting[];
  error?: string;
};

type ModalMode = "create" | "edit" | null;

const toDateTime = (value: string | null) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ko-KR");
};

export default function DbSettingsPage() {
  const [settings, setSettings] = useState<DbSetting[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [testResultOpen, setTestResultOpen] = useState(false);
  const [testResultIsError, setTestResultIsError] = useState(false);
  const [testResultText, setTestResultText] = useState("");
  const [testingRowId, setTestingRowId] = useState<number | null>(null);

  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [settingName, setSettingName] = useState("");
  const [dbType, setDbType] = useState<"postgres">("postgres");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");

  const generatedUrl =
    dbType === "postgres"
      ? `jdbc:postgresql://${host || "<ip>"}:${port || "<port>"}/`
      : "";

  const load = async () => {
    setLoading(true);
    setPageError(null);
    setPageMessage(null);
    try {
      const response = await fetch("/api/db/settings", { cache: "no-store" });
      const payload = (await response.json()) as DbSettingsResponse;
      if (!response.ok || !payload.ok) {
        setPageError(payload.error ?? "DB 설정을 불러오지 못했습니다.");
        return;
      }
      const loaded = payload.settings ?? [];
      setSettings(loaded);
      if (loaded.length === 0) {
        setPageMessage("저장된 DB 설정이 없습니다. 새 설정 추가로 등록하세요.");
      }
    } catch {
      setPageError("DB 설정을 불러오는 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setSettingName("");
    setDbType("postgres");
    setHost("");
    setPort("5432");
    setDatabase("");
    setUser("");
    setPassword("");
    setModalError(null);
  };

  const openCreateModal = () => {
    resetForm();
    setModalMode("create");
  };

  const openEditModal = (item: DbSetting) => {
    setEditingId(item.id);
    setSettingName(item.settingName);
    setDbType(item.dbType);
    setHost(item.host);
    setPort(item.port ? String(item.port) : "5432");
    setDatabase(item.database);
    setUser(item.user);
    setPassword(item.password);
    setModalError(null);
    setModalMode("edit");
  };

  const closeModal = () => {
    setModalMode(null);
    resetForm();
  };

  const onTestConnection = async () => {
    if (testing) return;
    setTesting(true);
    setModalError(null);
    try {
      const response = await fetch("/api/db/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dbType,
          url: generatedUrl,
          database,
          user,
          password,
        }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
        durationMs?: number;
      };
      if (!response.ok || !payload.ok) {
        setTestResultIsError(true);
        setTestResultText(payload.error ?? "연결 테스트에 실패했습니다.");
        setTestResultOpen(true);
        return;
      }
      setTestResultIsError(false);
      setTestResultText(
        `연결 테스트 성공 (${Math.max(0, Number(payload.durationMs ?? 0))}ms)`,
      );
      setTestResultOpen(true);
    } catch {
      setTestResultIsError(true);
      setTestResultText("연결 테스트 중 오류가 발생했습니다.");
      setTestResultOpen(true);
    } finally {
      setTesting(false);
    }
  };

  const onTestRowConnection = async (item: DbSetting) => {
    if (testingRowId !== null) return;
    setTestingRowId(item.id);
    try {
      const response = await fetch("/api/db/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dbType: item.dbType,
          url: item.url,
          database: item.database,
          user: item.user,
          password: item.password,
        }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
        durationMs?: number;
      };
      if (!response.ok || !payload.ok) {
        setTestResultIsError(true);
        setTestResultText(payload.error ?? "연결 테스트에 실패했습니다.");
        setTestResultOpen(true);
        return;
      }
      setTestResultIsError(false);
      setTestResultText(
        `'${item.settingName}' 연결 테스트 성공 (${Math.max(0, Number(payload.durationMs ?? 0))}ms)`,
      );
      setTestResultOpen(true);
    } catch {
      setTestResultIsError(true);
      setTestResultText("연결 테스트 중 오류가 발생했습니다.");
      setTestResultOpen(true);
    } finally {
      setTestingRowId(null);
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !modalMode) return;
    setSaving(true);
    setModalError(null);
    try {
      const method = modalMode === "create" ? "POST" : "PUT";
      const body =
        modalMode === "create"
          ? {
              settingName,
              dbType,
              host,
              port,
              database,
              user,
              password,
            }
          : {
              id: editingId,
              settingName,
              dbType,
              host,
              port,
              database,
              user,
              password,
            };
      const response = await fetch("/api/db/settings", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        setModalError(
          payload.error ??
            (modalMode === "create"
              ? "DB 설정 저장에 실패했습니다."
              : "DB 설정 수정에 실패했습니다."),
        );
        return;
      }
      closeModal();
      setPageMessage(
        modalMode === "create"
          ? "DB 설정이 저장되었습니다."
          : "DB 설정이 수정되었습니다.",
      );
      await load();
    } catch {
      setModalError("요청 처리 중 오류가 발생했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: number, name: string) => {
    if (!window.confirm(`'${name}' 설정을 삭제할까요?`)) return;
    setPageError(null);
    setPageMessage(null);
    try {
      const response = await fetch("/api/db/settings", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        setPageError(payload.error ?? "DB 설정 삭제에 실패했습니다.");
        return;
      }
      setPageMessage("DB 설정이 삭제되었습니다.");
      await load();
    } catch {
      setPageError("DB 설정 삭제 중 오류가 발생했습니다.");
    }
  };

  const modalTitle = useMemo(
    () => (modalMode === "create" ? "새 DB 설정 추가" : "DB 설정 수정"),
    [modalMode],
  );

  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">DB 설정</h2>
            <p className="mt-2 text-sm text-slate-600">
              저장된 DB 설정 목록입니다. 최근 수정된 설정이 `/api/db/*` 기본 연결로 사용됩니다.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreateModal}
            className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            새 설정 추가
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="px-2 py-2">이름</th>
                <th className="px-2 py-2">호스트</th>
                <th className="px-2 py-2">포트</th>
                <th className="px-2 py-2">DB명</th>
                <th className="px-2 py-2">사용자</th>
                <th className="px-2 py-2">수정자</th>
                <th className="px-2 py-2">수정시각</th>
                <th className="px-2 py-2">관리</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="px-2 py-3 text-slate-500" colSpan={8}>
                    불러오는 중...
                  </td>
                </tr>
              ) : settings.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-slate-500" colSpan={8}>
                    저장된 DB 설정이 없습니다.
                  </td>
                </tr>
              ) : (
                settings.map((item) => (
                  <tr key={item.id} className="border-b border-slate-100">
                    <td className="px-2 py-2">{item.settingName}</td>
                    <td className="px-2 py-2">{item.host || "-"}</td>
                    <td className="px-2 py-2">{item.port ?? "-"}</td>
                    <td className="px-2 py-2">{item.database}</td>
                    <td className="px-2 py-2">{item.user}</td>
                    <td className="px-2 py-2">{item.updatedBy ?? "-"}</td>
                    <td className="px-2 py-2">{toDateTime(item.updatedAt)}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void onTestRowConnection(item)}
                          disabled={testingRowId !== null}
                          className="rounded-lg border border-blue-300 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-60"
                        >
                          {testingRowId === item.id ? "테스트 중..." : "연결 테스트"}
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditModal(item)}
                          className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          수정
                        </button>
                        <button
                          type="button"
                          onClick={() => void onDelete(item.id, item.settingName)}
                          className="rounded-lg border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                        >
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modalMode ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            className={`relative w-full max-w-2xl overflow-hidden rounded-2xl bg-white p-6 ${
              testResultOpen
                ? "shadow-none"
                : "border border-slate-200 shadow-xl"
            }`}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">{modalTitle}</h3>
              <button
                type="button"
                onClick={closeModal}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                닫기
              </button>
            </div>
            <form onSubmit={onSubmit} className="mt-4 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">설정 이름</span>
                  <input
                    value={settingName}
                    onChange={(e) => setSettingName(e.target.value)}
                    placeholder="예: 운영 DB"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-200 focus:border-blue-500 focus:ring-2"
                    required
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">DB 유형</span>
                  <select
                    value={dbType}
                    onChange={(e) => setDbType(e.target.value as "postgres")}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-200 focus:border-blue-500 focus:ring-2"
                  >
                    <option value="postgres">postgres</option>
                  </select>
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">IP / 호스트</span>
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="127.0.0.1"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-200 focus:border-blue-500 focus:ring-2"
                    required
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">포트</span>
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="5432"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-200 focus:border-blue-500 focus:ring-2"
                    required
                  />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">데이터베이스명</span>
                  <input
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-200 focus:border-blue-500 focus:ring-2"
                    required
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">사용자명</span>
                  <input
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-200 focus:border-blue-500 focus:ring-2"
                    required
                  />
                </label>
              </div>

              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">비밀번호</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="비밀번호를 입력하세요"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-blue-200 focus:border-blue-500 focus:ring-2"
                  required
                />
              </label>

              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">자동 생성 URL</span>
                <input
                  value={generatedUrl}
                  readOnly
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"
                />
              </label>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void onTestConnection()}
                  disabled={testing}
                  className="rounded-xl border border-blue-300 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-60"
                >
                  {testing ? "테스트 중..." : "연결 테스트"}
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  취소
                </button>
                <button
                  type="submit"
                  disabled={saving || testing}
                  className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                >
                  {saving ? "처리 중..." : "확인"}
                </button>
              </div>
              {modalError ? (
                <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {modalError}
                </p>
              ) : null}
            </form>

            {testResultOpen ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/20 p-4">
                <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
                  <h4 className="text-base font-semibold text-slate-900">연결 테스트 결과</h4>
                  <p
                    className={`mt-3 rounded-xl border px-3 py-2 text-sm ${
                      testResultIsError
                        ? "border-rose-200 bg-rose-50 text-rose-700"
                        : "border-emerald-200 bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    {testResultText}
                  </p>
                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setTestResultOpen(false)}
                      className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      확인
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {testResultOpen && !modalMode ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h4 className="text-base font-semibold text-slate-900">연결 테스트 결과</h4>
            <p
              className={`mt-3 rounded-xl border px-3 py-2 text-sm ${
                testResultIsError
                  ? "border-rose-200 bg-rose-50 text-rose-700"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
            >
              {testResultText}
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setTestResultOpen(false)}
                className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pageMessage ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {pageMessage}
        </p>
      ) : null}
      {pageError ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {pageError}
        </p>
      ) : null}
    </section>
  );
}
