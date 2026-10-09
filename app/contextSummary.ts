// Task 71 Stage 2. The plain words of the hint under the prompt box, from
// the plan /api/history-plan returns (lib/historyPlan.ts).

export interface PlanSummary {
  totalTurns: number;
  turnsSent: number;
  turnIdsSent: string[];
  leftOutByChoice: number;
  leftOutByCap: number;
  picturesInHistory: number;
  picturesSent: number;
  estimatedTokens: number;
  sizeWord: string;
  roughSize: string;
  showHint: boolean;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function contextSummary(plan: PlanSummary): string {
  const turns =
    plan.turnsSent === 0
      ? "no earlier turns"
      : plan.turnsSent < plan.totalTurns
        ? `${plan.turnsSent} of ${count(plan.totalTurns, "earlier turn", "earlier turns")}`
        : count(plan.turnsSent, "earlier turn", "earlier turns");
  const parts = [turns];
  if (plan.picturesInHistory > 0) {
    parts.push(
      plan.picturesSent < plan.picturesInHistory
        ? `${plan.picturesSent} of ${count(plan.picturesInHistory, "picture", "pictures")}`
        : count(plan.picturesSent, "picture", "pictures"),
    );
  }
  parts.push(`size: ${plan.sizeWord} (about ${plan.roughSize})`);
  let text = `With this question: ${parts.join(" · ")}`;
  if (plan.leftOutByCap > 0) {
    text +=
      plan.leftOutByCap === 1
        ? " · the oldest turn is left out to fit the size limit"
        : ` · the ${plan.leftOutByCap} oldest turns are left out to fit the size limit`;
  }
  return text;
}
