/**
 * cutiemail site generator.
 *
 * Renders the repository's OWN markdown (README, docs/*, the ADRs) into a static
 * site, so the published docs and the repo docs are literally the same files. The
 * homepage is bespoke (site/pages/home.html, built to the brand design). Output goes
 * to site/dist/, which Cloudflare Workers serves as static assets.
 *
 * No framework on purpose: a small, readable build for a small, readable project.
 */
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT = join(HERE, 'dist');
const GH = 'https://github.com/jamie-lord/cutiemail';
const GH_BLOB = `${GH}/blob/main/`;
const GH_TREE = `${GH}/tree/main/`;

/* ---------- the docs manifest: source markdown -> site URL, grouped for the sidebar ---------- */
const adrEntries = readdirSync(join(REPO, 'docs/decisions'))
  .filter((f) => /^\d{4}-.*\.md$/.test(f))
  .sort()
  .map((f) => {
    const num = f.slice(0, 4);
    const slug = f.replace(/\.md$/, '');
    // Pull the H1 for a readable title.
    const first = readFileSync(join(REPO, 'docs/decisions', f), 'utf8').split('\n').find((l) => l.startsWith('# '));
    const title = first ? first.replace(/^#\s+\d+\s*[.:-]?\s*/, '').trim() : slug;
    return { src: `docs/decisions/${f}`, url: `/docs/decisions/${slug}/`, title: `${num} · ${title}` };
  });

const NAV = [
  { group: 'Start here', items: [
    { src: 'README.md', url: '/docs/', title: 'Overview' },
    { src: 'docs/DEPLOYMENT.md', url: '/docs/deployment/', title: 'Deploy it for real' },
  ]},
  { group: 'How it works', items: [
    { src: 'docs/ARCHITECTURE.md', url: '/docs/architecture/', title: 'Architecture' },
    { src: 'docs/TESTING.md', url: '/docs/testing/', title: 'How it’s tested' },
    { src: 'docs/PERFORMANCE.md', url: '/docs/performance/', title: 'Performance' },
    { src: 'docs/IMPLEMENTING-A-CONFORMANT-SERVER.md', url: '/docs/conformant-server/', title: 'The conformance suite' },
    { src: 'docs/research/smtp-divergence.md', url: '/docs/smtp-divergence/', title: 'SMTP divergence notes' },
  ]},
  { group: 'Contributing', items: [
    { src: 'CONTRIBUTING.md', url: '/docs/contributing/', title: 'Contributing' },
    { src: 'SECURITY.md', url: '/docs/security/', title: 'Security policy' },
    { src: 'docs/WORKING-AGREEMENT.md', url: '/docs/working-agreement/', title: 'Philosophy' },
    { src: 'docs/BACKLOG.md', url: '/docs/backlog/', title: 'Backlog & declined ideas' },
  ]},
  { group: 'Decisions (ADRs)', items: adrEntries },
];

// Flat lookup: normalized repo-relative source path -> { url, title }.
const bySrc = new Map();
for (const g of NAV) for (const it of g.items) bySrc.set(it.src, it);

/* ---------- markdown ---------- */
const md = new MarkdownIt({ html: false, linkify: false, typographer: true });
md.use(anchor, {
  level: [2, 3, 4],
  // GitHub-compatible slugs (lowercase, punctuation stripped, spaces → hyphens) so the
  // same `#anchor` links in the repo's markdown work identically on GitHub and here.
  slugify: (s) => String(s).trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-'),
  permalink: anchor.permalink.linkInsideHeader({ symbol: '#', placement: 'after', class: 'header-anchor' }),
});
// mermaid fences pass through raw for client-side rendering; other fences render as-is.
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  if ((t.info || '').trim() === 'mermaid') {
    env.hasMermaid = true;
    return `<pre class="mermaid">${md.utils.escapeHtml(t.content)}</pre>\n`;
  }
  return defaultFence(tokens, idx, opts, env, self);
};

/* ---------- internal link rewriting ---------- */
// Resolve a markdown href (relative to its source file) to a site URL or a GitHub link.
function rewriteHref(href, srcPath) {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href; // external, mailto, in-page anchor, absolute
  const [rawPath, hash] = href.split('#');
  if (!rawPath) return href;
  // Resolve relative to the source file's directory, into a repo-root-relative POSIX path.
  const abs = posix.normalize(posix.join(posix.dirname(srcPath), rawPath));
  const known = bySrc.get(abs);
  if (known) return known.url + (hash ? `#${hash}` : '');
  // Not a published page → link to the source on GitHub.
  const isDir = href.endsWith('/') || (!posix.extname(abs) && existsSync(join(REPO, abs)) && !existsSync(join(REPO, `${abs}.md`)));
  const base = isDir ? GH_TREE : GH_BLOB;
  return base + abs + (hash ? `#${hash}` : '');
}

function processLinks(html, srcPath) {
  return html.replace(/href="([^"]*)"/g, (m, href) => `href="${rewriteHref(md.utils.unescapeAll(href), srcPath)}"`);
}
// Wrap tables so wide ones scroll instead of blowing out the layout.
function wrapTables(html) {
  return html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
}

/* ---------- layout ---------- */
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;700;800&family=Nunito:ital,wght@0,400;0,600;0,700;0,800;1,400&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">`;

