// This UI calls the product-search-api lambda directly (no backend proxy) —
// CORS is handled server-side (see response_util.py's Access-Control-Allow-*
// headers), and these are simple GET requests with no custom headers, so
// browsers won't need a CORS preflight.
const API_BASE_URL = 'https://kzzmx63rf9.execute-api.ap-south-1.amazonaws.com';

const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const suggestionsEl = document.getElementById('suggestions');
const resultsEl = document.getElementById('results');
const brandOutletMapEl = document.getElementById('brand-outlet-map');
const serviceTypeEl = document.getElementById('service-type');

let suggestTimer = null;

// Mirrors src/utils/shared/brand_outlet_map.py's decode_brand_outlet_map:
// base64.urlsafe_b64encode(json.dumps(map).encode()) — url-safe alphabet
// (-_ instead of +/), padding kept (the server's urlsafe_b64decode expects it).
function encodeBrandOutletMap(rawJson) {
  const bytes = new TextEncoder().encode(rawJson);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
}

// Throws if brand_outlet_map isn't valid JSON, so callers can surface a
// clear error instead of sending a garbage-encoded value to the API.
function getBaseParams() {
  const rawMap = brandOutletMapEl.value.trim() || '{"b1":"o1"}';
  JSON.parse(rawMap);
  return {
    brand_outlet_map: encodeBrandOutletMap(rawMap),
    service_type: serviceTypeEl.value.trim() || 'DEL101',
    platform: 'web',
    ver: '1.0',
  };
}

async function fetchSuggestions(query) {
  let params;
  try {
    params = new URLSearchParams({ q: query, ...getBaseParams() });
  } catch (e) {
    return [];
  }
  const res = await fetch(`${API_BASE_URL}/suggest?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.suggestions || [];
}

async function fetchSearch(query, context) {
  let params;
  try {
    params = new URLSearchParams({ q: query, ...getBaseParams() });
  } catch (e) {
    return { error: `brand_outlet_map must be valid JSON: ${e.message}` };
  }
  if (context) params.set('context', context);
  const res = await fetch(`${API_BASE_URL}/search?${params}`);
  if (!res.ok) return { error: `Request failed with status ${res.status}` };
  return res.json();
}

function renderSuggestions(items) {
  suggestionsEl.innerHTML = '';
  if (!items.length) { suggestionsEl.classList.remove('visible'); return; }
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    const ctxClass = item.context || '';
    div.innerHTML = `<span class="label">${escapeHtml(item.label)}</span><span class="ctx-badge ${ctxClass}">${escapeHtml(item.type || item.context || '')}</span>`;
    div.addEventListener('click', () => {
      suggestionsEl.classList.remove('visible');
      searchInput.value = item.label;
      doSearch(item.value || item.label, item.context);
    });
    suggestionsEl.appendChild(div);
  });
  suggestionsEl.classList.add('visible');
}

function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// The API wraps matched terms in literal <em>/</em> tags (see query_builder.py's
// highlight config). Swap those for private-use placeholders before escaping the
// rest of the text, so any incidental HTML in the underlying data can't leak
// through as real markup — only our own markers survive, rendered as <mark>.
const HL_OPEN = '';
const HL_CLOSE = '';

function renderHighlightFragment(fragment) {
  const marked = fragment.split('<em>').join(HL_OPEN).split('</em>').join(HL_CLOSE);
  const escaped = escapeHtml(marked);
  return escaped.split(HL_OPEN).join('<mark>').split(HL_CLOSE).join('</mark>');
}

function renderHighlights(highlights) {
  if (!highlights) return '';
  const rows = [];
  for (const [field, list] of Object.entries(highlights)) {
    for (const frag of (list || [])) {
      if (frag && frag.includes('<em>')) {
        rows.push(`<div class="hl-row"><span class="hl-field">${escapeHtml(field)}</span><span>${renderHighlightFragment(frag)}</span></div>`);
      }
    }
  }
  if (!rows.length) return '';
  return `<div class="product-highlight">${rows.join('')}</div>`;
}

function renderResults(data) {
  resultsEl.innerHTML = '';
  if (data.error) {
    resultsEl.innerHTML = `<div class="error-box">${escapeHtml(data.error)}</div>`;
    return;
  }

  const meta = data.meta || {};
  if (meta.code === 204 || meta.message === 'No search results') {
    resultsEl.innerHTML = '<div class="no-results">No search results found</div>';
    return;
  }

  const results = data.results || {};
  const total = data.total || 0;
  const corrected = data.corrected_query;

  let html = '';
  if (corrected) html += `<div class="corrected-query">Showing results for: <strong>${escapeHtml(corrected)}</strong></div>`;
  html += `<div class="result-meta">${total} product${total !== 1 ? 's' : ''} found across ${Object.keys(results).length} brand${Object.keys(results).length !== 1 ? 's' : ''}</div>`;

  for (const [brandId, products] of Object.entries(results)) {
    html += `<div class="brand-group">`;
    html += `<div class="brand-bar"><span class="brand-id">${escapeHtml(brandId)}</span><span class="brand-count">${products.length} product${products.length !== 1 ? 's' : ''}</span></div>`;
    html += `<div class="product-list">`;
    for (const p of products) {
      html += `<div class="product-bar">`;
      const scoreLabel = (p.score !== undefined && p.score !== null) ? `<span class="product-score">${escapeHtml(String(p.score))}</span>` : '';
      html += `<div class="product-bar-main"><span class="product-id">${escapeHtml(p.product_id)}</span><span class="product-label">${escapeHtml(p.product_label || '')}</span>${scoreLabel}</div>`;
      html += renderHighlights(p.highlights);
      html += `</div>`;
    }
    html += `</div></div>`;
  }

  resultsEl.innerHTML = html;
}

async function doSearch(query, context) {
  suggestionsEl.classList.remove('visible');
  resultsEl.innerHTML = '<div class="loading">Searching...</div>';
  const data = await fetchSearch(query, context);
  renderResults(data);
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchBtn.disabled = q.length < 3;

  suggestionsEl.classList.remove('visible');

  if (q.length < 3) return;

  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(async () => {
    const items = await fetchSuggestions(q);
    renderSuggestions(items);
  }, 250);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    suggestionsEl.classList.remove('visible');
    const q = searchInput.value.trim();
    if (q.length >= 3) doSearch(q);
  }
});

searchBtn.addEventListener('click', () => {
  const q = searchInput.value.trim();
  if (q.length >= 3) doSearch(q);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrapper')) {
    suggestionsEl.classList.remove('visible');
  }
});
