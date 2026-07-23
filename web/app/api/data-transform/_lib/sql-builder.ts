// 데이터 가공: 기존 시리즈(dp.viz_map_data)를 입력(src)으로 받아
// obs_date / obs_value 두 컬럼을 산출하는 SELECT 를 생성한다.
// 입력 시리즈는 src CTE 로 노출된다: src(obs_date date, obs_value numeric)

export type TransformType =
  | "sql"
  | "resample"
  | "rate"
  | "combine"
  | "interpolate"
  | "movavg"
  | "python";
export type ResampleUnit = "day" | "week" | "month" | "quarter" | "year";
export type ResampleAgg = "avg" | "sum" | "max" | "min" | "last" | "first";
export type RateType = "pop" | "yoy"; // pop=전기대비, yoy=전년동기대비
export type CombineOp = "sub" | "add" | "mul" | "div"; // A-B, A+B, A*B, A/B

export type TransformConfig = {
  sql?: string;
  targetUnit?: ResampleUnit;
  agg?: ResampleAgg;
  rateType?: RateType;
  secondMapId?: number; // combine: 두 번째 시리즈(B)
  op?: CombineOp; // combine: 연산
  divToPercent?: boolean; // combine(div): 나누기 결과에 x100 적용(%)
  window?: number; // movavg: 이동평균 구간(관측치 개수)
  code?: string; // python: 사용자 작성 코드 (df 입력 → result 출력)
};

// python 가공은 SQL이 아니라 외부 Python 서비스(/transform)에서 실행된다.
export const isPythonTransform = (type: TransformType): boolean => type === "python";

// 사용자 Python 코드 검증: 비어있지 않고 result 변수를 설정해야 한다.
export const validateUserPython = (raw: string | undefined | null): string => {
  const code = (raw ?? "").trim();
  if (!code) throw new Error("Python 코드를 입력하세요.");
  if (!/\bresult\b/.test(code)) {
    throw new Error("결과를 result 변수에 담아야 합니다. (예: result = df.assign(y=trend))");
  }
  return code;
};

// 이동평균 구간 허용 범위 (관측치 개수)
const MOVAVG_MIN = 2;
const MOVAVG_MAX = 1000;

// date_trunc 단위 → freq 코드
const UNIT_FREQ: Record<ResampleUnit, string> = {
  day: "D",
  week: "W",
  month: "M",
  quarter: "Q",
  year: "Y",
};
// 업샘플(보간) 시 격자 생성 간격
const UNIT_STEP: Record<ResampleUnit, string> = {
  day: "1 day",
  week: "1 week",
  month: "1 month",
  quarter: "3 months",
  year: "1 year",
};
// 다운샘플(집계)은 day 제외 (일→일은 의미 없음)
const RESAMPLE_UNITS = new Set<ResampleUnit>(["week", "month", "quarter", "year"]);
// 업샘플(보간)은 day 포함
const INTERP_UNITS = new Set<ResampleUnit>(["day", "week", "month", "quarter", "year"]);
// 원본 freq 코드 → date_trunc/interval 단위어 (보간 앵커 계산용)
const FREQ_UNIT: Record<string, ResampleUnit> = {
  D: "day",
  W: "week",
  M: "month",
  Q: "quarter",
  Y: "year",
};
// 주기 세밀도 순위 (작을수록 짧은 주기). 보간은 target이 원본보다 짧아야 한다.
const UNIT_RANK: Record<ResampleUnit, number> = {
  day: 1,
  week: 2,
  month: 3,
  quarter: 4,
  year: 5,
};
const RESAMPLE_AGGS = new Set<ResampleAgg>(["avg", "sum", "max", "min", "last", "first"]);
const RATE_TYPES = new Set<RateType>(["pop", "yoy"]);
const COMBINE_OPS = new Set<CombineOp>(["sub", "add", "mul", "div"]);

const DENY_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|merge|vacuum|call|into)\b/i;

// SQL에서 주석을 제거한 사본. 안전성 검사는 "주석을 뺀 실제 코드"로 수행한다.
// (주석은 Postgres가 무시하므로 실행에는 원본을 그대로 쓰고, 검사에서만 제외)
export const stripSqlComments = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* ... */ 블록 주석
    .replace(/--[^\n]*/g, " "); // -- 줄 주석 (해당 줄 끝까지)

