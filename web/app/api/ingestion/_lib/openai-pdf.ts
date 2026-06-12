// PDF 표 추출용 OpenAI 헬퍼.
// ai-forecast-llm/run/route.ts 의 Responses API 호출 패턴(fetchWithTimeout,
// parseJsonSafe, extractResponseOutputText)을 기능-로컬로 재사용한다.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const OPENAI_PDF_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.OPENAI_PDF_TIMEOUT_MS ?? 120000) || 120000,
);
const OPENAI_PDF_MAX_OUTPUT_TOKENS = Math.max(
  1000,
  Number(process.env.OPENAI_PDF_MAX_OUTPUT_TOKENS ?? 8000) || 8000,
);

export type ExtractedTable = {
  found: boolean;
  detectedTitle: string | null;
  unit: string | null;
  columns: string[];
  rows: Array<Array<string | number>>;
  notes: string | null;
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
};

const parseJsonSafe = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// Responses API 출력에서 텍스트만 모은다 (output_text 또는 output[].content[].text).
const extractResponseOutputText = (parsed: unknown): string => {
  if (!parsed || typeof parsed !== "object") return "";
  const record = parsed as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  const output = Array.isArray(record.output) ? record.output : [];
  const chunks: string[] = [];
  output.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const message = item as Record<string, unknown>;
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((part) => {
      if (!part || typeof part !== "object") return;
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string" && p.text.trim()) {
        chunks.push(p.text.trim());
        return;
      }
      if (typeof p.value === "string" && p.value.trim()) {
        chunks.push(p.value.trim());
      }
    });
  });
  return chunks.join("\n").trim();
};

// 코드펜스(```json ... ```)로 감싸진 경우를 벗겨낸다.
const stripCodeFence = (text: string): string => {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
};

const TABLE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "detectedTitle", "unit", "columns", "rows", "notes"],
  properties: {
    found: { type: "boolean" },
    detectedTitle: { type: ["string", "null"] },
    unit: { type: ["string", "null"] },
    columns: { type: "array", items: { type: "string" } },
    rows: {
      type: "array",
      items: { type: "array", items: { type: ["string", "number"] } },
    },
    notes: { type: ["string", "null"] },
  },
} as const;

const SYSTEM_PROMPT =
  "You extract a single table from a PDF document and return it as structured JSON. " +
  "Only return data that actually appears in the document. Never invent rows, columns, or values. " +
  "If the requested table cannot be found, set found=false and return empty columns/rows.";

const buildUserPrompt = (description: string, pageHint?: string | null) =>
  [
    "다음 PDF에서 아래 설명에 가장 잘 맞는 표 1개를 찾아 추출하세요.",
    "",
    "[표 설명]",
    description.trim(),
    pageHint && pageHint.trim() ? `\n[참고 페이지/위치]\n${pageHint.trim()}` : "",
    "",
    "규칙:",
    "- columns: 표의 헤더(열 제목)를 순서대로 넣습니다.",
    "- rows: 각 데이터 행을 columns 와 같은 순서로 넣습니다. 라벨/항목 셀은 문자열, 숫자 셀은 숫자로 (천단위 콤마 제거, 괄호 표기 음수는 음수로).",
    "- 합계/소계 행이 있으면 그대로 포함하고 notes 에 언급합니다.",
    "- detectedTitle: 문서에서 실제로 찾은 표 제목/캡션을 넣습니다.",
    "- unit: 캡션에 단위(예: 억달러, %)가 있으면 넣습니다.",
    "- 설명에 맞는 표를 찾지 못하면 found=false 로 응답합니다.",
    "JSON 으로만 답하세요.",
  ]
    .filter((line) => line !== "")
    .join("\n");

const coerceExtractedTable = (raw: unknown): ExtractedTable => {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const columns = Array.isArray(record.columns)
    ? record.columns.map((c) => (typeof c === "string" ? c : String(c ?? "")))
    : [];
  const rows = Array.isArray(record.rows)
    ? record.rows
        .filter((r): r is unknown[] => Array.isArray(r))
        .map((r) =>
          r.map((cell) =>
            typeof cell === "number" || typeof cell === "string"
              ? cell
              : cell == null
                ? ""
                : String(cell),
          ),
        )
    : [];
  return {
    found: record.found === true || (columns.length > 0 && rows.length > 0 && record.found !== false),
    detectedTitle: typeof record.detectedTitle === "string" ? record.detectedTitle : null,
    unit: typeof record.unit === "string" ? record.unit : null,
    columns,
    rows,
    notes: typeof record.notes === "string" ? record.notes : null,
  };
};

const callResponses = async (body: Record<string, unknown>) => {
  const response = await fetchWithTimeout(
    `${OPENAI_BASE_URL}/responses`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    },
    OPENAI_PDF_TIMEOUT_MS,
  );
  const rawBody = await response.text();
  const parsed = parseJsonSafe(rawBody) as
    | {
        id?: string;
        error?: { message?: string };
        output?: unknown;
        output_text?: string;
      }
    | null;
  return { response, rawBody, parsed };
};

