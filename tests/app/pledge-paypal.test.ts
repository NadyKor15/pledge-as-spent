import { describe, expect, it } from "vitest";
import { pledgeScriptOptions } from "../../src/ui/pledge-paypal";

describe("PayPal's window for a pledge", () => {
  it("places a hold and offers no Pay in 4 or PayPal Credit", () => {
    const o = pledgeScriptOptions("client-id", "USD", "diapers");
    expect(o).toMatchObject({ clientId: "client-id", intent: "authorize", currency: "USD", commit: true, components: "buttons" });
    expect(o.disableFunding.split(",").sort()).toEqual(["credit", "paylater"]);
  });

  it("keeps one script namespace per need and currency", () => {
    expect(pledgeScriptOptions("c", "EUR", "water").dataNamespace).toBe("paypal_water_EUR");
    expect(pledgeScriptOptions("c", "JPY", "water").dataNamespace).not.toBe(pledgeScriptOptions("c", "EUR", "water").dataNamespace);
  });
});