// 사용자 SQL 검증: 단일문, SELECT 또는 WITH 로 시작, DDL/DML 금지
// (편집창에 with src 정의를 직접 포함할 수 있으므로 WITH 시작을 허용한다)
// '--' 줄 주석은 허용한다. 검사·시작구문 판별은 주석을 제거한 코드로 하고,
// 실행에는 주석이 포함된 원본을 그대로 반환한다.
export const validateUserSql = (raw: string | undefined | null): string => {
  const sql = (raw ?? "").trim();
  if (!sql) throw new Error("SQL을 입력하세요.");
  const code = stripSqlComments(sql).trim(); // 주석을 뺀 실제 코드
  if (!code) throw new Error("SQL을 입력하세요.");
  if (code.includes(";")) throw new Error("세미콜론(;)으로 여러 문을 실행할 수 없습니다.");
  if (!/^(with|select)\b/i.test(code)) throw new Error("SELECT 또는 WITH 문으로 시작해야 합니다.");
  if (DENY_KEYWORDS.test(code)) throw new Error("조회(SELECT) 외의 키워드는 사용할 수 없습니다.");
  return sql;
};

const sourceCte = (sourceMapId: number) =>
  `with src as (
      select obs_date, obs_value::numeric as obs_value
      from dp.viz_map_data
      where map_id = ${Math.trunc(sourceMapId)}
    )`;

