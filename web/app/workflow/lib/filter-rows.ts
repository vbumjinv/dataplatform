export const FILTER_OPERATORS = [
  { id: "eq", label: "같음" },
  { id: "neq", label: "다름" },
  { id: "contains", label: "포함" },
  { id: "starts", label: "시작" },
  { id: "gt", label: "보다 큼" },
  { id: "gte", label: "이상" },
  { id: "lt", label: "보다 작음" },
  { id: "lte", label: "이하" },
  { id: "empty", label: "비어 있음" },
  { id: "notEmpty", label: "비어 있지 않음" },
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number]["id"];

export type FilterCondition = {
  id: string;
  column: string;
  operator: FilterOperator;
  value: string;
};

export type FilterNodeOptions = {
  columnsChosen: boolean;
  selectedColumns: string[];
  conditions: FilterCondition[];
};

export const emptyFilterOptions = (): FilterNodeOptions => ({
  columnsChosen: false,
  selectedColumns: [],
  conditions: [],
});

export const valueNeeded = (operator: FilterOperator) =>
  operator !== "empty" && operator !== "notEmpty";

const compareValue = (left: string, right: string) => {
  const leftNumber = Number(left.replace(/,/g, ""));
  const rightNumber = Number(right.replace(/,/g, ""));
  if (
    left.trim() !== "" &&
    right.trim() !== "" &&
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber)
  ) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right, "ko", { numeric: true });
};

export const rowMatchesCondition = (
  row: Record<string, string>,
  condition: FilterCondition,
) => {
  if (!condition.column) return true;
  const raw = row[condition.column] ?? "";
  const expected = condition.value.trim();
  const compared = compareValue(raw, expected);

  switch (condition.operator) {
    case "eq":
      return raw === expected;
    case "neq":
      return raw !== expected;
    case "contains":
      return raw.toLowerCase().includes(expected.toLowerCase());
    case "starts":
      return raw.toLowerCase().startsWith(expected.toLowerCase());
    case "gt":
      return compared > 0;
    case "gte":
      return compared >= 0;
    case "lt":
      return compared < 0;
    case "lte":
      return compared <= 0;
    case "empty":
      return raw.trim() === "";
    case "notEmpty":
      return raw.trim() !== "";
    default:
      return true;
  }
};

export const applyFilterRows = (
  rows: Record<string, string>[],
  filter: Pick<FilterNodeOptions, "columnsChosen" | "selectedColumns" | "conditions"> | null,
) => {
  const active = (filter?.conditions ?? []).filter((condition) => condition.column.trim());
  const matched = rows.filter((row) =>
    active.every((condition) => rowMatchesCondition(row, condition)),
  );

  if (!filter?.columnsChosen) return matched;

  const columns = filter.selectedColumns;
  return matched.map((row) =>
    Object.fromEntries(columns.map((column) => [column, row[column] ?? ""])),
  );
};
