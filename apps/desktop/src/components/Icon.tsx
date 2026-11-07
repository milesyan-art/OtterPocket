const PATHS = {
  vault: 'M12 3l7 4v10l-7 4-7-4V7l7-4zm0 0v18M5 7l7 4 7-4',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  project: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  chevron: 'M9 6l6 6-6 6',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z',
  trash: 'M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  check: 'M5 12l5 5 9-10',
  close: 'M6 6l12 12M18 6L6 18',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  // The three ways to arrange, drawn alike: few shapes, wide gaps. Tidy up (the first Arrange icon):
  // different sizes, edges lined up. Grid: one cell each. Columns: one width, uneven lengths.
  tidy: 'M4 4h6v16H4zM14 4h6v6h-6zM14 14h6v6h-6z',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  columns: 'M4 4h6v11H4zM14 4h6v16h-6z',
  group: 'M3 7V4h3M18 4h3v3M21 17v3h-3M6 20H3v-3M7 8h5v4H7zM12 12h5v4h-5z',
  ungroup: 'M3 4h7v6H3zM14 14h7v6h-7z',
  contrast: 'M12 3a9 9 0 1 0 0 18V3z M12 3a9 9 0 1 1 0 18',
  pin: 'M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  finder: 'M4 5h16v14H4zM4 9h16',
  sidebar: 'M4 5h16v14H4zM9.5 5v14',
  alert: 'M12 3.5l9.5 16.5h-19L12 3.5zM12 10v4.5M12 17.5v.5',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5 4 4 3-3L20 17M15.5 9.5h.01',
  lock: 'M7.5 11V8a4.5 4.5 0 0 1 9 0v3M5.5 11h13v9h-13z',
  laptop: 'M5 5h14v10H5zM3 19h18',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.8v.2',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
