import { describe, expect, it } from "vitest";
import {
  uniqueUsageResources,
  xApiReadResourcesFromPayload,
  xApiUsageResourceLabel,
  xApiUsageUnitCostUsd,
  xApiUserReadResources,
} from "../src/util/x-api-cost.js";

describe("x-api usage costing", () => {
  it("maps current read prices for resources the bot fetches", () => {
    expect(xApiUsageUnitCostUsd("post_read")).toBe(0.005);
    expect(xApiUsageUnitCostUsd("user_read")).toBe(0.01);
    expect(xApiUsageUnitCostUsd("media_read")).toBe(0.005);
    expect(xApiUsageResourceLabel("post_read")).toBe("Posts read");
  });

  it("extracts billable read resources from tweet payloads", () => {
    const resources = xApiReadResourcesFromPayload({
      data: { id: "tweet-1" },
      includes: {
        tweets: [{ id: "quoted-1" }],
        users: [{ id: "user-1" }, { id: "user-2" }],
        media: [{ media_key: "media-1" }],
      },
    });

    expect(resources).toEqual([
      { resource_type: "post_read", resource_id: "tweet-1", cost_usd: 0.005 },
      { resource_type: "post_read", resource_id: "quoted-1", cost_usd: 0.005 },
      { resource_type: "user_read", resource_id: "user-1", cost_usd: 0.01 },
      { resource_type: "user_read", resource_id: "user-2", cost_usd: 0.01 },
      { resource_type: "media_read", resource_id: "media-1", cost_usd: 0.005 },
    ]);
  });

  it("deduplicates repeated resources in a single payload", () => {
    const resources = xApiReadResourcesFromPayload({
      data: { id: "tweet-1" },
      includes: {
        tweets: [{ id: "tweet-1" }],
        users: [{ id: "user-1" }, { id: "user-1" }],
      },
    });

    expect(resources).toEqual([
      { resource_type: "post_read", resource_id: "tweet-1", cost_usd: 0.005 },
      { resource_type: "user_read", resource_id: "user-1", cost_usd: 0.01 },
    ]);
  });

  it("extracts users returned by username lookup", () => {
    expect(xApiUserReadResources([{ id: "u1" }, {}, { id: "u2" }])).toEqual([
      { resource_type: "user_read", resource_id: "u1", cost_usd: 0.01 },
      { resource_type: "user_read", resource_id: "u2", cost_usd: 0.01 },
    ]);
  });

  it("deduplicates direct usage resources", () => {
    expect(
      uniqueUsageResources([
        { resource_type: "post_read", resource_id: "1", cost_usd: 0.005 },
        { resource_type: "post_read", resource_id: "1", cost_usd: 0.005 },
      ]),
    ).toEqual([{ resource_type: "post_read", resource_id: "1", cost_usd: 0.005 }]);
  });
});
