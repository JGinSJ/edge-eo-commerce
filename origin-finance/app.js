/**
 * Pure client-side render. Nothing rate-specific exists in index.html: this
 * script fetches the rate data and builds the entire page in the DOM, then
 * patches <title>/<meta> and injects JSON-LD structured data.
 *
 * A crawler that does NOT execute JS sees only the loading shell, with no rate.
 * The headless prerenderer executes this, waits for the network to settle, and
 * captures the fully-populated HTML (incl. structured data).
 *
 * Every dynamic value is rendered through rateSlot(), which tags its element with
 * data-rate-key="<product>.<field>". Those attributes are the hooks the Harper
 * component uses to swap the value at serve time (dynamic injection), so a rate
 * change does not need a new headless render.
 */

// Page copy (names, blurbs, FAQ) is a static file next to the page.
const CONTENT_URL = './rates.json';

// The numbers come from the Harper rate sheet, through the property's /_harper
// proxy. It is the same row Harper fills the bot view from, so a person and a
// bot read one source of truth. There is deliberately no fallback: if the sheet
// cannot be read the page says so rather than show a rate that may be stale.
//
// Local preview has no /_harper, so on localhost the sample numbers in
// rates.json stand in.
const RATE_SHEET_URL = '/_harper/rate_sheet/national';
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

const pct = (n) => `${Number(n).toFixed(3)}%`;

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
};

/**
 * A dynamic value. `key` is "<product-key>.<field>" (or "asOf"); `format` tells
 * Harper how to print the value when it fills this slot: pct3 | num | datetime.
 */
const rateSlot = (key, format, text, tag = 'span') =>
  el(tag, { 'data-rate-key': key, 'data-rate-format': format }, text);

/** The placeholder Harper swaps for the current value (see rate-templates below). */
const rateToken = (key, format) => `%%RATE:${key}:${format}%%`;

const asOfText = (iso) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
  }).format(new Date(iso));

function renderRateCard(p, asOf) {
  return el('aside', { class: 'ratecard', 'aria-label': `Today's ${p.name} rate` },
    el('p', { class: 'ratecard-label' }, `Today's ${p.name} rate`),
    el('div', { class: 'ratecard-rate' }, rateSlot(`${p.key}.rate`, 'pct3', pct(p.rate))),
    el('div', { class: 'ratecard-apr' }, rateSlot(`${p.key}.apr`, 'pct3', pct(p.apr)), ' APR'),
    el('p', { class: 'ratecard-meta' }, rateSlot(`${p.key}.points`, 'num', String(p.points)), ' points · ', p.term),
    el('p', { class: 'ratecard-asof' }, 'Effective ', rateSlot('asOf', 'datetime', asOfText(asOf), 'time')),
    el('button', { class: 'cta', type: 'button' }, 'Start your application')
  );
}

function renderRateTable(data) {
  const rows = data.products.map((p) =>
    el('tr', {},
      el('th', { scope: 'row' }, p.name),
      el('td', {}, rateSlot(`${p.key}.rate`, 'pct3', pct(p.rate))),
      el('td', {}, rateSlot(`${p.key}.apr`, 'pct3', pct(p.apr))),
      el('td', {}, rateSlot(`${p.key}.points`, 'num', String(p.points)))
    )
  );
  return el('section', { class: 'rates', 'aria-labelledby': 'rates-h' },
    el('h2', { id: 'rates-h' }, "Today's mortgage rates"),
    el('p', { class: 'asof' }, 'Rates effective ', rateSlot('asOf', 'datetime', asOfText(data.asOf), 'time'), '.'),
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Product'),
        el('th', { scope: 'col' }, 'Rate'),
        el('th', { scope: 'col' }, 'APR'),
        el('th', { scope: 'col' }, 'Points')
      )),
      el('tbody', {}, ...rows)
    ),
    el('p', { class: 'fineprint' }, data.assumptions)
  );
}

function renderProducts(data) {
  return el('section', { class: 'products', 'aria-labelledby': 'products-h' },
    el('h2', { id: 'products-h' }, 'Compare loan options'),
    el('ul', { class: 'product-list' },
      ...data.products.map((p) =>
        el('li', { class: 'product-item' }, el('strong', {}, p.name), el('p', {}, p.blurb))
      )
    )
  );
}

function renderFaq(faq) {
  return el('section', { class: 'faq', 'aria-labelledby': 'faq-h' },
    el('h2', { id: 'faq-h' }, 'Common questions'),
    ...faq.map((f) => el('div', { class: 'faq-item' }, el('h3', {}, f.q), el('p', {}, f.a)))
  );
}

