import type { ProposalKind, ToolRisk } from "@bridle/core";

const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function cardFace(
  kind: ProposalKind,
  risk: ToolRisk,
  egress: "none" | "loopback" | "remote",
): { tone: "calm" | "caution" | "danger"; badges: string[] } {
  const tone = risk === "destructive" ? "danger"
    : egress === "remote" || risk === "sync" ? "caution"
      : "calm";
  const badges = [title(kind), title(risk)];
  if (egress === "remote") badges.push("Remote provider");
  else if (egress === "loopback") badges.push("Local server");
  if (risk === "destructive") badges.push("Irreversible");
  return { tone, badges };
}
