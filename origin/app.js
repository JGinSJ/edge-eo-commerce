/**
 * Pure client-side render. Nothing product-specific exists in index.html —
 * this script fetches the product data and builds the entire page in the DOM,
 * then patches <title>/<meta> and injects JSON-LD structured data.
 *
 * A crawler that does NOT execute JS sees only the loading shell. The headless
 * prerenderer executes this, waits for the network to settle, and captures the
 * fully-populated HTML (incl. structured data) — which is what the edge caches
 * and serves to search/AI crawlers.
 */

const money = (amount, currency) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
};

const stars = (rating) => {
  const full = Math.round(rating);
  return '★★★★★☆☆☆☆☆'.slice(5 - full, 10 - full);
};

function renderGallery(images) {
  const main = el('div', { class: 'gallery-main', style: `background:${images[0].tone}`, role: 'img', 'aria-label': images[0].alt });
  const thumbs = el('div', { class: 'gallery-thumbs' },
    ...images.map((img, i) =>
      el('button', { class: 'thumb' + (i === 0 ? ' is-active' : ''), style: `background:${img.tone}`, 'aria-label': img.alt })
    )
  );
  return el('div', { class: 'gallery' }, main, thumbs);
}

function renderSpecs(specs) {
  const rows = specs.map(([k, v]) =>
    el('tr', {}, el('th', { scope: 'row' }, k), el('td', {}, v))
  );
  return el('section', { class: 'specs', 'aria-labelledby': 'specs-h' },
    el('h2', { id: 'specs-h' }, 'Technical specifications'),
    el('table', {}, el('tbody', {}, ...rows))
  );
}

function renderReviews(p) {
  const items = p.reviews.map((r) =>
    el('li', { class: 'review' },
      el('div', { class: 'review-head' },
        el('span', { class: 'review-stars', 'aria-label': `${r.rating} out of 5` }, stars(r.rating)),
        el('strong', {}, r.title)
      ),
      el('p', {}, r.body),
      el('span', { class: 'review-author' }, r.author)
    )
  );
  return el('section', { class: 'reviews', 'aria-labelledby': 'reviews-h' },
    el('h2', { id: 'reviews-h' }, `Reviews (${p.reviewCount.toLocaleString()})`),
    el('ul', { class: 'review-list' }, ...items)
  );
}

function renderProduct(p) {
  const price = el('div', { class: 'buybox' },
    el('div', { class: 'price' }, money(p.price, p.currency)),
    el('div', { class: 'avail' }, p.availability === 'InStock' ? 'In stock — ships free' : 'Out of stock'),
    el('button', { class: 'add-to-cart', type: 'button' }, 'Add to cart')
  );

  const highlights = el('ul', { class: 'highlights' },
    ...p.highlights.map((h) => el('li', {}, h))
  );

  const summary = el('section', { class: 'summary' },
    el('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      el('a', { href: '/' }, 'Shop'), el('span', {}, '/'),
      el('a', { href: '/' }, p.category), el('span', {}, '/'),
      el('span', { 'aria-current': 'page' }, p.name)
    ),
    el('p', { class: 'eyebrow' }, p.brand),
    el('h1', {}, p.name),
    el('div', { class: 'rating' },
      el('span', { class: 'rating-stars', 'aria-hidden': 'true' }, stars(p.rating)),
      el('span', {}, `${p.rating} · ${p.reviewCount.toLocaleString()} reviews`)
    ),
    el('p', { class: 'lede' }, p.shortDescription),
    highlights,
    price
  );

  return el('article', { class: 'product' },
    el('div', { class: 'product-grid' }, renderGallery(p.images), summary),
    el('section', { class: 'description', 'aria-labelledby': 'desc-h' },
      el('h2', { id: 'desc-h' }, 'Overview'),
      el('p', {}, p.description)
    ),
    renderSpecs(p.specs),
    renderReviews(p)
  );
}

/** SEO/GEO/AEO payload that only exists after JS runs — the reason prerender matters. */
function injectMetadata(p) {
  document.title = `${p.name} — ${money(p.price, p.currency)} | ${p.brand}`;
  document.querySelector('meta[name="description"]')?.setAttribute('content', p.shortDescription);

  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: p.name,
    sku: p.sku,
    brand: { '@type': 'Brand', name: p.brand },
    description: p.shortDescription,
    aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating, reviewCount: p.reviewCount },
    offers: {
      '@type': 'Offer',
      price: p.price,
      priceCurrency: p.currency,
      availability: `https://schema.org/${p.availability}`
    }
  };
  const script = el('script', { type: 'application/ld+json' });
  script.textContent = JSON.stringify(ld);
  document.head.append(script);
}

async function main() {
  const app = document.getElementById('app');
  try {
    // Real client-side data fetch — content is NOT in the initial HTML.
    const res = await fetch('./products.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`products.json ${res.status}`);
    const product = await res.json();

    app.replaceChildren(renderProduct(product));
    app.setAttribute('aria-busy', 'false');
    injectMetadata(product);
    document.documentElement.dataset.rendered = '1'; // a settle signal a prerenderer can wait on
  } catch (err) {
    app.replaceChildren(el('p', { class: 'error' }, 'Sorry — this product could not be loaded.'));
    console.error(err);
  }
}

main();
