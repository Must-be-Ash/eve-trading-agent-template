import type { PublicSourceAcquisitionResult, PublicSourceSubscription } from "./public-source-adapter-schema";
import type { PublicSourceAcquisitionStoreClient } from "./public-source-acquisition-store";
import { resolveXPublicStatementRuntimePath } from "./public-source-flags";
import { emitPublicSourceAcquisitionObservations, emitPublicSourceRuntimeObservation, type PublicSourceRuntimeObservationSink } from "./public-source-observability";
import { resolveReviewedPublicSource } from "./public-source-registry";
import { createPublicSourceSubscription, type PublicSourceWorkspaceReference } from "./public-source-workspace-reference";
import { ensurePublicSourceSubscription, projectPublicSourceAcquisition, type PublicSourceProjectionCommit, type PublicSourceSubscriptionStoreClient } from "./public-source-subscription-store";
import { runSharedXPublicStatementAcquisition, type XAcquisitionReceipt, type XPublicStatementRequest, type XPublicStatementResponse, type XRevocableEvidenceOptions } from "./x-public-statement-adapter";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import type { WorkspaceMonitor } from "./workspace-monitor-store";
type PublicSourceMonitor = Pick<
  WorkspaceMonitor,
  | "lifecycleState"
  | "managedBy"
  | "monitorId"
  | "publicSourceSubscriptions"
  | "workspaceId"
>;

type CoordinatorFetch = {
  readonly adapterId: "x-public-statements";
  readonly evidence: XRevocableEvidenceOptions;
  readonly excludeReplies?: boolean;
  readonly firstRunStartAt?: string | null;
  readonly fetchResponse: (request: XPublicStatementRequest) => Promise<XPublicStatementResponse>;
};

export interface PublicSourceCoordinatorResult {
  readonly deliveryAcquisitionId?: string;
  readonly deliveryPending?: boolean;
  readonly acquisition: PublicSourceAcquisitionResult;
  readonly baselineEstablished: boolean;
  readonly projection: PublicSourceProjectionCommit | null;
  readonly reused: boolean;
  readonly subscription: PublicSourceSubscription;
  readonly xReceipt: XAcquisitionReceipt | null;
  readonly workspaceCheckpoint: {
    readonly contentDigest: string;
    readonly watermark: string;
  } | null;
}

export class PublicSourceCoordinatorError extends Error {
  readonly code:
    | "public_source_disabled"
    | "public_source_misconfigured"
    | "public_source_reference_invalid";

  constructor(code: PublicSourceCoordinatorError["code"], diagnostic?: "public_source_route_flags_invalid") {
    super(diagnostic ?? code); this.code = code; this.name = "PublicSourceCoordinatorError";
  }
}

function requireEnabled(
  adapterId: CoordinatorFetch["adapterId"],
  environment: NodeJS.ProcessEnv,
): void {
  const path = resolveXPublicStatementRuntimePath(environment);
  if (path === "public_source_adapter") return;
  throw new PublicSourceCoordinatorError(
    path === "public_source_misconfigured"
      ? "public_source_misconfigured"
      : "public_source_disabled",
    path === "public_source_misconfigured" ? "public_source_route_flags_invalid" : undefined,
  );
}

function requireReference(input: {
  readonly monitor: PublicSourceMonitor;
  readonly sourceId: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
}): PublicSourceWorkspaceReference {
  const reference = input.monitor.publicSourceSubscriptions?.find(
    (candidate) => candidate.sourceId === input.sourceId,
  );
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  if (
    !reference ||
    input.monitor.workspaceId !== input.scope.workspaceId ||
    reference.sourceInstanceId !== reviewed.sourceInstance.sourceInstanceId ||
    reference.adapterDefinitionDigest !== reviewed.adapterDefinition.definitionDigest ||
    reference.sourceConfigurationDigest !== reviewed.sourceInstance.configurationDigest
  ) {
    throw new PublicSourceCoordinatorError("public_source_reference_invalid");
  }
  return reference;
}

function emitWriteCount(input: {
  readonly counter:
    | "public_source_fact_revision_total"
    | "public_source_correction_total"
    | "public_source_retraction_total"
    | "public_source_projection_total";
  readonly count: number;
  readonly operation: "created" | "reused";
  readonly sink?: PublicSourceRuntimeObservationSink;
}): void {
  if (input.count === 0) return;
  emitPublicSourceRuntimeObservation({
    counter: input.counter,
    operation: input.operation,
    value: input.count,
  }, input.sink);
}

