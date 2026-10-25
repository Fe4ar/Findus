import { EditorContent, useEditor, Editor as TipTap, Node } from "@tiptap/react";
import { Icon, IconName } from "./Icons";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { ask } from "./Dialog";

const lowlight = createLowlight(common);

// Block that embeds a .drawio file node; the page view renders it with DrawioView.
const Drawio = Node.create({
  name: "drawio",
  group: "block",
  atom: true,
  addAttributes() {
    return { file: { default: null, parseHTML: (el) => el.getAttribute("data-drawio"), renderHTML: (a) => ({ "data-drawio": a.file }) } };
  },
  parseHTML() {
    return [{ tag: "div[data-drawio]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", HTMLAttributes];
  },
});

export const extensions = [
  StarterKit.configure({ codeBlock: false }),
  Link.configure({ openOnClick: false, autolink: true }),
  Image,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  CodeBlockLowlight.configure({ lowlight }),
  Drawio,
];

interface Props {
  initial: object | null;
  initialHtml: string;
  onReady: (editor: TipTap) => void;
  onImage?: (file: File) => Promise<string | null>;
  onDiagram?: () => Promise<string | null>;
}

export function Editor({ initial, initialHtml, onReady, onImage, onDiagram }: Props) {
  const editor = useEditor({
    extensions,
    content: initial && Object.keys(initial).length ? initial : initialHtml,
    autofocus: "end",
    onCreate: ({ editor }) => onReady(editor),
  });
  if (!editor) return null;

  const btn = (icon: IconName, title: string, action: () => void, active = false) => (
    <button type="button" title={title} aria-label={title} aria-pressed={active}
      className={active ? "active" : ""} onMouseDown={(e) => e.preventDefault()} onClick={action}>
      <Icon name={icon} />
    </button>
  );
  const c = () => editor.chain().focus();

  return (
    <div className="editor">
      <div className="toolbar" role="toolbar" aria-label="Formatierung">
        {btn("h1", "Überschrift 1", () => c().toggleHeading({ level: 1 }).run(), editor.isActive("heading", { level: 1 }))}
        {btn("h2", "Überschrift 2", () => c().toggleHeading({ level: 2 }).run(), editor.isActive("heading", { level: 2 }))}
        {btn("h3", "Überschrift 3", () => c().toggleHeading({ level: 3 }).run(), editor.isActive("heading", { level: 3 }))}
        <span className="sep" />
        {btn("bold", "Fett", () => c().toggleBold().run(), editor.isActive("bold"))}
        {btn("italic", "Kursiv", () => c().toggleItalic().run(), editor.isActive("italic"))}
        {btn("strike", "Durchgestrichen", () => c().toggleStrike().run(), editor.isActive("strike"))}
        {btn("code", "Code", () => c().toggleCode().run(), editor.isActive("code"))}
        <span className="sep" />
        {btn("bulletList", "Aufzählung", () => c().toggleBulletList().run(), editor.isActive("bulletList"))}
        {btn("orderedList", "Nummerierte Liste", () => c().toggleOrderedList().run(), editor.isActive("orderedList"))}
        {btn("quote", "Zitat", () => c().toggleBlockquote().run(), editor.isActive("blockquote"))}
        {btn("codeBlock", "Codeblock", () => c().toggleCodeBlock().run(), editor.isActive("codeBlock"))}
        <span className="sep" />
        {btn("link", "Link", async () => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const url = await ask({ title: "Link einfügen", label: "Adresse (leer = Link entfernen)", initial: prev ?? "https://" });
          if (url === null) return;
          if (!url.trim()) c().unsetLink().run();
          else c().extendMarkRange("link").setLink({ href: url.trim() }).run();
        }, editor.isActive("link"))}
        {onImage && btn("image", "Bild einfügen", () => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const src = await onImage(file);
            if (src) c().setImage({ src, alt: file.name }).run();
          };
          input.click();
        })}
        {onDiagram && btn("diagram", "Schaubild (draw.io) einfügen", async () => {
          const file = await onDiagram();
          if (file) c().insertContent({ type: "drawio", attrs: { file } }).run();
        })}
        {btn("table", "Tabelle einfügen", () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
        {editor.isActive("table") && (
          <>
            {btn("rowAdd", "Zeile darunter", () => c().addRowAfter().run())}
            {btn("colAdd", "Spalte rechts", () => c().addColumnAfter().run())}
            {btn("rowDelete", "Zeile löschen", () => c().deleteRow().run())}
            {btn("colDelete", "Spalte löschen", () => c().deleteColumn().run())}
            {btn("trash", "Tabelle löschen", () => c().deleteTable().run())}
          </>
        )}
        <span className="sep" />
        {btn("undo", "Rückgängig", () => c().undo().run())}
        {btn("redo", "Wiederholen", () => c().redo().run())}
      </div>
      <EditorContent editor={editor} className="prose editing" />
    </div>
  );
}
