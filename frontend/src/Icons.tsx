// Small inline icon set for toolbars: 24×24 grid, 2px round strokes in currentColor, so it follows light/dark mode.
// Own drawings in the style of common line icon sets; no dependency, no external request.
const PATHS = {
  h1: "M4 6v12M12 6v12M4 12h8M17 10l2.5-1.5V18",
  h2: "M4 6v12M12 6v12M4 12h8M16 10.5a2 2 0 0 1 4 .2c0 2.3-4 3.8-4 7.3h4",
  h3: "M4 6v12M12 6v12M4 12h8M16 9.2a2 2 0 1 1 2 3.3 2.2 2.2 0 1 1-2 3.5",
  bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z",
  italic: "M10 5h8M6 19h8M14 5l-4 14",
  strike: "M5 12h14M16 7.5C15.4 6 13.9 5 12 5c-2.4 0-4 1.3-4 3 0 1.3.9 2.3 2.6 2.9M8 16.5c.6 1.5 2.1 2.5 4 2.5 2.4 0 4-1.3 4-3 0-.6-.2-1.1-.5-1.6",
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  bulletList: "M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01",
  orderedList: "M10 7h10M10 12h10M10 17h10M4 5h1.5v4M4 9h3M4 14.2a1.5 1.5 0 0 1 3 .3c0 1.2-3 1.8-3 3.5h3",
  quote: "M5 17c2.5-1 3.5-3 3.5-6V8H5v4h3.5M14 17c2.5-1 3.5-3 3.5-6V8H14v4h3.5",
  codeBlock: "M4 5h16v14H4zM10 10l-2 2 2 2M14 10l2 2-2 2",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  image: "M4 5h16v14H4zM9 10.5h.01M20 15l-5-5-9 9",
  diagram: "M4 4h7v5H4zM13 15h7v5h-7zM7.5 9v3.5h9V15",
  table: "M4 5h16v14H4zM4 10h16M4 14.5h16M10 5v14",
  rowAdd: "M4 4h16v7H4zM12 14v6M9 17h6",
  colAdd: "M4 4h7v16H4zM14 12h6M17 9v6",
  rowDelete: "M4 4h16v7H4zM9 17h6",
  colDelete: "M4 4h7v16H4zM14 12h6",
  trash: "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 11v5M13.5 11v5",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z",
  fileText: "M7 3h7l4 4v14H7zM14 3v4h4M9.5 12h5M9.5 16h5",
  chevron: "M9 6l6 6-6 6",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16",
  chart: "M3 3v18h18M8 17v-5M13 17V7M18 17v-8",
  user: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  clipboard: "M9 3h6v4H9zM7 5H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M9 12h6M9 16h6",
  pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  external: "M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  share: "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
