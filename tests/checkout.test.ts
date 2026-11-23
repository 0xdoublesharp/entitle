import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckoutController, appearance, planPrice } from "../web/checkout.ts";
import type {
  CheckoutLoader,
  CheckoutSession,
  CheckoutSdk,
  ElementsCheckout,
  CheckoutActions,
} from "../web/checkout.ts";

const details = (): ElementsCheckout => ({
  uiMode: "elements",
  clientSecret: "cs_fixture_secret",
  publishableKey: "pk_test_fixture",
  stripeAccount: "acct_seller",
  returnUrl: "https://shop.example.test/t/seller?checkout=complete",
});
const session = (): CheckoutSession => ({
  currency: "usd",
  canConfirm: true,
  total: { total: { amount: "$120.00", minorUnitsAmount: 12000 } },
  status: { type: "open" },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const events: string[] = [];
  let change!: (value: CheckoutSession) => void;
  let loadError: (() => void) | undefined;
  const actions: CheckoutActions = {
    getSession: session,
    confirm: async () => ({ type: "success", session: session() }),
  };
  const sdk: CheckoutSdk = {
    on: (event, callback) => {
      assert.equal(event, "change");
      change = callback;
    },
    loadActions: async () => ({ type: "success", actions }),
    createPaymentElement: () => ({
      on: (event: "loaderror", callback: () => void) => {
        assert.equal(event, "loaderror");
        loadError = callback;
      },
      mount: () => {
        events.push("mount");
      },
      destroy: () => {
        events.push("destroy");
      },
    }),
  };
  const loader: CheckoutLoader = async (key, options) => {
    assert.equal(key, "pk_test_fixture");
    assert.deepEqual(options, { stripeAccount: "acct_seller" });
    return {
      initCheckoutElementsSdk: (options) => {
        assert.equal(options.clientSecret, "cs_fixture_secret");
        assert.deepEqual(options.elementsOptions, { appearance });
        assert.deepEqual(options.defaultValues, {
          email: "buyer@example.test",
        });
        return sdk;
      },
    };
  };
  const states: string[] = [];
  const controller = new CheckoutController(loader, (state) =>
    states.push(state.phase),
  );
  const container = {} as HTMLElement;
  return {
    controller,
    actions,
    sdk,
    loader,
    container,
    states,
    events,
    change: (value: CheckoutSession) => change(value),
    loadError: () => {
      assert.ok(loadError, "Payment Element must subscribe to loaderror");
      loadError();
    },
  };
}
test("Checkout initializes the connected seller's Elements, clears the secret, and tracks canonical session totals", async () => {
  const f = fixture(),
    config = details();
  await f.controller.start(config, f.container, "buyer@example.test");
  assert.equal(config.clientSecret, "");
  assert.deepEqual(f.events, ["mount"]);
  assert.equal(f.controller.state.phase, "ready");
  assert.equal(f.controller.state.amount, "$120.00");
  f.change({
    ...session(),
    currency: "jpy",
    total: { total: { amount: "¥1,234", minorUnitsAmount: 1234 } },
    canConfirm: false,
  });
  assert.equal(f.controller.state.amount, "¥1,234");
  assert.equal(f.controller.state.currency, "jpy");
  assert.equal(f.controller.state.canConfirm, false);
  f.controller.dispose();
  f.change(session());
  assert.equal(f.controller.state.phase, "idle");
  assert.deepEqual(f.events, ["mount", "destroy"]);
  f.controller.dispose();
});
test("Confirmation prevents duplicates and distinguishes pending from completed payments without granting access", async () => {
  for (const status of [
    { type: "open" },
    { type: "complete", paymentStatus: "unpaid" },
    { type: "complete", paymentStatus: "paid" },
    { type: "complete", paymentStatus: "no_payment_required" },
  ] as const) {
    const f = fixture(),
      pending = deferred<Awaited<ReturnType<CheckoutActions["confirm"]>>>();
    let confirmations = 0;
    f.actions.confirm = async (options) => {
      confirmations++;
      assert.deepEqual(options, {
        returnUrl: details().returnUrl,
        redirect: "if_required",
      });
      return pending.promise;
    };
    await f.controller.confirm();
    await f.controller.start(details(), f.container, "buyer@example.test");
    const first = f.controller.confirm();
    await f.controller.confirm();
    assert.equal(confirmations, 1);
    assert.equal(f.controller.state.phase, "submitting");
    pending.resolve({ type: "success", session: { ...session(), status } });
    await first;
    assert.equal(
      f.controller.state.phase,
      status.type === "complete" && status.paymentStatus !== "unpaid"
        ? "complete"
        : "pending",
    );
    await f.controller.confirm();
    assert.equal(confirmations, 1);
    assert.deepEqual(f.events, ["mount", "destroy"]);
  }
});
test("Payment validation and transport failures remain retryable", async () => {
  const f = fixture();
  await f.controller.start(details(), f.container, "buyer@example.test");
  f.actions.confirm = async () => ({
    type: "error",
    error: { message: "Check your card details." },
  });
  await f.controller.confirm();
  assert.equal(f.controller.state.error, "Check your card details.");
  assert.equal(f.controller.state.phase, "ready");
  f.actions.confirm = async () => {
    throw Error("private provider details");
  };
  await f.controller.confirm();
  assert.equal(
    f.controller.state.error,
    "Payment could not be submitted. Try again.",
  );
  assert.equal(f.controller.state.phase, "ready");
  f.controller.dispose();
});
test("Loader, initialization and action errors can be retried without exposing secrets", async () => {
  for (const failure of [
    "null",
    "reject",
    "init",
    "actions",
    "actions-reject",
  ] as const) {
    const f = fixture();
    const loader: CheckoutLoader = async () => {
      if (failure === "null") return null;
      if (failure === "reject") throw Error("private provider details");
      return {
        initCheckoutElementsSdk: () => {
          if (failure === "init") throw Error("private provider details");
          f.sdk.loadActions = async () => {
            if (failure === "actions-reject")
              throw Error("private provider details");
            return {
              type: "error",
              error: { message: "Session unavailable." },
            };
          };
          return f.sdk;
        },
      };
    };
    const controller = new CheckoutController(loader, () => {}),
      config = details();
    await controller.start(config, f.container, "buyer@example.test");
    assert.equal(controller.state.phase, "error");
    assert.equal(config.clientSecret, "");
    assert.doesNotMatch(controller.state.error, /private|secret/);
    controller.dispose();
  }
});
test("Cancellation erases pending secrets and discards delayed loader, actions, and confirmation results", async () => {
  const f = fixture(),
    loaded = deferred<Awaited<ReturnType<CheckoutLoader>>>();
  const controller = new CheckoutController(
      () => loaded.promise,
      () => {},
    ),
    config = details();
  const start = controller.start(config, f.container, "buyer@example.test");
  controller.dispose();
  assert.equal(config.clientSecret, "");
  loaded.resolve(
    await f.loader(config.publishableKey, {
      ...(config.stripeAccount ? { stripeAccount: config.stripeAccount } : {}),
    }),
  );
  await start;
  assert.equal(controller.state.phase, "idle");
  assert.deepEqual(f.events, []);
  for (const reject of [false, true]) {
    const pending = deferred<Awaited<ReturnType<CheckoutSdk["loadActions"]>>>();
    f.sdk.loadActions = () => pending.promise;
    const start = f.controller.start(
      details(),
      f.container,
      "buyer@example.test",
    );
    await Promise.resolve();
    f.controller.dispose();
    if (reject) pending.reject(Error("late private failure"));
    else pending.resolve({ type: "success", actions: f.actions });
    await start;
    assert.equal(f.controller.state.phase, "idle");
  }
  const g = fixture(),
    confirmation = deferred<Awaited<ReturnType<CheckoutActions["confirm"]>>>();
  g.actions.confirm = () => confirmation.promise;
  await g.controller.start(details(), g.container, "buyer@example.test");
  const submit = g.controller.confirm();
  g.controller.dispose();
  confirmation.resolve({ type: "success", session: session() });
  await submit;
  assert.equal(g.controller.state.phase, "idle");
});
test("Canceled confirmation rejection and unusable sessions cannot enable another payment", async () => {
  const f = fixture(),
    pending = deferred<Awaited<ReturnType<CheckoutActions["confirm"]>>>();
  f.actions.confirm = () => pending.promise;
  await f.controller.start(details(), f.container, "buyer@example.test");
  const submit = f.controller.confirm();
  f.controller.dispose();
  pending.reject(Error("late failure"));
  await submit;
  assert.equal(f.controller.state.phase, "idle");
  const g = fixture();
  g.actions.getSession = () => ({ ...session(), status: { type: "expired" } });
  await g.controller.start(details(), g.container, "buyer@example.test");
  assert.equal(g.controller.state.canConfirm, false);
  await g.controller.confirm();
  assert.equal(g.controller.state.phase, "error");
  assert.match(g.controller.state.error, /checkout session expired/);
  g.controller.dispose();
});

test("Payment iframe loading errors destroy the Element and cannot be overwritten by late actions or callbacks", async () => {
  const f = fixture(),
    pending = deferred<Awaited<ReturnType<CheckoutSdk["loadActions"]>>>();
  f.sdk.loadActions = () => pending.promise;
  const start = f.controller.start(
    details(),
    f.container,
    "buyer@example.test",
  );
  await Promise.resolve();
  f.loadError();
  assert.equal(f.controller.state.phase, "error");
  assert.equal(
    f.controller.state.error,
    "Payment form could not load. Try again.",
  );
  assert.deepEqual(f.events, ["mount", "destroy"]);
  pending.resolve({ type: "success", actions: f.actions });
  await start;
  assert.equal(f.controller.state.phase, "error");
  f.controller.dispose();
  f.loadError();
  assert.equal(f.controller.state.phase, "idle");
  const g = fixture();
  await g.controller.start(details(), g.container, "buyer@example.test");
  g.loadError();
  g.change(session());
  assert.equal(g.controller.state.phase, "error");
  assert.equal(g.controller.state.canConfirm, false);
  const h = fixture();
  await h.controller.start(details(), h.container, "buyer@example.test");
  await h.controller.confirm();
  h.loadError();
  assert.equal(h.controller.state.phase, "pending");
});

test("expired session changes and confirm results enter an error state that stale events cannot restore", async () => {
  const expired: CheckoutSession = {
    ...session(),
    status: { type: "expired" },
  };
  for (const source of ["change", "confirm"]) {
    const f = fixture();
    await f.controller.start(details(), f.container, "buyer@example.test");
    if (source === "change") f.change(expired);
    else {
      f.actions.confirm = async () => ({ type: "success", session: expired });
      await f.controller.confirm();
    }
    assert.equal(f.controller.state.phase, "error");
    assert.match(f.controller.state.error, /checkout session expired/);
    assert.equal(f.controller.state.canConfirm, false);
    assert.deepEqual(f.events, ["mount", "destroy"]);
    f.change(session());
    assert.equal(f.controller.state.phase, "error");
    await f.controller.confirm();
    f.controller.dispose();
  }
});


test("standalone Checkout initializes Stripe without a connected-account option", async () => {
  const f = fixture();
  const config = details();
  delete config.stripeAccount;
  let options: unknown;
  const loader: CheckoutLoader = async (_key, value) => {
    options = value;
    return { initCheckoutElementsSdk: () => f.sdk };
  };
  const controller = new CheckoutController(loader, () => {});
  await controller.start(config, f.container, "buyer@example.test");
  assert.deepEqual(options, {});
  assert.equal(controller.state.phase, "ready");
  controller.dispose();
});

test("plan prices follow Stripe's minor-unit encoding rather than Intl display digits", () => {
  const price = (unit_amount: number, currency: string) =>
    planPrice({ unit_amount, currency, billing_interval: "month" });
  for (const [amount, currency, expected] of [
    [4999, "usd", "$49.99"],
    [1200, "jpy", "¥1,200"],
    [1200, "krw", "₩1,200"],
    [12345, "kwd", "KWD\u00a012.345"],
    [12345, "bhd", "BHD\u00a012.345"],
    [12345, "jod", "JOD\u00a012.345"],
    [12345, "omr", "OMR\u00a012.345"],
    [12345, "tnd", "TND\u00a012.345"],
    // Stripe requires two-decimal amounts for ISK and UGX: 500 is 5 ISK.
    [500, "isk", "ISK\u00a05"],
    [123400, "ISK", "ISK\u00a01,234"],
    [500000, "ugx", "UGX\u00a05,000"],
    // Intl shows no minor units for these, but Stripe still encodes hundredths.
    [50000, "huf", "HUF\u00a0500"],
    [1500000, "idr", "IDR\u00a015,000"],
    [990, "clp", "CLP\u00a0990"],
  ] as const)
    // Intl separates currency codes from amounts with a no-break space.
    assert.equal(price(amount, currency), `${expected} / month`, currency);
});
