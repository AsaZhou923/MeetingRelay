const route = `${window.location.search} ${window.location.hash}`.toLowerCase();
const isOverlay = /(?:[?&]view=overlay\b|[?&]overlay\b|#overlay\b)/.test(route);

if (isOverlay) {
  await import("./caption-overlay");
} else {
  await import("./main");
}

export {};
