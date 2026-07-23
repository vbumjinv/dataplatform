import type { Client } from "pg";
import {
  buildTransformSelect,
  isPythonTransform,
  normalizeTransformType,
  resolveOutputFreq,
  validateUserPython,
  type TransformConfig,
} from "./sql-builder";

export type TransformInput = {
  name?: string;
  transformType?: string;
  sourceMapId?: number | null;
  config?: TransformConfig;
  outputName?: string;
  outputUnit?: string | null;
  outputFreq?: string | null;
  dbSettingId?: number | null;
  isActive?: boolean;
};

const fetchSourceFreq = async (client: Client, sourceMapId: number): Promise<string | null> => {
  const res = await client.query<{ freq: string | null }>(
    `select freq from dp.viz_map_mst where map_id = $1`,
    [sourceMapId],
  );
  if (res.rows.length === 0) throw new Error("입력 시리즈를 찾을 수 없습니다.");
  return res.rows[0]?.freq ?? null;
};

// 입력 검증 + config 정규화 (변환 SELECT 생성으로 안전성까지 확인)
const normalizeInput = async (client: Client, input: TransformInput) => {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("이름을 입력하세요.");
  const sourceMapId = Number(input.sourceMapId);
  if (!Number.isFinite(sourceMapId) || sourceMapId <= 0) {
    throw new Error("입력 시리즈를 선택하세요.");
  }
  const transformType = normalizeTransformType(input.transformType);
  const config = input.config ?? {};
  // 원본 주기는 검증(보간 앵커)에도 필요하므로 SELECT 생성 전에 먼저 읽는다.
  const sourceFreq = await fetchSourceFreq(client, sourceMapId);
  // config 유효성 검증: python 은 코드 검증, 그 외는 변환 SELECT 생성으로 안전성까지 확인
  if (isPythonTransform(transformType)) {
    validateUserPython(config.code);
  } else {
    buildTransformSelect(transformType, config, sourceMapId, sourceFreq);
  }

  const outputFreq = resolveOutputFreq(transformType, config, sourceFreq, input.outputFreq);
  const outputName = (input.outputName ?? "").trim() || name;
  const outputUnit = (input.outputUnit ?? "")?.toString().trim() || null;

  return { name, sourceMapId, transformType, config, outputFreq, outputName, outputUnit };
};

export const createTransform = async (
  client: Client,
  input: TransformInput,
): Promise<number> => {
  const n = await normalizeInput(client, input);
  await client.query("begin");
  try {
    const insertRes = await client.query<{ transform_id: number }>(
      `insert into dp.api_transform (
         name, transform_type, source_map_id, config,
         output_name, output_unit, output_freq, db_setting_id, is_active
       )
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
       returning transform_id`,
      [
        n.name,
        n.transformType,
        n.sourceMapId,
        JSON.stringify(n.config),
        n.outputName,
        n.outputUnit,
        n.outputFreq,
        input.dbSettingId ?? null,
        input.isActive ?? true,
      ],
    );
    const transformId = Number(insertRes.rows[0]?.transform_id);

    // 출력 파생 시리즈 (viz_map_mst 행) 생성 → 차트에서 map:<id> 로 사용
    const mapRes = await client.query<{ map_id: number }>(
      `insert into dp.viz_map_mst (
         source_org, api_name, source_table, series_name, series_key,
         date_column, date_format, value_column, where_clause,
         unit_name, freq, duplicate_date_policy, is_active
       )
       values ('derived', $1, $2, $3, null,
         'obs_date', null, 'obs_value', null,
         $4, $5, 'none', true)
       returning map_id`,
      [n.outputName, `transform:${transformId}`, n.outputName, n.outputUnit, n.outputFreq],
    );
    const outputMapId = Number(mapRes.rows[0]?.map_id);

    await client.query(
      `update dp.api_transform set output_map_id = $2, updated_at = now() where transform_id = $1`,
      [transformId, outputMapId],
    );
    await client.query("commit");
    return transformId;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
};

export const updateTransform = async (
  client: Client,
  transformId: number,
  input: TransformInput,
): Promise<void> => {
  const n = await normalizeInput(client, input);
  await client.query("begin");
  try {
    const cur = await client.query<{ output_map_id: number | null }>(
      `select output_map_id from dp.api_transform where transform_id = $1`,
      [transformId],
    );
    if (cur.rows.length === 0) throw new Error("가공 정의를 찾을 수 없습니다.");

    await client.query(
      `update dp.api_transform
       set name = $2, transform_type = $3, source_map_id = $4, config = $5::jsonb,
           output_name = $6, output_unit = $7, output_freq = $8,
           db_setting_id = $9, is_active = $10, updated_at = now()
       where transform_id = $1`,
      [
        transformId,
        n.name,
        n.transformType,
        n.sourceMapId,
        JSON.stringify(n.config),
        n.outputName,
        n.outputUnit,
        n.outputFreq,
        input.dbSettingId ?? null,
        input.isActive ?? true,
      ],
    );

    const outputMapId = cur.rows[0]?.output_map_id;
    if (outputMapId) {
      // 출력 파생 시리즈 메타 동기화
      await client.query(
        `update dp.viz_map_mst
         set api_name = $2, series_name = $2, source_table = $3,
             unit_name = $4, freq = $5, updated_at = now()
         where map_id = $1`,
        [Number(outputMapId), n.outputName, `transform:${transformId}`, n.outputUnit, n.outputFreq],
      );
    }
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
};
