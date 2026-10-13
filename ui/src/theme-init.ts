// Applied before React renders so the page never flashes the wrong theme (an inline script would break the CSP).
try {
  const saved = localStorage.getItem('edge-theme');
  const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
} catch {}
