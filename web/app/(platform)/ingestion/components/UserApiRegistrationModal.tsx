"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ApiParam = {
  id: number;
  param_key: string;
  param_value: string;
  param_location: string;
  param_order: number;
  encode_mode?: string | null;
  param_role?: string | null;
};

type ApiGroup = {
  id: number;
  name: string | null;
  is_template?: boolean;
  created_at: string;
  params: ApiParam[];
};

type ApiSource = {
  id: number;
  name: string;
  provider: string;
  base_url: string;
  api_key: string | null;
  api_key_param_key?: string | null;
  api_key_location?: string | null;
  api_key_order?: number | null;
  api_key_encode_mode?: string | null;
  enabled: boolean;
  is_template?: boolean;
  created_at: string;
  groups: ApiGroup[];
};

type Props = {
  open: boolean;
  templates: ApiSource[];
  sources: ApiSource[];
  onClose: () => void;
  onCompleted: () => void;
};

type Step =
  | "org"
  | "target"
  | "kosisUserStats"
  | "datagokrSpec"
  | "period"
  | "extra"
  | "name"
  | "confirm";

type ExtraParam = { key: string; value: string };

type BokStatItem = {
  p_stat_code: string;
  stat_code: string;
  stat_name: string;
  cycle: string;
  srch_yn: string;
  org_name: string;
};
type KosisStatItem = {
  node_id: number;
  p_stat_code: string;
  stat_code: string;
  tree_no?: string;
  stat_name_no?: string;
  stat_name: string;
  cycle?: string;
  srch_yn: string;
  org_name?: string;
  vw_cd: string;
  stat_id?: string;
  send_de?: string;
  full_path?: string;
};
type DatagokrStatItem = {
  p_stat_code: string;
  stat_code: string;
  stat_name: string;
  srch_yn: string;
  org_cd: string;
  org_name: string;
  list_url?: string;
};
type FredStatItem = {
  node_id: string;
  parent_node_id: string | null;
  node_name: string;
  node_type: string;
  category_id?: number | null;
  stat_code?: string | null;
  cycle?: string | null;
  srch_yn?: string | null;
  lvl?: number | null;
  leaf_yn?: string | null;
  sort_ord?: number | null;
  org_name?: string | null;
};
type DatagokrTreeNode = DatagokrStatItem & {
  children: DatagokrTreeNode[];
  selectable: boolean;
};
type FredTreeNode = FredStatItem & {
  children: FredTreeNode[];
  selectable: boolean;
};

/** 통계청 트리/검색 표시용: `stat_name_no`(번호+이름) 우선, 없으면 `stat_name` */
const kosisDisplayLabel = (item: Pick<KosisStatItem, "stat_name_no" | "stat_name">) =>
  (item.stat_name_no ?? "").trim() || item.stat_name;

type BokTreeNode = BokStatItem & {
  children: BokTreeNode[];
  selectable: boolean;
};
const ORG_CATALOG = [
  {
    provider: "bok",
    name: "한국은행",
    description: "경제/금융 주요 지표를 쉽게 가져옵니다.",
  },
  {
    provider: "kosis",
    name: "통계청",
    description: "국가 통계 데이터를 수집할 수 있습니다.",
  },
  {
    provider: "datagokr",
    name: "공공데이터포털",
    description: "공공기관 오픈데이터를 연동합니다.",
  },
  {
    provider: "fred",
    name: "FRED",
    description: "미국 세인트루이스 연준 경제시계열을 연동합니다.",
  },
];

const DEFAULT_STEP_LABELS: Array<{ key: Step; label: string }> = [
  { key: "org", label: "기관 선택" },
  { key: "target", label: "수집대상 선택" },
  { key: "period", label: "기간 입력" },
  { key: "extra", label: "추가 파라미터 입력(선택)" },
  { key: "name", label: "API 명 입력" },
  { key: "confirm", label: "완료" },
];
const KOSIS_STEP_LABELS: Array<{ key: Step; label: string }> = [
  { key: "org", label: "기관 선택" },
  { key: "target", label: "수집대상 선택" },
  { key: "kosisUserStats", label: "userStatsId 입력" },
  { key: "period", label: "주기+기간 입력" },
  { key: "extra", label: "추가 파라미터 입력(선택)" },
  { key: "name", label: "API 명 입력" },
  { key: "confirm", label: "완료" },
];
const DATAGOKR_STEP_LABELS: Array<{ key: Step; label: string }> = [
  { key: "org", label: "기관 선택" },
  { key: "target", label: "수집대상 선택" },
  { key: "datagokrSpec", label: "API 정보 입력" },
  { key: "period", label: "기간 입력" },
  { key: "extra", label: "추가 파라미터 입력(선택)" },
  { key: "name", label: "API 명 입력" },
  { key: "confirm", label: "완료" },
];
const normalizeProvider = (provider?: string | null) => {
  const value = (provider ?? "").trim().toLowerCase();
  if (!value) return "custom";
  if (value === "data-go-kr" || value === "data_go_kr") return "datagokr";
  return value;
};

const pad = (value: number) => String(value).padStart(2, "0");

const formatForPeriod = (dateText: string, period: string) => {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (period === "D") return `${year}${pad(month)}${pad(date.getDate())}`;
  if (period === "Q") return `${year}Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === "A" || period === "Y") return `${year}`;
  return `${year}${pad(month)}`;
};
const normalizePeriodType = (value?: string | null) => {
  const period = (value ?? "").trim().toUpperCase();
  if (["D", "M", "Q", "A", "Y"].includes(period)) return period;
  // 기존 등록 로직과 동일하게 미지원 주기는 월간(M) 기본값 사용
  return "M";
};

const addMonthsRange = (months: number) => {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - months);
  const toInput = (date: Date) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return { start: toInput(start), end: toInput(end) };
};
const normalizeIsoDate = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(`${trimmed}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
};

const decodeSafe = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeValue = (value: string, mode?: string | null) => {
  const normalized = mode === "decode" ? decodeSafe(value) : value;
  if (mode === "none") return normalized;
  return encodeURIComponent(normalized);
};
const parseNumberedPrefix = (label: string) => {
  const token = (label.trim().match(/^([0-9]+(?:\.[0-9]+)*)\./) ?? [])[1] ?? "";
  if (!token) return null;
  const parts = token
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
  return parts.length ? parts : null;
};
const compareByNumberedPrefix = (a: string, b: string) => {
  const aParts = parseNumberedPrefix(a);
  const bParts = parseNumberedPrefix(b);
  if (aParts && bParts) {
    const length = Math.max(aParts.length, bParts.length);
    for (let index = 0; index < length; index += 1) {
      const left = aParts[index] ?? -1;
      const right = bParts[index] ?? -1;
      if (left !== right) return left - right;
    }
    return a.localeCompare(b, "ko");
  }
  if (aParts) return -1;
  if (bParts) return 1;
  return a.localeCompare(b, "ko");
};