export async function coordinatePublicSourceOccurrence(input: {
  readonly clients?: { readonly acquisition?: PublicSourceAcquisitionStoreClient; readonly subscription?: PublicSourceSubscriptionStoreClient };
  readonly deferProjectionAcknowledgement?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch: CoordinatorFetch;
  readonly monitor: PublicSourceMonitor;
  readonly observedAt?: Date;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly sink?: PublicSourceRuntimeObservationSink;
  readonly sourceId: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<PublicSourceCoordinatorResult> {
  const environment = input.environment ?? process.env;
  const window = Object.freeze({
    endAt: input.window.endAt,
    startAt: input.window.startAt,
  });
  requireEnabled(input.fetch.adapterId, environment);
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  if (reviewed.adapterDefinition.adapterId !== input.fetch.adapterId) {
    throw new PublicSourceCoordinatorError("public_source_reference_invalid");
  }
  const reference = requireReference(input);
  const subscription = await ensurePublicSourceSubscription(
    input.scope,
    createPublicSourceSubscription({
      binding: input.monitor.managedBy
        ? {
            bindingRevision: input.monitor.managedBy.bindingRevision,
            packContentDigest: input.monitor.managedBy.packContentDigest,
            packId: input.monitor.managedBy.packId,
            packVersion: input.monitor.managedBy.packVersion,
          }
        : null,
      lifecycleState: input.monitor.lifecycleState === "enabled" ? "active" : "paused",
      monitorId: input.monitor.monitorId,
      reference,
      workspaceId: input.scope.workspaceId,
    }),
    input.clients?.subscription,
  );
  const shared = await runSharedXPublicStatementAcquisition({
    client: input.clients?.acquisition, evidence: input.fetch.evidence,
    excludeReplies: input.fetch.excludeReplies, fetchResponse: input.fetch.fetchResponse,
    firstRunStartAt: input.fetch.firstRunStartAt, sourceId: input.sourceId, window,
  });
  const xReceipt = shared.receipt;
  emitPublicSourceAcquisitionObservations(shared.acquisition, input.sink);
  if (shared.reused) {
    emitPublicSourceRuntimeObservation({
      counter: "public_source_acquisition_reused_total",
    }, input.sink);
  }
  if (shared.commit && !shared.reused) {
    emitWriteCount({ counter: "public_source_fact_revision_total", count: shared.commit.factsCreated, operation: "created", sink: input.sink });
    emitWriteCount({ counter: "public_source_fact_revision_total", count: shared.commit.factsReused, operation: "reused", sink: input.sink });
    emitWriteCount({ counter: "public_source_correction_total", count: shared.commit.correctionsCreated, operation: "created", sink: input.sink });
    emitWriteCount({ counter: "public_source_correction_total", count: shared.commit.correctionsReused, operation: "reused", sink: input.sink });
    emitWriteCount({ counter: "public_source_retraction_total", count: shared.commit.retractionsCreated, operation: "created", sink: input.sink });
    emitWriteCount({ counter: "public_source_retraction_total", count: shared.commit.retractionsReused, operation: "reused", sink: input.sink });
  }

  if (!shared.journal || (shared.acquisition.status !== "complete" && shared.acquisition.status !== "no_change")) {
    return Object.freeze({
      acquisition: shared.acquisition,
      baselineEstablished: shared.baselineEstablished,
      projection: null,
      reused: shared.reused,
      subscription,
      workspaceCheckpoint: null,
      xReceipt,
    });
  }
  const deliveryAcquisition = shared.acquisition;
  const projection = await projectPublicSourceAcquisition({
    acquisition: deliveryAcquisition,
    advanceDeliveryCursor: input.deferProjectionAcknowledgement !== true,
    projectedAt: input.observedAt,
    scope: input.scope,
    subscriptionId: subscription.subscriptionId,
  }, input.clients);
  emitWriteCount({
    counter: "public_source_projection_total",
    count: projection.projectionsCreated + projection.retractionsCreated,
    operation: "created",
    sink: input.sink,
  });
  emitWriteCount({
    counter: "public_source_projection_total",
    count: projection.projectionsReused + projection.retractionsReused,
    operation: "reused",
    sink: input.sink,
  });
  return Object.freeze({
    deliveryAcquisitionId: deliveryAcquisition.acquisitionId,
    deliveryPending: false,
    acquisition: deliveryAcquisition,
    baselineEstablished: deliveryAcquisition.baselineEstablished,
    projection, reused: shared.reused, subscription: projection.subscription,
    workspaceCheckpoint: Object.freeze({contentDigest: deliveryAcquisition.proposedNextCursor!.contentDigest, watermark: deliveryAcquisition.observedAt}),
    xReceipt,
  });
}
