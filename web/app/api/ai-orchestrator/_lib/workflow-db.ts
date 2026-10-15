import type {
  CollectionStage,
  CollectionWorkflow,
  CollectionWorkflowState,
  CollectionWorkflowStatus,
} from "./collection-workflow";

type Queryable = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rowCount?: number | null; rows: Array<Record<string, unknown>> }>;
};

const mapWorkflow = (row: Record<string, unknown>): CollectionWorkflow => ({
  workflowId: String(row.workflow_id),
  sessionId: String(row.session_id),
  userId: String(row.user_id),
  dbSettingId:
    row.db_setting_id == null ? null : Number(row.db_setting_id),
  stage: String(row.stage) as CollectionStage,
  status: String(row.status) as CollectionWorkflowStatus,
  state: (row.state as CollectionWorkflowState) ?? { version: "1.0" },
  revision: Number(row.revision),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  completedAt: row.completed_at ? String(row.completed_at) : null,
});

const RETURNING = `
  workflow_id, session_id, user_id, db_setting_id, stage, status, state,
  revision, created_at, updated_at, completed_at
`;

export const getActiveCollectionWorkflow = async (
  client: Queryable,
  sessionId: string,
  userId: string,
): Promise<CollectionWorkflow | null> => {
  const result = await client.query(
    `select ${RETURNING}
       from dp.ai_collection_workflow
      where session_id = $1::uuid
        and user_id = $2::text
        and status = 'active'
      limit 1`,
    [sessionId, userId],
  );
  return result.rows[0] ? mapWorkflow(result.rows[0]) : null;
};

export const createCollectionWorkflow = async (
  client: Queryable,
  payload: {
    workflowId: string;
    sessionId: string;
    userId: string;
    dbSettingId: number | null;
    stage?: CollectionStage;
    state: CollectionWorkflowState;
  },
): Promise<CollectionWorkflow> => {
  const result = await client.query(
    `insert into dp.ai_collection_workflow (
       workflow_id, session_id, user_id, db_setting_id, stage, state
     )
     values ($1::uuid, $2::uuid, $3::text, $4::bigint, $5::text, $6::jsonb)
     returning ${RETURNING}`,
    [
      payload.workflowId,
      payload.sessionId,
      payload.userId,
      payload.dbSettingId,
      payload.stage ?? "select_api",
      JSON.stringify(payload.state),
    ],
  );
  return mapWorkflow(result.rows[0]);
};

export const updateCollectionWorkflow = async (
  client: Queryable,
  payload: {
    workflowId: string;
    userId: string;
    expectedRevision: number;
    stage: CollectionStage;
    state: CollectionWorkflowState;
    status?: CollectionWorkflowStatus;
  },
): Promise<CollectionWorkflow | null> => {
  const status = payload.status ?? "active";
  const result = await client.query(
    `update dp.ai_collection_workflow
        set stage = $1::text,
            state = $2::jsonb,
            status = $3::text,
            revision = revision + 1,
            updated_at = now(),
            completed_at = case when $3::text = 'completed' then now() else completed_at end
      where workflow_id = $4::uuid
        and user_id = $5::text
        and revision = $6::int
      returning ${RETURNING}`,
    [
      payload.stage,
      JSON.stringify(payload.state),
      status,
      payload.workflowId,
      payload.userId,
      payload.expectedRevision,
    ],
  );
  return result.rows[0] ? mapWorkflow(result.rows[0]) : null;
};

export const getCollectionWorkflowById = async (
  client: Queryable,
  workflowId: string,
  userId: string,
): Promise<CollectionWorkflow | null> => {
  const result = await client.query(
    `select ${RETURNING}
       from dp.ai_collection_workflow
      where workflow_id = $1::uuid and user_id = $2::text
      limit 1`,
    [workflowId, userId],
  );
  return result.rows[0] ? mapWorkflow(result.rows[0]) : null;
};
