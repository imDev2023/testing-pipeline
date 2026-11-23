// Renders content.json into dist/: the front page, one page per resolved ticket and one per document.
// No server, no client-side script; the pages are plain HTML and one stylesheet.
//
//   npm run build

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = join(here, 'dist');
const content = JSON.parse(readFileSync(join(here, 'content.json'), 'utf8'));

// ---- Text ----

const escape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescape = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const MONTHS = 'January February March April May June July August September October November December'.split(' ');
const longDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const shortDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[iso.slice(5, 7) - 1].slice(0, 3)}`;

/** True for text with a run too long to sit on a phone's line unbroken, such as an address or a hash. */
const unbroken = (text) => text.split(/[\s/-]+/).some((run) => run.length > 28);

/** Keeps a hyphenated word such as "on-chain" on one line, for headings, where a break after the hyphen reads badly. */
const whole = (html) =>
  html.replace(/(<[^>]+>)|([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+)/gu, (match, tag, word) => tag ?? `<span class="whole">${word}</span>`);

/** A Markdown renderer that trusts nothing: raw HTML is shown as text and only web links become links. */
function markdown(sections = []) {
  const ids = new Set();
  return new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const text = unescape(html);
        // The same anchors GitHub gives the file, so a link written for the repo lands here too;
        // a decision ("TAX-03: ...") is also reachable by its id alone (`/decisions/#tax-03`).
        const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
        let id = base;
        for (let n = 1; ids.has(id); n++) id = `${base}-${n}`;
        ids.add(id);
        const decision = text.match(/^([A-Z0-9]+-(?:\d{2}|[1-9]\d{2,})): /)?.[1].toLowerCase();
        const alias = decision && !ids.has(decision) ? `<span id="${decision}"></span>` : '';
        if (alias) ids.add(decision);
        if (depth === 2) sections.push({ id, text });
        return `<h${depth} id="${id}">${alias}${whole(html)}</h${depth}>\n`;
      },
      listitem(item) {
        // A numbered item keeps the number it was written with, even when an item before it is not shown.
        const number = item.raw.match(/^\s*(\d+)[.)]\s/);
        return `<li${number ? ` value="${number[1]}"` : ''}>${this.parser.parse(item.tokens, !!item.loose)}</li>\n`;
      },
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        if (!/^(https?:\/\/|\/|#)/.test(href)) return text;
        const attributes = (href.startsWith('http') ? ' rel="noopener"' : '') + (unbroken(unescape(text)) ? ' class="long"' : '');
        return `<a href="${escape(href)}"${attributes}>${text}</a>`;
      },
      codespan({ text }) {
        // A flag such as --check never breaks between its hyphens, and only an address or a hash
        // may break mid-word: a table column must stay as wide as the names in it.
        const flags = /(^|[\s=(])(--?[A-Za-z][\w-]*)/g;
        return `<code${unbroken(text) ? ' class="long"' : ''}>${escape(text).replace(flags, '$1<span class="flag">$2</span>')}</code>`;
      },
      image({ text }) {
        return escape(text);
      },
      html({ text }) {
        return escape(text);
      },
    },
  });
}

const inline = (text) => markdown().parseInline(text);

/** Renders a document body. Its headings start at h2, whatever level the source used. */
function prose(text) {
  const sections = [];
  const marked = markdown(sections);
  const tokens = marked.lexer(text);
  const headings = tokens.filter((token) => token.type === 'heading');
  const shift = Math.min(...headings.map((heading) => heading.depth)) - 2;
  for (const heading of headings) heading.depth = Math.min(heading.depth - shift, 4);
  const html = marked
    .parser(tokens)
    .replace(/<table>[\s\S]*?<\/table>/g, (table) => {
      const columns = table.slice(0, table.indexOf('</tr>')).match(/<th[ >]/g).length;
      return `<div class="table" data-columns="${columns}">${table}</div>`;
    });
  return { html, sections };
}

// ---- Pages ----

const STATE = {
  done: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle class="fill" cx="8" cy="8" r="7.5"/><path class="check" d="m4.7 8.3 2.2 2.2 4.4-4.9"/></svg>',
  'in progress':
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle class="ring" cx="8" cy="8" r="6.75"/><path class="half" d="M8 4a4 4 0 0 1 0 8z"/></svg>',
  next: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle class="ring" cx="8" cy="8" r="6.75"/></svg>',
};

/** Starts a sentence with a capital, unless it starts with code, which is never altered. */
const capital = (text) => (/^\p{Ll}/u.test(text) ? text[0].toUpperCase() + text.slice(1) : text);
const statement = capital(content.statement);
const description = unescape(inline(statement));
const register = content.documents.find((document) => document.path === 'decisions');

