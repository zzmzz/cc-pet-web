import { describe, expect, it, beforeEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CardMarkdown } from "./CardMarkdown.js";

describe("CardMarkdown", () => {
  beforeEach(cleanup);

  it("turns single line breaks into <br>", () => {
    const { container } = render(<CardMarkdown content={"第一行\n第二行"} />);
    expect(container.querySelectorAll("br").length).toBe(1);
  });

  it("leaves fenced code blocks untouched", () => {
    const { container } = render(<CardMarkdown content={"```ts\nconst a = 1;\nconst b = 2;\n```"} />);
    expect(container.querySelector("code")?.textContent).toBe("const a = 1;\nconst b = 2;\n");
    expect(container.querySelectorAll("br").length).toBe(0);
  });

  it("does not pre-wrap, which would double every <br>", () => {
    const { container } = render(<CardMarkdown content={"第一行\n第二行"} />);
    expect(container.firstElementChild?.className).not.toContain("whitespace-pre");
  });
});
