import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient, ApiError, takeLoginToken } from "./api.ts";

test("request headers preserve Headers instances and tuple inputs", async () => {
  const inputs: HeadersInit[] = [
    new Headers({ "X-CSRF-Token": "verified", Accept: "application/zip" }),
    [
      ["X-CSRF-Token", "verified"],
      ["Accept", "application/zip"],
    ],
    { "X-CSRF-Token": "verified", accept: "application/zip" },
  ];
  for (const headers of inputs) {
    let sent: Headers | undefined;
    const client = new ApiClient(async (_input, init) => {
      sent = new Headers(init?.headers);
      return Response.json({ ok: true });
    });
    await client.request("/protected", { method: "POST", headers });
    assert.equal(sent?.get("X-CSRF-Token"), "verified");
    assert.equal(sent?.get("Accept"), "application/zip");
  }
});

test("authenticated mutations send the session CSRF token in a same-origin request", async () => {
  let request: RequestInit | undefined;
  let url: string | undefined;
  const client = new ApiClient(async (input, init) => {
    url = String(input);
    request = init;
    return Response.json({ ok: true });
  });
  client.csrfToken = "session-token";
  await client.post("/auth/logout", {});
  assert.equal(url, "/api/v1/auth/logout");
  assert.equal(request?.credentials, "same-origin");
  assert.equal(request?.mode, "same-origin");
  assert.equal(
    new Headers(request?.headers).get("X-CSRF-Token"),
    "session-token",
  );
  assert.deepEqual(JSON.parse(request?.body as string), {});
});

test("public login requests omit session CSRF and preserve server errors with request IDs", async () => {
  const client = new ApiClient(async (_input, init) => {
    assert.equal(new Headers(init?.headers).has("X-CSRF-Token"), false);
    return Response.json(
      {
        error: {
          code: "rate_limited",
          message: "Try again shortly.",
          requestId: "req-123",
        },
      },
      { status: 429 },
    );
  });
  await assert.rejects(
    client.post("/auth/request", { email: "person@example.com" }, false),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, "Try again shortly.");
      assert.equal(error.status, 429);
      assert.equal(error.requestId, "req-123");
      assert.equal(error.code, "rate_limited");
      return true;
    },
  );
});

test("login secrets are extracted from the fragment and removed before any request", () => {
  const replaced: string[] = [];
  const token = takeLoginToken(
    { hash: "#login=abc%2Bdef", pathname: "/", search: "?from=email" },
    {
      replaceState: (
        _data: unknown,
        _unused: string,
        url?: string | URL | null,
      ) => {
        replaced.push(String(url));
      },
    },
  );
  assert.equal(token, "abc+def");
  assert.deepEqual(replaced, ["/?from=email"]);
});

test("unrelated URL fragments do not become login credentials", () => {
  assert.equal(
    takeLoginToken(
      { hash: "#help", pathname: "/", search: "" },
      {
        replaceState: () => {
          assert.fail("ordinary fragment must remain");
        },
      },
    ),
    null,
  );
});

test("transport failures give a useful message without exposing request bodies", async () => {
  const client = new ApiClient(async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(
    client.post("/auth/consume", { token: "secret" }, false),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message.includes("secret"), false);
      assert.match(error.message, /connection/i);
      return true;
    },
  );
});

test("a login link opened in an existing tab is cleared and awaits explicit confirmation", async () => {
  const { watchLoginTokens } = await import("./api.ts");
  const location = { hash: "", pathname: "/", search: "" };
  const events = new EventTarget();
  const tokens: string[] = [];
  const stop = watchLoginTokens(
    location,
    {
      replaceState: () => {
        location.hash = "";
      },
    },
    events,
    (token) => tokens.push(token),
  );
  assert.deepEqual(tokens, []);
  location.hash = "#login=arrived-after-startup";
  events.dispatchEvent(new Event("hashchange"));
  assert.deepEqual(tokens, ["arrived-after-startup"]);
  assert.equal(location.hash, "");
  stop();
  location.hash = "#login=after-unmount";
  events.dispatchEvent(new Event("hashchange"));
  assert.equal(tokens.length, 1);
});

test("GET responses and empty success responses preserve their public API shape", async () => {
  const client = new ApiClient(async (input, init) => {
    assert.equal(init?.method, undefined);
    assert.equal(new Headers(init?.headers).get("Accept"), "application/json");
    return String(input).endsWith("/empty")
      ? new Response(null, { status: 204 })
      : Response.json({ value: 17 });
  });
  assert.deepEqual(await client.get("/value"), { value: 17 });
  assert.equal(await client.get("/empty"), undefined);
});

test("malformed and incomplete error responses use a safe useful fallback", async () => {
  for (const response of [
    new Response("upstream failed", { status: 502 }),
    Response.json(null, { status: 500 }),
    Response.json({}, { status: 500 }),
    Response.json({ error: {} }, { status: 400 }),
    Response.json({ error: { message: "" } }, { status: 400 }),
  ]) {
    const client = new ApiClient(async () => response);
    await assert.rejects(client.get("/broken"), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(
        error.message,
        "The request could not be completed. Please try again.",
      );
      assert.equal(error.requestId, undefined);
      return true;
    });
  }
});

test("error messages include request references only when present", async () => {
  const { errorMessage } = await import("./api.ts");
  assert.equal(
    errorMessage(new ApiError("Server refused.", 403, "ref-42")),
    "Server refused. Reference: ref-42",
  );
  assert.equal(errorMessage(new ApiError("Offline.")), "Offline.");
  assert.equal(
    errorMessage(new Error("internal implementation detail")),
    "Something went wrong. Please try again.",
  );
});

test("an empty login fragment is still removed and cannot become a usable token", () => {
  const replaced: string[] = [];
  assert.equal(
    takeLoginToken(
      { hash: "#login=", pathname: "/", search: "" },
      {
        replaceState: (
          _data: unknown,
          _unused: string,
          url?: string | URL | null,
        ) => {
          replaced.push(String(url));
        },
      },
    ),
    "",
  );
  assert.deepEqual(replaced, ["/"]);
});
