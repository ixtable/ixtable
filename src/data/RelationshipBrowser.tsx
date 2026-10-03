import {
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import "@xyflow/react/dist/style.css";
import type { DbObject, TableSchema } from "../lib/types";

type SchemaNodeData = { schema: TableSchema; count: number | null; selected: boolean };
export type NodePositions = Record<string, { x: number; y: number }>;
/** A relationship drawn on the canvas: `child.column` references `parent.column`. */
export interface DrawnRelationship {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
}

const NO_POSITIONS: NodePositions = {};
const handleId = (index: number, direction: "source" | "target") => `c${index}-${direction}`;
const columnIndex = (handle: string | null | undefined) =>
  Number(handle?.match(/^c(\d+)-/)?.[1] ?? -1);

function SchemaNode({ data }: NodeProps<Node<SchemaNodeData>>) {
  return (
    <div className={`flow-table ${data.selected ? "active" : ""}`}>
      <div className="flow-table-head">
        <Table2 />
        <strong>{data.schema.name}</strong>
      </div>
      {data.schema.columns.map((column, index) => (
        <div className="flow-field" key={column.name}>
          <Handle id={handleId(index, "target")} type="target" position={Position.Left} />
          <span>{column.primaryKeyPosition ? "🔑" : "#"}</span>
          {column.name}
          <em>
            {column.primaryKeyPosition
              ? "PK"
              : data.schema.foreignKeys.some((key) => key.fromColumns.includes(column.name))
                ? "FK"
                : ""}
          </em>
          <Handle id={handleId(index, "source")} type="source" position={Position.Right} />
        </div>
      ))}
    </div>
  );
}

/**
 * Relationship diagram. Node positions persist through `onArrange`; dragging from a referenced
 * column (right handle) to a referencing column (left handle) proposes a foreign key.
 */
export function RelationshipBrowser({
  objects,
  schemas,
  selected,
  onSelect,
  positions = NO_POSITIONS,
  onArrange,
  onRelate,
}: {
  objects: DbObject[];
  schemas: TableSchema[];
  selected: string;
  onSelect: (name: string) => void;
  positions?: NodePositions;
  onArrange?: (positions: NodePositions) => void;
  onRelate?: (relationship: DrawnRelationship) => void;
}) {
  const nodeTypes = useMemo(() => ({ table: SchemaNode }), []);
  const computed = useMemo<Node<SchemaNodeData>[]>(
    () =>
      schemas.map((schema, index) => ({
        id: schema.name,
        type: "table",
        position: positions[schema.name] ?? {
          x: 30 + (index % 3) * 300,
          y: 25 + Math.floor(index / 3) * 190,
        },
        data: {
          schema,
          count: objects.find((object) => object.name === schema.name)?.rowCount ?? null,
          selected: schema.name === selected,
        },
      })),
    [objects, schemas, selected, positions],
  );
  const [nodes, setNodes] = useState(computed);
  useEffect(() => setNodes(computed), [computed]);
  const edges = useMemo<Edge[]>(
    () =>
      schemas.flatMap((schema) =>
        schema.foreignKeys.map((key) => {
          const target = schemas.find((s) => s.name === key.targetTable);
          return {
            id: `${schema.name}-${key.id}`,
            source: key.targetTable,
            sourceHandle: handleId(
              Math.max(0, target?.columns.findIndex((c) => c.name === key.targetColumns[0]) ?? 0),
              "source",
            ),
            target: schema.name,
            targetHandle: handleId(
              Math.max(
                0,
                schema.columns.findIndex((c) => c.name === key.fromColumns[0]),
              ),
              "target",
            ),
            label: "1 — ∞",
          };
        }),
      ),
    [schemas],
  );
  const connect = (c: Connection) => {
    const parent = schemas.find((s) => s.name === c.source);
    const child = schemas.find((s) => s.name === c.target);
    const parentColumn = parent?.columns[columnIndex(c.sourceHandle)]?.name;
    const childColumn = child?.columns[columnIndex(c.targetHandle)]?.name;
    if (parent && child && parentColumn && childColumn)
      onRelate?.({ childTable: child.name, childColumn, parentTable: parent.name, parentColumn });
  };
  return (
    <div className="flow-browser">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes: NodeChange<Node<SchemaNodeData>>[]) =>
          setNodes((current) => applyNodeChanges(changes, current))
        }
        onNodeDragStop={(_, node) =>
          onArrange?.({ ...positions, [node.id]: { x: node.position.x, y: node.position.y } })
        }
        onConnect={connect}
        onNodeClick={(_, node) => onSelect(node.data.schema.name)}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.5}
        maxZoom={1.4}
        nodesConnectable={!!onRelate}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => (node.data.selected ? "#52785d" : "#cdd7ce")}
          maskColor="#f4f6f2bb"
        />
      </ReactFlow>
    </div>
  );
}
