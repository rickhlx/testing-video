// Builds the identical chrome every page wears, so that switching between two
// pages changes the mechanism under test and nothing else.
import { PAGES } from './pages.js';

export function scaffold(slug) {
  const i = PAGES.findIndex((p) => p.slug === slug);
  const page = PAGES[i];
  if (!page) throw new Error(`unknown page slug: ${slug}`);

  document.title = `${page.n} · ${page.title}`;

  const header = document.createElement('header');
  header.className = 'top';
  header.innerHTML = `
    <a class="back" href="/">&larr; matrix</a>
    <span class="idx">${page.n}</span>
    <h1></h1>
    <span class="what"></span>
    <span class="nav"></span>`;
  header.querySelector('h1').textContent = page.title;
  header.querySelector('.what').textContent = page.isolates;

  // Titles contain literal tag names, so attribute values need escaping too.
  const attr = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const nav = header.querySelector('.nav');
  const prev = PAGES[i - 1], next = PAGES[i + 1];
  if (prev) nav.insertAdjacentHTML('beforeend', `<a href="${prev.file}" title="${attr(prev.title)}">&larr; ${prev.n}</a> `);
  if (next) nav.insertAdjacentHTML('beforeend', `<a href="${next.file}" title="${attr(next.title)}">${next.n} &rarr;</a>`);

  const main = document.createElement('main');
  main.className = 'split';
  main.innerHTML = `
    <section>
      <div class="stage"></div>
      <div class="controls"></div>
      <div class="notes"></div>
    </section>
    <aside class="panelmount"></aside>`;

  document.body.append(header, main);

  return {
    stage: main.querySelector('.stage'),
    controls: main.querySelector('.controls'),
    notes: main.querySelector('.notes'),
    panel: main.querySelector('.panelmount'),
  };
}

/** A labelled button, since every page needs a few. */
export function button(controls, label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => onClick(b));
  controls.append(b);
  return b;
}

/** A <select>, used for codec and variant switching. */
export function select(controls, label, options, onChange) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px;color:var(--fg-dim);font-size:13px';
  wrap.append(label);
  const s = document.createElement('select');
  for (const [value, text] of Object.entries(options)) {
    s.append(new Option(text, value));
  }
  s.addEventListener('change', () => onChange(s.value));
  wrap.append(s);
  controls.append(wrap);
  return s;
}

/** Load a vendored script once, resolving when it has executed. */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(el);
  });
}
