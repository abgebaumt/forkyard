import { cn, laneColor } from "./cn";
import { Avatar, RefLabel, type RefLabelProps } from "./Git";
import { t } from "../i18n";

export interface GraphCommit {
  id: string;
  /** Column of the node, 0 is leftmost. */
  lane: number;
  /** IDs of the parents. The first is the main parent, further ones are merge parents. */
  parents: string[];
  kind?: "commit" | "merge" | "wip" | "stash";
  message: string;
  author?: string;
  date?: string;
  sha?: string;
  refs?: RefLabelProps[];
}

const ROW = 28; // tokens.json › size.graph-row
const LANE = 16; // size.lane
const NODE = 5; // half of size.node

const x = (lane: number) => LANE / 2 + lane * LANE;
const y = (row: number) => ROW / 2 + row * ROW;

interface Edge {
  d: string;
  lane: number;
  dashed: boolean;
}

function edges(commits: GraphCommit[]): Edge[] {
  const rowOf = new Map(commits.map((commit, index) => [commit.id, index]));
  const result: Edge[] = [];
  commits.forEach((commit, row) => {
    commit.parents.forEach((parentId, parentIndex) => {
      const parentRow = rowOf.get(parentId);
      const parent = parentRow === undefined ? undefined : commits[parentRow];
      if (parentRow === undefined || !parent) return;
      const [cx, cy, px, py] = [x(commit.lane), y(row), x(parent.lane), y(parentRow)];
      let d: string;
      let lane = commit.lane;
      if (cx === px) {
        d = `M${cx} ${cy}V${py}`;
      } else if (parentIndex > 0) {
        // Merge edge: turn into the merge parent's lane immediately, then vertically.
        d = `M${cx} ${cy}C${px} ${cy} ${px} ${cy} ${px} ${cy + ROW / 2}V${py}`;
        lane = parent.lane;
      } else {
        // Branch-off: stay in the own lane and only turn in shortly before the parent.
        d = `M${cx} ${cy}V${py - ROW / 2}C${cx} ${py} ${cx} ${py} ${px} ${py}`;
      }
      result.push({ d, lane, dashed: commit.kind === "wip" });
    });
  });
  return result;
}

export type GraphColumn = "author" | "date" | "sha";

export interface GraphProps {
  commits: GraphCommit[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Additional columns. Refs, graph and message are always there and the message gets the space. */
  columns?: GraphColumn[];
}

const REFS = 180;

/**
 * Graph as SVG for the design page and small lists. Defines dimensions, colours and
 * states. In the app a canvas draws the same geometry, because SVG
 * is too slow for tens of thousands of rows; the layout (lane) comes from the core.
 */
export function Graph({ commits, selectedId, onSelect, columns = ["author", "date"] }: GraphProps) {
  const lanes = Math.max(...commits.map((commit) => commit.lane)) + 1;
  const graphWidth = lanes * LANE + 8;
  return (
    <div role="grid" aria-label={t("ui.commitGraph")} className="relative text-base">
      <svg
        aria-hidden
        className="pointer-events-none absolute top-0 z-10"
        style={{ left: REFS }}
        width={graphWidth}
        height={commits.length * ROW}
      >
        {edges(commits).map((edge, index) => (
          <path
            key={index}
            d={edge.d}
            fill="none"
            stroke={laneColor(edge.lane)}
            strokeWidth={2}
            strokeDasharray={edge.dashed ? "3 3" : undefined}
          />
        ))}
        {commits.map((commit, row) => {
          const color = laneColor(commit.lane);
          if (commit.kind === "wip") {
            return (
              <circle key={commit.id} cx={x(commit.lane)} cy={y(row)} r={NODE} fill="var(--gc-bg)" stroke={color} strokeWidth={2} strokeDasharray="2 2" />
            );
          }
          if (commit.kind === "merge") {
            return <circle key={commit.id} cx={x(commit.lane)} cy={y(row)} r={NODE - 1.5} fill={color} stroke="var(--gc-bg)" strokeWidth={1.5} />;
          }
          if (commit.kind === "stash") {
            return (
              <rect key={commit.id} x={x(commit.lane) - NODE + 0.5} y={y(row) - NODE + 0.5} width={NODE * 2 - 1} height={NODE * 2 - 1} rx={2} fill="var(--gc-bg)" stroke={color} strokeWidth={2} />
            );
          }
          return <circle key={commit.id} cx={x(commit.lane)} cy={y(row)} r={NODE} fill={color} stroke="var(--gc-bg)" strokeWidth={1.5} />;
        })}
      </svg>
      {commits.map((commit) => {
        const selected = commit.id === selectedId;
        const wip = commit.kind === "wip";
        return (
          <div
            key={commit.id}
            role="row"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect?.(commit.id)}
            className={cn("flex h-graph-row items-center", selected ? "bg-accent-surface" : "hover:bg-surface")}
          >
            <div role="gridcell" className="flex shrink-0 items-center justify-end gap-1 overflow-hidden px-2" style={{ width: REFS }}>
              {commit.refs?.map((ref) => <RefLabel key={`${ref.kind}:${ref.name}`} {...ref} />)}
            </div>
            <div role="gridcell" className="shrink-0" style={{ width: graphWidth }} />
            <div
              role="gridcell"
              title={commit.message}
              className={cn("min-w-40 flex-1 truncate px-2", wip && "text-text-muted italic", commit.kind === "merge" && "text-text-muted")}
            >
              {commit.message}
            </div>
            {columns.includes("author") ? (
              // Narrow: only the avatar, the name is in the tooltip. That keeps the space for the message.
              <div role="gridcell" className="flex w-8 shrink-0 items-center justify-center">
                {commit.author ? (
                  <>
                    <Avatar name={commit.author} size={18} />
                    <span className="sr-only">{commit.author}</span>
                  </>
                ) : null}
              </div>
            ) : null}
            {columns.includes("date") ? (
              <div role="gridcell" className="w-24 shrink-0 truncate px-2 text-text-muted tabular-nums">
                {commit.date}
              </div>
            ) : null}
            {columns.includes("sha") ? (
              <div role="gridcell" className="w-20 shrink-0 px-2 font-mono text-code text-text-muted">
                {commit.sha}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