// 가공 유형/설정을 검증하고, obs_date / obs_value 를 산출하는 완성된 SELECT 를 반환
export const buildTransformSelect = (
  type: TransformType,
  config: TransformConfig,
  sourceMapId: number,
  sourceFreq?: string | null,
): string => {
  if (!Number.isFinite(sourceMapId) || sourceMapId <= 0) {
    throw new Error("입력 시리즈를 선택하세요.");
  }

  if (type === "python") {
    // python 가공은 SQL로 변환하지 않는다 (transform-runner 가 외부 서비스로 실행).
    throw new Error("Python 가공은 SQL로 변환할 수 없습니다.");
  }

  if (type === "sql") {
    const userSql = validateUserSql(config.sql);
    // WITH 로 시작하면 사용자가 src 정의를 편집창에 직접 포함한 것 → 그대로 실행.
    // SELECT 로 시작하면(구버전 호환) 시스템이 src CTE 를 앞에 주입한다.
    // (선두 주석은 무시하고 판별해야 src CTE 가 중복 주입되지 않는다)
    const code = stripSqlComments(userSql).trim();
    return /^with\b/i.test(code) ? userSql : `${sourceCte(sourceMapId)}\n${userSql}`;
  }

  const cte = sourceCte(sourceMapId);

  if (type === "resample") {
    const unit = config.targetUnit ?? "month";
    const agg = config.agg ?? "avg";
    if (!RESAMPLE_UNITS.has(unit)) throw new Error("지원하지 않는 리샘플 주기입니다.");
    if (!RESAMPLE_AGGS.has(agg)) throw new Error("지원하지 않는 집계 방식입니다.");
    if (agg === "last" || agg === "first") {
      // 주의: ORDER BY 에서 출력 별칭(obs_date)이 원본 컬럼을 가리지 않도록 src. 로 명시.
      const bucket = `date_trunc('${unit}', src.obs_date)`;
      const order = agg === "last" ? "desc" : "asc";
      return `${cte}
        select distinct on (${bucket}) ${bucket}::date as obs_date, src.obs_value as obs_value
        from src
        where src.obs_date is not null and src.obs_value is not null
        order by ${bucket}, src.obs_date ${order}`;
    }
    const bucket = `date_trunc('${unit}', obs_date)`;
    return `${cte}
      select ${bucket}::date as obs_date, ${agg}(obs_value) as obs_value
      from src
      where obs_date is not null and obs_value is not null
      group by 1
      order by 1`;
  }

  if (type === "rate") {
    const rateType = config.rateType ?? "pop";
    if (!RATE_TYPES.has(rateType)) throw new Error("지원하지 않는 증감률 유형입니다.");
    if (rateType === "yoy") {
      // 전년동기대비 (%) : 1년 전 같은 날짜와 비교
      return `${cte}
        select cur.obs_date as obs_date,
          (cur.obs_value - prev.obs_value) / nullif(prev.obs_value, 0) * 100 as obs_value
        from src cur
        join src prev on prev.obs_date = (cur.obs_date - interval '1 year')::date
        order by cur.obs_date`;
    }
    // 전기대비 (%) : 직전 관측치와 비교
    return `${cte}
      select obs_date as obs_date,
        (obs_value - lag(obs_value) over (order by obs_date))
          / nullif(lag(obs_value) over (order by obs_date), 0) * 100 as obs_value
      from src
      order by obs_date`;
  }

  if (type === "combine") {
    // 두 시리즈 연산 : A(입력) 와 B(secondMapId) 를 obs_date 가 일치하는 행만 inner join 후 연산
    const secondMapId = Number(config.secondMapId);
    if (!Number.isFinite(secondMapId) || secondMapId <= 0) {
      throw new Error("두 번째 시리즈(B)를 선택하세요.");
    }
    const op = config.op ?? "sub";
    if (!COMBINE_OPS.has(op)) throw new Error("지원하지 않는 연산입니다.");
    const shouldMultiplyBy100 = Boolean(config.divToPercent);
    const expr =
      op === "add"
        ? "a.obs_value + b.obs_value"
        : op === "mul"
          ? "a.obs_value * b.obs_value"
          : op === "div"
            ? shouldMultiplyBy100
              ? "(a.obs_value / nullif(b.obs_value, 0)) * 100"
              : "a.obs_value / nullif(b.obs_value, 0)"
            : "a.obs_value - b.obs_value"; // sub (기본)
    return `with a as (
        select obs_date, obs_value::numeric as obs_value
        from dp.viz_map_data where map_id = ${Math.trunc(sourceMapId)}
      ),
      b as (
        select obs_date, obs_value::numeric as obs_value
        from dp.viz_map_data where map_id = ${Math.trunc(secondMapId)}
      )
      select a.obs_date as obs_date, (${expr}) as obs_value
      from a
      join b on b.obs_date = a.obs_date
      order by a.obs_date`;
  }

  if (type === "movavg") {
    // 이동평균: 주기(일/월/년)와 무관하게 "관측치 N개" 단위로 평균.
    // 날짜 오름차순 정렬 후 직전 N-1개 + 현재 행으로 윈도우를 잡는다.
    // 윈도우가 다 차기 전(앞쪽 N-1개)은 결과에서 제외한다.
    // 채워넣은(fill-forward) 행(is_filled)은 제외 → 실제 관측치만으로 N개를 센다.
    const w = Math.trunc(Number(config.window));
    if (!Number.isFinite(w) || w < MOVAVG_MIN || w > MOVAVG_MAX) {
      throw new Error(`이동평균 구간은 ${MOVAVG_MIN}~${MOVAVG_MAX} 사이의 정수여야 합니다.`);
    }
    const frame = `order by obs_date rows between ${w - 1} preceding and current row`;
    // 공유 src CTE 대신 is_filled 까지 읽는 전용 CTE 사용 (SQL 가공에 노출되는 src 스키마는 유지)
    return `with src as (
        select obs_date, obs_value::numeric as obs_value,
               coalesce(is_filled, false) as is_filled
        from dp.viz_map_data where map_id = ${Math.trunc(sourceMapId)}
      )
      select obs_date, obs_value
      from (
        select obs_date,
          avg(obs_value) over (${frame}) as obs_value,
          count(*) over (${frame}) as cnt
        from src
        where obs_date is not null and obs_value is not null
          and not is_filled
      ) q
      where cnt >= ${w}
      order by obs_date`;
  }

  if (type === "interpolate") {
    // 업샘플(선형보간): 원본 두 점 사이를 직선으로 이어 target 주기 격자마다 값을 추정.
    // 원본 값은 "그 기간을 target 슬롯으로 자른 마지막 슬롯의 1일"에 앵커한다.
    //   예) 월→일: 그 달 말일 / 연→월: 12월 1일 / 연→분기: 10월 1일(Q4)
    // 격자는 첫 앵커점(기준값) 다음 슬롯부터 생성한다 → 첫 원본 기간은 기준값으로만 쓰인다.
    // (viz_map_data 저장 규칙이 모두 "슬롯의 1일"이므로 출력 날짜도 1일로 떨어진다)
    const unit = config.targetUnit ?? "day";
    if (!INTERP_UNITS.has(unit)) throw new Error("지원하지 않는 보간 주기입니다.");
    // 보간은 원본 주기(freq)를 알아야 앵커를 잡을 수 있다. 미지정이면 막는다.
    const f = (sourceFreq ?? "").trim().toUpperCase();
    const srcUnit = FREQ_UNIT[f];
    if (!srcUnit) {
      throw new Error("원본 시리즈의 주기(freq)가 지정되어 있어야 보간할 수 있습니다.");
    }
    // 업샘플만 허용: target 주기가 원본보다 더 짧아야 한다.
    if (UNIT_RANK[unit] >= UNIT_RANK[srcUnit]) {
      throw new Error("보간은 원본보다 더 짧은 주기로만 가능합니다.");
    }
    const step = UNIT_STEP[unit]; // target 격자 간격
    const srcStep = UNIT_STEP[srcUnit]; // 원본 한 기간 길이
    const mid = Math.trunc(sourceMapId);
    // 원본 기간 말일을 구한 뒤 target 슬롯의 1일로 내림 → 앵커 날짜
    const anchored =
      `date_trunc('${unit}', ` +
      `date_trunc('${srcUnit}', obs_date) + interval '${srcStep}' - interval '1 day'` +
      `)::date`;
    return `with src0 as (
        select obs_date, obs_value::numeric as obs_value
        from dp.viz_map_data where map_id = ${mid}
      ),
      src as (select ${anchored} as obs_date, obs_value from src0),
      bounds as (select min(obs_date) as lo, max(obs_date) as hi from src),
      grid as (
        select g::date as obs_date
        from generate_series(
          (select lo from bounds)::timestamp,
          (select hi from bounds)::timestamp,
          interval '${step}'
        ) as g
        where g::date > (select lo from bounds)
      )
      select grid.obs_date as obs_date,
        case
          when hi.obs_date = lo.obs_date then lo.obs_value
          else lo.obs_value + (hi.obs_value - lo.obs_value)
               * (grid.obs_date - lo.obs_date)::numeric
               / nullif((hi.obs_date - lo.obs_date)::numeric, 0)
        end as obs_value
      from grid
      cross join lateral (
        select obs_date, obs_value from src
        where src.obs_date <= grid.obs_date order by src.obs_date desc limit 1
      ) lo
      cross join lateral (
        select obs_date, obs_value from src
        where src.obs_date >= grid.obs_date order by src.obs_date asc limit 1
      ) hi
      order by grid.obs_date`;
  }

  throw new Error("지원하지 않는 가공 유형입니다.");
};

