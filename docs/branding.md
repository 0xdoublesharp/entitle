# Branding

Use **Doublesharp Entitle** as the product name and **Entitle** as the short name.
Technical names, example slugs and project directories use `entitle`.
First-party npm packages use `@0xdoublesharp`; the application package is
`@0xdoublesharp/entitle`.

The shared name, tagline, description, and hosted link are defined in
[`packages/shared/site.ts`](../packages/shared/site.ts). Runtime email, checkout,
and package URLs use `PUBLIC_ORIGIN`.

Use [`web/public/favicon.svg`](../web/public/favicon.svg) for both the header
mark and favicon. The double-sharp mark is ivory on a forest-green square.
Adjacent text provides its accessible name; decorative icons stay hidden from
screen readers.

The public site uses forest green, ivory and restrained gold accents. Keep
strong text contrast, visible focus indicators, readable spacing and narrow-screen
stacking. Scope public-page styles so they do not alter seller or buyer workflows.
Keep actions concrete, put optional setup in disclosures, and explain errors where
users can recover. Use real server metrics and verified product claims.

When renaming an example integration, update its package directory, framework
identity, setup constants, test fixtures and build scripts together. Persisted
protocol identifiers require explicit compatibility work, not a copy edit.
