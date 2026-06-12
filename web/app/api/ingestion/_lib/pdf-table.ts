// AI 없이 PDF 의 【20대 주요 수출 품목 규모 및 증감률】 표를 직접 파싱한다.
// 핵심 규칙: 각 데이터 행은 "순번 품목 [금액 (증감률)]×여러월".
//  - 금액 = 괄호 없는 숫자, 증감률 = 괄호 표기.
//  - 최신월(보고월) 금액 = 행에서 "마지막 비괄호 숫자".
//  - '전체/합계' 행은 표의 끝 표시 → 제외하고 중단.
// 품목 수는 PDF 마다 다를 수 있으므로 순번 행을 동적으로 모두 수집한다.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type ItemTradeRow = { item: string; obsValue: number };
export type ItemTradeParseResult = { items: ItemTradeRow[]; note: string | null };

// 표 캡션 "N대 주요 수출 품목 규모 및 증감률" 을 공백 제거 후 부분일치로 찾는다.
// (본문 산문의 "주요 수출 품목이 …" 오매칭을 피하기 위해 캡션 고유어구 사용)
const HEADING_KEYWORD = "수출품목규모";
const ROW_Y_TOLERANCE = 3;
const TOTAL_LABELS = ["전체", "합계", "총계"];

type TextCell = { x: number; y: number; str: string };

const loadCells = async (buffer: Buffer): Promise<TextCell[][]> => {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;
  const pages: TextCell[][] = [];
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      for (const item of content.items) {
        const anyItem = item as { str?: string; transform?: number[] };
        if (typeof anyItem.str !== "string") continue;
        const str = anyItem.str.trim();
        if (!str) continue;
        const transform = anyItem.transform ?? [];
        if (!pages[pageNo - 1]) pages[pageNo - 1] = [];
        pages[pageNo - 1].push({ x: transform[4] ?? 0, y: transform[5] ?? 0, str });
      }
      if (!pages[pageNo - 1]) pages[pageNo - 1] = [];
    }
  } finally {
    try {
      await loadingTask.destroy();
    } catch {
      // ignore
    }
  }
  return pages;
};

// 같은 y(±tolerance) 끼리 한 행으로 묶고 x 오름차순 정렬.
const clusterRows = (cells: TextCell[]): TextCell[][] => {
  const sorted = [...cells].sort((a, b) => b.y - a.y);
  const rows: TextCell[][] = [];
  let current: TextCell[] = [];
  let anchorY: number | null = null;
  for (const cell of sorted) {
    if (anchorY === null || Math.abs(cell.y - anchorY) <= ROW_Y_TOLERANCE) {
      current.push(cell);
      if (anchorY === null) anchorY = cell.y;
    } else {
      rows.push(current);
      current = [cell];
      anchorY = cell.y;
    }
  }
  if (current.length) rows.push(current);
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
};

const isTotalRow = (text: string) =>
  TOTAL_LABELS.some((label) => text.replace(/\s+/g, "").startsWith(label));

// 행 텍스트에서 품목명과 "마지막 비괄호 숫자"(최신월 금액)를 뽑는다.
const parseDataRow = (rowText: string): ItemTradeRow | null => {
  const text = rowText.replace(/\s+/g, " ").trim();
  // 순번(정수) + 나머지
  const m = text.match(/^(\d{1,3})\s+(.+)$/);
  if (!m) return null;
  const rest = m[2];

  // 품목명 = 첫 숫자/괄호 전까지의 텍스트
  const itemMatch = rest.match(/^([^\d(]+)/);
  const item = itemMatch ? itemMatch[1].replace(/\s+/g, "").trim() : "";
  if (!item) return null;

  // 괄호(증감률) 제거 후 남는 평문 숫자들 중 마지막 = 최신월 금액
  const withoutParens = rest.replace(/\([^)]*\)/g, " ");
  const numbers = withoutParens.match(/-?\d[\d,]*(?:\.\d+)?/g);
  if (!numbers || numbers.length < 2) return null; // 여러 월의 금액이 있어야 표 행
  const last = numbers[numbers.length - 1];
  const value = Number(last.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return { item, obsValue: value };
};

export const extractItemTradeTable = async (
  buffer: Buffer,
): Promise<ItemTradeParseResult> => {
  const pages = await loadCells(buffer);

  // 표 캡션이 있는 페이지를 찾는다(공백 제거 후 부분일치).
  const targetPage = pages.find((cells) =>
    cells
      .map((c) => c.str)
      .join("")
      .replace(/\s+/g, "")
      .includes(HEADING_KEYWORD),
  );
  if (!targetPage) {
    return {
      items: [],
      note: "'주요 수출 품목 규모 및 증감률' 표를 PDF 에서 찾지 못했습니다.",
    };
  }

  const rows = clusterRows(targetPage);
  const items: ItemTradeRow[] = [];
  let started = false;
  for (const row of rows) {
    const rowText = row.map((c) => c.str).join(" ");
    const normalized = rowText.replace(/\s+/g, " ").trim();
    if (isTotalRow(normalized)) {
      if (started) break; // 전체/합계 = 표의 끝
      continue;
    }
    const parsed = parseDataRow(normalized);
    if (parsed) {
      // 순번이 있는 본 품목 행만 수집. 순번 없는 보조행(전기차/OLED 등)이나
      // 각주(*) 행은 건너뛴다(중단하지 않음). 표 끝은 '전체' 행으로만 판단.
      items.push(parsed);
      started = true;
    }
  }

  if (items.length === 0) {
    return { items: [], note: "표는 찾았으나 데이터 행을 추출하지 못했습니다." };
  }
  return { items, note: null };
};