function renderPage(data, featured) {
  const summary = el('section', { class: 'summary' },
    el('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      el('a', { href: './index.html' }, 'Home loans'), el('span', {}, '/'),
      el('a', { href: './index.html' }, 'Mortgage rates'), el('span', {}, '/'),
      el('span', { 'aria-current': 'page' }, featured.name)
    ),
    el('p', { class: 'eyebrow' }, 'Larkspur Bank Home Loans'),
    el('h1', {}, data.page.headline),
    el('p', { class: 'lede' }, data.page.lede),
    el('ul', { class: 'highlights' }, ...data.page.highlights.map((h) => el('li', {}, h)))
  );

  return el('article', { class: 'ratepage' },
    el('div', { class: 'rate-grid' }, summary, renderRateCard(featured, data.asOf)),
    renderRateTable(data),
    renderProducts(data),
    renderFaq(data.page.faq)
  );
}

/**
 * The three places a rate appears outside a slot: <title>, the meta description
 * and the JSON-LD. `v` supplies the rate values, so the same builder produces
 * both what a person gets (real values) and the tokenized templates for Harper.
 */
function buildMetadata(data, featured, v) {
  return {
    title: `${data.page.headline}: ${v.rate} (${v.apr} APR) | Larkspur Bank`,
    description: `Today's ${featured.name} mortgage rate at Larkspur Bank is ${v.rate} (${v.apr} APR). ${data.page.lede}`,
    jsonld: [
      {
        '@context': 'https://schema.org/',
        '@type': 'MortgageLoan',
        name: `${featured.name} Mortgage`,
        description: featured.blurb,
        provider: { '@type': 'BankOrCreditUnion', name: 'Larkspur Bank' },
        loanTerm: { '@type': 'QuantitativeValue', value: 30, unitCode: 'ANN' },
        interestRate: v.rateNumber,
        annualPercentageRate: v.aprNumber,
        dateModified: v.asOf,
      },
      {
        '@context': 'https://schema.org/',
        '@type': 'FAQPage',
        mainEntity: data.page.faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };
}

/** SEO/GEO/AEO payload that only exists after JS runs. It carries the rate too. */
function injectMetadata(data, featured) {
  const live = buildMetadata(data, featured, {
    rate: pct(featured.rate), apr: pct(featured.apr),
    rateNumber: featured.rate, aprNumber: featured.apr, asOf: data.asOf,
  });
  document.title = live.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', live.description);
  const ld = el('script', { type: 'application/ld+json' });
  ld.textContent = JSON.stringify(live.jsonld);
  document.head.append(ld);

  // The same three, with tokens where the rates go. Harper swaps these in when it
  // stores the prerender, then removes this block. A JSON number is written as a
  // quoted ":json" token; Harper replaces the token together with its quotes.
  const k = featured.key;
  const templates = buildMetadata(data, featured, {
    rate: rateToken(`${k}.rate`, 'pct3'), apr: rateToken(`${k}.apr`, 'pct3'),
    rateNumber: rateToken(`${k}.rate`, 'json'), aprNumber: rateToken(`${k}.apr`, 'json'),
    asOf: rateToken('asOf', 'iso'),
  });
  const tpl = el('script', { type: 'application/json', id: 'rate-templates' });
  tpl.textContent = JSON.stringify(templates);
  document.head.append(tpl);
}

/** Fetch JSON without letting any cache answer. */
async function getJson(url, what) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${what} ${res.status}`);
  return res.json();
}

/** Page copy + current numbers. Every product must have its numbers, or we fail. */
async function loadData() {
  const content = await getJson(CONTENT_URL, 'content');
  if (IS_LOCAL) return content; // sample numbers from rates.json
  const sheet = await getJson(RATE_SHEET_URL, 'rate sheet');
  const byKey = new Map((sheet.products || []).map((p) => [p.key, p]));
  const products = content.products.map((p) => {
    const n = byKey.get(p.key);
    if (!n || ![n.rate, n.apr, n.points].every(Number.isFinite)) throw new Error(`no rates for ${p.key}`);
    return { ...p, rate: n.rate, apr: n.apr, points: n.points };
  });
  if (!sheet.asOf) throw new Error('rate sheet has no asOf');
  return { ...content, asOf: sheet.asOf, products };
}

async function main() {
  const app = document.getElementById('app');
  try {
    // Real client-side data fetch: the rate is NOT in the initial HTML.
    const data = await loadData();
    const featured = data.products.find((p) => p.key === data.featured) || data.products[0];

    app.replaceChildren(renderPage(data, featured));
    app.setAttribute('aria-busy', 'false');
    injectMetadata(data, featured);
    document.documentElement.dataset.rendered = '1'; // a settle signal a prerenderer can wait on
  } catch (err) {
    app.replaceChildren(el('p', { class: 'error' }, 'Sorry, current rates could not be loaded.'));
    console.error(err);
  }
}

main();
