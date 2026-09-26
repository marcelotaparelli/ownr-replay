import type { ToolReference } from "../src/domain/stage.ts";
import { h } from "./dom.ts";
import { highlightLines } from "./highlight.ts";

/** Vocabulary for the exercise — never the solution. One item open at a time. */
export function renderToolbox(root: HTMLElement, tools: ToolReference[], askTutor: (question: string) => void): void {
  const list = h("ul", { class: "tools" });
  for (const tool of tools) {
    const detail = h(
      "div",
      { class: "tool-detail", hidden: true },
      tool.signature ? h("code", { class: "sig" }, tool.signature) : null,
      h("p", {}, tool.summary),
      h("pre", { class: "snippet", html: highlightLines(tool.example).join("\n") }),
      tool.whenToUse ? h("p", { class: "muted" }, h("strong", {}, "Quando usar: "), tool.whenToUse) : null,
      tool.complexity ? h("p", { class: "muted" }, h("strong", {}, "Complexidade: "), tool.complexity) : null,
      h("button", { type: "button", class: "link", onclick: () => askTutor(`Como ${tool.name} pode me ajudar nesta etapa?`) }, "Perguntar ao tutor →"),
    );
    const toggle = h("button", { type: "button", class: "tool-name", "aria-expanded": "false" }, h("code", {}, tool.name), h("span", { class: "muted" }, tool.summary));
    toggle.addEventListener("click", () => {
      const open = detail.hidden;
      for (const other of list.querySelectorAll<HTMLElement>(".tool-detail")) other.hidden = true;
      for (const other of list.querySelectorAll(".tool-name")) other.setAttribute("aria-expanded", "false");
      detail.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    });
    list.append(h("li", {}, toggle, detail));
  }
  root.replaceChildren(h("div", { class: "panel-head" }, h("h2", {}, "Toolbox"), h("span", { class: "muted" }, `${tools.length} ferramentas`)), list);
}
