import { Client } from "pg";

const CONNECT_TIMEOUT_MS = 5000;
const MAX_BIND_PARAMS_PER_QUERY = 30000;
const API_FETCH_TIMEOUT_MS = 15000;
const API_FETCH_MAX_ATTEMPTS = 3;
const END_LATEST_TOKEN = "__TODAY__";
const DB_CONFIG = {
  url: process.env.DP_DB_URL,
  database: process.env.DP_DB_NAME,
  user: process.env.DP_DB_USER,
  password: process.env.DP_DB_PASSWORD,
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const formatErrorWithCause = (error: unknown) => {
  if (!(error instanceof Error)) return String(error ?? "unknown");
  const cause = error.cause as { code?: string; errno?: string; syscall?: string } | undefined;
  const parts = [`${error.name}: ${error.message}`];
  if (cause?.code) parts.push(`cause.code=${cause.code}`);
  if (cause?.errno) parts.push(`cause.errno=${cause.errno}`);
  if (cause?.syscall) parts.push(`cause.syscall=${cause.syscall}`);
  return parts.join(" | ");
};

const isRetryableStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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
const escapeIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

const castForColumn = (dataType: string, colRef: string): string => {
  const t = dataType?.toLowerCase() ?? "text";
  if (
    t === "numeric" ||
    t === "decimal" ||
    t === "real" ||
    t === "double precision"
  ) {
    return `${colRef}::numeric`;
  }
  if (
    t === "smallint" ||
    t === "integer" ||
    t === "bigint" ||
    t === "serial" ||
    t === "bigserial"
  ) {
    return `${colRef}::bigint`;
  }
  return colRef;
};
const decodeSafe = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const normalizeValue = (value: string, mode?: string) => {
  const normalized = mode === "decode" ? decodeSafe(value) : value;
  if (mode === "none") return normalized;
  return encodeURIComponent(normalized);
};
const parseXmlRows = (value: string): Array<Record<string, string>> | null => {
  const xmlCandidate = value.includes("&lt;")
    ? value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
    : value;
  const xmlStart = xmlCandidate.indexOf("<");
  if (xmlStart < 0) return null;
  const trimmed = xmlCandidate.slice(xmlStart).trim();
  if (!trimmed.startsWith("<")) return null;
  const rowMatches = Array.from(
    trimmed.matchAll(/<(?:[\w-]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?row>/gi),
  );
  const itemMatches = Array.from(
    trimmed.matchAll(/<(?:[\w-]+:)?item\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?item>/gi),
  );
  const targets = rowMatches.length > 0 ? rowMatches : itemMatches;
  if (!targets.length) return null;

  const rows: Array<Record<string, string>> = [];
  for (const match of targets) {
    const block = match[1] ?? "";
    const record: Record<string, string> = {};
    const fieldMatches = Array.from(
      block.matchAll(
        /<((?:[\w-]+:)?[a-zA-Z0-9_:-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g,
      ),
    );
    for (const field of fieldMatches) {
      const rawKey = field[1]?.trim();
      const key = rawKey ? rawKey.split(":").pop()?.trim() ?? rawKey : "";
      if (!key) continue;
      const rawValue = (field[2] ?? "").trim();
      record[key] = decodeSafe(rawValue);
    }
    if (Object.keys(record).length > 0) {
      rows.push(record);
    }
  }
  return rows.length ? rows : null;
};
const toPeriodValue = (date: Date, period: string) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  if (period === "D") return `${year}${pad(month)}${pad(day)}`;
  if (period === "M") return `${year}${pad(month)}`;
  if (period === "Q") return `${year}Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === "A" || period === "Y") return `${year}`;
  return "";
};
const buildUrlFromSourceParams = (
  sourceItem: {
    baseUrl: string;
    apiKey?: string | null;
    apiKeyParamKey?: string | null;
    apiKeyLocation?: string | null;
    apiKeyOrder?: number | null;
    apiKeyEncodeMode?: string | null;
  },
  rawParams: Array<{
    key: string;
    value: string;
    location: "path" | "query";
    order: number;
    encodeMode?: string | null;
  }>,
) => {
  const url = new URL(sourceItem.baseUrl);
  const base = `${url.origin}${url.pathname}`.replace(/\/$/, "");
  const apiKeyKey = sourceItem.apiKeyParamKey?.trim() || "";
  const apiKeyLocation = sourceItem.apiKeyLocation || "query";
  const apiKeyOrder = Number.isFinite(sourceItem.apiKeyOrder)
    ? Number(sourceItem.apiKeyOrder)
    : 0;
  const apiKeyValue = sourceItem.apiKey ?? "";

  const pathParams = rawParams
    .filter((item) => item.location === "path" && item.value.trim())
    .map((item) => ({ ...item, encodeMode: item.encodeMode ?? "encode" }));
  const queryParams = rawParams
    .filter(
      (item) =>
        item.location === "query" &&
        item.key.trim() &&
        item.value.trim() &&
        (!apiKeyKey || item.key !== apiKeyKey),
    )
    .map((item) => ({ ...item, encodeMode: item.encodeMode ?? "encode" }));

  if (apiKeyValue && apiKeyKey) {
    if (apiKeyLocation === "path") {
      pathParams.push({
        key: apiKeyKey,
        value: apiKeyValue,
        location: "path",
        order: apiKeyOrder,
        encodeMode: sourceItem.apiKeyEncodeMode ?? "encode",
      });
    } else {
      queryParams.push({
        key: apiKeyKey,
        value: apiKeyValue,
        location: "query",
        order: apiKeyOrder,
        encodeMode: sourceItem.apiKeyEncodeMode ?? "encode",
      });
    }
  }

  const pathSegment = pathParams
    .sort((a, b) => a.order - b.order)
    .map((item) => normalizeValue(item.value, item.encodeMode))
    .join("/");
  const queryPairs = queryParams
    .sort((a, b) => a.order - b.order)
    .map(
      (item) =>
        `${encodeURIComponent(item.key)}=${normalizeValue(
          item.value,
          item.encodeMode,
        )}`,
    )
    .join("&");
  const existingQuery = url.search.replace(/^\?/, "");
  const mergedQuery = [existingQuery, queryPairs].filter(Boolean).join("&");
  const fullPath = pathSegment ? `${base}/${pathSegment}` : base;
  return mergedQuery ? `${fullPath}?${mergedQuery}` : fullPath;
};
const normalizeApiPayload = (payload: unknown): unknown => {
  if (payload == null) return null;
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    const xmlRows = parseXmlRows(trimmed);
    if (xmlRows) return xmlRows;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return parsed;
      } catch {
        return payload;
      }
    }
    return payload;
  }
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.rows)) return record.rows;
    if (Array.isArray(record.row)) return record.row;
    if (Array.isArray(record.items)) return record.items;
    if (record.data && typeof record.data === "object") {
      const nested = record.data as Record<string, unknown>;
      if (Array.isArray(nested.list)) return nested.list;
      if (Array.isArray(nested.rows)) return nested.rows;
      if (Array.isArray(nested.row)) return nested.row;
      if (Array.isArray(nested.items)) return nested.items;
    }
    const statisticSearch = record.StatisticSearch;
    if (statisticSearch && typeof statisticSearch === "object") {
      const nested = statisticSearch as Record<string, unknown>;
      if (Array.isArray(nested.row)) return nested.row;
      if (Array.isArray(nested.rows)) return nested.rows;
      if (Array.isArray(nested.items)) return nested.items;
      if (Array.isArray(nested.list)) return nested.list;
    }
    const kosisResult = record.result ?? record.Result;
    if (kosisResult && typeof kosisResult === "object") {
      const nested = kosisResult as Record<string, unknown>;
      if (Array.isArray(nested.list)) return nested.list;
      if (Array.isArray(nested.data)) return nested.data;
      if (Array.isArray(nested.rows)) return nested.rows;
      if (Array.isArray(nested.row)) return nested.row;
      if (Array.isArray(nested.items)) return nested.items;
    }
    const response = record.response;
    if (response && typeof response === "object") {
      const responseRecord = response as Record<string, unknown>;
      const body = responseRecord.body;
      if (body && typeof body === "object") {
        const bodyRecord = body as Record<string, unknown>;
        const items = bodyRecord.items;
        if (items && typeof items === "object") {
          const itemsRecord = items as Record<string, unknown>;
          if (Array.isArray(itemsRecord.item)) return itemsRecord.item;
          if (Array.isArray(itemsRecord.items)) return itemsRecord.items;
        }
      }
    }
    return record;
  }
  return payload;
};
const buildTabularFromApi = (payload: unknown) => {
  const normalized = normalizeApiPayload(payload);
  if (normalized == null) return { header: [] as string[], dataRows: [] as unknown[][] };
  const rows = Array.isArray(normalized) ? normalized : [normalized];
  if (rows.length === 0) return { header: [] as string[], dataRows: [] as unknown[][] };
  const first = rows[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const header = Object.keys(first as Record<string, unknown>);
    const dataRows = rows.map((row) =>
      header.map((key) => (row as Record<string, unknown>)[key] ?? null),
    );
    return { header, dataRows };
  }
  return {
    header: ["value"],
    dataRows: rows.map((row) => [row]),
  };
};

export const executeApiGroupLoad = async (payload: {
  sourceId: number;
  groupId: number;
  truncate?: boolean;
  triggerType?: "manual" | "schedule";
}) => {
  if (
    !isNonEmpty(DB_CONFIG.url) ||
    !isNonEmpty(DB_CONFIG.database) ||
    !isNonEmpty(DB_CONFIG.user) ||
    !isNonEmpty(DB_CONFIG.password)
  ) {
    throw new Error("DB 환경변수 설정이 필요합니다.");
  }
  const connectionString = buildConnectionString(DB_CONFIG);
  if (!connectionString) {
    throw new Error("DB 접속 URL 형식이 올바르지 않습니다.");
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  let timeoutId: NodeJS.Timeout | null = null;
  let inTransaction = false;
  let loadLogId: number | null = null;
  const startedAtMs = Date.now();
  const triggerType = payload.triggerType === "schedule" ? "schedule" : "manual";
  let errorStage: "setup" | "api_fetch" | "table_load" | "merge_sql" | "unknown" = "setup";
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("DB 연결 시간이 초과되었습니다."));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);

    const rows = await client.query(
      `
        select
          s.base_url,
          s.api_key,
          s.api_key_param_key,
          s.api_key_location,
          s.api_key_order,
          s.api_key_encode_mode,
          g.target_schema,
          g.target_table,
          g.target_truncate,
          g.target_merge_sql,
          p.param_key,
          p.param_value,
          p.param_location,
          p.param_order,
          p.encode_mode,
          p.param_role
        from dp.api_param_group g
        join dp.api_source s on s.id = g.source_id
        join dp.api_param p on p.group_id = g.id
        where g.id = $1
          and g.source_id = $2
          and g.is_template = false
        order by p.param_order asc, p.id asc
      `,
      [payload.groupId, payload.sourceId],
    );
    if (!rows.rowCount) {
      throw new Error("API 파라미터가 존재하지 않습니다.");
    }
    const first = rows.rows[0];
    const targetSchema = (first.target_schema as string | null) ?? "public";
    const targetTable = (first.target_table as string | null) ?? "";
    const targetMergeSql = ((first.target_merge_sql as string | null) ?? "").trim();
    if (!targetTable.trim()) {
      throw new Error("적재 테이블 매핑이 필요합니다.");
    }
    const resolvedParamRows = rows.rows.map((row) => ({
      key: String(row.param_key ?? ""),
      value: String(row.param_value ?? ""),
      location: ((row.param_location as "path" | "query") ?? "query"),
      order: Number.isFinite(row.param_order) ? Number(row.param_order) : 0,
      encodeMode: (row.encode_mode as string | null) ?? "encode",
      role: (row.param_role as string | null) ?? null,
    }));
    const roleKeyMap = new Map<string, string>();
    resolvedParamRows.forEach((param) => {
      if (!param.role || roleKeyMap.has(param.role)) return;
      roleKeyMap.set(param.role, param.key);
    });
    const paramValueByKey = new Map<string, string>(
      resolvedParamRows.map((param) => [param.key, param.value]),
    );
    const periodTypeKey =
      roleKeyMap.get("period_type") ??
      (["period", "prdSe", "periodType"].find((key) => paramValueByKey.has(key)) ?? null);
    const endKey =
      roleKeyMap.get("end") ??
      (["apiEnd", "endPrdDe", "endYymm"].find((key) => paramValueByKey.has(key)) ?? null);
    const periodTypeValue = periodTypeKey ? paramValueByKey.get(periodTypeKey) ?? "M" : "M";
    const effectivePeriod =
      periodTypeValue && ["D", "M", "Q", "A", "Y"].includes(periodTypeValue)
        ? periodTypeValue
        : "M";
    const todayEndValue = toPeriodValue(new Date(), effectivePeriod);
    const requestParams = resolvedParamRows.map((param) => {
      const isEndParamByKey = ["apiEnd", "endPrdDe", "endYymm"].includes(param.key);
      const shouldResolveLatest =
        param.value === END_LATEST_TOKEN &&
        ((endKey && param.key === endKey) || (!endKey && isEndParamByKey));
      if (shouldResolveLatest) {
        return { ...param, value: todayEndValue };
      }
      return param;
    });
    const url = buildUrlFromSourceParams(
      {
        baseUrl: String(first.base_url ?? ""),
        apiKey: (first.api_key as string | null) ?? "",
        apiKeyParamKey: (first.api_key_param_key as string | null) ?? "",
        apiKeyLocation: (first.api_key_location as string | null) ?? "query",
        apiKeyOrder: Number.isFinite(first.api_key_order)
          ? Number(first.api_key_order)
          : 0,
        apiKeyEncodeMode: (first.api_key_encode_mode as string | null) ?? "encode",
      },
      requestParams,
    );
    try {
      const logInsert = await client.query<{ load_log_id: number }>(
        `
          insert into dp.api_load_log (
            source_id,
            group_id,
            trigger_type,
            status,
            started_at,
            request_url,
            target_table,
            merge_configured
          )
          values ($1, $2, $3, 'running', now(), $4, $5, $6)
          returning load_log_id
        `,
        [
          payload.sourceId,
          payload.groupId,
          triggerType,
          url,
          `${targetSchema}.${targetTable}`,
          Boolean(targetMergeSql),
        ],
      );
      loadLogId = Number(logInsert.rows[0]?.load_log_id ?? 0) || null;
    } catch {
      // ignore log insert errors to not block ingestion
    }

    errorStage = "api_fetch";
    let body: unknown = null;
    let response: Response | null = null;
    let lastFetchError: unknown = null;
    for (let attempt = 1; attempt <= API_FETCH_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => {
        controller.abort();
      }, API_FETCH_TIMEOUT_MS);
      try {
        response = await fetch(url, { signal: controller.signal });
        const contentType = response.headers.get("content-type") ?? "";
        body = contentType.includes("application/json")
          ? await response.json()
          : await response.text();
        if (response.ok) {
          lastFetchError = null;
          break;
        }
        const message =
          typeof body === "string"
            ? body
            : ((body as { error?: string }).error ?? `API 응답 오류(${response.status})`);
        if (isRetryableStatus(response.status) && attempt < API_FETCH_MAX_ATTEMPTS) {
          lastFetchError = new Error(
            `API 응답 재시도(${attempt}/${API_FETCH_MAX_ATTEMPTS}): ${message}`,
          );
          await sleep(400 * attempt);
          continue;
        }
        throw new Error(message);
      } catch (error) {
        const isAbortError =
          error instanceof Error &&
          (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
        const isNetworkFetchError =
          error instanceof Error &&
          (error.name === "TypeError" ||
            error.message.toLowerCase().includes("fetch failed") ||
            error.message.toLowerCase().includes("network"));
        if (isAbortError) {
          lastFetchError = new Error(
            `API 호출 시간 초과(${API_FETCH_TIMEOUT_MS}ms) 시도 ${attempt}/${API_FETCH_MAX_ATTEMPTS}`,
          );
        } else {
          lastFetchError = error;
        }
        if (!(isAbortError || isNetworkFetchError)) {
          throw error;
        }
        if (attempt < API_FETCH_MAX_ATTEMPTS) {
          await sleep(400 * attempt);
          continue;
        }
      } finally {
        clearTimeout(abortTimer);
      }
    }
    if (!response || lastFetchError) {
      throw new Error(`API 호출 실패: ${formatErrorWithCause(lastFetchError)}`);
    }

    let { header, dataRows } = buildTabularFromApi(body);
    if (
      typeof body === "string" &&
      header.length === 1 &&
      header[0] === "value"
    ) {
      const reparsedXmlRows = parseXmlRows(body);
      if (reparsedXmlRows?.length) {
        header = Object.keys(reparsedXmlRows[0] ?? {});
        dataRows = reparsedXmlRows.map((row) =>
          header.map((key) => row[key] ?? null),
        );
      }
    }
    if (!header.length || !dataRows.length) {
      throw new Error("적재할 데이터가 없습니다.");
    }

    const columnRows = await client.query(
      `
        select column_name, data_type
        from information_schema.columns
        where table_schema = $1
          and table_name = $2
        order by ordinal_position
      `,
      [targetSchema, targetTable],
    );
    const tableColumns = columnRows.rows.map((row) => row.column_name as string);
    const columnTypes = new Map(
      columnRows.rows.map((row) => [
        (row.column_name as string).toLowerCase(),
        (row.data_type as string) || "text",
      ]),
    );
    if (!tableColumns.length) {
      throw new Error("테이블 컬럼을 찾을 수 없습니다.");
    }

    const normalizeColumnKey = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const headerIndex = new Map<string, number>();
    header.forEach((name, index) => {
      const key = normalizeColumnKey(String(name));
      if (!key || headerIndex.has(key)) return;
      headerIndex.set(key, index);
    });
    const columnsToInsert = tableColumns.filter((column) =>
      headerIndex.has(normalizeColumnKey(column)),
    );
    if (!columnsToInsert.length) {
      throw new Error(
        `API 컬럼과 테이블 컬럼이 맞지 않습니다. API 헤더=[${header.join(
          ", ",
        )}] / 테이블 컬럼=[${tableColumns.join(", ")}]`,
      );
    }

    const insertRows = dataRows
      .map((row) =>
        columnsToInsert.map((column) => {
          const index = headerIndex.get(normalizeColumnKey(column));
          return index == null ? null : (row[index] ?? null);
        }),
      )
      .filter((row) => row.some((value) => value !== null && value !== ""));
    if (!insertRows.length) {
      throw new Error("적재할 데이터가 없습니다.");
    }

    const escapedTable = `${escapeIdentifier(targetSchema)}.${escapeIdentifier(
      targetTable,
    )}`;
    const shouldTruncate =
      payload.truncate ?? Boolean(first.target_truncate);
    errorStage = "table_load";
    await client.query("begin");
    inTransaction = true;
    if (shouldTruncate) {
      await client.query(`truncate table ${escapedTable}`);
    }
    const escapedColumns = columnsToInsert.map(escapeIdentifier).join(", ");
    const aliasColumns = columnsToInsert.map(escapeIdentifier).join(", ");
    const selectExpressions = columnsToInsert
      .map((col) => {
        const escaped = escapeIdentifier(col);
        const dt = columnTypes.get(col.toLowerCase()) ?? "text";
        return castForColumn(dt, `v.${escaped}`);
      })
      .join(", ");
    const placeholderCasts = columnsToInsert.map((col) => {
      const dt = columnTypes.get(col.toLowerCase()) ?? "text";
      if (
        dt === "numeric" ||
        dt === "decimal" ||
        dt === "real" ||
        dt === "double precision"
      )
        return "::numeric";
      if (
        dt === "smallint" ||
        dt === "integer" ||
        dt === "bigint" ||
        dt === "serial" ||
        dt === "bigserial"
      )
        return "::bigint";
      return "";
    });
    let insertedCount = 0;
    const maxRowsPerBatch = Math.max(
      1,
      Math.floor(MAX_BIND_PARAMS_PER_QUERY / Math.max(columnsToInsert.length, 1)),
    );
    const dedupeCondition = columnsToInsert
      .map((column) => {
        const escaped = escapeIdentifier(column);
        return `(t.${escaped})::text is not distinct from (v.${escaped})::text`;
      })
      .join(" and ");

    for (let start = 0; start < insertRows.length; start += maxRowsPerBatch) {
      const batchRows = insertRows.slice(start, start + maxRowsPerBatch);
      const values: unknown[] = [];
      const placeholders = batchRows
        .map((row, rowIndex) => {
          const base = rowIndex * columnsToInsert.length;
          const rowPlaceholders = columnsToInsert.map((_, colIndex) => {
            values.push(row[colIndex] ?? null);
            const cast = placeholderCasts[colIndex] ?? "";
            return `$${base + colIndex + 1}${cast}`;
          });
          return `(${rowPlaceholders.join(", ")})`;
        })
        .join(", ");

      if (shouldTruncate) {
        const insertResult = await client.query(
          `insert into ${escapedTable} (${escapedColumns}) values ${placeholders}`,
          values,
        );
        insertedCount += insertResult.rowCount ?? 0;
      } else {
        const insertResult = await client.query(
          `
            insert into ${escapedTable} (${escapedColumns})
            select ${selectExpressions}
            from (values ${placeholders}) as v (${aliasColumns})
            where not exists (
              select 1
              from ${escapedTable} t
              where ${dedupeCondition}
            )
          `,
          values,
        );
        insertedCount += insertResult.rowCount ?? 0;
      }
    }
    if (targetMergeSql) {
      errorStage = "merge_sql";
      await client.query(targetMergeSql);
    }
    await client.query("commit");
    inTransaction = false;
    if (loadLogId) {
      try {
        await client.query(
          `
            update dp.api_load_log
            set
              status = 'success',
              finished_at = now(),
              elapsed_ms = $2,
              inserted_count = $3,
              error_message = null,
              error_stage = null
            where load_log_id = $1
          `,
          [loadLogId, Math.max(0, Date.now() - startedAtMs), insertedCount],
        );
      } catch {
        // ignore log update errors to not block ingestion
      }
    }

    return {
      loadLogId,
      inserted: insertedCount,
      url,
      table: `${targetSchema}.${targetTable}`,
      columns: columnsToInsert,
      mergeConfigured: Boolean(targetMergeSql),
    };
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("rollback");
      } catch {
        // ignore rollback errors
      }
    }
    if (loadLogId) {
      const message = formatErrorWithCause(error);
      const stage =
        errorStage === "setup" ||
        errorStage === "api_fetch" ||
        errorStage === "table_load" ||
        errorStage === "merge_sql"
          ? errorStage
          : "unknown";
      try {
        await client.query(
          `
            update dp.api_load_log
            set
              status = 'error',
              finished_at = now(),
              elapsed_ms = $2,
              error_message = $3,
              error_stage = $4
            where load_log_id = $1
          `,
          [loadLogId, Math.max(0, Date.now() - startedAtMs), message, stage],
        );
      } catch {
        // ignore log update errors to not block ingestion
      }
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
};
