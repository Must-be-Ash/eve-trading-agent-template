import {
  publicApplicationOrigin,
  publicArtifactPageUrl,
} from "#public-app-url";

export const PHOTON_ALERT_APP_PATH = "/eve/v1/photon-alert";
export const PHOTON_WORKSPACE_APP_PATH = "/eve/v1/photon-workspaces";

export const PHOTON_APPROVAL_APP_PATH = "/eve/v1/photon-approval";

const PHOTON_PUBLIC_URL_PATTERN = /https:\/\/[^\s<>"'`)\]}]+/giu;

export interface PhotonArtifactPresentation {
  message: string;
  url: string;
}

export function photonApprovalAppUrl(approvalToken: string): string {
  const url = new URL(PHOTON_APPROVAL_APP_PATH, publicApplicationOrigin());
  url.hash = approvalToken;
  return url.toString();
}

export function photonArtifactPresentation(
  message: string,
): PhotonArtifactPresentation | null {
  const markerMatch = message.match(
    /^[ \t]*ARTIFACT_URL:[ \t]*(https:\/\/\S+)[ \t]*$/imu,
  );
  const markerUrl = markerMatch?.[1]
    ? publicArtifactPageUrl(markerMatch[1])
    : null;
  const publicUrl =
    markerUrl ??
    [...message.matchAll(PHOTON_PUBLIC_URL_PATTERN)]
      .map((match) => publicArtifactPageUrl(match[0]))
      .find((url): url is string => Boolean(url)) ??
    null;
  if (!publicUrl) return null;

  if (!markerUrl || !markerMatch?.[0]) {
    return { message, url: publicUrl };
  }
  const visibleFallback = `Open the artifact:\n${publicUrl}`;
  const matchIndex = markerMatch.index ?? 0;
  return {
    message:
      `${message.slice(0, matchIndex)}${visibleFallback}${message.slice(
        matchIndex + markerMatch[0].length,
      )}`.trim(),
    url: publicUrl,
  };
}

export function photonWorkspaceAppUrl(managerToken: string): string {
  const url = new URL(PHOTON_WORKSPACE_APP_PATH, publicApplicationOrigin());
  url.hash = managerToken;
  return url.toString();
}

export function photonAlertAppUrl(alertToken: string, managerToken?: string): string {
  const url = new URL(PHOTON_ALERT_APP_PATH, publicApplicationOrigin());
  url.hash = managerToken ? `${alertToken}.${managerToken}` : alertToken;
  return url.toString();
}
