// PayPal's script for a pledge, kept apart from the form so its options can be tested without a browser.

/**
 * A hold (intent authorize, committed in PayPal's window), and no "Pay in 4" or "PayPal Credit" there: a pledge is
 * a hold that may be partly captured later, and pay-later or credit offers in that window only confuse it. One
 * namespace per need and currency: with several forms on a page, each provider would tear down the others' buttons.
 */
export function pledgeScriptOptions(clientId: string, currency: string, needId: string) {
  return {
    clientId,
    intent: "authorize",
    currency,
    components: "buttons",
    commit: true,
    disableFunding: "paylater,credit",
    dataNamespace: `paypal_${needId}_${currency}`,
  };
}
