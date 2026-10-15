import { sendPhotonWorkspaceAlertCard } from "./photon-alert-outbound";
import {
  deliverWorkspaceAlertToPhoton,
  type PhotonAlertCard,
} from "./photon-alert-delivery";
import { readPhotonAlertDeliverySubscription } from "./photon-alert-subscription-store";
import {
  listPendingWorkspaceAlerts,
  finishWorkspaceAlertDelivery,
  readWorkspaceAlertsForFinding,
  removePendingWorkspaceAlert,
  type WorkspaceAlert,
  type WorkspaceAlertStoreClient,
} from "./workspace-alert-store";
import { getWorkspaceMonitor, pauseWorkspaceMonitorAfterUncertainAlert, recordWorkspaceMonitorFailure } from "./workspace-monitor-store";
import type { ClaimedWorkspaceMonitor, WorkspaceMonitor } from "./workspace-monitor-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import type { WorkspaceRunOutcome } from "./workspace-finding-store";

export interface WorkspaceAlertDispatchClients {
  readonly alert?: WorkspaceAlertStoreClient;
  readonly deliver?: typeof deliverWorkspaceAlertToPhoton;
  readonly readSubscription?: typeof readPhotonAlertDeliverySubscription;
  readonly send?: (card: PhotonAlertCard, destination: string) => Promise<unknown>;
}

export async function deliverWorkspaceOutcomeToPhoton(input: {
  clients?: WorkspaceAlertDispatchClients;
  job: ClaimedWorkspaceMonitor;
  outcome: WorkspaceRunOutcome;
}): Promise<void> {
  const finding = input.outcome.finding;
  if (!finding) return;
  const alerts = await readWorkspaceAlertsForFinding(input.job.scope, finding.findingId, input.clients?.alert);
  if (alerts.length === 0) throw new Error("workspace_alert_unavailable");
  const monitor = await getWorkspaceMonitor(input.job.scope, input.job.monitor.monitorId);
  for (const alert of alerts) {
    if (!monitor) {
      await removePendingWorkspaceAlert(input.job.scope, alert.alertId, input.clients?.alert);
      continue;
    }
    await deliverStagedAlert({ alert, clients: input.clients, monitor, scope: input.job.scope });
  }
}

async function deliverStagedAlert(input: {
  alert: WorkspaceAlert;
  clients?: WorkspaceAlertDispatchClients;
  monitor: WorkspaceMonitor;
  now?: Date;
  scope: AuthorizedWorkspaceStoreScope;
}): Promise<void> {
  if (input.monitor.lifecycleState !== "enabled" ||
    input.monitor.configurationRevision !== input.alert.configurationRevision ||
    input.monitor.deliverySubscriptionId !== input.alert.deliverySubscriptionId) {
    await removePendingWorkspaceAlert(input.scope, input.alert.alertId, input.clients?.alert);
    return;
  }
  const readSubscription = input.clients?.readSubscription ?? readPhotonAlertDeliverySubscription;
  const subscription = await readSubscription({
    ownerId: input.scope.ownerId,
    subscriptionId: input.monitor.deliverySubscriptionId,
  });
  const send = input.clients?.send;
  const delivery = await (input.clients?.deliver ?? deliverWorkspaceAlertToPhoton)({
    alert: input.alert,
    alertClient: input.clients?.alert,
    monitor: input.monitor,
    now: input.now,
    pauseMonitor: pauseWorkspaceMonitorAfterUncertainAlert,
    scope: input.scope,
    send: (card: PhotonAlertCard) => send
      ? send(card, subscription.destination) as ReturnType<typeof sendPhotonWorkspaceAlertCard>
      : sendPhotonWorkspaceAlertCard({ card, destination: subscription.destination }),
    subscription,
  });
  if (delivery.state === "delivering") {
    const now = input.now ?? new Date();
    if (now.getTime() - Date.parse(delivery.updatedAt) < 30 * 60_000) return;
    await finishWorkspaceAlertDelivery({ deliveryId: delivery.deliveryId, outcome: "delivery_uncertain",
      failureCode: "photon_acceptance_unknown", now, scope: input.scope }, input.clients?.alert);
    await pauseWorkspaceMonitorAfterUncertainAlert({ expectedRevision: input.monitor.configurationRevision,
      monitorId: input.monitor.monitorId, now, scope: input.scope });
  }
  if (delivery.state === "retryable_failure" && delivery.attempt >= 8) {
    await recordWorkspaceMonitorFailure({ errorCode: "alert_preparation_retries_exhausted", failureThreshold: 1,
      expectedRevision: input.monitor.configurationRevision, monitorId: input.monitor.monitorId, scope: input.scope });
  }
  if ((delivery.state !== "staged" && delivery.state !== "retryable_failure") || delivery.attempt >= 8) {
    await removePendingWorkspaceAlert(input.scope, input.alert.alertId, input.clients?.alert);
  }
}

export async function retryPendingWorkspaceAlertsToPhoton(input: {
  now: Date;
  clients?: WorkspaceAlertDispatchClients;
}): Promise<void> {
  const pending = await listPendingWorkspaceAlerts({ limit: 20, now: input.now }, input.clients?.alert);
  const failures: unknown[] = [];
  for (const { alert, scope } of pending) {
    try {
      const monitor = await getWorkspaceMonitor(scope, alert.monitorId);
      if (!monitor) {
        await removePendingWorkspaceAlert(scope, alert.alertId, input.clients?.alert);
        continue;
      }
      await deliverStagedAlert({ alert, clients: input.clients, monitor, now: input.now, scope });
    } catch (error) {
      // No evaluator runs here. The durable delivery state decides whether a
      // later tick may retry preparation or must hold a possibly accepted send.
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "workspace_alert_retry_failed");
}
