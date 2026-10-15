// [미러] UserApiRegistrationModal.tsx 의 submitParams(1794~2012) 중 핵심 기관(kosis/bok/fred)
// 파라미터 조립 로직을 서버로 이식한 것. 마법사 규칙이 바뀌면 여기도 동기화 필요(drift).
//
// api-config POST 는 provider 템플릿 그룹 파라미터를 키 기준으로 병합하고, 여기서 보낸 파라미터가
// 같은 키를 덮어쓴다(빈 값은 버림). 따라서 여기서는 "동적 파라미터"만 템플릿과 동일한
// key/location/order/role 로 만들어 반환한다. 정적 파라미터(method/format/lang/file_type 등)는
// api-config 가 템플릿에서 자동 병합한다.

export type BuiltParam = {
  key: string;
  value: string;
  location: "path" | "query";
  order: number;
  role: string | null;
  encodeMode: string;
};

export type BuildInput = {
  provider: string;
  code: string; // search_statistic 결과의 code (통계코드/series_id)
  cycle?: string; // 주기(M/D/Q/A/Y 또는 provider 표기)
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  userStatsId?: string; // kosis 전용(활용신청 통계표 ID)
};

export type BuildResult = {
  ok: boolean;
  provider: string;
  baseUrl: string;
  params: BuiltParam[];
  notes: string[];
  error?: string;
};

// 자동 파라미터 조립 지원 provider (핵심 기관). 그 외는 미지원 안내.
export const SUPPORTED_BUILD_PROVIDERS = ["kosis", "bok", "fred", "custom"];

const BASE_URL: Record<string, string> = {
  kosis: "https://kosis.kr/openapi/statisticsData.do",
  bok: "https://ecos.bok.or.kr/api/StatisticSearch",
  fred: "https://api.stlouisfed.org/fred/series/observations",
};

const pad = (n: number) => String(n).padStart(2, "0");

const parseDate = (s: string): { y: number; mo: number; d: number } | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").trim());
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
};

const normPeriod = (cycle?: string): "D" | "M" | "Q" | "A" | "Y" => {
  const c = (cycle ?? "").trim().toUpperCase();
  return (["D", "M", "Q", "A", "Y"] as const).includes(c as "D" | "M" | "Q" | "A" | "Y")
    ? (c as "D" | "M" | "Q" | "A" | "Y")
    : "M";
};

// 마법사 formatForPeriod 미러: D→YYYYMMDD, Q→YYYYQn, A/Y→YYYY, 그 외→YYYYMM
const formatForPeriod = (s: string, period: string): string => {
  const p = parseDate(s);
  if (!p) return "";
  if (period === "D") return `${p.y}${pad(p.mo)}${pad(p.d)}`;
  if (period === "Q") return `${p.y}Q${Math.floor((p.mo - 1) / 3) + 1}`;
  if (period === "A" || period === "Y") return `${p.y}`;
  return `${p.y}${pad(p.mo)}`;
};

const isoOnly = (s: string): string => {
  const p = parseDate(s);
  return p ? `${p.y}-${pad(p.mo)}-${pad(p.d)}` : "";
};

export const buildCollectionParams = (input: BuildInput): BuildResult => {
  const provider = (input.provider ?? "").trim().toLowerCase();
  const code = (input.code ?? "").trim();

  if (provider === "kosis") {
    const period = normPeriod(input.cycle);
    const params: BuiltParam[] = [
      {
        key: "userStatsId",
        value: (input.userStatsId ?? "").trim() || code,
        location: "query",
        order: 4,
        role: null,
        encodeMode: "encode",
      },
      { key: "prdSe", value: period, location: "query", order: 5, role: "period_type", encodeMode: "encode" },
      { key: "startPrdDe", value: formatForPeriod(input.startDate, period), location: "query", order: 6, role: "start", encodeMode: "encode" },
      { key: "endPrdDe", value: formatForPeriod(input.endDate, period), location: "query", order: 7, role: "end", encodeMode: "encode" },
    ];
    return {
      ok: true,
      provider,
      baseUrl: BASE_URL.kosis,
      params,
      notes: [
        "KOSIS: userStatsId 는 KOSIS 활용신청 통계표 ID 입니다. 사용자가 값을 주면 그것을, 없으면 통계코드로 대체하지만 정확한 수집을 위해 활용신청 ID 를 권장합니다.",
      ],
    };
  }

  if (provider === "bok") {
    const period = normPeriod(input.cycle);
    const params: BuiltParam[] = [
      { key: "statCode", value: code, location: "path", order: 5, role: null, encodeMode: "encode" },
      { key: "period", value: period, location: "path", order: 6, role: "period_type", encodeMode: "encode" },
      { key: "apiStart", value: formatForPeriod(input.startDate, period), location: "path", order: 7, role: "start", encodeMode: "encode" },
      { key: "apiEnd", value: formatForPeriod(input.endDate, period), location: "path", order: 8, role: "end", encodeMode: "encode" },
    ];
    return {
      ok: true,
      provider,
      baseUrl: BASE_URL.bok,
      params,
      notes: [
        "BOK ECOS: 통계표에 항목코드(itemCode1 등)가 여러 개인 경우, 그대로 수집하면 여러 항목이 함께 들어옵니다. 특정 항목만 원하면 매핑 단계의 whereClause 로 거르세요.",
      ],
    };
  }

  if (provider === "fred") {
    const frequency = (input.cycle ?? "").trim().toLowerCase() || "m";
    const params: BuiltParam[] = [
      { key: "series_id", value: code, location: "query", order: 5, role: null, encodeMode: "encode" },
      { key: "frequency", value: frequency, location: "query", order: 6, role: "period_type", encodeMode: "encode" },
      { key: "observation_start", value: isoOnly(input.startDate), location: "query", order: 7, role: "start", encodeMode: "encode" },
      { key: "observation_end", value: isoOnly(input.endDate), location: "query", order: 8, role: "end", encodeMode: "encode" },
    ];
    return { ok: true, provider, baseUrl: BASE_URL.fred, params, notes: [] };
  }

  if (provider === "custom") {
    return {
      ok: true,
      provider,
      baseUrl: "",
      params: [],
      notes: ["custom: 기본 URL과 파라미터를 사용자와 함께 직접 지정하세요."],
    };
  }

  return {
    ok: false,
    provider,
    baseUrl: "",
    params: [],
    notes: [],
    error: `'${provider}' 는 자동 파라미터 조립 미지원입니다. 지원: ${SUPPORTED_BUILD_PROVIDERS.join(
      ", ",
    )}. 그 외 기관(oecd·krx·undp·worldbank·datagokr 특수)은 기존 '데이터 수집' 화면을 이용하세요.`,
  };
};
