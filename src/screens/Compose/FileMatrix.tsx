/** "By files": which file goes into which commit, as a matrix file × commit with hunk counts; split files are marked. */
import type { ComposeUnit } from "../../core";
import { laneColor } from "../../ui/cn";
import { t } from "../../i18n";
import { SKIP, matrixOf, type Arrangement } from "./model";

export function FileMatrix({ arrangement, units, onGoto }: { arrangement: Arrangement; units: ComposeUnit[]; onGoto: (unit: string) => void }) {
  const rows = matrixOf(arrangement, units);
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3" data-compose-matrix="">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-medium text-text-muted">{t("wip.compose.file")}</th>
            {arrangement.commits.map((commit, index) => (
              <th key={commit.key} title={commit.title} className="border-b border-border px-2.5 py-1.5 text-center text-xs font-medium whitespace-nowrap text-text-muted">
                {t("wip.compose.commit", { number: index + 1 })}
              </th>
            ))}
            <th className="border-b border-border px-2.5 py-1.5 text-center text-xs font-medium whitespace-nowrap text-text-muted">{t("wip.compose.skip")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path} data-compose-matrix-row={row.path} data-split={row.split ? "" : undefined}>
              <td className="border-b border-border px-2.5 py-1.5 font-mono text-code whitespace-nowrap text-text">
                {row.path}
                {row.split ? <span className="font-sans text-xs text-text-muted"> · {t("wip.compose.split")}</span> : null}
              </td>
              {row.cells.map((cell) => (
                <td key={cell.group} className="border-b border-border px-2.5 py-1.5 text-center">
                  {cell.count > 0 && cell.first ? (
                    <button
                      type="button"
                      data-compose-cell={cell.group === SKIP ? "skip" : String(cell.group)}
                      title={t("wip.compose.cellTip", { count: cell.count })}
                      onClick={() => onGoto(cell.first!)}
                      className={cell.group === SKIP ? "rounded-pill bg-surface-sunken px-2 text-xs font-semibold text-text-muted" : "rounded-pill px-2 text-xs font-semibold text-on-lane"}
                      style={cell.group === SKIP ? undefined : { backgroundColor: laneColor(cell.group) }}
                    >
                      {cell.count}
                    </button>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
