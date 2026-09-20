export const topNavRoutes = [
  { path: "/", nameKey: "home" },
  { path: "/library", nameKey: "library" },
  { path: "/catalogue", nameKey: "catalogue" },
  { path: "/downloads", nameKey: "downloads", badge: true },
  { path: "/settings", nameKey: "settings" },
] as const;
