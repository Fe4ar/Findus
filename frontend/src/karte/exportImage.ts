import { tr } from "../i18n";
// Map download as SVG (styles inlined, so it looks the same outside Findus) or PNG (rendered via canvas).
const PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "opacity", "font-size", "font-family", "font-weight"];

function standalone(svg: SVGSVGElement) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll("*")];
  const dst = [clone, ...clone.querySelectorAll("*")];
  src.forEach((s, i) => {
    const cs = getComputedStyle(s);
    (dst[i] as SVGElement).setAttribute("style", PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  // HTML inside foreignObject would taint the PNG canvas: text boxes become plain SVG text lines.
  clone.querySelectorAll("foreignObject").forEach((fo) => {
    const x = Number(fo.getAttribute("x")), y = Number(fo.getAttribute("y"));
    const div = fo.firstElementChild as HTMLElement | null;
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("style", `fill:${div?.style.color || getComputedStyle(svg).color};font-size:13px;font-family:${getComputedStyle(svg).fontFamily}`);
    (div?.textContent ?? "").split("\n").forEach((line, i) => {
      const span = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      span.setAttribute("x", String(x + 4));
      span.setAttribute("y", String(y + 15 + i * 16));
      span.textContent = line;
      t.appendChild(span);
    });
    fo.replaceWith(t);
  });
  clone.querySelectorAll(".karte-handle, .karte-slot-hint").forEach((n) => n.remove());
  const [, , w, h] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.removeAttribute("class");
  const bg = getComputedStyle(svg.parentElement!).backgroundColor;
  clone.insertAdjacentHTML("afterbegin", `<rect width="${w}" height="${h}" style="fill:${bg}" />`);
  return { text: new XMLSerializer().serializeToString(clone), w, h };
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const safeName = (title: string) => title.replace(/[\\/:*?"<>|]+/g, "_").trim() || "Karte";

export function exportSvg(svg: SVGSVGElement, title: string) {
  download(new Blob([standalone(svg).text], { type: "image/svg+xml" }), `${safeName(title)}.svg`);
}

export function exportPng(svg: SVGSVGElement, title: string, scale = 2) {
  const { text, w, h } = standalone(svg);
  const img = new Image();
  return new Promise<void>((resolve, reject) => {
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((b) => (b ? (download(b, `${safeName(title)}.png`), resolve()) : reject(new Error("PNG"))), "image/png");
    };
    img.onerror = () => reject(new Error(tr("SVG konnte nicht gerendert werden")));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
  });
}
