import type { InputRequest } from "eve/client";

const MAX_APPROVAL_TEXT_LENGTH = 500;
const ORDER_APPROVAL_WINDOW_MS = 5 * 60_000;

const PHOTON_SUPPORTED_COINBASE_APPROVALS = new Set([
  "coinbase_create_order",
  "coinbase_cancel_order",
]);

export type PhotonApprovalDecision = "approve" | "deny";

export interface PhotonApprovalPrompt {
  approvalText: string;
  expiresAtMs: number;
  requestId: string;
  toolName: string;
}

function boundedString(
  value: unknown,
  pattern: RegExp,
  maxLength = 40,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !pattern.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function decimal(value: unknown): string | undefined {
  return boundedString(value, /^(?:0|[1-9]\d*)(?:\.\d+)?$/u, 40);
}

function product(value: unknown): string | undefined {
  return boundedString(
    value,
    /^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/u,
    41,
  );
}

function orderApprovalSummary(input: Record<string, unknown>): string | null {
  const productId = product(input.productId);
  const [baseCurrency, quoteCurrency] = productId?.split("-") ?? [];
  const side = input.side === "BUY" || input.side === "SELL" ? input.side : null;
  const orderType =
    input.type === "market" ||
    input.type === "limit" ||
    input.type === "stop_limit"
      ? input.type
      : null;
  const quoteSize = decimal(input.quoteSize);
  const baseSize = decimal(input.baseSize);
  const limitPrice = decimal(input.limitPrice);
  const stopPrice = decimal(input.stopPrice);
  const stopDirection =
    input.stopDirection === "up" || input.stopDirection === "down"
      ? input.stopDirection
      : null;

  if (!productId || !side || !orderType) {
    return null;
  }

  if (
    orderType === "market" &&
    side === "BUY" &&
    quoteSize &&
    quoteCurrency &&
    baseCurrency
  ) {
    return `Buy ${quoteSize} ${quoteCurrency} of ${baseCurrency}?`;
  }
  if (orderType === "market" && side === "SELL" && baseSize && baseCurrency) {
    return `Sell ${baseSize} ${baseCurrency}?`;
  }
  if (
    (orderType === "limit" || orderType === "stop_limit") &&
    baseSize &&
    baseCurrency &&
    quoteCurrency &&
    limitPrice
  ) {
    const stop =
      orderType === "stop_limit" && stopPrice && stopDirection
        ? ` after ${stopDirection} stop ${stopPrice}`
        : "";
    if (orderType === "stop_limit" && !stop) return null;
    return `${side === "BUY" ? "Buy" : "Sell"} ${baseSize} ${baseCurrency} at ${limitPrice} ${quoteCurrency}${stop}?`;
  }
  return null;
}

function approvalSummary(request: InputRequest): string {
  if (!isPhotonApprovalSupported(request)) throw new Error("This action cannot be approved from iMessage.");
  if (request.action.toolName === "coinbase_cancel_order") {
    const input = request.action.input;
    const orderId = boundedString(input.order_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu, 36);
    if (!orderId || Object.keys(input).length !== 1) {
      throw new Error("The Coinbase cancellation cannot be rendered as an exact approval.");
    }
    return `Request cancellation of order ${orderId}? Only the remaining open portion can be canceled; filled portions are unaffected.`;
  }
  const summary = orderApprovalSummary(request.action.input);
  if (!summary) throw new Error("The Coinbase order cannot be rendered as an exact approval.");
  return summary;
}

function orderPreviewExpiry(
  input: Record<string, unknown>,
  nowMs: number,
): number {
  const defaultExpiry = nowMs + ORDER_APPROVAL_WINDOW_MS;
  if (typeof input.previewToken !== "string" || input.previewToken.length > 8192) throw new Error("A signed order preview is required.");
  const [encoded] = input.previewToken.split(".");
  if (!encoded) throw new Error("A signed order preview is required.");
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof payload === "object" &&
      payload !== null &&
      Number.isSafeInteger(Reflect.get(payload, "expiresAtMs")) &&
      Reflect.get(payload, "expiresAtMs") > nowMs
    ) {
      return Math.min(defaultExpiry, Reflect.get(payload, "expiresAtMs"));
    }
  } catch {
    throw new Error("The order preview has expired or is invalid.");
  }
  throw new Error("The order preview has expired or is invalid.");
}

export function isPhotonApprovalSupported(request: InputRequest): boolean {
  if (request.kind !== "tool-approval") return false;
  const toolName = request.action.toolName;
  return PHOTON_SUPPORTED_COINBASE_APPROVALS.has(toolName);
}

export function createPhotonApprovalPrompt(
  request: InputRequest,
  nowMs = Date.now(),
): PhotonApprovalPrompt {
  if (request.kind !== "tool-approval") {
    throw new Error("Photon approval prompts require a tool-approval request.");
  }

  const summary = approvalSummary(request);
  if (summary.length > MAX_APPROVAL_TEXT_LENGTH) {
    throw new Error(
      "The approval details are too long for an exact iMessage prompt.",
    );
  }

  return {
    approvalText: summary,
    expiresAtMs: request.action.toolName === "coinbase_cancel_order"
      ? nowMs + ORDER_APPROVAL_WINDOW_MS
      : orderPreviewExpiry(request.action.input, nowMs),
    requestId: request.requestId,
    toolName: request.action.toolName,
  };
}

export function parsePhotonTextDecision(
  text: string,
): PhotonApprovalDecision | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, "")
    .trim();
  if (
    normalized === "yes" ||
    normalized === "approve"
  ) {
    return "approve";
  }
  if (
    normalized === "no" ||
    normalized === "deny" ||
    normalized === "cancel"
  ) {
    return "deny";
  }
  return null;
}

export function isPhotonApprovalAlias(text: string): boolean {
  if (parsePhotonTextDecision(text)) return true;
  const normalized = text.trim().toLowerCase();
  const numericOption = Number(normalized);
  return (
    normalized.length > 0 &&
    Number.isInteger(numericOption) &&
    numericOption > 0
  );
}
