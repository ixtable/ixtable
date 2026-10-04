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
import { defaultLayout } from "./layout";
import { type DrawnRelationship, drawnFrom, handleId, relationshipEdges } from "./relationships";

type SchemaNodeData = { schema: TableSchema; count: number | null; selected: boolean };
export type NodePositions = Record<string, { x: number; y: number }>;
export type { DrawnRelationship };

const NO_POSITIONS: NodePositions = {};

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
 * column (right handle) to a referencing column (left handle) opens the relationship editor.
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
  const computed = useMemo<Node<SchemaNodeData>[]>(() => {
    const layout = defaultLayout(schemas);
    return schemas.map((schema, index) => ({
      id: schema.name,
      type: "table",
      position: positions[schema.name] ?? layout[index],
      data: {
        schema,
        count: objects.find((object) => object.name === schema.name)?.rowCount ?? null,
        selected: schema.name === selected,
      },
    }));
  }, [objects, schemas, selected, positions]);
  const [nodes, setNodes] = useState(computed);
  useEffect(() => setNodes(computed), [computed]);
  const edges = useMemo<Edge[]>(() => relationshipEdges(schemas), [schemas]);
  const connect = (c: Connection) => {
    const drawn = drawnFrom(c, schemas);
    if (drawn) onRelate?.(drawn);
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
