'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Connection,
  ConnectionMode,
  Controls,
  Edge,
  EdgeChange,
  NodeChange,
  NodeTypes,
  useReactFlow,
} from "reactflow";
import "reactflow/dist/style.css";
import { DataCollectorNode } from "./nodes/DataCollectorNode";
import { DeletableEdge } from "./edges/DeletableEdge";
import type {
  DataCollectorData,
  DataCollectorNode as CollectorNode,
} from "../types";

const parseXmlRows = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("<")) return null;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(trimmed, "text/xml");
    const rowNodes = Array.from(doc.getElementsByTagName("row"));
    const itemNodes =
      rowNodes.length === 0 ? Array.from(doc.getElementsByTagName("item")) : [];
    const nodes = rowNodes.length > 0 ? rowNodes : itemNodes;
    if (nodes.length > 0) {
      const rows = nodes.map((row) => {
        const record: Record<string, unknown> = {};
        Array.from(row.children).forEach((child) => {
          record[child.tagName] = child.textContent ?? "";
        });
        return record;
      });
      return rows;
    }
  } catch {
    return null;
  }
  return null;
};

const normalizeApiPayload = (payload: unknown) => {
  if (payload == null) return null;
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "string") {
    const xmlRows = parseXmlRows(payload);
    if (xmlRows) return xmlRows;
    const trimmed = payload.trim();
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

const nodeTypes: NodeTypes = {
  dataCollector: DataCollectorNode,
  dbSink: DataCollectorNode,
  dataStorage: DataCollectorNode,
};
const edgeTypes = {
  deletable: DeletableEdge,
};

interface WorkflowCanvasProps {
  nodes: CollectorNode[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onEdgeUpdate: (edge: Edge, connection: Connection) => void;
  onDeleteEdge: (edgeId: string) => void;
  onSelectNode: (nodeId: string | null) => void;
  onNodeDoubleClick: (nodeId: string) => void;
  onDropNode: (type: string, position: { x: number; y: number }) => void;
  onPaneClick: () => void;
  onCanvasRef: (node: HTMLDivElement | null) => void;
  selectedNode?: CollectorNode;
  isOutputOpen: boolean;
  onToggleOutput: () => void;
}

export function WorkflowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onEdgeUpdate,
  onDeleteEdge,
  onSelectNode,
  onNodeDoubleClick,
  onDropNode,
  onPaneClick,
  onCanvasRef,
  selectedNode,
  isOutputOpen,
  onToggleOutput,
}: WorkflowCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
  const outputRef = useRef<HTMLDivElement | null>(null);
  const [outputHeight, setOutputHeight] = useState(0);
  const edgesWithActions = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: "deletable",
        data: {
          ...(edge.data ?? {}),
          onDeleteEdge,
        },
      })),
    [edges, onDeleteEdge],
  );

  useEffect(() => {
    if (!isOutputOpen) {
      setOutputHeight(0);
      return;
    }

    const node = outputRef.current;
    if (!node) return;

    const updateHeight = () => {
      setOutputHeight(node.getBoundingClientRect().height);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isOutputOpen, selectedNode]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/reactflow");
      if (!type) return;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      onDropNode(type, position);
    },
    [onDropNode, screenToFlowPosition],
  );

  return (
    <div
      ref={onCanvasRef}
      className="relative h-[calc(100vh-320px)] min-h-[520px] w-full rounded-3xl border border-slate-200 bg-white/90 shadow-sm"
    >
      <ReactFlow
        nodes={nodes}
        edges={edgesWithActions}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeUpdate={onEdgeUpdate}
        nodesConnectable
        connectionMode={ConnectionMode.Loose}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        edgesUpdatable
        fitView
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onNodeDoubleClick={(_, node) => onNodeDoubleClick(node.id)}
        onPaneClick={onPaneClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        style={{ paddingBottom: outputHeight }}
      >
        <Background gap={16} />
        <Controls style={{ bottom: outputHeight + 16 }} />
      </ReactFlow>
      <button
        type="button"
        onClick={onToggleOutput}
        className="absolute right-4 rounded-full border border-slate-200 bg-white/90 px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-white"
        style={{ bottom: outputHeight + 16 }}
      >
        {isOutputOpen ? "▼" : "▲"}
      </button>
      {isOutputOpen && (
        <div
          ref={outputRef}
          className="absolute inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-5 py-4 text-xs text-slate-600"
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">Output</p>
            <span className="text-xs text-slate-500">
              {selectedNode ? selectedNode.data.label : "노드를 선택하세요"}
            </span>
          </div>
          <div className="mt-3">
            {!selectedNode ? (
              <span className="text-slate-400">선택된 노드가 없습니다.</span>
            ) : selectedNode.data.status !== "success" ? (
              <span className="text-slate-400">
                실행 성공 후 출력이 표시됩니다.
              </span>
            ) : selectedNode.data.kind === "excel" ? (
              selectedNode.data.excelPreview?.rows?.length ? (
                <div className="max-h-40 overflow-auto rounded-xl border border-slate-200">
                  <table className="w-full border-collapse text-[11px]">
                    {selectedNode.data.excelPreview.header ? (
                      <thead className="bg-slate-100 text-slate-700">
                        <tr>
                          {selectedNode.data.excelPreview.header.map(
                            (cell, cellIndex) => (
                              <th
                                key={`output-header-${cellIndex}`}
                                className="whitespace-nowrap border border-slate-200 px-2 py-1 text-left font-semibold"
                              >
                                {cell ?? ""}
                              </th>
                            ),
                          )}
                        </tr>
                      </thead>
                    ) : null}
                    <tbody>
                      {selectedNode.data.excelPreview.rows.map(
                        (row, rowIndex) => (
                          <tr key={`output-row-${rowIndex}`} className="bg-white">
                            {row.map((cell, cellIndex) => (
                              <td
                                key={`output-cell-${rowIndex}-${cellIndex}`}
                                className="whitespace-nowrap border border-slate-200 px-2 py-1"
                              >
                                {cell ?? ""}
                              </td>
                            ))}
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <span className="text-slate-400">
                  출력할 엑셀 데이터가 없습니다.
                </span>
              )
            ) : selectedNode.data.kind === "db" &&
              selectedNode.data.dbQueryRows?.length ? (
              <div className="max-h-40 overflow-auto rounded-xl border border-slate-200">
                <table className="w-full border-collapse text-[11px]">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>
                      {Object.keys((selectedNode.data.dbQueryRows ?? [])[0] ?? {}).map(
                        (key) => (
                          <th
                            key={key}
                            className="whitespace-nowrap border border-slate-200 px-2 py-1 text-left font-semibold"
                          >
                            {key}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedNode.data.dbQueryRows ?? []).map((row, rowIndex) => (
                      <tr key={`output-db-${rowIndex}`} className="bg-white">
                        {Object.keys((selectedNode.data.dbQueryRows ?? [])[0] ?? {}).map(
                          (key) => (
                            <td
                              key={`output-db-${rowIndex}-${key}`}
                              className="whitespace-nowrap border border-slate-200 px-2 py-1"
                            >
                              {row[key] == null ? "" : String(row[key])}
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : selectedNode.data.kind === "api" ? (
              (() => {
                const table = buildTabularFromApi(selectedNode.data.apiResult);
                if (table.header.length === 0 || table.dataRows.length === 0) {
                  return selectedNode.data.preview ? (
                    <pre className="max-h-40 overflow-auto rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-700">
                      {selectedNode.data.preview}
                    </pre>
                  ) : (
                    <span className="text-slate-400">출력 데이터가 없습니다.</span>
                  );
                }
                return (
                  <div className="max-h-40 overflow-auto rounded-xl border border-slate-200">
                    <table className="w-full border-collapse text-[11px]">
                      <thead className="bg-slate-100 text-slate-700">
                        <tr>
                          {table.header.map((key) => (
                            <th
                              key={`output-api-${key}`}
                              className="whitespace-nowrap border border-slate-200 px-2 py-1 text-left font-semibold"
                            >
                              {key}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {table.dataRows.map((row, rowIndex) => (
                          <tr key={`output-api-${rowIndex}`} className="bg-white">
                            {row.map((cell, cellIndex) => (
                              <td
                                key={`output-api-${rowIndex}-${cellIndex}`}
                                className="whitespace-nowrap border border-slate-200 px-2 py-1"
                              >
                                {cell == null ? "" : String(cell)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()
            ) : selectedNode.data.preview ? (
              <pre className="max-h-40 overflow-auto rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-700">
                {selectedNode.data.preview}
              </pre>
            ) : (
              <span className="text-slate-400">출력 데이터가 없습니다.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
