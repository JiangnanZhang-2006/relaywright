import { PASSWORD_EXACT_SOURCE, PASSWORD_TEXT_SOURCE } from './password-like.js';

/**
 * Page-world extractor. The source is a string so the daemon's compiler cannot
 * rewrite it into a call to __name. `request` is the function argument.
 */
export const EXTRACT_SOURCE = `
var textLike = /${PASSWORD_TEXT_SOURCE}/i;
var exactLike = /${PASSWORD_EXACT_SOURCE}/i;
var limit = request.limit;
var fields = request.fields;
var rows = [];
var truncated = false;

function norm(value) {
  return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
}

function secret(el) {
  if (!el || el.nodeType !== 1) return false;
  var tag = String(el.tagName || '').toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  var type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return true;
  var auto = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (auto.indexOf('password') !== -1) return true;
  var placeholder = el.getAttribute('placeholder') || '';
  var name = (el.getAttribute('name') || '').trim();
  var id = (el.id || '').trim();
  var label = el.getAttribute('aria-label') || '';
  if (textLike.test(placeholder) || textLike.test(label) || textLike.test(name) || textLike.test(id)) return true;
  if (exactLike.test(name) || exactLike.test(id)) return true;
  return false;
}

function readOne(el, attr) {
  if (secret(el)) return ${JSON.stringify('‹redacted›')};
  var kind = attr || 'text';
  if (kind === 'text') return norm(el.textContent || '');
  if (kind === 'value') {
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return norm(el.value);
    return norm(el.getAttribute('value') || '');
  }
  return norm(el.getAttribute(kind) || '');
}

function readField(root, field) {
  var selector = String(field.selector || '').replace(/^\\s+|\\s+$/g, '');
  if (selector === ':scope') {
    var own = readOne(root, field.attr);
    return field.all ? [own] : own;
  }
  var nodes;
  try {
    nodes = root.querySelectorAll(selector);
  } catch (err) {
    throw new Error('Invalid selector: ' + field.selector);
  }
  var values = [];
  for (var i = 0; i < nodes.length; i += 1) values.push(readOne(nodes[i], field.attr));
  if (field.all) return values;
  return values.length ? values[0] : null;
}

function walk(doc, frame, depth) {
  if (truncated || !doc || depth > 4) return;
  var roots;
  try {
    roots = doc.querySelectorAll(request.root_selector);
  } catch (err) {
    throw new Error('Invalid selector: ' + request.root_selector);
  }
  for (var i = 0; i < roots.length; i += 1) {
    if (rows.length >= limit) {
      truncated = true;
      return;
    }
    var row = {};
    if (depth > 0) row.frame = frame;
    var names = Object.keys(fields);
    for (var n = 0; n < names.length; n += 1) row[names[n]] = readField(roots[i], fields[names[n]]);
    rows.push(row);
  }
  if (rows.length >= limit) return;
  var frames = doc.querySelectorAll('iframe,frame');
  for (var f = 0; f < frames.length; f += 1) {
    if (rows.length >= limit) {
      truncated = true;
      return;
    }
    var frameEl = frames[f];
    var child = null;
    var url = '';
    try {
      child = frameEl.contentDocument;
      url = frameEl.contentWindow && frameEl.contentWindow.location ? frameEl.contentWindow.location.href : '';
    } catch (err) {
      continue;
    }
    if (!child) continue;
    walk(child, { name: frameEl.getAttribute('name') || frameEl.id || '', url: url }, depth + 1);
  }
}

walk(document, { name: '', url: location.href }, 0);
return { rows: rows, truncated: truncated };
`;
