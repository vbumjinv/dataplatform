import { NextResponse } from "next/server";
import { Client } from "pg";
import {
  initializeIngestionScheduler,
  refreshIngestionSchedule,
  removeIngestionSchedule,
} from "../scheduler";

export const runtime = "nodejs";

type Payload = {
  source?: {
    name?: string;
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    enabled?: boolean;
    apiKeyParamKey?: string;
    apiKeyLocation?: string;
    apiKeyOrder?: number;
    apiKeyEncodeMode?: string;
    isTemplate?: boolean;
  };
  groupName?: string;
  params?: Array<{
    key: string;
    value: string;
    location: "path" | "query";
    order: number;
    encodeMode?: string;
    role?: string;
  }>;
  schedule?: {
    enabled?: boolean;
    type?: "interval" | "cron";
    intervalMinutes?: number;
    cronExpr?: string;
  };
  target?: {
    schema?: string;
    table?: string;
    truncate?: boolean;
    mergeSql?: string;
  };
};
type UpdatePayload = Payload & {
  sourceId?: number;
  groupId?: number | null;
  updateTarget?:
    | "source"
    | "group"
    | "refreshPeriods"
    | "groupSchedule"
    | "groupTargetTable";
};

const CONNECT_TIMEOUT_MS = 5000;
const DB_CONFIG = {
  url: process.env.DP_DB_URL,
  database: process.env.DP_DB_NAME,
  user: process.env.DP_DB_USER,
  password: process.env.DP_DB_PASSWORD,
};

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isValidId = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const toValidId = (value: unknown) => {
  if (typeof value === "string") {
    const parsed = Number(value);
    return isValidId(parsed) ? parsed : null;
  }
  return isValidId(value) ? value : null;
};
const normalizeProvider = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
const resolveSourceApiKeyMeta = async (
  client: Client,
  source: Payload["source"],
) => {
  const provider = source?.provider?.trim() || "custom";
  const sourceParamKey = source?.apiKeyParamKey?.trim() || null;
  const sourceLocation = source?.apiKeyLocation?.trim() || null;
  const sourceEncodeMode = source?.apiKeyEncodeMode?.trim() || null;
  const sourceOrder = Number.isFinite(source?.apiKeyOrder)
    ? Number(source?.apiKeyOrder)
    : null;
  const shouldApplyTemplateDefaults = !isNonEmpty(sourceParamKey);

  let templateParamKey: string | null = null;
  let templateLocation: string | null = null;
  let templateOrder: number | null = null;
  let templateEncodeMode: string | null = null;

  if (
    shouldApplyTemplateDefaults &&
    normalizeProvider(provider) !== "custom" &&
    normalizeProvider(provider).length > 0
  ) {
    const templateRow = await client.query(
      `
        select
          api_key_param_key,
          api_key_location,
          api_key_order,
          api_key_encode_mode
        from dp.api_source
        where is_template = true
          and lower(provider) = lower($1)
        order by id asc
        limit 1
      `,
      [provider],
    );
    const row = templateRow.rows[0] as
      | {
          api_key_param_key?: string | null;
          api_key_location?: string | null;
          api_key_order?: number | null;
          api_key_encode_mode?: string | null;
        }
      | undefined;
    templateParamKey = row?.api_key_param_key?.trim() || null;
    templateLocation = row?.api_key_location?.trim() || null;
    templateOrder = Number.isFinite(row?.api_key_order)
      ? Number(row?.api_key_order)
      : null;
    templateEncodeMode = row?.api_key_encode_mode?.trim() || null;
  }

  return {
    provider,
    apiKeyParamKey: shouldApplyTemplateDefaults
      ? templateParamKey ?? null
      : sourceParamKey,
    apiKeyLocation: shouldApplyTemplateDefaults
      ? templateLocation ?? sourceLocation ?? "query"
      : sourceLocation ?? "query",
    apiKeyOrder: shouldApplyTemplateDefaults
      ? templateOrder ?? sourceOrder ?? 0
      : sourceOrder ?? 0,
    apiKeyEncodeMode: shouldApplyTemplateDefaults
      ? templateEncodeMode ?? sourceEncodeMode ?? "encode"
      : sourceEncodeMode ?? "encode",
  };
};
const padNumber = (value: number, length = 2) =>
  String(value).padStart(length, "0");