export type ExtractTableResult = {
  table: ExtractedTable;
  responseId: string | null;
};

// 행 길이를 헤더 길이에 맞춰 정규화(부족분 빈칸, 초과분 절단).
export const toRectangular = (table: ExtractedTable): ExtractedTable => {
  const width = table.columns.length;
  const rows = table.rows.map((row) => {
    const normalized = row.slice(0, width);
    while (normalized.length < width) normalized.push("");
    return normalized;
  });
  return { ...table, rows };
};

// json_schema(strict) → 실패 시 평문 JSON 폴백으로 Responses API 를 호출하고,
// 추출 표 + 이어말하기용 responseId 를 반환한다.
const performStructuredCall = async (
  input: unknown,
  previousResponseId?: string | null,
): Promise<ExtractTableResult> => {
  const baseBody: Record<string, unknown> = {
    model: OPENAI_MODEL,
    input,
    max_output_tokens: OPENAI_PDF_MAX_OUTPUT_TOKENS,
  };
  if (previousResponseId) {
    baseBody.previous_response_id = previousResponseId;
  }

  // 1차: json_schema strict
  let attempt = await callResponses({
    ...baseBody,
    text: {
      format: {
        type: "json_schema",
        name: "table_extraction",
        strict: true,
        schema: TABLE_JSON_SCHEMA,
      },
    },
  });

  // json_schema/ input_file 미지원 등으로 실패하면 2차: 평문 JSON 지시 후 파싱
  if (!attempt.response.ok) {
    const firstError = attempt.parsed?.error?.message || attempt.rawBody;
    attempt = await callResponses(baseBody);
    if (!attempt.response.ok) {
      throw new Error(
        attempt.parsed?.error?.message ||
          firstError ||
          "OpenAI PDF 추출 호출에 실패했습니다.",
      );
    }
  }

  const text = extractResponseOutputText(attempt.parsed);
  if (!text) {
    throw new Error("OpenAI 응답에서 추출 결과 텍스트를 찾지 못했습니다.");
  }
  const json = parseJsonSafe(stripCodeFence(text));
  if (!json) {
    throw new Error("OpenAI 응답을 JSON 으로 해석하지 못했습니다.");
  }
  const responseId =
    typeof attempt.parsed?.id === "string" ? attempt.parsed.id : null;
  return { table: coerceExtractedTable(json), responseId };
};

type ExtractArgs = {
  base64: string;
  filename: string;
  description: string;
  pageHint?: string | null;
};

/**
 * PDF(base64)를 OpenAI Responses API 에 input_file 로 첨부해 표를 추출한다.
 */
export const extractTableFromPdf = async ({
  base64,
  filename,
  description,
  pageHint,
}: ExtractArgs): Promise<ExtractTableResult> => {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 설정이 필요합니다.");
  }
  if (!OPENAI_MODEL) {
    throw new Error("OPENAI_MODEL 설정이 필요합니다. (비전 지원 모델 권장: 예) gpt-4o-mini)");
  }

  const userPrompt = buildUserPrompt(description, pageHint);
  const input = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        {
          type: "input_file",
          filename,
          file_data: `data:application/pdf;base64,${base64}`,
        },
        { type: "input_text", text: userPrompt },
      ],
    },
  ];
  return performStructuredCall(input);
};

const buildRefinePrompt = (instruction: string) =>
  [
    "직전에 추출한 표를 아래 요청에 맞게 수정해서 다시 추출하세요.",
    "동일한 JSON 스키마(found, detectedTitle, unit, columns, rows, notes)를 그대로 유지합니다.",
    "문서에 실제로 있는 데이터만 사용하고 값을 임의로 만들지 마세요.",
    "",
    "[수정 요청]",
    instruction.trim(),
    "",
    "JSON 으로만 답하세요.",
  ].join("\n");

type RefineArgs = {
  previousResponseId: string;
  instruction: string;
};

/**
 * previous_response_id 로 직전 응답(업로드한 PDF 맥락 포함)을 이어받아
 * 후속 요청을 반영해 표를 다시 추출한다. PDF 를 재전송하지 않는다.
 */
export const refineTableFromPdf = async ({
  previousResponseId,
  instruction,
}: RefineArgs): Promise<ExtractTableResult> => {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 설정이 필요합니다.");
  }
  if (!OPENAI_MODEL) {
    throw new Error("OPENAI_MODEL 설정이 필요합니다.");
  }
  const input = [
    {
      role: "user",
      content: [{ type: "input_text", text: buildRefinePrompt(instruction) }],
    },
  ];
  return performStructuredCall(input, previousResponseId);
};
