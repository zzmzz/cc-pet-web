import type { BridgeCard, BridgeCardElement, ChatCard, ChatCardElement } from "@cc-pet/shared";

function normalizeElement(el: BridgeCardElement): ChatCardElement {
  switch (el.type) {
    case "list_item":
      return {
        type: "list_item",
        text: el.text,
        btnText: el.btn_text,
        btnType: el.btn_type,
        btnValue: el.btn_value,
      };
    case "select":
      return {
        type: "select",
        placeholder: el.placeholder,
        options: el.options,
        initValue: el.init_value,
      };
    case "actions":
      return {
        type: "actions",
        layout: el.layout,
        buttons: el.buttons.map((b) => ({
          text: b.text,
          value: b.value,
          btnType: b.btn_type,
        })),
      };
    case "markdown":
    case "divider":
    case "note":
      return el;
  }
}

export function normalizeBridgeCard(card: BridgeCard): ChatCard {
  return {
    header: card.header,
    elements: card.elements.map(normalizeElement),
  };
}
