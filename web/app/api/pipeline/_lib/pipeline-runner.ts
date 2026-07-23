// 파이프라인 실행: 수집 1개 적재 후, 연결된 매핑 N개를 생성 실행하고 run_log 를 남긴다.
import type { Client } from "pg";
import { canUseDb, connectWithTimeout, createPipelineClientBySettingId } from "./db";
import { executeApiGroupLoad } from "../../ingestion/load-runner";
import {
  buildMapDataForMapping,
  fetchMappings,
} from "../../visualization/_lib/mapping-query";
import {
  markMapRunLogError,
  markMapRunLogSuccess,
  startMapRunLog,
} from "../../visualization/_lib/map-run-log";
import { runTransform } from "../../data-transform/_lib/transform-runner";
import { addRunPid, beginRun, endRun, setRunProgress } from "../../_shared/cancel-registry";

const LOCK_NS = 8104;

export const pipelineCancelKey = (pipelineId: number) => `pipeline:${pipelineId}`;

type TriggerType = "manual" | "schedule";

type StepResult = {
  type: "collect" | "map" | "transform";
  refId: number | null;
  status: "success" | "error" | "skipped";
  mapLabel?: string;
  message?: string;
  affectedCount?: number;
};

export type RunPipelineResult = {
  ok: boolean;
  stepResults: StepResult[];
};

const normalizeDbSettingId = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
};

const readStoredDbSettingId = async (client: Client, pipelineId: number): Promise<number | null> => {
  try {
    const result = await client.query<{ db_setting_id: number | null }>(
      `select db_setting_id from dp.api_pipeline where pipeline_id = $1`,
      [pipelineId],
    );
    return normalizeDbSettingId(result.rows[0]?.db_setting_id);
  } catch {
    return null;
  }
};

const resolvePipelineDbSettingId = async (
  pipelineId: number,
  explicitId?: number | null,
): Promise<number | null> => {
  const normalizedExplicit = normalizeDbSettingId(explicitId);
  if (normalizedExplicit != null) return normalizedExplicit;

  const bootstrap = await createPipelineClientBySettingId(null);
  if (!bootstrap) throw new Error("DB 접속 URL 형식이 올바르지 않습니다.");
  try {
    await connectWithTimeout(bootstrap);
    return await readStoredDbSettingId(bootstrap, pipelineId);
  } finally {
    try {
      await bootstrap.end();
    } catch {
      // ignore
    }
  }
};

/**
 * 파이프라인을 실행한다. 수집(group) 적재가 성공하면 연결된 매핑들을 차례로 생성한다.
 * 수집이 실패하면 매핑은 건너뛴다. 매핑 일부 실패는 나머지 매핑 실행을 막지 않는다.
 */
