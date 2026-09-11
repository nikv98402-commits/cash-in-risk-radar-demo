const SVG_NS = "http://www.w3.org/2000/svg";

function appendChildValue(doc, parent, value) {
  if (value === null || value === undefined || value === false) return;
  if (Array.isArray(value)) {
    value.forEach((item) => appendChildValue(doc, parent, item));
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    parent.append(doc.createTextNode(String(value)));
    return;
  }
  parent.append(value);
}

export function createTextElement(doc, tagName, text = "", options = {}) {
  const node = doc.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.title) node.title = String(options.title);
  if (options.dataset) {
    Object.entries(options.dataset).forEach(([key, value]) => {
      node.dataset[key] = String(value);
    });
  }
  if (options.attributes) {
    Object.entries(options.attributes).forEach(([key, value]) => {
      node.setAttribute(key, String(value));
    });
  }
  node.textContent = String(text ?? "");
  return node;
}

export function createElement(doc, tagName, options = {}, ...children) {
  const node = createTextElement(doc, tagName, "", options);
  children.forEach((child) => appendChildValue(doc, node, child));
  return node;
}

export function createSvgElement(doc, tagName, attributes = {}, text = null) {
  const node = doc.createElementNS(SVG_NS, tagName);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  if (text !== null) node.textContent = String(text);
  return node;
}

export function replaceChildren(target, children = []) {
  target.replaceChildren(...children.filter(Boolean));
  return target;
}

export function createPill(doc, text, tone) {
  return createTextElement(doc, "span", text, { className: `pill ${tone}` });
}

export function createTableCell(doc, content, options = {}) {
  const cell = createElement(doc, "td", options);
  appendChildValue(doc, cell, content);
  return cell;
}

export function appendStack(doc, parent, items) {
  items.filter(Boolean).forEach(({ tag = "span", text = "", className = "", title = "" }) => {
    parent.append(createTextElement(doc, tag, text, { className, title }));
  });
  return parent;
}