function page({ path, title, body, date = '', twin = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:type" content="website">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/geist.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="application/json" href="/content.json">
${twin ? `<link rel="alternate" type="text/markdown" href="${twin}">` : ''}
</head>
<body>
<header class="band top">
<div class="bar">
<a class="name" href="/"${path === '/' ? ' aria-current="page"' : ''}>${escape(content.name)}</a>
${date}
</div>
</header>
<main>
${body}
</main>
</body>
</html>
`;
}

function ticketRow(ticket) {
  const title = whole(escape(ticket.title));
  return `<li>
${STATE[ticket.state]}
${ticket.resolution ? `<a href="/${ticket.number}/">${title}</a>` : `<span>${title}</span>`}
${ticket.closed ? `<time datetime="${ticket.closed.slice(0, 10)}">${shortDate(ticket.closed)}</time>` : ''}
${ticket.decision ? `<p>${inline(capital(ticket.decision))}</p>` : ''}
</li>`;
}

function ticketGroup(name, state) {
  const tickets = content.tickets.filter((ticket) => ticket.state === state);
  if (!tickets.length) return '';
  return `<section class="band">
<h2>${name} <span>${tickets.length}</span></h2>
<ol class="tickets ${state.replace(' ', '-')}">
${tickets.map(ticketRow).join('\n')}
</ol>
</section>`;
}

/** Where a page's Markdown twin lives: /7/ is also /7.md. */
const twinOf = (path) => `${path.slice(0, -1)}.md`;

const titles = new Map([
  ...content.tickets.map((ticket) => [`/${ticket.number}/`, ticket.title]),
  ...content.documents.map((document) => [`/${document.path}/`, document.title]),
]);

function frontPage() {
  return page({
    path: '/',
    title: content.name,
    twin: '/index.md',
    date: `<time datetime="${content.refreshed}">${longDate(content.refreshed)}</time>`,
    body: `<div class="band intro">
<h1 class="col">${whole(inline(statement))}</h1>
</div>
<section class="band">
<h2>Destination</h2>
<div class="prose lead">
${prose(content.destination).html}</div>
</section>
<section class="band">
<h2>${escape(content.rule.name)}</h2>
<div class="col rule">
<p class="lead">${inline(capital(content.rule.text))}</p>
${register ? `<a href="/decisions/">${inline(register.title)}</a>` : ''}
</div>
</section>
${ticketGroup('Done', 'done')}
${ticketGroup('In progress', 'in progress')}
${ticketGroup('Next', 'next')}
<section class="band" id="pipeline">
<h2>Found in Pipeline <span>${content.pipeline.length}</span></h2>
<ul class="found">
${content.pipeline
  .map(({ finding, from }) => `<li>\n<p>${inline(finding)}</p>\n<a href="${from}">${inline(titles.get(from))}</a>\n</li>`)
  .join('\n')}
</ul>
</section>`,
  });
}

function documentPage({ path, title, lead = '', date = '', body }) {
  const { html, sections } = prose(body);
  const contents =
    sections.length < 3
      ? ''
      : `<nav class="contents" aria-label="Contents">
<ol>
${sections.map(({ id, text }) => `<li><a href="#${id}">${escape(text)}</a></li>`).join('\n')}
</ol>
</nav>`;
  return page({
    path,
    title: `${unescape(inline(title))} - ${content.name}`,
    twin: twinOf(path),
    body: `<article class="band document">
${contents}
<div class="col">
<h1>${whole(inline(title))}</h1>
${date ? `<time datetime="${date.slice(0, 10)}">${longDate(date)}</time>` : ''}
${lead ? `<p class="lead">${inline(capital(lead))}</p>` : ''}
<div class="prose">
${html}</div>
</div>
</article>`,
  });
}

const missing = page({
  path: '/404',
  title: `No page at this address - ${content.name}`,
  body: `<div class="band document">
<div class="col">
<h1>No page at this address.</h1>
<p class="lead"><a href="/">See what the project has done so far</a></p>
</div>
</div>`,
});

// ---- Output ----

rmSync(out, { recursive: true, force: true });
cpSync(join(here, 'static'), out, { recursive: true });
cpSync(join(here, 'content.json'), join(out, 'content.json'));

const write = (file, html) => {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  writeFileSync(join(out, file), html);
};

write('index.html', frontPage());
write('404.html', missing);
for (const ticket of content.tickets.filter((ticket) => ticket.resolution)) {
  write(
    `${ticket.number}/index.html`,
    documentPage({
      path: `/${ticket.number}/`,
      title: ticket.title,
      lead: ticket.decision ?? '',
      date: ticket.closed,
      body: ticket.resolution,
    }),
  );
}
for (const document of content.documents) {
  write(`${document.path}/index.html`, documentPage({ path: `/${document.path}/`, ...document }));
}

// The same pages as Markdown, and an index of them, for readers that are programs.
const done = content.tickets.filter((ticket) => ticket.resolution);
const listed = (tickets) => tickets.map((ticket) => `- ${ticket.title}`).join('\n');
const linked = (path, title, note) => `- [${title}](${twinOf(path)})${note ? `: ${note}` : ''}`;

for (const ticket of done) {
  write(`${ticket.number}.md`, `# ${ticket.title}\n\n${ticket.decision ?? ''}\n\n${ticket.resolution}\n`);
}
for (const document of content.documents) {
  write(`${document.path}.md`, `# ${document.title}\n\n${document.body}\n`);
}

const index = `# ${content.name}

> ${statement}

As of ${content.refreshed}. Everything here is also in one file, [content.json](/content.json).

## Destination

${content.destination}

## ${content.rule.name}

${capital(content.rule.text)}${register ? ` See [${register.title}](/decisions.md).` : ''}

## Done

${done.map((ticket) => linked(`/${ticket.number}/`, ticket.title, ticket.decision)).join('\n')}

## In progress

${listed(content.tickets.filter((ticket) => ticket.state === 'in progress'))}

## Next

${listed(content.tickets.filter((ticket) => ticket.state === 'next'))}

## Found in Pipeline

${content.pipeline.map(({ finding, from }) => `- ${finding} ([${titles.get(from)}](${twinOf(from)}))`).join('\n')}

## Documents

${content.documents.map((document) => linked(`/${document.path}/`, document.title)).join('\n')}
`;
write('index.md', index);
write('llms.txt', index);

console.log(`dist/: ${titles.size - content.tickets.filter((ticket) => !ticket.resolution).length + 2} pages.`);
