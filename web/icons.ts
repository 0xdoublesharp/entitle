import { h } from "vue";

export const icon = (path: string, className = "ui-icon") =>
  h(
    "svg",
    {
      class: className,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.6,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    [h("path", { d: path })],
  );

export const icons = {
  key: "M14 5a5 5 0 1 1-2 8L5 20H2v-3l7-7a5 5 0 0 1 5-5Z M16 7h.01",
  box: "m3 7 9-5 9 5v10l-9 5-9-5Z m0 0 9 5 9-5 M12 12v10 M7.5 4.5l9 5",
  card: "M3 4h18v16H3Z M3 9h18 M7 15h4",
  invite:
    "M15 20a6 6 0 0 0-12 0 M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M19 8v6 M16 11h6",
  chart: "M4 3v17h17 M8 15v-4 M13 15V7 M18 15V4",
  layers: "m2 7 10-5 10 5-10 5Z M2 12l10 5 10-5 M2 17l10 5 10-5",
  code: "m8 5-6 7 6 7 m8-14 6 7-6 7 M14 3l-4 18",
  arrow: "M4 12h16 m-6-6 6 6-6 6",
  check: "m5 12 4 4 10-10",
  chevron: "m6 9 6 6 6-6",
  plus: "M12 5v14 M5 12h14",
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  compass: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z m-6-4-2 6-6 2 2-6Z",
  upload: "M12 16V3 m-5 5 5-5 5 5 M4 15v6h16v-6",
  ticket: "M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4Z M15 8v1m0 2v2m0 2v1",
  receipt: "M5 3l3 2 4-2 4 2 3-2v18l-3-2-4 2-4-2-3 2Z M9 10h6 M9 14h6",
  flask: "M9 3h6 M10 3v7l-6 9a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3 M8 15h8",
  pulse: "M2 12h5l3-7 4 14 3-7h5",
  webhook:
    "M8 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z M20 12a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z M8 19a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z M6 7v10 M8 6l8 5 M8 18l8-5",
  shield: "M12 2 4 6v5c0 5 3 8 8 11 5-3 8-6 8-11V6Z m-4 10 3 3 5-6",
  download: "M12 3v13 m-5-5 5 5 5-5 M4 16v5h16v-5",
  workspace: "M3 21V8h18v13Z M8 8V4h8v4 M3 13h18 M10 13v3h4v-3",
  book: "M12 5C8 2 5 3 2 4v15c4-2 7-1 10 1 3-2 6-3 10-1V4c-3-1-6-2-10 1Z M12 5v15",
  external: "M14 4h6v6 M20 4l-9 9 M10 5H4v15h15v-6",
  refresh: "M20 10a8 8 0 1 0 0 5 M20 4v6h-6",
  logout: "M10 4H4v16h6 M9 12h12 m-4-4 4 4-4 4",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  filters: "M3 6h18 M3 12h18 M3 18h18 M8 4v4 M16 10v4 M10 16v4",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z m-2 5 6 6",
  up: "M12 19V5 m-5 5 5-5 5 5",
  down: "M12 5v14 m-5-5 5 5 5-5",
  sort: "M8 19V5 m-4 4 4-4 4 4 M16 5v14 m-4-4 4 4 4-4",
  warning: "M12 3 2 20h20Z M12 9v4 M12 16h.01",
  mailCheck: "M21 11V5H3v14h9 M3 6l9 7 9-7 m-6 12 2 2 5-5",
};

export const disclosureLabel = (label: string, leading?: string) => [
  leading && icon(leading),
  h("span", label),
  icon(icons.chevron, "ui-icon disclosure-chevron"),
];