export const runPipeline = async (
  pipelineId: number,
  triggerType: TriggerType,
  options?: { dbSettingId?: number | null },
): Promise<RunPipelineResult> => {
  if (!canUseDb()) throw new Error("DB 연결 설정이 없습니다. (DP_DB_* 확인)");

  const dbSettingId = await resolvePipelineDbSettingId(pipelineId, options?.dbSettingId);
  const client = await createPipelineClientBySettingId(dbSettingId);
  if (!client) throw new Error("DB 접속 URL 형식이 올바르지 않습니다.");

  const startedMs = Date.now();
  const stepResults: StepResult[] = [];
  const cancelKey = pipelineCancelKey(pipelineId);
  let locked = false;
  let runLogId: number | null = null;

  const cancelHandle = beginRun(cancelKey);

  try {
    await connectWithTimeout(client);
    const lockRes = await client.query<{ locked: boolean }>(
      `select pg_try_advisory_lock($1, $2) as locked`,
      [LOCK_NS, pipelineId],
    );
    locked = Boolean(lockRes.rows[0]?.locked);
    if (!locked) throw new Error("이미 실행 중인 파이프라인입니다.");

    // 러너 커넥션의 DB 백엔드 PID 등록 (취소 시 pg_cancel_backend 대상)
    try {
      const pidRes = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      addRunPid(cancelKey, pidRes.rows[0]?.pid);
    } catch {
      // ignore
    }

    const pipelineRes = await client.query<{ name: string; group_id: number | null }>(
      `select name, group_id from dp.api_pipeline where pipeline_id = $1`,
      [pipelineId],
    );
    const pipeline = pipelineRes.rows[0];
    if (!pipeline) throw new Error("파이프라인을 찾을 수 없습니다.");

    const mapRes = await client.query<{ map_id: number }>(
      `select map_id from dp.api_pipeline_map where pipeline_id = $1 order by sort_order, id`,
      [pipelineId],
    );
    const mapIds = mapRes.rows.map((r) => Number(r.map_id));

    const logRes = await client.query<{ run_log_id: number }>(
      `insert into dp.api_pipeline_run_log (pipeline_id, trigger_type, status)
       values ($1, $2, 'running') returning run_log_id`,
      [pipelineId, triggerType],
    );
    runLogId = logRes.rows[0]?.run_log_id ?? null;

    // 1) 수집(적재)
    let collectOk = false;
    if (!pipeline.group_id) {
      stepResults.push({ type: "collect", refId: null, status: "error", message: "수집이 지정되지 않았습니다." });
    } else {
      try {
        const groupRes = await client.query<{ source_id: number }>(
          `select source_id from dp.api_param_group where id = $1`,
          [pipeline.group_id],
        );
        const sourceId = groupRes.rows[0]?.source_id;
        if (!sourceId) throw new Error("수집 그룹을 찾을 수 없습니다.");
        setRunProgress(cancelKey, { phase: "collect", label: "수집(적재)" });
        await executeApiGroupLoad(
          {
            sourceId,
            groupId: pipeline.group_id,
            triggerType,
            dbSettingId: dbSettingId ?? undefined,
          },
          {
            abortSignal: cancelHandle.abort.signal,
            onDbBackendPid: (pid) => addRunPid(cancelKey, pid),
          },
        );
        stepResults.push({ type: "collect", refId: pipeline.group_id, status: "success" });
        collectOk = true;
      } catch (collectError) {
        const message = collectError instanceof Error ? collectError.message : String(collectError);
        stepResults.push({ type: "collect", refId: pipeline.group_id, status: "error", message });
      }
    }

    // 2) 매핑들 (수집 성공 시에만)
    for (const [mapIndex, mapId] of mapIds.entries()) {
      let mapLabel = `MAP:${mapId}`;
      if (!collectOk || cancelHandle.abort.signal.aborted) {
        stepResults.push({ type: "map", refId: mapId, status: "skipped", mapLabel });
        continue;
      }
      let mapRunLogId: number | null = null;
      try {
        const mappings = await fetchMappings(client, [mapId], false);
        const mapping = mappings[0];
        if (!mapping) throw new Error("매핑을 찾을 수 없습니다.");
        mapLabel = mapping.seriesName?.trim() || mapLabel;
        setRunProgress(cancelKey, {
          phase: "map",
          label: mapLabel,
          index: mapIndex + 1,
          total: mapIds.length,
        });
        mapRunLogId = await startMapRunLog(client, {
          mapId,
          seriesName: mapping.seriesName,
          triggerType,
          runMode: "generate",
        });
        const result = await buildMapDataForMapping(client, mapping, { replaceExisting: false });
        await markMapRunLogSuccess(client, mapRunLogId, {
          affectedCount: result.affectedCount,
          startDate: result.startDate,
          endDate: result.endDate,
        });
        stepResults.push({
          type: "map",
          refId: mapId,
          status: "success",
          mapLabel,
          affectedCount: result.affectedCount,
        });
      } catch (mapError) {
        const message = mapError instanceof Error ? mapError.message : String(mapError);
        if (!mapRunLogId) {
          mapRunLogId = await startMapRunLog(client, {
            mapId,
            seriesName: null,
            triggerType,
            runMode: "generate",
          });
        }
        await markMapRunLogError(client, mapRunLogId, message);
        stepResults.push({ type: "map", refId: mapId, status: "error", mapLabel, message });
      }
    }

    // 3) 데이터 가공들 (선택) — 매핑 이후, 수집 성공 시에만
    const transformRes = await client.query<{ transform_id: number; name: string }>(
      `select pt.transform_id, t.name
       from dp.api_pipeline_transform pt
       join dp.api_transform t on t.transform_id = pt.transform_id
       where pt.pipeline_id = $1
       order by pt.sort_order, pt.id`,
      [pipelineId],
    );
    const transforms = transformRes.rows;
    for (const [txIndex, tx] of transforms.entries()) {
      const txLabel = tx.name?.trim() || `TRANSFORM:${tx.transform_id}`;
      if (!collectOk || cancelHandle.abort.signal.aborted) {
        stepResults.push({ type: "transform", refId: tx.transform_id, status: "skipped", mapLabel: txLabel });
        continue;
      }
      try {
        setRunProgress(cancelKey, {
          phase: "transform",
          label: txLabel,
          index: txIndex + 1,
          total: transforms.length,
        });
        const result = await runTransform(client, tx.transform_id, triggerType);
        stepResults.push({
          type: "transform",
          refId: tx.transform_id,
          status: "success",
          mapLabel: txLabel,
          affectedCount: result.affectedCount,
        });
      } catch (txError) {
        const message = txError instanceof Error ? txError.message : String(txError);
        stepResults.push({ type: "transform", refId: tx.transform_id, status: "error", mapLabel: txLabel, message });
      }
    }

    const hasError = stepResults.some((s) => s.status === "error");
    if (runLogId != null) {
      await client.query(
        `update dp.api_pipeline_run_log
         set status = $2, step_results = $3::jsonb, finished_at = now(), elapsed_ms = $4, error_message = $5
         where run_log_id = $1`,
        [
          runLogId,
          hasError ? "error" : "success",
          JSON.stringify(stepResults),
          Date.now() - startedMs,
          hasError ? "일부 단계가 실패했습니다." : null,
        ],
      );
    }
    return { ok: !hasError, stepResults };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runLogId != null) {
      try {
        await client.query(
          `update dp.api_pipeline_run_log
           set status = 'error', step_results = $2::jsonb, finished_at = now(), elapsed_ms = $3, error_message = $4
           where run_log_id = $1`,
          [runLogId, JSON.stringify(stepResults), Date.now() - startedMs, message],
        );
      } catch {
        // ignore
      }
    }
    throw error;
  } finally {
    endRun(cancelKey);
    try {
      if (locked) {
        await client.query(`select pg_advisory_unlock($1, $2)`, [LOCK_NS, pipelineId]);
      }
    } catch {
      // ignore
    }
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
};