const toPeriodValue = (date: Date, period: string) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (period === "D") {
    return `${year}${padNumber(month)}${padNumber(date.getDate())}`;
  }
  if (period === "M") {
    return `${year}${padNumber(month)}`;
  }
  if (period === "Q") {
    const quarter = Math.floor((month - 1) / 3) + 1;
    return `${year}Q${quarter}`;
  }
  if (period === "A" || period === "Y") {
    return `${year}`;
  }
  return null;
};

const normalizeJdbcUrl = (raw: string) => {
  if (raw.startsWith("jdbc:")) {
    return raw.replace(/^jdbc:/, "");
  }
  return raw;
};

const buildConnectionString = (payload: {
  url?: string;
  database?: string;
  user?: string;
  password?: string;
}) => {
  if (!payload.url) return null;
  const normalized = normalizeJdbcUrl(payload.url);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    return null;
  }
  if (payload.user) parsed.username = payload.user;
  if (payload.password) parsed.password = payload.password;
  if (payload.database) parsed.pathname = `/${payload.database}`;
  return parsed.toString();
};

export async function POST(request: Request) {
  let payload: Payload | null = null;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  if (
    !payload.source ||
    !isNonEmpty(payload.source.name) ||
    !isNonEmpty(payload.source.baseUrl) ||
    !isNonEmpty(payload.source.apiKey)
  ) {
    return NextResponse.json(
      { ok: false, error: "API 소스 정보를 모두 입력하세요." },
      { status: 400 },
    );
  }

  if (
    !isNonEmpty(DB_CONFIG.url) ||
    !isNonEmpty(DB_CONFIG.database) ||
    !isNonEmpty(DB_CONFIG.user) ||
    !isNonEmpty(DB_CONFIG.password)
  ) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }

  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);

    await client.query("begin");
    const resolvedSourceMeta = await resolveSourceApiKeyMeta(
      client,
      payload.source,
    );
    const sourceName = payload.source.name.trim();
    const sourceLookup = await client.query(
      `select id from dp.api_source where name = $1 limit 1`,
      [sourceName],
    );
    let sourceId: number;
    if (sourceLookup.rowCount && sourceLookup.rows[0]) {
      sourceId = sourceLookup.rows[0].id as number;
    } else {
      const sourceResult = await client.query(
        `
          insert into dp.api_source (
            name,
            provider,
            base_url,
            api_key,
            enabled,
            api_key_param_key,
            api_key_location,
            api_key_order,
            api_key_encode_mode,
            is_template
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          returning id
        `,
        [
          sourceName,
          resolvedSourceMeta.provider,
          payload.source.baseUrl.trim(),
          payload.source.apiKey?.trim() || null,
          payload.source.enabled ?? true,
          resolvedSourceMeta.apiKeyParamKey,
          resolvedSourceMeta.apiKeyLocation,
          resolvedSourceMeta.apiKeyOrder,
          resolvedSourceMeta.apiKeyEncodeMode,
          payload.source.isTemplate ?? false,
        ],
      );
      sourceId = sourceResult.rows[0]?.id as number;
    }

    if (
      !isNonEmpty(payload.groupName ?? "") &&
      (!payload.params || payload.params.length === 0)
    ) {
      await client.query("commit");
      return NextResponse.json({ ok: true, sourceId });
    }

    const inputParams = (payload.params ?? [])
      .filter((item) => isNonEmpty(item.key) && isNonEmpty(item.value))
      .map((item) => ({
        key: item.key.trim(),
        value: item.value.trim(),
        location: item.location,
        order: Number.isFinite(item.order) ? item.order : 0,
        encodeMode: item.encodeMode?.trim() || "encode",
        role: item.role?.trim() || null,
      }));

    const paramsByKey = new Map<
      string,
      {
        key: string;
        value: string;
        location: "path" | "query";
        order: number;
        encodeMode: string;
        role: string | null;
      }
    >();
    const provider = resolvedSourceMeta.provider.trim().toLowerCase();
    if (provider && provider !== "custom") {
      const templateSourceResult = await client.query(
        `
          select id
          from dp.api_source
          where is_template = true
            and lower(provider) = lower($1)
          order by id asc
          limit 1
        `,
        [resolvedSourceMeta.provider],
      );
      const templateSourceId = templateSourceResult.rows[0]?.id as number | undefined;
      if (templateSourceId) {
        const templateGroupResult = await client.query(
          `
            select id
            from dp.api_param_group
            where source_id = $1
              and is_template = true
            order by id asc
            limit 1
          `,
          [templateSourceId],
        );
        const templateGroupId = templateGroupResult.rows[0]?.id as
          | number
          | undefined;
        if (templateGroupId) {
          const templateParamResult = await client.query(
            `
              select
                param_key,
                param_value,
                param_location,
                param_order,
                encode_mode,
                param_role
              from dp.api_param
              where group_id = $1
              order by param_order asc, id asc
            `,
            [templateGroupId],
          );
          templateParamResult.rows.forEach((row) => {
            const key = String(row.param_key ?? "").trim();
            if (!key) return;
            paramsByKey.set(key, {
              key,
              value: String(row.param_value ?? "").trim(),
              location: ((row.param_location as "path" | "query") ?? "query"),
              order: Number.isFinite(row.param_order) ? Number(row.param_order) : 0,
              encodeMode: String(row.encode_mode ?? "encode").trim() || "encode",
              role: isNonEmpty(row.param_role) ? row.param_role.trim() : null,
            });
          });
        }
      }
    }
    inputParams.forEach((item) => {
      paramsByKey.set(item.key, item);
    });
    const params = Array.from(paramsByKey.values()).filter(
      (item) => item.key.length > 0 && item.value.length > 0,
    );

    const valueByKey = new Map(params.map((item) => [item.key, item.value]));
    const hasParamValue = (key: string) => {
      const value = valueByKey.get(key);
      return typeof value === "string" && value.length > 0;
    };
    if (params.length === 0) {
      await client.query("rollback");
      return NextResponse.json(
        { ok: false, error: "파라미터를 입력하세요." },
        { status: 400 },
      );
    }

    if (params.length > 0) {
      const statCodeParam = params.find((item) => item.key === "statCode");
      const groupName =
        payload.groupName?.trim() ||
        statCodeParam?.value ||
        `${sourceName}-${new Date().toISOString()}`;
      const groupResult = await client.query(
        `
          insert into dp.api_param_group (source_id, name)
          values ($1, $2)
          returning id
        `,
        [sourceId, groupName],
      );
      const groupId = groupResult.rows[0]?.id as number;

      const values: Array<string | number | null> = [];
      const rows = params
        .map((item, index) => {
          const base = index * 7;
          values.push(
            groupId,
            item.key,
            item.value,
            item.location,
            item.order,
            item.encodeMode ?? "encode",
            item.role ?? null,
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${
            base + 5
          }, $${base + 6}, $${base + 7})`;
        })
        .join(", ");

      await client.query(
        `
          insert into dp.api_param (
            group_id,
            param_key,
            param_value,
            param_location,
            param_order,
            encode_mode,
            param_role
          )
          values ${rows}
        `,
        values,
      );
    }

    await client.query("commit");
    return NextResponse.json({ ok: true, sourceId });
  } catch (error) {
    await client.query("rollback");
    const message =
      error instanceof Error ? error.message : "저장에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function PATCH(request: Request) {
  await initializeIngestionScheduler();
  let payload: UpdatePayload | null = null;
  try {
    payload = (await request.json()) as UpdatePayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  const updateTarget = payload.updateTarget ?? "group";
  const sourceId = toValidId(payload.sourceId);
  const groupId = toValidId(payload.groupId);
  if (updateTarget !== "refreshPeriods") {
    if (!sourceId) {
      return NextResponse.json(
        { ok: false, error: "수정 대상이 올바르지 않습니다." },
        { status: 400 },
      );
    }
    if (
      (updateTarget === "group" ||
        updateTarget === "groupSchedule" ||
        updateTarget === "groupTargetTable") &&
      !groupId
    ) {
      return NextResponse.json(
        { ok: false, error: "그룹 정보가 올바르지 않습니다." },
        { status: 400 },
      );
    }
  }

  if (
    !isNonEmpty(DB_CONFIG.url) ||
    !isNonEmpty(DB_CONFIG.database) ||
    !isNonEmpty(DB_CONFIG.user) ||
    !isNonEmpty(DB_CONFIG.password)
  ) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }

  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);

    await client.query("begin");
    if (updateTarget === "refreshPeriods") {
      const rows = await client.query(
        `
          select
            s.id as source_id,
            s.provider as provider,
            g.id as group_id,
            p.param_key as param_key,
            p.param_value as param_value,
            p.param_role as param_role
          from dp.api_param p
          join dp.api_param_group g on p.group_id = g.id
          join dp.api_source s on g.source_id = s.id
          where g.is_template = false
          order by s.id, g.id, p.param_order asc
        `,
      );
      const groups = new Map<
        number,
        {
          sourceId: number;
          provider: string;
          params: Map<string, string>;
          roles: Map<string, string>;
        }
      >();
      rows.rows.forEach((row) => {
        const groupId = row.group_id as number;
        if (!groups.has(groupId)) {
          groups.set(groupId, {
            sourceId: row.source_id as number,
            provider: row.provider as string,
            params: new Map(),
            roles: new Map(),
          });
        }
        groups
          .get(groupId)
          ?.params.set(row.param_key as string, row.param_value as string);
        if (row.param_role) {
          groups
            .get(groupId)
            ?.roles.set(row.param_role as string, row.param_key as string);
        }
      });

      const today = new Date();
      const buildStartDate = (period: string) => {
        const base = new Date(today);
        if (period === "D") {
          base.setDate(base.getDate() - 3);
          return base;
        }
        if (period === "M") {
          base.setMonth(base.getMonth() - 3);
          return base;
        }
        if (period === "Q") {
          base.setMonth(base.getMonth() - 9);
          return base;
        }
        if (period === "A" || period === "Y") {
          base.setFullYear(base.getFullYear() - 3);
          return base;
        }
        return null;
      };
      let updatedCount = 0;

      for (const [groupId, groupData] of groups.entries()) {
        const { params, roles } = groupData;
        const periodKey = roles.get("period_type") ?? null;
        const startKey = roles.get("start") ?? null;
        const endKey = roles.get("end") ?? null;
        const periodType = periodKey ? params.get(periodKey) ?? undefined : undefined;

        if (!periodType || !startKey || !endKey) {
          continue;
        }
        const startDate = buildStartDate(periodType);
        if (!startDate) continue;
        const startValue = toPeriodValue(startDate, periodType);
        const endValue = toPeriodValue(today, periodType);
        if (!startValue || !endValue) continue;
        if (params.has(startKey)) {
          await client.query(
            `update dp.api_param set param_value = $1 where group_id = $2 and param_key = $3`,
            [startValue, groupId, startKey],
          );
          updatedCount += 1;
        }
        if (params.has(endKey)) {
          await client.query(
            `update dp.api_param set param_value = $1 where group_id = $2 and param_key = $3`,
            [endValue, groupId, endKey],
          );
          updatedCount += 1;
        }
      }

      await client.query("commit");
      return NextResponse.json({ ok: true, updatedCount });
    }
    const sourceLookup = await client.query(
      `select id, provider from dp.api_source where id = $1 limit 1`,
      [sourceId],
    );
    if (!sourceLookup.rowCount) {
      await client.query("rollback");
      return NextResponse.json(
        { ok: false, error: "수정 대상이 존재하지 않습니다." },
        { status: 404 },
      );
    }

    if (updateTarget === "source") {
      if (
        !payload.source ||
        !isNonEmpty(payload.source.name) ||
        !isNonEmpty(payload.source.baseUrl) ||
        !isNonEmpty(payload.source.apiKey)
      ) {
        await client.query("rollback");
        return NextResponse.json(
          { ok: false, error: "API 소스 정보를 모두 입력하세요." },
          { status: 400 },
        );
      }
      const resolvedSourceMeta = await resolveSourceApiKeyMeta(
        client,
        payload.source,
      );
      await client.query(
        `
          update dp.api_source
          set name = $1,
              provider = $2,
              base_url = $3,
              api_key = $4,
              enabled = $5,
              api_key_param_key = $6,
              api_key_location = $7,
              api_key_order = $8,
              api_key_encode_mode = $9,
              is_template = $10
          where id = $11
        `,
        [
          payload.source.name.trim(),
          resolvedSourceMeta.provider,
          payload.source.baseUrl.trim(),
          payload.source.apiKey?.trim() || null,
          payload.source.enabled ?? true,
          resolvedSourceMeta.apiKeyParamKey,
          resolvedSourceMeta.apiKeyLocation,
          resolvedSourceMeta.apiKeyOrder,
          resolvedSourceMeta.apiKeyEncodeMode,
          payload.source.isTemplate ?? false,
          sourceId,
        ],
      );
      await client.query("commit");
      return NextResponse.json({ ok: true, sourceId });
    }

    if (updateTarget === "groupSchedule") {
      const scheduleType =
        payload.schedule?.type === "cron" ? "cron" : "interval";
      const enabled = payload.schedule?.enabled ?? false;
      const intervalMinutes = Number.isFinite(payload.schedule?.intervalMinutes)
        ? Math.max(1, Number(payload.schedule?.intervalMinutes))
        : null;
      const cronExpr = isNonEmpty(payload.schedule?.cronExpr)
        ? payload.schedule?.cronExpr.trim()
        : null;
      if (enabled && scheduleType === "interval" && !intervalMinutes) {
        await client.query("rollback");
        return NextResponse.json(
          { ok: false, error: "실행 주기(분)를 입력하세요." },
          { status: 400 },
        );
      }
      if (enabled && scheduleType === "cron" && !cronExpr) {
        await client.query("rollback");
        return NextResponse.json(
          { ok: false, error: "CRON 표현식을 입력하세요." },
          { status: 400 },
        );
      }
      const result = await client.query(
        `
          update dp.api_param_group
          set schedule_enabled = $1,
              schedule_type = $2,
              schedule_interval_minutes = $3,
              schedule_cron_expr = $4
          where id = $5
            and source_id = $6
        `,
        [enabled, scheduleType, intervalMinutes, cronExpr, groupId, sourceId],
      );
      if (!result.rowCount) {
        await client.query("rollback");
        return NextResponse.json(
          { ok: false, error: "스케줄 수정 대상이 존재하지 않습니다." },
          { status: 404 },
        );
      }
      await client.query("commit");
      if (groupId) {
        await refreshIngestionSchedule(groupId);
      }
      return NextResponse.json({ ok: true, sourceId, groupId });
    }
    if (updateTarget === "groupTargetTable") {
      const schema = payload.target?.schema?.trim() || "public";
      const table = payload.target?.table?.trim() || "";
      if (!table) {
        await client.query("rollback");
        return NextResponse.json(
          { ok: false, error: "임시 적재(_LRD) 테이블을 선택하세요." },
          { status: 400 },
        );
      }
      if (!table.toLowerCase().endsWith("_lrd")) {
        await client.query("rollback");
        return NextResponse.json(
          { ok: false, error: "임시 적재 테이블명은 _LRD 로 끝나야 합니다." },
          { status: 400 },
        );
      }
      const result = await client.query(
        `
          update dp.api_param_group
          set target_schema = $1,
              target_table = $2,
              target_truncate = $3,
              target_merge_sql = $4
          where id = $5
            and source_id = $6
        `,
        [
          schema,
          table,
          payload.target?.truncate ?? false,
          payload.target?.mergeSql?.trim() || null,
          groupId,
          sourceId,
        ],
      );
      if (!result.rowCount) {
        await client.query("rollback");
        return NextResponse.json(
          { ok: false, error: "매핑 대상이 존재하지 않습니다." },
          { status: 404 },
        );
      }
      await client.query("commit");
      if (groupId) {
        await refreshIngestionSchedule(groupId);
      }
      return NextResponse.json({ ok: true, sourceId, groupId });
    }

    const params = (payload.params ?? [])
      .filter((item) => isNonEmpty(item.key) && isNonEmpty(item.value))
      .map((item) => ({
        key: item.key.trim(),
        value: item.value.trim(),
        location: item.location,
        order: Number.isFinite(item.order) ? item.order : 0,
        encodeMode: item.encodeMode?.trim() || "encode",
        role: item.role?.trim() || null,
      }));

    if (params.length === 0) {
      await client.query("rollback");
      return NextResponse.json(
        { ok: false, error: "파라미터를 입력하세요." },
        { status: 400 },
      );
    }

    if (groupId) {
      const groupCheck = await client.query(
        `select id from dp.api_param_group where id = $1 and source_id = $2 limit 1`,
        [groupId, sourceId],
      );
      if (!groupCheck.rowCount) {
        await client.query("rollback");
        return NextResponse.json(
          { ok: false, error: "그룹 정보가 존재하지 않습니다." },
          { status: 404 },
        );
      }

      await client.query(`update dp.api_param_group set name = $1 where id = $2`, [
        payload.groupName?.trim() || null,
        groupId,
      ]);
      await client.query(`delete from dp.api_param where group_id = $1`, [
        groupId,
      ]);

      if (params.length > 0) {
        const values: Array<string | number | null> = [];
        const rows = params
          .map((item, index) => {
            const base = index * 7;
            values.push(
              groupId,
              item.key,
              item.value,
              item.location,
              item.order,
              item.encodeMode ?? "encode",
              item.role ?? null,
            );
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${
              base + 5
            }, $${base + 6}, $${base + 7})`;
          })
          .join(", ");
        await client.query(
          `
            insert into dp.api_param (
              group_id,
              param_key,
              param_value,
              param_location,
              param_order,
              encode_mode,
              param_role
            )
            values ${rows}
          `,
          values,
        );
      }
    } else if (params.length > 0) {
      const groupName =
        payload.groupName?.trim() ||
        statCodeParam?.value ||
        `${(payload.source?.name ?? "group").trim()}-${new Date().toISOString()}`;
      const groupResult = await client.query(
        `
          insert into dp.api_param_group (source_id, name)
          values ($1, $2)
          returning id
        `,
        [sourceId, groupName],
      );
      const groupId = groupResult.rows[0]?.id as number;
      const values: Array<string | number | null> = [];
      const rows = params
        .map((item, index) => {
          const base = index * 7;
          values.push(
            groupId,
            item.key,
            item.value,
            item.location,
            item.order,
            item.encodeMode ?? "encode",
            item.role ?? null,
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${
            base + 5
          }, $${base + 6}, $${base + 7})`;
        })
        .join(", ");
      await client.query(
        `
          insert into dp.api_param (
            group_id,
            param_key,
            param_value,
            param_location,
            param_order,
            encode_mode,
            param_role
          )
          values ${rows}
        `,
        values,
      );
    }

    await client.query("commit");
    return NextResponse.json({ ok: true, sourceId });
  } catch (error) {
    await client.query("rollback");
    const message =
      error instanceof Error ? error.message : "수정에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function DELETE(request: Request) {
  await initializeIngestionScheduler();
  let payload: UpdatePayload | null = null;
  try {
    payload = (await request.json()) as UpdatePayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문이 비어있습니다." },
      { status: 400 },
    );
  }

  const sourceId = toValidId(payload.sourceId);
  const groupId = toValidId(payload.groupId);
  if (!sourceId) {
    return NextResponse.json(
      { ok: false, error: "삭제 대상이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  if (
    !isNonEmpty(DB_CONFIG.url) ||
    !isNonEmpty(DB_CONFIG.database) ||
    !isNonEmpty(DB_CONFIG.user) ||
    !isNonEmpty(DB_CONFIG.password)
  ) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);

    await client.query("begin");
    if (groupId) {
      await client.query(`delete from dp.api_param where group_id = $1`, [
        groupId,
      ]);
      const result = await client.query(
        `delete from dp.api_param_group where id = $1 and source_id = $2`,
        [groupId, sourceId],
      );
      if (!result.rowCount) {
        await client.query("rollback");
        return NextResponse.json(
          { ok: false, error: "삭제 대상이 존재하지 않습니다." },
          { status: 404 },
        );
      }
      await client.query("commit");
      removeIngestionSchedule(groupId);
      return NextResponse.json({ ok: true });
    }
    const groupsToRemove = await client.query(
      `select id from dp.api_param_group where source_id = $1`,
      [sourceId],
    );
    await client.query(`delete from dp.api_param_group where source_id = $1`, [
      sourceId,
    ]);
    const result = await client.query(
      `delete from dp.api_source where id = $1`,
      [sourceId],
    );
    if (!result.rowCount) {
      await client.query("rollback");
      return NextResponse.json(
        { ok: false, error: "삭제 대상이 존재하지 않습니다." },
        { status: 404 },
      );
    }
    await client.query("commit");
    groupsToRemove.rows.forEach((row) => {
      const id = Number(row.id);
      if (Number.isFinite(id) && id > 0) {
        removeIngestionSchedule(id);
      }
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    const message =
      error instanceof Error ? error.message : "삭제에 실패했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function GET(request: Request) {
  await initializeIngestionScheduler();
  if (
    !isNonEmpty(DB_CONFIG.url) ||
    !isNonEmpty(DB_CONFIG.database) ||
    !isNonEmpty(DB_CONFIG.user) ||
    !isNonEmpty(DB_CONFIG.password)
  ) {
    return NextResponse.json(
      { ok: false, error: "DB 환경변수 설정이 필요합니다." },
      { status: 400 },
    );
  }
  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);

    const url = new URL(request.url);
    const isTemplate = url.searchParams.get("template") === "true";
    const sourceRows = await client.query(
      `
        select
          id,
          name,
          provider,
          base_url,
          api_key,
          enabled,
          created_at,
          api_key_param_key,
          api_key_location,
          api_key_order,
          api_key_encode_mode,
          is_template
        from dp.api_source
        where is_template = $1
        order by id desc
      `,
      [isTemplate],
    );
    const groupRows = await client.query(
      `
        select
          id,
          source_id,
          name,
          created_at,
          is_template,
          schedule_enabled,
          schedule_type,
          schedule_interval_minutes,
          schedule_cron_expr,
          target_schema,
          target_table,
          target_truncate,
          target_merge_sql
        from dp.api_param_group
        where is_template = $1
        order by id desc
      `,
      [isTemplate],
    );
    const paramRows = await client.query(
      `
        select
          p.id,
          p.group_id,
          p.param_key,
          p.param_value,
          p.param_location,
          p.param_order,
          p.encode_mode,
          p.param_role
        from dp.api_param p
        join dp.api_param_group g on g.id = p.group_id
        where g.is_template = $1
        order by p.param_order asc, p.id asc
      `,
      [isTemplate],
    );

    const paramsByGroup = new Map<number, Array<Record<string, unknown>>>();
    paramRows.rows.forEach((row) => {
      const groupId = row.group_id as number;
      if (!paramsByGroup.has(groupId)) {
        paramsByGroup.set(groupId, []);
      }
      paramsByGroup.get(groupId)?.push(row);
    });

    const groupsBySource = new Map<number, Array<Record<string, unknown>>>();
    groupRows.rows.forEach((row) => {
      const sourceId = row.source_id as number;
      if (!groupsBySource.has(sourceId)) {
        groupsBySource.set(sourceId, []);
      }
      groupsBySource
        .get(sourceId)
        ?.push({ ...row, params: paramsByGroup.get(row.id as number) ?? [] });
    });

    const sources = sourceRows.rows.map((row) => ({
      ...row,
      groups: groupsBySource.get(row.id as number) ?? [],
    }));

    return NextResponse.json({ ok: true, sources });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "목록을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}
