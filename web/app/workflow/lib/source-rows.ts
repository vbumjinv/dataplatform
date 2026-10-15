import type { DataCollectorNode } from "../types";

export type SourceRows = {
  columns: string[];
  rows: Record<string, string>[];
};

const emptyRows = (): SourceRows => ({ columns: [], rows: [] });

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const textRows = (columns: string[], rows: Array<Record<string, unknown>>): SourceRows => ({
  columns,
  rows: rows.map((row) =>
    Object.fromEntries(columns.map((column) => [column, row[column] == null ? "" : String(row[column])])),
  ),
});

const rowsFromArray = (value: unknown[]): SourceRows => {
  const records = value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
  if (records.length === 0) return emptyRows();
  const columns = Array.from(new Set(records.flatMap((row) => Object.keys(row))));
  return textRows(columns, records);
};

export const rowsFromPayload = (payload: unknown): SourceRows => {
  if (Array.isArray(payload)) return rowsFromArray(payload);
  const record = asRecord(payload);
  if (!record) return emptyRows();
  for (const key of ["rows", "row", "data", "items", "list"]) {
    if (Array.isArray(record[key])) return rowsFromArray(record[key] as unknown[]);
  }
  return rowsFromArray([record]);
};

export const rowsFromTabular = (header: string[], dataRows: unknown[][]): SourceRows => {
  if (header.length === 0) return emptyRows();
  return {
    columns: header,
    rows: dataRows.map((row) =>
      Object.fromEntries(header.map((column, index) => [column, row[index] == null ? "" : String(row[index])])),
    ),
  };
};

const readExcelRows = (node: DataCollectorNode): SourceRows => {
  const options = {
    startRow: 1,
    startCol: 1,
    hasHeader: true,
    ...node.data.excelOptions,
  };
  const sheetName = options.sheetName || node.data.excelSheets?.[0];
  const sheetRows = sheetName ? node.data.excelRowsBySheet?.[sheetName] : undefined;
  if (!sheetRows?.length) return emptyRows();
  const startRow = Math.max(1, options.startRow || 1);
  const startCol = Math.max(1, options.startCol || 1);
  const sliced = sheetRows
    .slice(startRow - 1)
    .map((row) => row.slice(startCol - 1));
  if (!sliced.length) return emptyRows();
  if (options.hasHeader) {
    const [header, ...body] = sliced;
    const columns = header.map((cell, index) => String(cell ?? `Column ${index + 1}`));
    return {
      columns,
      rows: body.map((row) =>
        Object.fromEntries(columns.map((column, index) => [column, row[index] == null ? "" : String(row[index])])),
      ),
    };
  }
  const width = sliced[0]?.length ?? 0;
  const columns = Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  return {
    columns,
    rows: sliced.map((row) =>
      Object.fromEntries(columns.map((column, index) => [column, row[index] == null ? "" : String(row[index])])),
    ),
  };
};

export const readNodeRows = (node: DataCollectorNode): SourceRows => {
  if (node.data.kind === "excel") return readExcelRows(node);
  if (node.data.kind === "db") {
    const stored = node.data.dbQueryRows ?? [];
    const columns = node.data.dbQueryColumns?.length
      ? node.data.dbQueryColumns.map((column) => column.name)
      : stored[0]
        ? Object.keys(stored[0])
        : [];
    return textRows(columns, stored);
  }
  if (node.data.kind === "api" || node.data.kind === "bok" || node.data.kind === "filter") {
    return rowsFromPayload(node.data.apiResult);
  }
  return emptyRows();
};
