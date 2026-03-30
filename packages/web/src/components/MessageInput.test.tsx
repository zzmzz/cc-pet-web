import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { MessageInput } from "./MessageInput.js";

afterEach(() => {
  cleanup();
});

function renderInput(onSend = vi.fn()) {
  render(
    <MessageInput
      value="hello"
      onChange={() => {}}
      onSend={onSend}
    />,
  );
  return {
    input: screen.getByPlaceholderText("输入消息，Enter 发送，Shift+Enter 换行"),
    onSend,
  };
}

describe("MessageInput", () => {
  it("sends on Enter when not composing", () => {
    const { input, onSend } = renderInput();
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does not send on Enter when native event is composing", () => {
    const { input, onSend } = renderInput();
    const event = createEvent.keyDown(input, { key: "Enter", code: "Enter" });
    Object.defineProperty(event, "isComposing", {
      value: true,
      configurable: true,
    });
    fireEvent(input, event);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send on Enter when keyCode is 229", () => {
    const { input, onSend } = renderInput();
    const event = createEvent.keyDown(input, { key: "Enter", code: "Enter" });
    Object.defineProperty(event, "keyCode", {
      value: 229,
      configurable: true,
    });
    fireEvent(input, event);
    expect(onSend).not.toHaveBeenCalled();
  });
});