export default function UserApiRegistrationModal({
  open,
  templates,
  sources,
  onClose,
  onCompleted,
}: Props) {
  const [step, setStep] = useState<Step>("org");
  const [orgQuery, setOrgQuery] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [bokAppliedQuery, setBokAppliedQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);
  const [bokStats, setBokStats] = useState<BokStatItem[]>([]);
  const [bokLoading, setBokLoading] = useState(false);
  const [bokError, setBokError] = useState("");
  const [bokExpanded, setBokExpanded] = useState<Set<string>>(new Set());
  const [bokSelectedStatCode, setBokSelectedStatCode] = useState<string | null>(null);
  const [kosisStats, setKosisStats] = useState<KosisStatItem[]>([]);
  const [kosisLoading, setKosisLoading] = useState(false);
  const [kosisLoadingParentKeys, setKosisLoadingParentKeys] = useState<Set<string>>(new Set());
  const [kosisLoadedParentKeys, setKosisLoadedParentKeys] = useState<Set<string>>(new Set());
  const [kosisSearchResults, setKosisSearchResults] = useState<KosisStatItem[]>([]);
  const [kosisSearchLoading, setKosisSearchLoading] = useState(false);
  const [kosisError, setKosisError] = useState("");
  const [kosisAppliedQuery, setKosisAppliedQuery] = useState("");
  const [kosisExpanded, setKosisExpanded] = useState<Set<number>>(new Set());
  const [kosisSelectedNodeId, setKosisSelectedNodeId] = useState<number | null>(null);
  const [kosisUserStatsId, setKosisUserStatsId] = useState("");
  const [kosisCycle, setKosisCycle] = useState("M");
  const [datagokrStats, setDatagokrStats] = useState<DatagokrStatItem[]>([]);
  const [datagokrLoading, setDatagokrLoading] = useState(false);
  const [datagokrError, setDatagokrError] = useState("");
  const [datagokrAppliedQuery, setDatagokrAppliedQuery] = useState("");
  const [datagokrSearchResults, setDatagokrSearchResults] = useState<DatagokrStatItem[]>([]);
  const [datagokrSelectedStatCode, setDatagokrSelectedStatCode] = useState<string | null>(null);
  const [datagokrExpanded, setDatagokrExpanded] = useState<Set<string>>(new Set());
  const [datagokrApiServiceName, setDatagokrApiServiceName] = useState("");
  const [datagokrFunctionName, setDatagokrFunctionName] = useState("");
  // FRED: 80만건 규모라 tree는 lazy loading으로 parent 기준 조회합니다.
  const [fredRoots, setFredRoots] = useState<FredTreeNode[]>([]);
  const [fredLoadingRoots, setFredLoadingRoots] = useState(false);
  const [fredLoadingSearch, setFredLoadingSearch] = useState(false);
  const [fredError, setFredError] = useState("");
  const [fredAppliedQuery, setFredAppliedQuery] = useState("");
  const [fredSearchResults, setFredSearchResults] = useState<FredStatItem[]>([]);
  const [fredSelectedNodeId, setFredSelectedNodeId] = useState<string | null>(null);
  const [fredSelectedStat, setFredSelectedStat] = useState<FredStatItem | null>(null);
  const [fredExpanded, setFredExpanded] = useState<Set<string>>(new Set());
  const [fredChildrenByParent, setFredChildrenByParent] = useState<Record<string, FredTreeNode[]>>({});
  const [fredLoadedParentKeys, setFredLoadedParentKeys] = useState<Set<string>>(new Set());
  const [fredLoadingParentKeys, setFredLoadingParentKeys] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [extraParams, setExtraParams] = useState<ExtraParam[]>([{ key: "", value: "" }]);
  const [apiGroupName, setApiGroupName] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewHeader, setPreviewHeader] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<Array<Array<unknown>>>([]);
  const [urlCopied, setUrlCopied] = useState(false);

  const providerGroups = useMemo(() => {
    const map = new Map<string, number>();
    templates.forEach((item) => {
      const provider = normalizeProvider(item.provider);
      map.set(provider, (map.get(provider) ?? 0) + 1);
    });
    return map;
  }, [templates]);

  const visibleOrgs = useMemo(() => {
    const q = orgQuery.trim().toLowerCase();
    return ORG_CATALOG.filter((org) => {
      if (!q) return true;
      return (
        org.name.toLowerCase().includes(q) ||
        org.description.toLowerCase().includes(q)
      );
    });
  }, [orgQuery]);

  const targetItems = useMemo(() => {
    if (!selectedProvider) return [];
    const rows: Array<{
      key: string;
      provider: string;
      source: ApiSource;
      group: ApiGroup;
      title: string;
      description: string;
      typeLabel: string;
      statusLabel: string;
      codeHint: string;
    }> = [];

    templates.forEach((source) => {
      const provider = normalizeProvider(source.provider);
      if (provider !== selectedProvider) return;
      (source.groups ?? []).forEach((group) => {
        const title = (group.name ?? "").trim() || source.name;
        const description = `${source.name} 데이터`;
        const typeLabel = title.includes("통계") ? "통계표" : "데이터셋";
        const statusLabel = source.enabled ? "사용 가능" : "사용 제한";
        rows.push({
          key: `${source.id}:${group.id}`,
          provider,
          source,
          group,
          title,
          description,
          typeLabel,
          statusLabel,
          codeHint: `ID ${group.id}`,
        });
      });
    });

    const q = targetQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((item) =>
      [item.title, item.description, item.typeLabel, item.codeHint]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [selectedProvider, targetQuery, templates]);

  const selectedTarget = useMemo(
    () => targetItems.find((item) => item.key === selectedTargetKey) ?? null,
    [selectedTargetKey, targetItems],
  );
  const bokTemplateTarget = useMemo(() => {
    const source = templates.find(
      (item) => normalizeProvider(item.provider) === "bok" && (item.groups ?? []).length > 0,
    );
    const group = source?.groups?.[0];
    if (!source || !group) return null;
    return { source, group };
  }, [templates]);
  const kosisTemplateTarget = useMemo(() => {
    const source = templates.find(
      (item) => normalizeProvider(item.provider) === "kosis" && (item.groups ?? []).length > 0,
    );
    const group = source?.groups?.[0];
    if (!source || !group) return null;
    return { source, group };
  }, [templates]);
  const datagokrTemplateTarget = useMemo(() => {
    const source = templates.find(
      (item) => normalizeProvider(item.provider) === "datagokr" && (item.groups ?? []).length > 0,
    );
    const group = source?.groups?.[0];
    if (!source || !group) return null;
    return { source, group };
  }, [templates]);
  const fredTemplateTarget = useMemo(() => {
    const source = templates.find(
      (item) => normalizeProvider(item.provider) === "fred" && (item.groups ?? []).length > 0,
    );
    const group = source?.groups?.[0];
    if (!source || !group) return null;
    return { source, group };
  }, [templates]);

  const bokTreeRoots = useMemo(() => {
    if (!bokStats.length) return [] as BokTreeNode[];
    const nodeMap = new Map<string, BokTreeNode>();

    bokStats.forEach((item) => {
      const code = item.stat_code.trim();
      if (!code) return;
      nodeMap.set(code, {
        ...item,
        children: [],
        selectable: item.srch_yn.trim().toUpperCase() === "Y",
      });
    });

    const roots: BokTreeNode[] = [];
    nodeMap.forEach((node) => {
      const parentCode = node.p_stat_code.trim();
      const parent = nodeMap.get(parentCode);
      if (parentCode === "*" || !parent) {
        roots.push(node);
        return;
      }
      parent.children.push(node);
    });

    const sortNodes = (nodes: BokTreeNode[]) => {
      nodes.sort((a, b) => a.stat_name.localeCompare(b.stat_name, "ko"));
      nodes.forEach((node) => sortNodes(node.children));
    };
    sortNodes(roots);
    return roots;
  }, [bokStats]);
  const kosisParentKey = useCallback(
    (parentCode: string, vwCd?: string | null) =>
      `${vwCd?.trim() || "__ALL__"}::${parentCode.trim() || "*"}`,
    [],
  );
  const kosisChildrenByParent = useMemo(() => {
    const map = new Map<string, KosisStatItem[]>();
    kosisStats.forEach((item) => {
      const key =
        item.p_stat_code.trim() === "*"
          ? kosisParentKey("*")
          : kosisParentKey(item.p_stat_code, item.vw_cd);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    });
    map.forEach((list) => {
      list.sort((a, b) =>
        (a.tree_no ?? "").localeCompare(b.tree_no ?? "", undefined, { numeric: true }),
      );
    });
    return map;
  }, [kosisParentKey, kosisStats]);
  const kosisRootNodes = useMemo(
    () => kosisChildrenByParent.get(kosisParentKey("*")) ?? [],
    [kosisChildrenByParent, kosisParentKey],
  );
  /** 검색 시: 트리가 아닌 목록으로만 표시. 최종 선택 가능 통계표(srch_yn=Y)만 포함 */
  const bokSearchResults = useMemo(() => {
    const query = bokAppliedQuery.trim().toLowerCase();
    if (!query) return [] as BokStatItem[];
    return bokStats
      .filter((item) => {
        if (item.srch_yn.trim().toUpperCase() !== "Y") return false;
        return (
          item.stat_code.toLowerCase().includes(query) ||
          item.stat_name.toLowerCase().includes(query)
        );
      })
      .sort((a, b) => a.stat_name.localeCompare(b.stat_name, "ko"));
  }, [bokAppliedQuery, bokStats]);
  const selectedBokStat = useMemo(
    () => bokStats.find((item) => item.stat_code === bokSelectedStatCode) ?? null,
    [bokSelectedStatCode, bokStats],
  );
  const datagokrTreeRoots = useMemo(() => {
    if (!datagokrStats.length) return [] as DatagokrTreeNode[];
    const nodeMap = new Map<string, DatagokrTreeNode>();
    datagokrStats.forEach((item) => {
      const code = item.stat_code.trim();
      if (!code) return;
      nodeMap.set(code, {
        ...item,
        children: [],
        selectable: item.srch_yn.trim().toUpperCase() === "Y",
      });
    });
    const roots: DatagokrTreeNode[] = [];
    nodeMap.forEach((node) => {
      const parentCode = node.p_stat_code.trim();
      const parent = nodeMap.get(parentCode);
      if (!parentCode || !parent) {
        roots.push(node);
        return;
      }
      parent.children.push(node);
    });
    const sortNodes = (nodes: DatagokrTreeNode[]) => {
      nodes.sort((a, b) => compareByNumberedPrefix(a.stat_name, b.stat_name));
      nodes.forEach((node) => sortNodes(node.children));
    };
    sortNodes(roots);
    return roots;
  }, [datagokrStats]);
  const fredTreeRoots = fredRoots;
  const kosisNodeIndex = useMemo(() => {
    const map = new Map<number, KosisStatItem>();
    kosisStats.forEach((item) => map.set(item.node_id, item));
    kosisSearchResults.forEach((item) => map.set(item.node_id, item));
    return map;
  }, [kosisSearchResults, kosisStats]);
  const selectedKosisStat = useMemo(
    () => (kosisSelectedNodeId ? kosisNodeIndex.get(kosisSelectedNodeId) ?? null : null),
    [kosisNodeIndex, kosisSelectedNodeId],
  );
  const selectedDatagokrStat = useMemo(
    () =>
      datagokrStats.find((item) => item.stat_code === datagokrSelectedStatCode) ??
      datagokrSearchResults.find((item) => item.stat_code === datagokrSelectedStatCode) ??
      null,
    [datagokrSearchResults, datagokrSelectedStatCode, datagokrStats],
  );
  const selectedFredStat = fredSelectedStat;
  const bokRegisteredSource = useMemo(() => {
    const candidates = sources.filter(
      (item) => normalizeProvider(item.provider) === "bok" && !item.is_template,
    );
    const withKey = candidates.find(
      (item) => item.enabled && Boolean((item.api_key ?? "").trim()),
    );
    return withKey ?? candidates.find((item) => item.enabled) ?? candidates[0] ?? null;
  }, [sources]);
  const kosisRegisteredSource = useMemo(() => {
    const candidates = sources.filter(
      (item) => normalizeProvider(item.provider) === "kosis" && !item.is_template,
    );
    const withKey = candidates.find(
      (item) => item.enabled && Boolean((item.api_key ?? "").trim()),
    );
    return withKey ?? candidates.find((item) => item.enabled) ?? candidates[0] ?? null;
  }, [sources]);
  const datagokrRegisteredSource = useMemo(() => {
    const candidates = sources.filter(
      (item) => normalizeProvider(item.provider) === "datagokr" && !item.is_template,
    );
    const withKey = candidates.find(
      (item) => item.enabled && Boolean((item.api_key ?? "").trim()),
    );
    return withKey ?? candidates.find((item) => item.enabled) ?? candidates[0] ?? null;
  }, [sources]);
  const fredRegisteredSource = useMemo(() => {
    const candidates = sources.filter(
      (item) => normalizeProvider(item.provider) === "fred" && !item.is_template,
    );
    const withKey = candidates.find(
      (item) => item.enabled && Boolean((item.api_key ?? "").trim()),
    );
    return withKey ?? candidates.find((item) => item.enabled) ?? candidates[0] ?? null;
  }, [sources]);

  const resolvedSelectedTarget = useMemo(() => {
    if (selectedProvider === "bok") {
      if (!bokTemplateTarget || !selectedBokStat) return null;
      const sourceForCall = bokRegisteredSource ?? bokTemplateTarget.source;
      return {
        key: `bok:${selectedBokStat.stat_code}`,
        provider: "bok",
        source: sourceForCall,
        group: bokTemplateTarget.group,
        title: selectedBokStat.stat_name,
        description: `통계표 코드 ${selectedBokStat.stat_code}`,
        typeLabel: "통계표",
        statusLabel: "사용 가능",
        codeHint: selectedBokStat.stat_code,
      };
    }
    if (selectedProvider === "kosis") {
      if (!kosisTemplateTarget || !selectedKosisStat) return null;
      const sourceForCall = kosisRegisteredSource ?? kosisTemplateTarget.source;
      return {
        key: `kosis:${selectedKosisStat.node_id}`,
        provider: "kosis",
        source: sourceForCall,
        group: kosisTemplateTarget.group,
        title: kosisDisplayLabel(selectedKosisStat),
        description: selectedKosisStat.full_path || `통계표 코드 ${selectedKosisStat.stat_code}`,
        typeLabel: "통계표",
        statusLabel: "사용 가능",
        codeHint: selectedKosisStat.stat_code,
      };
    }
    if (selectedProvider === "datagokr") {
      if (!datagokrTemplateTarget || !selectedDatagokrStat) return null;
      const sourceForCall = datagokrRegisteredSource ?? datagokrTemplateTarget.source;
      return {
        key: `datagokr:${selectedDatagokrStat.stat_code}`,
        provider: "datagokr",
        source: sourceForCall,
        group: datagokrTemplateTarget.group,
        title: selectedDatagokrStat.stat_name,
        description: selectedDatagokrStat.org_name || "공공데이터포털 API",
        typeLabel: "OpenAPI",
        statusLabel: "사용 가능",
        codeHint: selectedDatagokrStat.stat_code,
      };
    }
    if (selectedProvider === "fred") {
      if (!fredTemplateTarget || !selectedFredStat || !selectedFredStat.stat_code) return null;
      const sourceForCall = fredRegisteredSource ?? fredTemplateTarget.source;
      return {
        key: `fred:${selectedFredStat.node_id}`,
        provider: "fred",
        source: sourceForCall,
        group: fredTemplateTarget.group,
        title: selectedFredStat.node_name,
        description: `시리즈 코드 ${selectedFredStat.stat_code}`,
        typeLabel: "시계열",
        statusLabel: "사용 가능",
        codeHint: selectedFredStat.stat_code,
      };
    }
    return selectedTarget;
  }, [
    bokRegisteredSource,
    bokTemplateTarget,
    datagokrRegisteredSource,
    datagokrTemplateTarget,
    selectedDatagokrStat,
    fredRegisteredSource,
    fredTemplateTarget,
    kosisRegisteredSource,
    kosisTemplateTarget,
    selectedFredStat,
    selectedKosisStat,
    selectedBokStat,
    selectedProvider,
    selectedTarget,
  ]);

  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "bok") return;
    if (bokStats.length > 0 || bokLoading) return;
    const fetchBokStats = async () => {
      setBokLoading(true);
      setBokError("");
      try {
        const response = await fetch("/api/ingestion/bok-stat-list");
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: BokStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "한국은행 통계표 목록을 불러오지 못했습니다.");
        }
        const items = payload.items ?? [];
        setBokStats(items);
        setBokExpanded(new Set());
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "한국은행 통계표 목록을 불러오지 못했습니다.";
        setBokError(message);
      } finally {
        setBokLoading(false);
      }
    };
    void fetchBokStats();
  }, [bokLoading, bokStats.length, open, selectedProvider, step]);
  const loadKosisChildren = useCallback(
    async (parentCode: string, vwCd?: string) => {
      const cacheKey = kosisParentKey(parentCode, vwCd);
      if (kosisLoadedParentKeys.has(cacheKey)) return;
      setKosisLoadingParentKeys((prev) => new Set(prev).add(cacheKey));
      if (parentCode === "*") setKosisLoading(true);
      setKosisError("");
      try {
        const params = new URLSearchParams({ parent: parentCode });
        if (vwCd?.trim()) params.set("vw", vwCd.trim());
        const response = await fetch(`/api/ingestion/kosis-stat-list?${params.toString()}`);
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: KosisStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "통계청 통계표 목록을 불러오지 못했습니다.");
        }
        const items = payload.items ?? [];
        setKosisStats((prev) => {
          const next = [...prev];
          const known = new Set(prev.map((item) => item.node_id));
          items.forEach((item) => {
            if (!known.has(item.node_id)) {
              next.push(item);
              known.add(item.node_id);
            }
          });
          return next;
        });
        setKosisLoadedParentKeys((prev) => new Set(prev).add(cacheKey));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "통계청 통계표 목록을 불러오지 못했습니다.";
        setKosisError(message);
      } finally {
        setKosisLoadingParentKeys((prev) => {
          const next = new Set(prev);
          next.delete(cacheKey);
          return next;
        });
        if (parentCode === "*") setKosisLoading(false);
      }
    },
    [kosisLoadedParentKeys, kosisParentKey],
  );
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "kosis") return;
    const rootKey = kosisParentKey("*");
    if (kosisLoadedParentKeys.has(rootKey) || kosisLoading) return;
    void loadKosisChildren("*");
  }, [kosisLoadedParentKeys, kosisLoading, loadKosisChildren, open, selectedProvider, step, kosisParentKey]);
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "datagokr") return;
    if (datagokrStats.length > 0 || datagokrLoading) return;
    const fetchDatagokrStats = async () => {
      setDatagokrLoading(true);
      setDatagokrError("");
      try {
        const response = await fetch("/api/ingestion/datagokr-stat-list");
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: DatagokrStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "공공데이터포털 수집대상을 불러오지 못했습니다.");
        }
        setDatagokrStats(payload.items ?? []);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "공공데이터포털 수집대상을 불러오지 못했습니다.";
        setDatagokrError(message);
      } finally {
        setDatagokrLoading(false);
      }
    };
    void fetchDatagokrStats();
  }, [datagokrLoading, datagokrStats.length, open, selectedProvider, step]);
  useEffect(() => {
    if (!open || step !== "target" || selectedProvider !== "fred") return;
    if (fredRoots.length > 0 || fredLoadingRoots) return;
    const fetchFredRoots = async () => {
      setFredLoadingRoots(true);
      setFredError("");
      try {
        const response = await fetch("/api/ingestion/fred-stat-list");
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: FredStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "FRED 수집대상을 불러오지 못했습니다.");
        }
        const toTreeNode = (item: FredStatItem): FredTreeNode => ({
          ...item,
          children: [],
          selectable:
            (item.node_type ?? "").trim().toUpperCase() === "SERIES" ||
            (item.srch_yn ?? "").trim().toUpperCase() === "Y",
        });
        setFredRoots((payload.items ?? []).map(toTreeNode));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "FRED 수집대상을 불러오지 못했습니다.";
        setFredError(message);
      } finally {
        setFredLoadingRoots(false);
      }
    };
    void fetchFredRoots();
  }, [fredLoadingRoots, fredRoots.length, open, selectedProvider, step]);

  const periodType = useMemo(() => {
    if (selectedProvider === "bok" && selectedBokStat) {
      return normalizePeriodType(selectedBokStat.cycle);
    }
    if (selectedProvider === "kosis") {
      return normalizePeriodType(kosisCycle);
    }
    if (selectedProvider === "fred" && selectedFredStat) {
      return normalizePeriodType(selectedFredStat.cycle ?? "M");
    }
    if (!resolvedSelectedTarget) return "M";
    const params = resolvedSelectedTarget.group.params ?? [];
    const rolePeriod =
      params.find((item) => (item.param_role ?? "").trim() === "period_type")
        ?.param_value ?? "";
    const keyPeriod =
      params.find((item) =>
        ["period", "prdSe", "periodType"].includes(item.param_key),
      )?.param_value ?? "";
    const value = rolePeriod || keyPeriod || "M";
    return normalizePeriodType(value);
  }, [kosisCycle, resolvedSelectedTarget, selectedBokStat, selectedFredStat, selectedProvider]);

  const canGoNextFromOrg = Boolean(selectedProvider);
  const canGoNextFromTarget =
    selectedProvider === "bok"
      ? Boolean(selectedBokStat && bokTemplateTarget)
      : selectedProvider === "kosis"
        ? Boolean(selectedKosisStat && kosisTemplateTarget)
      : selectedProvider === "datagokr"
        ? Boolean(selectedDatagokrStat && datagokrTemplateTarget)
      : selectedProvider === "fred"
        ? Boolean(selectedFredStat && selectedFredStat.stat_code && fredTemplateTarget)
      : Boolean(selectedTarget);
  const kosisUserStatsError =
    selectedProvider === "kosis" && kosisUserStatsId.trim().length === 0
      ? "userStatsId를 입력해주세요."
      : "";
  const canGoNextFromKosisUserStats = kosisUserStatsError.length === 0;
  const datagokrSpecError =
    selectedProvider === "datagokr" &&
    (!datagokrApiServiceName.trim() || !datagokrFunctionName.trim())
      ? "API 서비스명과 상세 기능명을 모두 입력해주세요."
      : "";
  const canGoNextFromDatagokrSpec = datagokrSpecError.length === 0;
  const periodError =
    !startDate || !endDate
      ? "시작일과 종료일을 입력해주세요."
      : startDate > endDate
        ? "종료일은 시작일보다 빠를 수 없습니다."
        : "";
  const canGoNextFromPeriod = periodError.length === 0;
  const apiGroupNameError =
    apiGroupName.trim().length === 0
      ? "API 명을 입력해주세요."
      : apiGroupName.trim().length > 120
        ? "API 명은 120자 이내로 입력해주세요."
        : "";
  const canGoNextFromName = apiGroupNameError.length === 0;

  const currentStepLabels =
    selectedProvider === "kosis"
      ? KOSIS_STEP_LABELS
      : selectedProvider === "datagokr"
        ? DATAGOKR_STEP_LABELS
      : DEFAULT_STEP_LABELS;
  const activeStepIndex = currentStepLabels.findIndex((item) => item.key === step);
  const submitParams = useMemo(() => {
    if (!resolvedSelectedTarget) return [] as Array<{
      key: string;
      value: string;
      location: "path" | "query";
      order: number;
      encodeMode?: string;
      role?: string | null;
    }>;
    const params = resolvedSelectedTarget.group.params.map((item) => ({
      key: item.param_key,
      value: item.param_value ?? "",
      location: (item.param_location as "path" | "query") ?? "query",
      order: Number.isFinite(item.param_order) ? item.param_order : 0,
      encodeMode: item.encode_mode ?? "encode",
      role: item.param_role ?? null,
    }));
    const paramMap = new Map(params.map((item) => [item.key, item]));
    const roleKey = new Map<string, string>();
    params.forEach((item) => {
      const role = item.role?.trim();
      if (!role || roleKey.has(role)) return;
      roleKey.set(role, item.key);
    });

    const startKey =
      roleKey.get("start") ??
      (["apiStart", "startPrdDe", "strtYymm"].find((key) => paramMap.has(key)) ?? null);
    const endKey =
      roleKey.get("end") ??
      (["apiEnd", "endPrdDe", "endYymm"].find((key) => paramMap.has(key)) ?? null);
    const fredStartDate = normalizeIsoDate(startDate);
    const fredEndDate = normalizeIsoDate(endDate);
    const startValue =
      selectedProvider === "fred" ? fredStartDate : formatForPeriod(startDate, periodType);
    const endValue =
      selectedProvider === "fred" ? fredEndDate : formatForPeriod(endDate, periodType);

    if (startKey && startValue) {
      const item = paramMap.get(startKey);
      if (item) paramMap.set(startKey, { ...item, value: startValue });
    }
    if (endKey && endValue) {
      const item = paramMap.get(endKey);
      if (item) paramMap.set(endKey, { ...item, value: endValue });
    }
    if (selectedProvider === "bok" && selectedBokStat) {
      const cycleRaw = (selectedBokStat.cycle ?? "").trim().toUpperCase();
      const cycleValue = normalizePeriodType(selectedBokStat.cycle);
      ["period", "prdSe", "periodType"].forEach((key) => {
        const current = paramMap.get(key);
        if (current) {
          paramMap.set(key, { ...current, value: cycleRaw || cycleValue });
        }
      });
      const statCodeParam = paramMap.get("statCode");
      if (statCodeParam) {
        paramMap.set("statCode", { ...statCodeParam, value: selectedBokStat.stat_code });
      } else {
        paramMap.set("statCode", {
          key: "statCode",
          value: selectedBokStat.stat_code,
          location: "path",
          order: 5,
          encodeMode: "encode",
          role: null,
        });
      }
    }
    if (selectedProvider === "kosis" && selectedKosisStat) {
      const setOrInsert = (
        keys: string[],
        value: string,
        defaultKey: string,
        location: "path" | "query",
        order: number,
      ) => {
        if (!value.trim()) return;
        let found = false;
        keys.forEach((key) => {
          const current = paramMap.get(key);
          if (current) {
            paramMap.set(key, { ...current, value });
            found = true;
          }
        });
        if (!found) {
          paramMap.set(defaultKey, {
            key: defaultKey,
            value,
            location,
            order,
            encodeMode: "encode",
            role: null,
          });
        }
      };
      setOrInsert(
        ["userStatsId", "tblId", "tbl_id", "statCode", "stat_code"],
        selectedKosisStat.stat_code,
        "tblId",
        "query",
        4,
      );
      setOrInsert(["userStatsId"], kosisUserStatsId.trim(), "userStatsId", "query", 4);
      setOrInsert(["vwCd", "vw_cd"], selectedKosisStat.vw_cd ?? "", "vwCd", "query", 5);
      setOrInsert(["statId", "stat_id"], selectedKosisStat.stat_id ?? "", "statId", "query", 6);
      setOrInsert(["sendDe", "send_de"], selectedKosisStat.send_de ?? "", "sendDe", "query", 7);
      setOrInsert(["prdSe", "period", "periodType"], kosisCycle, "prdSe", "query", 8);
    }
    if (selectedProvider === "datagokr" && selectedDatagokrStat) {
      const setOrInsert = (
        keys: string[],
        value: string,
        defaultKey: string,
        location: "path" | "query",
        order: number,
      ) => {
        if (!value.trim()) return;
        let found = false;
        keys.forEach((key) => {
          const current = paramMap.get(key);
          if (current) {
            paramMap.set(key, { ...current, value });
            found = true;
          }
        });
        if (!found) {
          paramMap.set(defaultKey, {
            key: defaultKey,
            value,
            location,
            order,
            encodeMode: "encode",
            role: null,
          });
        }
      };
      setOrInsert(
        ["orgCode", "org_cd"],
        selectedDatagokrStat.org_cd,
        "orgCode",
        "path",
        1,
      );
      setOrInsert(
        ["apiName", "api_name", "apiServiceName"],
        datagokrApiServiceName.trim(),
        "apiName",
        "path",
        2,
      );
      setOrInsert(
        ["functionName", "function_name", "apiDetailName"],
        datagokrFunctionName.trim(),
        "functionName",
        "path",
        3,
      );
      setOrInsert(
        ["listId", "list_id", "statCode", "stat_code"],
        selectedDatagokrStat.stat_code,
        "listId",
        "query",
        6,
      );
    }
    if (selectedProvider === "fred" && selectedFredStat?.stat_code) {
      const setOrInsert = (
        keys: string[],
        value: string,
        defaultKey: string,
        location: "path" | "query",
        order: number,
      ) => {
        if (!value.trim()) return;
        let found = false;
        keys.forEach((key) => {
          const current = paramMap.get(key);
          if (current) {
            paramMap.set(key, { ...current, value });
            found = true;
          }
        });
        if (!found) {
          paramMap.set(defaultKey, {
            key: defaultKey,
            value,
            location,
            order,
            encodeMode: "encode",
            role: null,
          });
        }
      };
      const cycleRaw = (selectedFredStat.cycle ?? "").trim();
      const frequency = cycleRaw ? cycleRaw.toLowerCase() : "m";
      setOrInsert(["series_id", "seriesId", "statCode", "stat_code"], selectedFredStat.stat_code, "series_id", "query", 5);
      setOrInsert(["frequency", "freq", "period", "periodType"], frequency, "frequency", "query", 6);
      setOrInsert(["observation_start", "apiStart", "start"], fredStartDate, "observation_start", "query", 7);
      setOrInsert(["observation_end", "apiEnd", "end"], fredEndDate, "observation_end", "query", 8);
      setOrInsert(["file_type", "fileType", "format"], "json", "file_type", "query", 1);
    }

    const maxOrder = params.reduce((acc, item) => Math.max(acc, item.order), 0);
    let orderCursor = maxOrder + 1;
    extraParams
      .filter((item) => item.key.trim() && item.value.trim())
      .forEach((item) => {
        const key = item.key.trim();
        const value = item.value.trim();
        const current = paramMap.get(key);
        if (current) {
          paramMap.set(key, { ...current, value });
        } else {
          paramMap.set(key, {
            key,
            value,
            location: "query",
            order: orderCursor,
            encodeMode: "encode",
            role: null,
          });
          orderCursor += 1;
        }
      });

    return Array.from(paramMap.values());
  }, [
    endDate,
    extraParams,
    periodType,
    resolvedSelectedTarget,
    selectedBokStat,
    kosisCycle,
    datagokrApiServiceName,
    datagokrFunctionName,
    selectedDatagokrStat,
    selectedFredStat,
    fredTemplateTarget,
    kosisUserStatsId,
    selectedKosisStat,
    selectedProvider,
    startDate,
  ]);

  const previewUrl = useMemo(() => {
    if (!resolvedSelectedTarget) return "";
    const source = resolvedSelectedTarget.source;
    if (!source.base_url) return "";
    const url = new URL(source.base_url);
    const base = `${url.origin}${url.pathname}`.replace(/\/$/, "");
    const apiKeyKey = source.api_key_param_key?.trim() || "";
    const apiKeyLocation = source.api_key_location || "query";
    const apiKeyOrder = Number.isFinite(source.api_key_order)
      ? Number(source.api_key_order)
      : 0;
    const apiKeyValue = source.api_key ?? "";

    const pathParams = submitParams
      .filter((item) => item.location === "path" && item.value.trim())
      .map((item) => ({ ...item, encodeMode: item.encodeMode ?? "encode" }));
    const queryParams = submitParams
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
          encodeMode: source.api_key_encode_mode ?? "encode",
        });
      } else {
        queryParams.push({
          key: apiKeyKey,
          value: apiKeyValue,
          location: "query",
          order: apiKeyOrder,
          encodeMode: source.api_key_encode_mode ?? "encode",
        });
      }
    }
    const pathSegment = pathParams
      .sort((a, b) => a.order - b.order)
      .map((item) => normalizeValue(item.value, item.encodeMode))
      .join("/");
    const queryPairs = queryParams
      .sort((a, b) => a.order - b.order)
      .map((item) => `${encodeURIComponent(item.key)}=${normalizeValue(item.value, item.encodeMode)}`)
      .join("&");
    const existingQuery = url.search.replace(/^\?/, "");
    const mergedQuery = [existingQuery, queryPairs].filter(Boolean).join("&");
    const fullPath = pathSegment ? `${base}/${pathSegment}` : base;
    return mergedQuery ? `${fullPath}?${mergedQuery}` : fullPath;
  }, [resolvedSelectedTarget, submitParams]);

  const resetAll = () => {
    setStep("org");
    setOrgQuery("");
    setTargetQuery("");
    setBokAppliedQuery("");
    setSelectedProvider(null);
    setSelectedTargetKey(null);
    setBokExpanded(new Set());
    setBokSelectedStatCode(null);
    setBokError("");
    setKosisExpanded(new Set());
    setKosisSelectedNodeId(null);
    setKosisStats([]);
    setKosisLoading(false);
    setKosisSearchResults([]);
    setKosisLoadingParentKeys(new Set());
    setKosisLoadedParentKeys(new Set());
    setKosisSearchLoading(false);
    setKosisUserStatsId("");
    setKosisCycle("M");
    setKosisAppliedQuery("");
    setKosisError("");
    setDatagokrStats([]);
    setDatagokrLoading(false);
    setDatagokrError("");
    setDatagokrAppliedQuery("");
    setDatagokrSearchResults([]);
    setDatagokrSelectedStatCode(null);
    setDatagokrExpanded(new Set());
    setDatagokrApiServiceName("");
    setDatagokrFunctionName("");
    setFredError("");
    setFredAppliedQuery("");
    setFredRoots([]);
    setFredLoadingRoots(false);
    setFredLoadingSearch(false);
    setFredSearchResults([]);
    setFredSelectedNodeId(null);
    setFredSelectedStat(null);
    setFredExpanded(new Set());
    setFredChildrenByParent({});
    setFredLoadedParentKeys(new Set());
    setFredLoadingParentKeys(new Set());
    setStartDate("");
    setEndDate("");
    setExtraParams([{ key: "", value: "" }]);
    setApiGroupName("");
    setSubmitError("");
    setSubmitting(false);
    setDone(false);
    setPreviewLoading(false);
    setPreviewError("");
    setPreviewHeader([]);
    setPreviewRows([]);
    setUrlCopied(false);
  };

  const handleClose = () => {
    resetAll();
    onClose();
  };

  const goBack = () => {
    if (step === "target") setStep("org");
    else if (step === "kosisUserStats") setStep("target");
    else if (step === "datagokrSpec") setStep("target");
    else if (step === "period")
      setStep(
        selectedProvider === "kosis"
          ? "kosisUserStats"
          : selectedProvider === "datagokr"
            ? "datagokrSpec"
          : "target",
      );
    else if (step === "extra") setStep("period");
    else if (step === "name") setStep("extra");
    else if (step === "confirm") setStep("name");
  };

  const quickRange = (months: number) => {
    const next = addMonthsRange(months);
    setStartDate(next.start);
    setEndDate(next.end);
  };

  const handleSubmit = async () => {
    if (!resolvedSelectedTarget || periodError || apiGroupNameError) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const payload = {
        source: {
          name: resolvedSelectedTarget.source.name,
          provider: normalizeProvider(resolvedSelectedTarget.source.provider),
          baseUrl: resolvedSelectedTarget.source.base_url,
          apiKey: resolvedSelectedTarget.source.api_key ?? "",
          enabled: true,
          apiKeyParamKey: resolvedSelectedTarget.source.api_key_param_key ?? "",
          apiKeyLocation: resolvedSelectedTarget.source.api_key_location ?? "query",
          apiKeyOrder: resolvedSelectedTarget.source.api_key_order ?? 0,
          apiKeyEncodeMode: resolvedSelectedTarget.source.api_key_encode_mode ?? "encode",
        },
        groupName: apiGroupName.trim(),
        params: submitParams,
      };

      const response = await fetch("/api/ingestion/api-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "등록에 실패했습니다.");
      }
      setDone(true);
      onCompleted();
    } catch (error) {
      const message = error instanceof Error ? error.message : "등록에 실패했습니다.";
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleBokNode = (code: string) => {
    setBokExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const runBokSearch = () => {
    const query = targetQuery.trim();
    setBokAppliedQuery(query);
    if (!query) {
      setBokExpanded(new Set());
    }
  };

  const resetBokSearch = () => {
    setTargetQuery("");
    setBokAppliedQuery("");
    setBokExpanded(new Set());
  };
  const toggleFredNode = async (node: FredTreeNode) => {
    const nodeId = node.node_id;
    const shouldExpand = !fredExpanded.has(nodeId);

    setFredExpanded((prev) => {
      const next = new Set(prev);
      if (shouldExpand) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });

    // 접기면 자식 로드는 필요 없습니다.
    if (!shouldExpand) return;

    // 이미 로드했으면 재조회하지 않습니다.
    if (fredLoadedParentKeys.has(nodeId)) return;

    setFredLoadingParentKeys((prev) => {
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });

    try {
      const response = await fetch(
        `/api/ingestion/fred-stat-list?parent=${encodeURIComponent(nodeId)}`,
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        items?: FredStatItem[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "FRED 하위 항목 로드에 실패했습니다.");
      }

      const toTreeNode = (item: FredStatItem): FredTreeNode => ({
        ...item,
        children: [],
        selectable:
          (item.node_type ?? "").trim().toUpperCase() === "SERIES" ||
          (item.srch_yn ?? "").trim().toUpperCase() === "Y",
      });

      setFredChildrenByParent((prev) => ({
        ...prev,
        [nodeId]: (payload.items ?? []).map(toTreeNode),
      }));
      setFredLoadedParentKeys((prev) => {
        const next = new Set(prev);
        next.add(nodeId);
        return next;
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "FRED 하위 항목 로드에 실패했습니다.";
      setFredError(message);
    } finally {
      setFredLoadingParentKeys((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
    }
  };
  const toggleDatagokrNode = (code: string) => {
    setDatagokrExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };
  const toggleKosisNode = async (node: KosisStatItem) => {
    const nodeId = node.node_id;
    const shouldExpand = !kosisExpanded.has(nodeId);
    setKosisExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
    if (!shouldExpand || node.srch_yn.trim().toUpperCase() === "Y") return;
    await loadKosisChildren(node.stat_code, node.vw_cd);
  };
  const runKosisSearch = async () => {
    const query = targetQuery.trim();
    setKosisAppliedQuery(query);
    if (!query) {
      setKosisSearchResults([]);
      return;
    }
    setKosisSearchLoading(true);
    setKosisError("");
    try {
      const response = await fetch(
        `/api/ingestion/kosis-stat-search?q=${encodeURIComponent(query)}&limit=100`,
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        items?: KosisStatItem[];
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "통계청 검색 결과를 불러오지 못했습니다.");
      }
      setKosisSearchResults(payload.items ?? []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "통계청 검색 결과를 불러오지 못했습니다.";
      setKosisError(message);
      setKosisSearchResults([]);
    } finally {
      setKosisSearchLoading(false);
    }
  };
  const resetKosisSearch = () => {
    setTargetQuery("");
    setKosisAppliedQuery("");
    setKosisSearchResults([]);
  };
  const runDatagokrSearch = () => {
    const query = targetQuery.trim();
    setDatagokrAppliedQuery(query);
    if (!query) {
      setDatagokrSearchResults([]);
      setDatagokrExpanded(new Set());
      return;
    }
    setDatagokrLoading(true);
    setDatagokrError("");
    void fetch(`/api/ingestion/datagokr-stat-list?q=${encodeURIComponent(query)}`)
      .then(async (response) => {
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: DatagokrStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "공공데이터포털 검색 결과를 불러오지 못했습니다.");
        }
        setDatagokrSearchResults(payload.items ?? []);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "공공데이터포털 검색 결과를 불러오지 못했습니다.";
        setDatagokrError(message);
        setDatagokrSearchResults([]);
      })
      .finally(() => {
        setDatagokrLoading(false);
      });
  };
  const resetDatagokrSearch = () => {
    setTargetQuery("");
    setDatagokrAppliedQuery("");
    setDatagokrSearchResults([]);
    setDatagokrSelectedStatCode(null);
    setDatagokrExpanded(new Set());
  };
  const runFredSearch = () => {
    const query = targetQuery.trim();
    setFredAppliedQuery(query);
    if (!query) {
      setFredSearchResults([]);
      setFredExpanded(new Set());
      return;
    }
    setFredLoadingSearch(true);
    setFredError("");
    void fetch(`/api/ingestion/fred-stat-search?q=${encodeURIComponent(query)}`)
      .then(async (response) => {
        const payload = (await response.json()) as {
          ok?: boolean;
          items?: FredStatItem[];
          error?: string;
        };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "FRED 검색 결과를 불러오지 못했습니다.");
        }
        setFredSearchResults(payload.items ?? []);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "FRED 검색 결과를 불러오지 못했습니다.";
        setFredError(message);
        setFredSearchResults([]);
      })
      .finally(() => {
        setFredLoadingSearch(false);
      });
  };
  const resetFredSearch = () => {
    setTargetQuery("");
    setFredAppliedQuery("");
    setFredSearchResults([]);
    setFredSelectedNodeId(null);
    setFredSelectedStat(null);
    setFredExpanded(new Set());
    setFredLoadingSearch(false);
  };

  const buildTabularFromJsonPreview = (raw: unknown) => {
    const tryExtractRows = (obj: Record<string, unknown>): Array<Record<string, unknown>> | null => {
      if (Array.isArray(obj.row)) {
        return obj.row.filter(
          (item): item is Record<string, unknown> =>
            item != null && typeof item === "object" && !Array.isArray(item),
        );
      }
      if (Array.isArray(obj.rows)) {
        return obj.rows.filter(
          (item): item is Record<string, unknown> =>
            item != null && typeof item === "object" && !Array.isArray(item),
        );
      }
      if (Array.isArray(obj.items)) {
        return obj.items.filter(
          (item): item is Record<string, unknown> =>
            item != null && typeof item === "object" && !Array.isArray(item),
        );
      }
      for (const value of Object.values(obj)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const nested = tryExtractRows(value as Record<string, unknown>);
          if (nested && nested.length > 0) return nested;
        }
      }
      return null;
    };

    const normalized = (() => {
      if (raw == null) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
          try {
            return JSON.parse(trimmed) as unknown;
          } catch {
            return [{ value: raw }];
          }
        }
        return [{ value: raw }];
      }
      if (typeof raw === "object") {
        const record = raw as Record<string, unknown>;
        const extractedRows = tryExtractRows(record);
        if (extractedRows && extractedRows.length > 0) return extractedRows;
        if (Array.isArray(record.data)) return record.data;
        if (Array.isArray(record.rows)) return record.rows;
        if (Array.isArray(record.items)) return record.items;
        return [record];
      }
      return [{ value: raw }];
    })();

    const asArray = Array.isArray(normalized) ? normalized : [normalized];
    const objectRows = asArray.filter(
      (item): item is Record<string, unknown> =>
        item != null && typeof item === "object" && !Array.isArray(item),
    );
    if (objectRows.length === 0) {
      return {
        header: ["value"],
        rows: asArray.slice(0, 10).map((item) => [String(item ?? "")]),
      };
    }
    const header = Array.from(new Set(objectRows.flatMap((row) => Object.keys(row))));
    const rows = objectRows.slice(0, 10).map((row) =>
      header.map((key) => row[key] ?? null),
    );
    return { header, rows };
  };

  const buildTabularFromDatagokrXml = (raw: unknown, contentType?: string) => {
    if (typeof raw !== "string") {
      throw new Error("공공데이터포털 XML 응답 파싱에 실패했습니다.");
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("조회 결과가 없습니다.");
    }

    const contentTypeValue = (contentType ?? "").toLowerCase();
    const looksLikeXml = trimmed.startsWith("<");
    const isXmlContentType = contentTypeValue.includes("xml");
    if (!looksLikeXml && !isXmlContentType) {
      throw new Error("공공데이터포털 미리보기 응답이 XML 형식이 아닙니다.");
    }

    let document: Document;
    try {
      document = new DOMParser().parseFromString(trimmed, "application/xml");
    } catch {
      throw new Error("공공데이터포털 XML 응답 파싱에 실패했습니다.");
    }
    if (document.querySelector("parsererror")) {
      throw new Error("공공데이터포털 XML 응답 파싱에 실패했습니다.");
    }

    const elementChildren = (element: Element) =>
      Array.from(element.children).filter((child): child is Element => child.nodeType === Node.ELEMENT_NODE);

    const readRow = (element: Element): Record<string, unknown> => {
      const children = elementChildren(element);
      if (children.length === 0) {
        return { value: (element.textContent ?? "").trim() };
      }
      return children.reduce<Record<string, unknown>>((acc, child) => {
        acc[child.tagName] = (child.textContent ?? "").trim();
        return acc;
      }, {});
    };

    const preferredRows = ["item", "row"].flatMap((tagName) =>
      Array.from(document.getElementsByTagName(tagName)).filter((node) => elementChildren(node).length > 0),
    );
    const rowsFromPreferred = preferredRows.map(readRow).filter((row) => Object.keys(row).length > 0);
    if (rowsFromPreferred.length > 0) {
      const header = Array.from(new Set(rowsFromPreferred.flatMap((row) => Object.keys(row))));
      const rows = rowsFromPreferred.slice(0, 10).map((row) => header.map((key) => row[key] ?? ""));
      return { header, rows };
    }

    const leafElements = Array.from(document.querySelectorAll("*")).filter(
      (element) => element.children.length === 0,
    );
    if (leafElements.length > 0) {
      const singleRow = leafElements.reduce<Record<string, unknown>>((acc, element) => {
        const key = element.tagName;
        if (key && !(key in acc)) {
          acc[key] = (element.textContent ?? "").trim();
        }
        return acc;
      }, {});
      const header = Object.keys(singleRow);
      if (header.length > 0) {
        return { header, rows: [header.map((key) => singleRow[key] ?? "")] };
      }
    }

    throw new Error("미리보기 응답 구조를 확인해주세요.");
  };
  const buildTabularFromFredPreview = (raw: unknown) => {
    const parsed = (() => {
      if (raw == null) return null;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        try {
          return JSON.parse(trimmed) as unknown;
        } catch {
          throw new Error("FRED 응답에서 observations 데이터를 찾을 수 없습니다.");
        }
      }
      return raw;
    })();

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("FRED 응답에서 observations 데이터를 찾을 수 없습니다.");
    }

    const observations = (parsed as Record<string, unknown>).observations;
    if (!Array.isArray(observations)) {
      throw new Error("FRED 응답에서 observations 데이터를 찾을 수 없습니다.");
    }

    const objectRows = observations.filter(
      (item): item is Record<string, unknown> =>
        item != null && typeof item === "object" && !Array.isArray(item),
    );
    if (objectRows.length === 0) {
      throw new Error("조회 결과가 없습니다.");
    }

    const keys = Array.from(new Set(objectRows.flatMap((row) => Object.keys(row))));
    const preferred = ["date", "value"].filter((key) => keys.includes(key));
    const rest = keys.filter((key) => !preferred.includes(key));
    const header = [...preferred, ...rest];
    const rows = objectRows.slice(0, 10).map((row) => header.map((key) => row[key] ?? null));
    return { header, rows };
  };

  const fetchPreviewData = async () => {
    if (!previewUrl) return;
    setPreviewLoading(true);
    setPreviewError("");
    try {
      const response = await fetch(`/api/collect?url=${encodeURIComponent(previewUrl)}`);
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: unknown;
        error?: string;
        contentType?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "데이터 미리보기에 실패했습니다.");
      }
      const provider = normalizeProvider(resolvedSelectedTarget?.provider ?? selectedProvider ?? "");
      const tabular =
        provider === "datagokr"
          ? buildTabularFromDatagokrXml(payload.data, payload.contentType)
          : provider === "fred"
            ? buildTabularFromFredPreview(payload.data)
          : buildTabularFromJsonPreview(payload.data);
      setPreviewHeader(tabular.header);
      setPreviewRows(tabular.rows);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "데이터 미리보기에 실패했습니다.";
      setPreviewError(message);
      setPreviewHeader([]);
      setPreviewRows([]);
    } finally {
      setPreviewLoading(false);
    }
  };
  const copyPreviewUrl = async () => {
    if (!previewUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(previewUrl);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = previewUrl;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!copied) {
          throw new Error("복사 실패");
        }
      }
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 1500);
    } catch {
      setUrlCopied(false);
    }
  };

  const renderBokTreeNodes = (nodes: BokTreeNode[], depth = 0) => {
    return nodes.flatMap((node) => {
      const expanded = bokExpanded.has(node.stat_code);
      const hasChildren = node.children.length > 0;
      const isSelected = bokSelectedStatCode === node.stat_code;
      const clickableClass = "cursor-pointer hover:border-slate-300";
      const row = (
        <div
          key={node.stat_code}
          className={`rounded-xl border ${
            isSelected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (hasChildren && !node.selectable) {
                toggleBokNode(node.stat_code);
                return;
              }
              if (node.selectable) setBokSelectedStatCode(node.stat_code);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left ${clickableClass}`}
          >
            {hasChildren ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  isSelected ? "border-white/40 text-white" : "border-slate-200 text-slate-600"
                }`}
              >
                {expanded ? "접기" : "펼치기"}
              </span>
            ) : (
              <span className="inline-flex w-10 justify-center text-[10px] text-slate-400">-</span>
            )}
            <span
              className={`flex-1 ${
                node.selectable
                  ? isSelected
                    ? "text-white"
                    : "text-slate-800"
                  : isSelected
                    ? "text-white/85"
                    : "text-slate-500"
              }`}
            >
              <p className="text-sm font-semibold">{node.stat_name}</p>
              <p className="text-[11px] opacity-80">
                코드 {node.stat_code}
                {node.cycle ? ` / 주기 ${node.cycle}` : ""}
                {node.selectable ? " / 선택 가능" : " / 분류"}
              </p>
            </span>
          </button>
          {hasChildren && expanded ? (
            <div className={`space-y-2 border-t px-2 pb-2 pt-2 ${isSelected ? "border-white/20" : "border-slate-100"}`}>
              <div className="space-y-2 pl-3">
                {renderBokTreeNodes(node.children, depth + 1)}
              </div>
            </div>
          ) : null}
        </div>
      );
      return [row];
    });
  };
  const renderKosisTreeNodes = (nodes: KosisStatItem[]) => {
    return nodes.flatMap((node) => {
      const expanded = kosisExpanded.has(node.node_id);
      const selectable = node.srch_yn.trim().toUpperCase() === "Y";
      const canExpand = !selectable;
      const isSelected = kosisSelectedNodeId === node.node_id;
      const childKey = kosisParentKey(node.stat_code, node.vw_cd);
      const childNodes = kosisChildrenByParent.get(childKey) ?? [];
      const loadingChildren = kosisLoadingParentKeys.has(childKey);
      const clickableClass = "cursor-pointer hover:border-slate-300";
      const row = (
        <div
          key={node.node_id}
          className={`rounded-xl border ${
            isSelected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (canExpand) {
                void toggleKosisNode(node);
                return;
              }
              setKosisSelectedNodeId(node.node_id);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left ${clickableClass}`}
          >
            {canExpand ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  isSelected ? "border-white/40 text-white" : "border-slate-200 text-slate-600"
                }`}
              >
                {expanded ? "접기" : "펼치기"}
              </span>
            ) : (
              <span className="inline-flex w-10 justify-center text-[10px] text-slate-400">-</span>
            )}
            <span
              className={`flex-1 ${
                selectable
                  ? isSelected
                    ? "text-white"
                    : "text-slate-800"
                  : isSelected
                    ? "text-white/85"
                    : "text-slate-500"
              }`}
            >
              <p className="text-sm font-semibold">{kosisDisplayLabel(node)}</p>
              <p className="text-[11px] opacity-80">
                코드 {node.stat_code}
                {node.vw_cd ? ` / 뷰 ${node.vw_cd}` : ""}
                {selectable ? " / 선택 가능" : " / 분류"}
              </p>
            </span>
          </button>
          {canExpand && expanded ? (
            <div
              className={`space-y-2 border-t px-2 pb-2 pt-2 ${
                isSelected ? "border-white/20" : "border-slate-100"
              }`}
            >
              <div className="space-y-2 pl-3">
                {loadingChildren ? (
                  <p className="px-2 py-2 text-xs text-slate-500">하위 항목을 불러오는 중입니다...</p>
                ) : childNodes.length > 0 ? (
                  renderKosisTreeNodes(childNodes)
                ) : (
                  <p className="px-2 py-2 text-xs text-slate-500">하위 항목이 없습니다.</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      );
      return [row];
    });
  };
  const renderDatagokrTreeNodes = (nodes: DatagokrTreeNode[]) => {
    return nodes.flatMap((node) => {
      const expanded = datagokrExpanded.has(node.stat_code);
      const hasChildren = node.children.length > 0;
      const isSelected = datagokrSelectedStatCode === node.stat_code;
      const clickableClass = "cursor-pointer hover:border-slate-300";
      const row = (
        <div
          key={node.stat_code}
          className={`rounded-xl border ${
            isSelected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (hasChildren && !node.selectable) {
                toggleDatagokrNode(node.stat_code);
                return;
              }
              if (node.selectable) setDatagokrSelectedStatCode(node.stat_code);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left ${clickableClass}`}
          >
            {hasChildren ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  isSelected ? "border-white/40 text-white" : "border-slate-200 text-slate-600"
                }`}
              >
                {expanded ? "접기" : "펼치기"}
              </span>
            ) : (
              <span className="inline-flex w-10 justify-center text-[10px] text-slate-400">-</span>
            )}
            <span
              className={`flex-1 ${
                node.selectable
                  ? isSelected
                    ? "text-white"
                    : "text-slate-800"
                  : isSelected
                    ? "text-white/85"
                    : "text-slate-500"
              }`}
            >
              <p className="text-sm font-semibold">{node.stat_name}</p>
              <p className="text-[11px] opacity-80">
                코드 {node.stat_code}
                {node.org_name ? ` / 기관 ${node.org_name}` : ""}
                {node.selectable ? " / 선택 가능" : " / 분류"}
              </p>
            </span>
          </button>
          {hasChildren && expanded ? (
            <div
              className={`space-y-2 border-t px-2 pb-2 pt-2 ${
                isSelected ? "border-white/20" : "border-slate-100"
              }`}
            >
              <div className="space-y-2 pl-3">{renderDatagokrTreeNodes(node.children)}</div>
            </div>
          ) : null}
        </div>
      );
      return [row];
    });
  };
  const renderFredTreeNodes = (nodes: FredTreeNode[]) => {
    return nodes.flatMap((node) => {
      const nodeId = node.node_id;
      const expanded = fredExpanded.has(nodeId);
      const isSelected = fredSelectedNodeId === nodeId;
      const clickableClass = "cursor-pointer hover:border-slate-300";
      // FRED의 category leaf_yn='Y'는 "하위 카테고리 없음" 의미일 수 있고,
      // 실제 SERIES 자식은 존재할 수 있으므로 확장 가능 여부는 selectable 여부로만 판단합니다.
      const canExpand = !node.selectable;
      const loadingChildren = fredLoadingParentKeys.has(nodeId);
      const children = fredChildrenByParent[nodeId] ?? [];
      const row = (
        <div
          key={nodeId}
          className={`rounded-xl border ${
            isSelected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (node.selectable) {
                setFredSelectedNodeId(nodeId);
                setFredSelectedStat(node);
                return;
              }
              if (canExpand) void toggleFredNode(node);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left ${clickableClass}`}
          >
            {canExpand ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  isSelected ? "border-white/40 text-white" : "border-slate-200 text-slate-600"
                }`}
              >
                {expanded ? "접기" : "펼치기"}
              </span>
            ) : (
              <span className="inline-flex w-10 justify-center text-[10px] text-slate-400">-</span>
            )}
            <span
              className={`flex-1 ${
                node.selectable
                  ? isSelected
                    ? "text-white"
                    : "text-slate-800"
                  : isSelected
                    ? "text-white/85"
                    : "text-slate-500"
              }`}
            >
              <p className="text-sm font-semibold">{node.node_name}</p>
              <p className="text-[11px] opacity-80">
                {node.stat_code ? `코드 ${node.stat_code}` : "카테고리"}
                {node.cycle ? ` / 주기 ${node.cycle}` : ""}
                {node.selectable ? " / 선택 가능" : " / 분류"}
              </p>
            </span>
          </button>
          {canExpand && expanded ? (
            <div
              className={`space-y-2 border-t px-2 pb-2 pt-2 ${
                isSelected ? "border-white/20" : "border-slate-100"
              }`}
            >
              <div className="space-y-2 pl-3">
                {loadingChildren ? (
                  <p className="px-2 py-2 text-xs text-slate-500">하위 항목을 불러오는 중입니다...</p>
                ) : children.length > 0 ? (
                  renderFredTreeNodes(children)
                ) : (
                  <p className="px-2 py-2 text-xs text-slate-500">하위 항목이 없습니다.</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      );
      return [row];
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/45 p-4">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div className="flex items-center gap-2">
            {step !== "org" && !done ? (
              <button
                onClick={goBack}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                ← 뒤로
              </button>
            ) : null}
            <h3 className="text-base font-semibold text-slate-900">API 등록</h3>
          </div>
          <button
            onClick={handleClose}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            닫기
          </button>
        </div>

        <div className="px-6 pt-4">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {currentStepLabels.map((item, index) => {
              const active = index === activeStepIndex && !done;
              const doneStep = index < activeStepIndex || done;
              return (
                <div
                  key={item.key}
                  className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                    active
                      ? "bg-slate-900 text-white"
                      : doneStep
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {item.label}
                </div>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {done ? (
            <div className="space-y-6 py-8">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">등록이 완료되었습니다</h4>
                <p className="mt-2 text-sm text-slate-600">
                  선택한 조건으로 API 수집 설정이 저장되었습니다.
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p>
                  API 명: <span className="font-semibold">{apiGroupName || "-"}</span>
                </p>
                <p>
                  기관:{" "}
                  {ORG_CATALOG.find((item) => item.provider === selectedProvider)?.name ??
                    "-"}
                </p>
                <p>수집대상: {resolvedSelectedTarget?.title ?? "-"}</p>
                {selectedKosisStat ? (
                  <>
                    <p>통계표 코드: {selectedKosisStat.stat_code}</p>
                    <p>경로: {selectedKosisStat.full_path || "-"}</p>
                  </>
                ) : null}
                {selectedDatagokrStat ? (
                  <>
                    <p>API 코드: {selectedDatagokrStat.stat_code}</p>
                    <p>API 서비스명: {datagokrApiServiceName || "-"}</p>
                    <p>상세 기능명: {datagokrFunctionName || "-"}</p>
                    <p>안내 페이지: {selectedDatagokrStat.list_url || "-"}</p>
                  </>
                ) : null}
                {selectedFredStat ? (
                  <>
                    <p>시리즈 코드(series_id): {selectedFredStat.stat_code || "-"}</p>
                    <p>주기(frequency): {(selectedFredStat.cycle ?? "").toLowerCase() || "-"}</p>
                  </>
                ) : null}
                <p>
                  기간: {startDate || "-"} ~ {endDate || "-"}
                </p>
                <div className="mt-2">
                  <p className="font-semibold">생성 URL:</p>
                  <p className="mt-1 break-all rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                    {previewUrl || "URL을 생성할 수 없습니다."}
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void copyPreviewUrl()}
                  disabled={!previewUrl}
                  className="mr-2 rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                >
                  {urlCopied ? "복사됨" : "URL 복사"}
                </button>
                <button
                  onClick={handleClose}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  닫기
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "org" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">기관을 선택해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  가져오려는 데이터가 속한 기관을 선택하면 다음 단계로 이동합니다.
                </p>
              </div>
              <input
                value={orgQuery}
                onChange={(event) => setOrgQuery(event.target.value)}
                placeholder="기관명으로 검색"
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                {visibleOrgs.map((org) => {
                  const count = providerGroups.get(org.provider) ?? 0;
                  const disabled = count === 0;
                  const selected = selectedProvider === org.provider;
                  return (
                    <button
                      key={org.provider}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setSelectedProvider(org.provider);
                        setSelectedTargetKey(null);
                        setBokSelectedStatCode(null);
                        setKosisSelectedNodeId(null);
                        setTargetQuery("");
                        setBokAppliedQuery("");
                        setBokExpanded(new Set());
                        setKosisAppliedQuery("");
                        setKosisExpanded(new Set());
                        setKosisSearchResults([]);
                        setDatagokrAppliedQuery("");
                        setDatagokrSearchResults([]);
                        setDatagokrSelectedStatCode(null);
                        setDatagokrExpanded(new Set());
                        setDatagokrApiServiceName("");
                        setDatagokrFunctionName("");
                        setFredAppliedQuery("");
                        setFredSearchResults([]);
                        setFredSelectedNodeId(null);
                        setFredSelectedStat(null);
                        setFredExpanded(new Set());
                        setFredRoots([]);
                        setFredChildrenByParent({});
                        setFredLoadedParentKeys(new Set());
                        setFredLoadingParentKeys(new Set());
                        setFredLoadingRoots(false);
                        setFredLoadingSearch(false);
                      }}
                      className={`rounded-2xl border p-4 text-left transition ${
                        selected
                          ? "border-slate-900 bg-slate-900 text-white"
                          : disabled
                            ? "border-slate-200 bg-slate-50 text-slate-400"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                      }`}
                    >
                      <p className="text-base font-semibold">{org.name}</p>
                      <p className="mt-1 text-xs opacity-80">{org.description}</p>
                      <p className="mt-3 text-[11px] opacity-80">
                        {disabled ? "등록 가능한 수집대상이 없습니다." : `${count}개 수집대상`}
                      </p>
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("target")}
                  disabled={!canGoNextFromOrg}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "target" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">가져올 데이터를 선택해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  이름 중심으로 수집대상을 찾고 선택할 수 있습니다.
                </p>
              </div>
              {selectedProvider === "bok" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          runBokSearch();
                        }
                      }}
                      placeholder="통계표명 또는 통계표 코드로 검색"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={runBokSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={resetBokSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {bokAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{bokAppliedQuery}&quot; — 선택 가능한 통계표만 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 분류 카드를 눌러 펼쳐보세요.
                    </p>
                  )}
                  {bokLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      한국은행 통계표 목록을 불러오는 중입니다...
                    </p>
                  ) : bokError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {bokError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {bokAppliedQuery ? (
                        bokSearchResults.length > 0 ? (
                          bokSearchResults.map((item) => {
                            const selected = bokSelectedStatCode === item.stat_code;
                            return (
                              <button
                                key={item.stat_code}
                                type="button"
                                onClick={() => setBokSelectedStatCode(item.stat_code)}
                                className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                }`}
                              >
                                <p className="text-sm font-semibold">{item.stat_name}</p>
                                <p className="text-[11px] opacity-80">
                                  코드 {item.stat_code}
                                  {item.cycle ? ` / 주기 ${item.cycle}` : ""}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : bokTreeRoots.length > 0 ? (
                        renderBokTreeNodes(bokTreeRoots)
                      ) : (
                        <p className="px-2 py-4 text-sm text-slate-500">
                          통계표 목록이 없습니다.
                        </p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 통계표:{" "}
                    {selectedBokStat
                      ? `${selectedBokStat.stat_name} (${selectedBokStat.stat_code})`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "kosis" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          runKosisSearch();
                        }
                      }}
                      placeholder="표시명(번호·이름) 또는 통계표 코드로 검색"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={runKosisSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={resetKosisSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {kosisAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{kosisAppliedQuery}&quot; 결과를 최대 100건까지 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 분류 카드를 누르면 해당 하위 노드만 지연 로딩됩니다.
                    </p>
                  )}
                  {kosisLoading || kosisSearchLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      {kosisSearchLoading
                        ? "통계청 검색 결과를 불러오는 중입니다..."
                        : "통계청 루트 목록을 불러오는 중입니다..."}
                    </p>
                  ) : kosisError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {kosisError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {kosisAppliedQuery ? (
                        kosisSearchResults.length > 0 ? (
                          kosisSearchResults.map((item) => {
                            const selectable = item.srch_yn.trim().toUpperCase() === "Y";
                            const selected = kosisSelectedNodeId === item.node_id;
                            return (
                              <button
                                key={item.node_id}
                                type="button"
                                onClick={() => {
                                  if (selectable) setKosisSelectedNodeId(item.node_id);
                                }}
                                className={`w-full rounded-xl border px-3 py-2 text-left ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                } ${selectable ? "hover:border-slate-300" : "cursor-not-allowed opacity-70"}`}
                              >
                                <p className="text-sm font-semibold">{kosisDisplayLabel(item)}</p>
                                <p className="text-[11px] opacity-80">
                                  코드 {item.stat_code}
                                  {item.vw_cd ? ` / 뷰 ${item.vw_cd}` : ""}
                                  {selectable ? " / 선택 가능" : " / 분류"}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : kosisRootNodes.length > 0 ? (
                        renderKosisTreeNodes(kosisRootNodes)
                      ) : (
                        <p className="px-2 py-4 text-sm text-slate-500">
                          통계청 수집대상 목록이 없습니다.
                        </p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 수집대상:{" "}
                    {selectedKosisStat
                      ? `${kosisDisplayLabel(selectedKosisStat)} (${selectedKosisStat.stat_code})`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "datagokr" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void runDatagokrSearch();
                        }
                      }}
                      placeholder="API명 또는 코드, 기관명으로 검색"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => void runDatagokrSearch()}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={() => void resetDatagokrSearch()}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {datagokrAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{datagokrAppliedQuery}&quot; 결과를 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 분류 카드를 눌러 펼쳐보세요.
                    </p>
                  )}
                  {datagokrLoading ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      공공데이터포털 수집대상을 불러오는 중입니다...
                    </p>
                  ) : datagokrError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {datagokrError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {datagokrAppliedQuery ? (
                        datagokrSearchResults.length > 0 ? (
                          datagokrSearchResults.map((item) => {
                            const selected = datagokrSelectedStatCode === item.stat_code;
                            return (
                              <button
                                key={item.stat_code}
                                type="button"
                                onClick={() => setDatagokrSelectedStatCode(item.stat_code)}
                                className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                }`}
                              >
                                <p className="text-sm font-semibold">{item.stat_name}</p>
                                <p className="text-[11px] opacity-80">
                                  코드 {item.stat_code}
                                  {item.org_name ? ` / 기관 ${item.org_name}` : ""}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : datagokrTreeRoots.length > 0 ? (
                        renderDatagokrTreeNodes(datagokrTreeRoots)
                      ) : (
                        <p className="px-2 py-2 text-sm text-slate-500">수집대상 목록이 없습니다.</p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 수집대상:{" "}
                    {selectedDatagokrStat
                      ? `${selectedDatagokrStat.stat_name} (${selectedDatagokrStat.stat_code})`
                      : "없음"}
                  </div>
                </div>
              ) : selectedProvider === "fred" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          runFredSearch();
                        }
                      }}
                      placeholder="시리즈명 또는 시리즈 코드로 검색"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={runFredSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      검색
                    </button>
                    <button
                      type="button"
                      onClick={resetFredSearch}
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      초기화
                    </button>
                  </div>
                  {fredAppliedQuery ? (
                    <p className="text-xs text-slate-500">
                      검색어 &quot;{fredAppliedQuery}&quot; — 선택 가능한 시리즈만 표시합니다.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      기본 상태는 접힘입니다. 카테고리 카드를 눌러 펼쳐보세요.
                    </p>
                  )}
                  {fredLoadingRoots || fredLoadingSearch ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                      FRED 수집대상을 불러오는 중입니다...
                    </p>
                  ) : fredError ? (
                    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-600">
                      {fredError}
                    </p>
                  ) : (
                    <div className="max-h-[42vh] space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                      {fredAppliedQuery ? (
                        fredSearchResults.length > 0 ? (
                          fredSearchResults.map((item) => {
                            const selected = fredSelectedNodeId === item.node_id;
                            return (
                              <button
                                key={item.node_id}
                                type="button"
                                onClick={() => {
                                  setFredSelectedNodeId(item.node_id);
                                  setFredSelectedStat(item);
                                }}
                                className={`w-full rounded-xl border px-3 py-2 text-left hover:border-slate-300 ${
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700"
                                }`}
                              >
                                <p className="text-sm font-semibold">{item.node_name}</p>
                                <p className="text-[11px] opacity-80">
                                  코드 {item.stat_code || "-"}
                                  {item.cycle ? ` / 주기 ${item.cycle}` : ""}
                                </p>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-2 py-2 text-sm text-slate-500">검색 결과가 없습니다.</p>
                        )
                      ) : fredTreeRoots.length > 0 ? (
                        renderFredTreeNodes(fredTreeRoots)
                      ) : (
                        <p className="px-2 py-2 text-sm text-slate-500">수집대상 목록이 없습니다.</p>
                      )}
                    </div>
                  )}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    선택된 시리즈:{" "}
                    {selectedFredStat
                      ? `${selectedFredStat.node_name} (${selectedFredStat.stat_code || "-"}) / 주기 ${
                          selectedFredStat.cycle || "-"
                        }`
                      : "없음"}
                  </div>
                </div>
              ) : (
                <>
                  <input
                    value={targetQuery}
                    onChange={(event) => setTargetQuery(event.target.value)}
                    placeholder="수집대상명으로 검색"
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                  />
                  <div className="max-h-[260px] space-y-2 overflow-y-auto pr-1">
                    {targetItems.map((item) => {
                      const selected = selectedTargetKey === item.key;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => setSelectedTargetKey(item.key)}
                          className={`w-full rounded-2xl border p-4 text-left transition ${
                            selected
                              ? "border-slate-900 bg-slate-900 text-white"
                              : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                          }`}
                        >
                          <p className="text-base font-semibold">{item.title}</p>
                          <p className="mt-1 text-xs opacity-80">{item.description}</p>
                          <div className="mt-3 flex flex-wrap gap-2 text-[11px] opacity-80">
                            <span className="rounded-full border px-2 py-0.5">{item.typeLabel}</span>
                            <span className="rounded-full border px-2 py-0.5">{item.statusLabel}</span>
                            <span className="rounded-full border px-2 py-0.5">{item.codeHint}</span>
                          </div>
                        </button>
                      );
                    })}
                    {targetItems.length === 0 ? (
                      <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                        선택 가능한 수집대상이 없습니다.
                      </p>
                    ) : null}
                  </div>
                </>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() =>
                    setStep(
                      selectedProvider === "kosis"
                        ? "kosisUserStats"
                        : selectedProvider === "datagokr"
                          ? "datagokrSpec"
                        : selectedProvider === "fred"
                          ? "period"
                        : "period",
                    )
                  }
                  disabled={!canGoNextFromTarget}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "kosisUserStats" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">userStatsId를 입력해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  통계청(KOSIS)에서 활용신청한 사용자 등록 통계표 ID가 필요합니다.
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                <p>선택한 통계표에 대해 아직 활용신청을 하지 않았다면 먼저 신청이 필요합니다.</p>
                <p className="mt-2">
                  KOSIS 공유서비스 &gt; 개발 가이드 &gt; 통계자료 &gt; URL 생성 &gt; 자료등록
                  &gt; 통계표명 또는 통계표ID 작성
                </p>
                <a
                  href="https://kosis.kr/openapi/"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  KOSIS OpenAPI 바로가기
                </a>
              </div>
              <label className="space-y-2 text-sm text-slate-700">
                userStatsId
                <input
                  value={kosisUserStatsId}
                  onChange={(event) => setKosisUserStatsId(event.target.value)}
                  placeholder="예: openapi/101/DT_1B040A3/2/1/20240101000000"
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                />
              </label>
              {kosisUserStatsError ? (
                <p className="text-xs text-rose-600">{kosisUserStatsError}</p>
              ) : null}
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("period")}
                  disabled={!canGoNextFromKosisUserStats}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}
          {!done && step === "datagokrSpec" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">
                  API 서비스명과 상세 기능명을 입력해주세요
                </h4>
                <p className="mt-2 text-sm text-slate-600">
                  데이터공공포털에서 활용신청한 API 서비스명과 상세 기능명이 필요합니다.
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                <p>선택한 통계표에 대해 아직 활용신청을 하지 않았다면 먼저 신청이 필요합니다.</p>
                <p className="mt-2">
                  데이터공공포털 &gt; 활용신청 &gt; API서비스명 &amp; 상세 기능명 작성
                </p>
                {selectedDatagokrStat?.list_url ? (
                  <a
                    href={selectedDatagokrStat.list_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    선택한 API 안내 페이지 바로가기
                  </a>
                ) : null}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-2 text-sm text-slate-700">
                  API 서비스명
                  <input
                    value={datagokrApiServiceName}
                    onChange={(event) => setDatagokrApiServiceName(event.target.value)}
                    placeholder="예: nationtrade"
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                  />
                </label>
                <label className="space-y-2 text-sm text-slate-700">
                  상세 기능명
                  <input
                    value={datagokrFunctionName}
                    onChange={(event) => setDatagokrFunctionName(event.target.value)}
                    placeholder="예: getNationtradeList"
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                  />
                </label>
              </div>
              {datagokrSpecError ? (
                <p className="text-xs text-rose-600">{datagokrSpecError}</p>
              ) : null}
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("period")}
                  disabled={!canGoNextFromDatagokrSpec}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "period" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">
                  {selectedProvider === "kosis" || selectedProvider === "fred"
                    ? "주기와 기간을 입력해주세요"
                    : "수집할 기간을 입력해주세요"}
                </h4>
                <p className="mt-2 text-sm text-slate-600">
                  시작일과 종료일을 선택하면 해당 기간으로 데이터를 등록합니다.
                </p>
              </div>
              {selectedProvider === "kosis" ? (
                <label className="space-y-2 text-sm text-slate-700">
                  주기
                  <select
                    value={kosisCycle}
                    onChange={(event) => setKosisCycle(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                  >
                    <option value="Y">연간</option>
                    <option value="Q">분기</option>
                    <option value="M">월간</option>
                    <option value="D">일간</option>
                  </select>
                </label>
              ) : selectedProvider === "fred" ? (
                <label className="space-y-2 text-sm text-slate-700">
                  주기 (선택 시리즈 기준 고정)
                  <select
                    value={(selectedFredStat?.cycle ?? "M").toUpperCase()}
                    disabled
                    className="w-full cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-100 px-4 py-3 text-slate-600"
                  >
                    <option value="A">연간 (A)</option>
                    <option value="Q">분기 (Q)</option>
                    <option value="M">월간 (M)</option>
                    <option value="W">주간 (W)</option>
                    <option value="D">일간 (D)</option>
                  </select>
                </label>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-2 text-sm text-slate-700">
                  시작일
                  <input
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                  />
                </label>
                <label className="space-y-2 text-sm text-slate-700">
                  종료일
                  <input
                    type="date"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => quickRange(1)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  최근 1개월
                </button>
                <button
                  type="button"
                  onClick={() => quickRange(3)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  최근 3개월
                </button>
                <button
                  type="button"
                  onClick={() => quickRange(6)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  최근 6개월
                </button>
                <button
                  type="button"
                  onClick={() => quickRange(12)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  최근 1년
                </button>
              </div>
              {periodError ? <p className="text-xs text-rose-600">{periodError}</p> : null}
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("extra")}
                  disabled={!canGoNextFromPeriod}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "extra" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">추가 조건이 있나요?</h4>
                <p className="mt-2 text-sm text-slate-600">
                  필요한 경우만 입력하세요. 입력하지 않아도 다음으로 진행할 수 있습니다.
                </p>
              </div>
              <div className="space-y-2">
                {extraParams.map((item, index) => (
                  <div
                    key={`extra-${index}`}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]"
                  >
                    <input
                      value={item.key}
                      onChange={(event) =>
                        setExtraParams((prev) =>
                          prev.map((row, idx) =>
                            idx === index ? { ...row, key: event.target.value } : row,
                          ),
                        )
                      }
                      placeholder="파라미터명"
                      className="rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <input
                      value={item.value}
                      onChange={(event) =>
                        setExtraParams((prev) =>
                          prev.map((row, idx) =>
                            idx === index ? { ...row, value: event.target.value } : row,
                          ),
                        )
                      }
                      placeholder="파라미터값"
                      className="rounded-2xl border border-slate-200 px-4 py-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setExtraParams((prev) =>
                          prev.length === 1 ? [{ key: "", value: "" }] : prev.filter((_, idx) => idx !== index),
                        )
                      }
                      className="rounded-full border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600"
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setExtraParams((prev) => [...prev, { key: "", value: "" }])}
                className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                + 파라미터 추가
              </button>
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("name")}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "name" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">API 명을 입력해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  입력한 API 명은 등록 후 그룹명으로 저장됩니다.
                </p>
              </div>
              <label className="space-y-2 text-sm text-slate-700">
                API 명
                <input
                  value={apiGroupName}
                  onChange={(event) => setApiGroupName(event.target.value)}
                  maxLength={120}
                  placeholder="예: 한국은행_본원통화_월별수집"
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                />
              </label>
              {apiGroupNameError ? (
                <p className="text-xs text-rose-600">{apiGroupNameError}</p>
              ) : (
                <p className="text-xs text-slate-500">최대 120자</p>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() => setStep("confirm")}
                  disabled={!canGoNextFromName}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  다음
                </button>
              </div>
            </div>
          ) : null}

          {!done && step === "confirm" ? (
            <div className="space-y-5 py-4">
              <div>
                <h4 className="text-2xl font-bold text-slate-900">등록 내용을 확인해주세요</h4>
                <p className="mt-2 text-sm text-slate-600">
                  아래 내용을 확인한 뒤 등록하기를 눌러주세요.
                </p>
              </div>
              <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p>
                  <span className="font-semibold">API 명:</span> {apiGroupName || "-"}
                </p>
                <p>
                  <span className="font-semibold">기관:</span>{" "}
                  {ORG_CATALOG.find((item) => item.provider === selectedProvider)?.name ?? "-"}
                </p>
                <p>
                  <span className="font-semibold">수집대상:</span> {resolvedSelectedTarget?.title ?? "-"}
                </p>
                {selectedBokStat ? (
                  <>
                    <p>
                      <span className="font-semibold">통계표 코드:</span> {selectedBokStat.stat_code}
                    </p>
                    <p>
                      <span className="font-semibold">주기:</span> {selectedBokStat.cycle || "-"}
                    </p>
                  </>
                ) : null}
                {selectedKosisStat ? (
                  <>
                    <p>
                      <span className="font-semibold">통계표 코드:</span> {selectedKosisStat.stat_code}
                    </p>
                    <p>
                      <span className="font-semibold">표시명:</span> {kosisDisplayLabel(selectedKosisStat)}
                    </p>
                    <p>
                      <span className="font-semibold">userStatsId:</span> {kosisUserStatsId || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">주기:</span> {kosisCycle}
                    </p>
                    <p>
                      <span className="font-semibold">경로:</span> {selectedKosisStat.full_path || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">vw_cd:</span> {selectedKosisStat.vw_cd || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">stat_id:</span> {selectedKosisStat.stat_id || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">send_de:</span> {selectedKosisStat.send_de || "-"}
                    </p>
                  </>
                ) : null}
                {selectedDatagokrStat ? (
                  <>
                    <p>
                      <span className="font-semibold">API 코드:</span> {selectedDatagokrStat.stat_code}
                    </p>
                    <p>
                      <span className="font-semibold">API 서비스명:</span> {datagokrApiServiceName || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">상세 기능명:</span> {datagokrFunctionName || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">안내 페이지:</span> {selectedDatagokrStat.list_url || "-"}
                    </p>
                  </>
                ) : null}
                {selectedFredStat ? (
                  <>
                    <p>
                      <span className="font-semibold">시리즈 코드(series_id):</span>{" "}
                      {selectedFredStat.stat_code || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">주기(frequency):</span>{" "}
                      {(selectedFredStat.cycle ?? "").toLowerCase() || "-"}
                    </p>
                    <p>
                      <span className="font-semibold">시리즈명:</span> {selectedFredStat.node_name}
                    </p>
                  </>
                ) : null}
                <p>
                  <span className="font-semibold">시작일:</span> {startDate || "-"}
                </p>
                <p>
                  <span className="font-semibold">종료일:</span> {endDate || "-"}
                </p>
                <div>
                  <p className="font-semibold">추가 파라미터:</p>
                  {extraParams.some((item) => item.key.trim() && item.value.trim()) ? (
                    <ul className="mt-1 space-y-1 text-xs">
                      {extraParams
                        .filter((item) => item.key.trim() && item.value.trim())
                        .map((item, index) => (
                          <li key={`summary-${index}`}>
                            {item.key} = {item.value}
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-slate-500">없음</p>
                  )}
                </div>
                <div>
                  <p className="font-semibold">생성 URL:</p>
                  <p className="mt-1 break-all rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                    {previewUrl || "URL을 생성할 수 없습니다."}
                  </p>
                  {!((resolvedSelectedTarget?.source.api_key ?? "").trim()) ? (
                    <p className="mt-1 text-[11px] text-amber-700">
                      기관 관리에 등록된 API Key가 없어 호출이 실패할 수 있습니다.
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-900">데이터 미리보기</p>
                  <button
                    type="button"
                    onClick={() => void fetchPreviewData()}
                    disabled={!previewUrl || previewLoading}
                    className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    {previewLoading ? "조회 중..." : "미리보기 조회"}
                  </button>
                </div>
                {previewError ? (
                  <p className="text-xs text-rose-600">{previewError}</p>
                ) : previewHeader.length > 0 ? (
                  <>
                    <div className="max-h-52 overflow-auto rounded-xl border border-slate-200">
                      <table className="min-w-full text-left text-xs">
                        <thead className="bg-slate-50 text-slate-600">
                          <tr>
                            {previewHeader.map((col) => (
                              <th key={col} className="whitespace-nowrap border-b border-slate-200 px-2 py-1.5">
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.map((row, rowIndex) => (
                            <tr key={`preview-row-${rowIndex}`} className="text-slate-700">
                              {previewHeader.map((_, colIndex) => (
                                <td key={`preview-cell-${rowIndex}-${colIndex}`} className="whitespace-nowrap border-b border-slate-100 px-2 py-1.5">
                                  {String(row[colIndex] ?? "")}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-500">
                      미리보기는 최대 10건까지 표시됩니다.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-slate-500">
                    조회 버튼을 눌러 상위 10건 샘플을 확인하세요.
                  </p>
                )}
              </div>
              {submitError ? <p className="text-xs text-rose-600">{submitError}</p> : null}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void copyPreviewUrl()}
                  disabled={!previewUrl}
                  className="mr-2 rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                >
                  {urlCopied ? "복사됨" : "URL 복사"}
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {submitting ? "등록 중..." : "등록하기"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
