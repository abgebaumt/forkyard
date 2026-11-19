/** Rebase tool only; the shared plan logic lives in `app/rebasePlan`. */
import type { RebasePlanRow } from "../../core";
import type { OkPlan } from "../../app/rebasePlan/apply";

/** Rows handed over from the graph's edit mode – only when they hold exactly the plan's commits. */
export function startRows(plan: OkPlan, initial: RebasePlanRow[] | undefined): RebasePlanRow[] {
  if (!initial || initial.length !== plan.rows.length) return plan.rows;
  const shas = new Set(initial.map((row) => row.sha));
  return plan.rows.every((row) => shas.has(row.sha)) ? initial : plan.rows;
}
