import { describe, it, expect } from "vitest";
import { normalizeBridgeCard } from "./card-normalize.js";
import type { BridgeCard } from "@cc-pet/shared";

describe("normalizeBridgeCard", () => {
  it("converts snake_case list_item fields to camelCase", () => {
    const bridge: BridgeCard = {
      header: { title: "Agent 提问", color: "blue" },
      elements: [
        { type: "markdown", content: "**Q?**" },
        {
          type: "list_item",
          text: "Option A — desc",
          btn_text: "A",
          btn_type: "default",
          btn_value: "askq:0:1",
        },
      ],
    };
    const out = normalizeBridgeCard(bridge);
    expect(out.header).toEqual({ title: "Agent 提问", color: "blue" });
    expect(out.elements[0]).toEqual({ type: "markdown", content: "**Q?**" });
    expect(out.elements[1]).toEqual({
      type: "list_item",
      text: "Option A — desc",
      btnText: "A",
      btnType: "default",
      btnValue: "askq:0:1",
    });
  });

  it("converts select init_value to initValue", () => {
    const bridge: BridgeCard = {
      elements: [
        {
          type: "select",
          placeholder: "Pick one",
          options: [{ text: "A", value: "a" }],
          init_value: "a",
        },
      ],
    };
    const out = normalizeBridgeCard(bridge);
    expect(out.elements[0]).toEqual({
      type: "select",
      placeholder: "Pick one",
      options: [{ text: "A", value: "a" }],
      initValue: "a",
    });
  });

  it("passes through actions/markdown/divider/note unchanged", () => {
    const bridge: BridgeCard = {
      elements: [
        { type: "divider" },
        { type: "note", text: "hint", tag: "tip" },
        {
          type: "actions",
          buttons: [{ text: "Go", value: "go", btn_type: "primary" }],
          layout: "row",
        },
      ],
    };
    const out = normalizeBridgeCard(bridge);
    expect(out.elements[0]).toEqual({ type: "divider" });
    expect(out.elements[1]).toEqual({ type: "note", text: "hint", tag: "tip" });
    expect(out.elements[2]).toEqual({
      type: "actions",
      buttons: [{ text: "Go", value: "go", btnType: "primary" }],
      layout: "row",
    });
  });
});
