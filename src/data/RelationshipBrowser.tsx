import {
  Background,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { Table2 } from "lucide-react";
import { useMemo } from "react";
import "@xyflow/react/dist/style.css";
import type { DbObject, TableSchema } from "../lib/types";

type SchemaNodeData = { schema: TableSchema; count: number | null; selected: boolean };
const handleId = (column: string, direction: "source" | "target") =>
  `${column.toLowerCase().replaceAll(" ", "-")}-${direction}`;

function SchemaNode({ data }: NodeProps<Node<SchemaNodeData>>) {
  return (
    <div className={`flow-table ${data.selected ? "active" : ""}`}>
      <div className="flow-table-head">
        <Table2 />
        <strong>{data.schema.name}</strong>
      </div>
      {data.schema.columns.map((column) => (
        <div className="flow-field" key={column.name}>
          <Handle id={handleId(column.name, "target")} type="target" position={Position.Left} />
          <span>{column.primaryKeyPosition ? "🔑" : "#"}</span>
          {column.name}
          <em>
            {column.primaryKeyPosition
              ? "PK"
              : data.schema.foreignKeys.some((key) => key.fromColumns.includes(column.name))
                ? "FK"
                : ""}
          </em>
          <Handle id={handleId(column.name, "source")} type="source" position={Position.Right} />
        </div>
      ))}
    </div>
  );
}

export function RelationshipBrowser({
  objects,
  schemas,
  selected,
  onSelect,
}: {
  objects: DbObject[];
  schemas: TableSchema[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  const nodeTypes = useMemo(() => ({ table: SchemaNode }), []);
  const nodes = useMemo<Node<SchemaNodeData>[]>(
    () =>
      schemas.map((schema, index) => ({
        id: schema.name,
        type: "table",
        position: { x: 30 + (index % 3) * 300, y: 25 + Math.floor(index / 3) * 190 },
        data: {
          schema,
          count: objects.find((object) => object.name === schema.name)?.rowCount ?? null,
          selected: schema.name === selected,
        },
      })),
    [objects, schemas, selected],
  );
  const edges = useMemo<Edge[]>(
    () =>
      schemas.flatMap((schema) =>
        schema.foreignKeys.map((key) => ({
          id: `${schema.name}-${key.id}`,
          source: key.targetTable,
          sourceHandle: handleId(key.targetColumns[0] ?? "", "source"),
          target: schema.name,
          targetHandle: handleId(key.fromColumns[0] ?? "", "target"),
          label: "1 — ∞",
        })),
      ),
    [schemas],
  );
  return (
    <div className="flow-browser">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.data.schema.name)}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.5}
        maxZoom={1.4}
        nodesConnectable={false}
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