// 출력 시리즈의 freq 코드 결정
export const resolveOutputFreq = (
  type: TransformType,
  config: TransformConfig,
  sourceFreq: string | null,
  requested?: string | null,
): string => {
  if (type === "resample") return UNIT_FREQ[config.targetUnit ?? "month"];
  if (type === "interpolate") return UNIT_FREQ[config.targetUnit ?? "day"];
  const r = (requested ?? "").trim().toUpperCase();
  if (r) return r;
  const s = (sourceFreq ?? "").trim().toUpperCase();
  return s || "M";
};

// 가공 유형 한글 라벨 (목록 표시용)
export const transformTypeLabel = (type: TransformType, config: TransformConfig): string => {
  if (type === "sql") return "SQL";
  if (type === "python") return "Python";
  const unitLabel: Record<ResampleUnit, string> = {
    day: "일",
    week: "주",
    month: "월",
    quarter: "분기",
    year: "년",
  };
  if (type === "interpolate") {
    return `선형보간 · ${unitLabel[config.targetUnit ?? "day"]}`;
  }
  if (type === "movavg") {
    const w = Math.trunc(Number(config.window));
    return `이동평균 · ${Number.isFinite(w) && w > 0 ? w : "?"}구간`;
  }
  if (type === "resample") {
    const aggLabel: Record<ResampleAgg, string> = {
      avg: "평균",
      sum: "합계",
      max: "최대",
      min: "최소",
      last: "마지막날",
      first: "첫날",
    };
    return `리샘플 · ${unitLabel[config.targetUnit ?? "month"]}/${aggLabel[config.agg ?? "avg"]}`;
  }
  if (type === "combine") {
    const opLabel: Record<CombineOp, string> = {
      sub: "빼기(A−B)",
      add: "더하기(A+B)",
      mul: "곱하기(A×B)",
      div: "나누기(A÷B)",
    };
    const pct = config.op === "div" && config.divToPercent ? " · %변환(x100)" : "";
    return `연산 · ${opLabel[config.op ?? "sub"]}${pct}`;
  }
  return `증감률 · ${config.rateType === "yoy" ? "전년동기대비" : "전기대비"}`;
};

export const normalizeTransformType = (value: unknown): TransformType => {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    v === "resample" ||
    v === "rate" ||
    v === "combine" ||
    v === "interpolate" ||
    v === "movavg" ||
    v === "python"
  )
    return v;
  return "sql";
};
