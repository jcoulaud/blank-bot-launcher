export const X_API_PRICING_DOC_URL = "https://docs.x.com/x-api/getting-started/pricing";

export const X_API_USAGE_RESOURCE_TYPES = ["post_read", "user_read", "media_read"] as const;

export type XApiUsageResourceType = (typeof X_API_USAGE_RESOURCE_TYPES)[number];

export type XApiUsageResource = {
  resource_type: XApiUsageResourceType;
  resource_id: string;
  cost_usd: number;
};

export type XApiUsageRecorder = (resources: readonly XApiUsageResource[], source: string) => void;

type XApiPayloadLike = {
  data?: { id?: string } | null;
  includes?:
    | {
        tweets?: ReadonlyArray<{ id?: string }>;
        users?: ReadonlyArray<{ id?: string }>;
        media?: ReadonlyArray<{ media_key?: string; url?: string }>;
      }
    | undefined;
};

export function xApiUsageUnitCostUsd(resourceType: XApiUsageResourceType): number {
  switch (resourceType) {
    case "post_read":
      return 0.005;
    case "user_read":
      return 0.01;
    case "media_read":
      return 0.005;
  }
}

export function xApiUsageResourceLabel(resourceType: XApiUsageResourceType): string {
  switch (resourceType) {
    case "post_read":
      return "Posts read";
    case "user_read":
      return "Users read";
    case "media_read":
      return "Media read";
  }
}

export function xApiReadResourcesFromPayload(payload: XApiPayloadLike): XApiUsageResource[] {
  const resources: XApiUsageResource[] = [];
  if (payload.data?.id) {
    resources.push(readResource("post_read", payload.data.id));
  }
  for (const tweet of payload.includes?.tweets ?? []) {
    if (tweet.id) resources.push(readResource("post_read", tweet.id));
  }
  for (const user of payload.includes?.users ?? []) {
    if (user.id) resources.push(readResource("user_read", user.id));
  }
  for (const media of payload.includes?.media ?? []) {
    const id = media.media_key ?? media.url;
    if (id) resources.push(readResource("media_read", id));
  }
  return uniqueUsageResources(resources);
}

export function xApiUserReadResources(users: ReadonlyArray<{ id?: string }>): XApiUsageResource[] {
  return uniqueUsageResources(
    users.flatMap((user) => (user.id ? [readResource("user_read", user.id)] : [])),
  );
}

export function uniqueUsageResources(resources: readonly XApiUsageResource[]): XApiUsageResource[] {
  const byKey = new Map<string, XApiUsageResource>();
  for (const resource of resources) {
    if (!resource.resource_id) continue;
    byKey.set(`${resource.resource_type}:${resource.resource_id}`, resource);
  }
  return [...byKey.values()];
}

function readResource(resourceType: XApiUsageResourceType, resourceId: string): XApiUsageResource {
  return {
    resource_type: resourceType,
    resource_id: resourceId,
    cost_usd: xApiUsageUnitCostUsd(resourceType),
  };
}