function head(title, desc) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="cutiemail">
<meta property="og:image" content="https://cuti.email/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="cutiemail: the SQLite of email">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://cuti.email/assets/og.png">
<meta name="theme-color" content="#fff6f0">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${FONTS}
<link rel="stylesheet" href="/styles/site.css">
</head>
<body>`;
}

function nav() {
  return `<header class="nav" id="nav"><div class="nav__inner">
  <a class="brand" href="/" aria-label="cutiemail home"><img src="/assets/mascot-mark.svg" alt=""><span class="brand__word">cutiemail</span></a>
  <nav class="nav__links">
    <a href="/docs/">docs</a>
    <a href="${GH}">github</a>
    <a class="btn btn--primary" href="/#start">get started</a>
  </nav>
</div></header>`;
}

function footer() {
  return `<footer class="footer"><div class="footer__inner">
  <div class="footer__brand"><img src="/assets/mascot-mark.svg" alt="">made with <span style="color:var(--pink)">♥</span> and zero dependencies · MIT © <a href="https://lord.technology">Jamie Lord</a></div>
  <div class="footer__links"><a href="/docs/">docs</a><a href="${GH}">github</a><span class="dom">cuti.email</span></div>
</div></footer>`;
}

const navScript = `<script>
const n=document.getElementById('nav');const on=()=>n.classList.toggle('scrolled',scrollY>4);on();addEventListener('scroll',on,{passive:true});
</script>`;

function mermaidScript() {
  return `<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({startOnLoad:true,securityLevel:'strict',theme:'base',themeVariables:{
  fontFamily:'JetBrains Mono, monospace',primaryColor:'#ffe4ee',primaryBorderColor:'#4a1d33',primaryTextColor:'#4a1d33',
  lineColor:'#4a1d33',secondaryColor:'#fff3cd',tertiaryColor:'#dff3ee',clusterBkg:'#fff6f0',clusterBorder:'#4a1d33',
  edgeLabelBackground:'#fff6f0'}});
</script>`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function sidebar(activeUrl) {
  const groups = NAV.map((g) => {
    const items = g.items.map((it) => `<li><a href="${it.url}"${it.url === activeUrl ? ' class="active"' : ''}>${esc(it.title)}</a></li>`).join('');
    return `<div class="sidebar__group"><p class="sidebar__title">${esc(g.group)}</p><ul>${items}</ul></div>`;
  }).join('');
  // A <details> so small screens can fold the nav away; a script opens it on wide screens.
  return `<details class="sidebar" id="sidebar" open><summary class="sidebar__summary">browse the docs</summary>${groups}</details>`;
}

const sidebarScript = `<script>
const sb=document.getElementById('sidebar');
if(sb&&matchMedia('(max-width: 900px)').matches)sb.removeAttribute('open');
</script>`;

/* ---------- page writers ---------- */
function writePage(outUrl, html) {
  const dir = outUrl === '/' ? OUT : join(OUT, outUrl.replace(/^\/|\/$/g, ''));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
}

function buildHome() {
  const body = readFileSync(join(HERE, 'pages/home.html'), 'utf8');
  const html = `${head('cutiemail: a mail server, built from the byte up', 'The SQLite of email: a tiny, self-contained mail server in TypeScript with zero runtime dependencies, small enough to actually read. Real SMTP send + receive, IMAP4rev2, SPF/DKIM/DMARC, plain-SQLite storage.')}
${nav()}
<main>${body}</main>
${footer()}
${navScript}
</body></html>`;
  writePage('/', html);
}

function buildDoc(item) {
  const srcAbs = join(REPO, item.src);
  if (!existsSync(srcAbs)) { console.warn(`  ! missing ${item.src}`); return; }
  const raw = readFileSync(srcAbs, 'utf8');
  const env = {};
  let content = md.render(raw, env);
  content = wrapTables(processLinks(content, item.src));
  const title = item.title.replace(/^\d+\s·\s/, '');
  const ghLink = GH_BLOB + item.src;
  const doc = `<div class="prose">
<p class="doc-top"><a href="/docs/">docs</a></p>
${content}
<div class="doc-edit"><a href="${ghLink}">Edit this page on GitHub →</a><span>${esc(item.src)}</span></div>
</div>`;
  const html = `${head(`${title} · cutiemail docs`, `cutiemail documentation: ${title}`)}
${nav()}
<div class="docs">${sidebar(item.url)}${doc}</div>
${footer()}
${navScript}
${sidebarScript}
${env.hasMermaid ? mermaidScript() : ''}
</body></html>`;
  writePage(item.url, html);
}

function build404() {
  const html = `${head('Not found · cutiemail', 'Page not found')}
${nav()}
<main class="wrap" style="text-align:center;padding:80px 32px;">
  <img src="/assets/mascot.svg" alt="" width="120" style="opacity:.9">
  <h1 style="font-family:var(--font-display);font-size:40px;margin:20px 0 8px;">404: nothing delivered here</h1>
  <p style="color:var(--mauve);font-size:18px;">That address didn't resolve. Try the <a href="/docs/">docs</a> or head <a href="/">home</a>.</p>
</main>
${footer()}
${navScript}
</body></html>`;
  writeFileSync(join(OUT, '404.html'), html);
}

const FAVICON = readFileSync(join(HERE, 'assets/mascot-mark.svg'), 'utf8');

/* ---------- run ---------- */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(HERE, 'styles'), join(OUT, 'styles'), { recursive: true });
cpSync(join(HERE, 'assets'), join(OUT, 'assets'), { recursive: true });
writeFileSync(join(OUT, 'favicon.svg'), FAVICON);

buildHome();
let count = 0;
for (const g of NAV) for (const it of g.items) { buildDoc(it); count++; }
build404();

console.log(`built: homepage + ${count} docs pages → site/dist`);
