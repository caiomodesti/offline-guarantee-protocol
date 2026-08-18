export type DeadlineUrgency = "normal" | "attention" | "urgent" | "apparently-expired";

export interface ClaimDeadlinePresentation {
  readonly utc: string;
  readonly urgency: DeadlineUrgency;
  readonly message: string;
}

const MAX_DATE_SECONDS = 8_640_000_000_000n;

/**
 * Local-clock presentation only. Eligibility remains an on-chain Solana Clock decision.
 */
export function presentClaimDeadline(deadlineSeconds: bigint, nowMilliseconds: number): ClaimDeadlinePresentation {
  if (deadlineSeconds < 0n || deadlineSeconds > MAX_DATE_SECONDS) throw new Error("claim submission deadline fora do intervalo exibível");
  if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) throw new Error("relógio local inválido");
  const deadlineMilliseconds = deadlineSeconds * 1_000n;
  const remaining = deadlineMilliseconds - BigInt(nowMilliseconds);
  const utc = new Date(Number(deadlineMilliseconds)).toISOString();
  if (remaining < 0n) return { utc, urgency: "apparently-expired", message: "O relógio deste aparelho indica que o prazo passou." };
  if (remaining <= 3_600_000n) return { utc, urgency: "urgent", message: "Menos de 1 hora pelo relógio deste aparelho. Sincronize agora." };
  if (remaining <= 21_600_000n) return { utc, urgency: "attention", message: "Menos de 6 horas pelo relógio deste aparelho." };
  return { utc, urgency: "normal", message: "Prazo de envio ainda não está próximo pelo relógio deste aparelho." };
}
