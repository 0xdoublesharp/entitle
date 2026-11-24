const hostname = "entitle.doublesharp.com";
const website = "31ea668e-2065-4976-a188-91e09a13792f";
const collector = "https://umami.apps.doublesharp.com/api/send";

type PageviewBrowser = Pick<Window, "fetch"> & {
  location: Pick<Location, "origin" | "pathname">;
  navigator: Pick<Navigator, "doNotTrack"> & { globalPrivacyControl?: boolean };
  localStorage: Pick<Storage, "getItem">;
};

export async function trackMarketingPageview(
  browser: PageviewBrowser = window,
) {
  const { origin, pathname } = browser.location;
  if (origin !== `https://${hostname}` || !/^\/(?:docs\/?)?$/.test(pathname))
    return;

  const { doNotTrack, globalPrivacyControl } = browser.navigator;
  if (doNotTrack === "1" || doNotTrack === "yes" || globalPrivacyControl)
    return;

  try {
    if (browser.localStorage.getItem("umami.disabled") === "true") return;
    await browser.fetch(collector, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive: true,
      body: JSON.stringify({
        type: "event",
        payload: { website, hostname, url: pathname === "/" ? "/" : "/docs" },
      }),
    });
  } catch {
    // Storage restrictions and collector failures must not affect navigation.
  }
}
