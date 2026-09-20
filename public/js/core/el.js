/* =========================================================================
   Building DOM.

   Every view renders through here rather than through innerHTML. Task labels,
   journal text and event titles are all user or model input, and there is no
   case in this app where any of them should be able to introduce markup.

   el('button.chip', { onclick: fn }, 'label') — tag, optional #id and .classes,
   an optional attribute bag, then children (strings become text nodes).
   ========================================================================= */

export function el(spec, attrs, children) {
  var parts = String(spec).split(/(?=[.#])/);
  var node = document.createElement(parts[0] || 'div');

  for (var i = 1; i < parts.length; i++) {
    if (parts[i][0] === '#') node.id = parts[i].slice(1);
    else node.classList.add(parts[i].slice(1));
  }

  if (attrs && (typeof attrs !== 'object' || Array.isArray(attrs) || attrs.nodeType)) {
    children = attrs; attrs = null;
  }

  for (var key in attrs) {
    var value = attrs[key];
    if (value == null || value === false) continue;
    if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'style') node.style.cssText = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }

  append(node, children);
  return node;
}

export function append(node, children) {
  if (children == null || children === false) return node;
  if (Array.isArray(children)) {
    for (var i = 0; i < children.length; i++) append(node, children[i]);
    return node;
  }
  node.appendChild(children.nodeType ? children : document.createTextNode(String(children)));
  return node;
}

/** Replace everything in `host` with `children`. */
export function fill(host, children) {
  if (!host) return host;
  host.textContent = '';
  return append(host, children);
}

/** 'HH:MM' from minutes since midnight. */
export function hhmm(minutes) {
  var m = Math.max(0, Math.round(minutes));
  return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
}

/** 'M:SS' or 'H:MM:SS' from seconds — timers read better without a leading 0. */
export function mmss(seconds) {
  var s = Math.max(0, Math.round(seconds));
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + ('0' + m).slice(-2) : String(m)) + ':' + ('0' + x).slice(-2);
}
