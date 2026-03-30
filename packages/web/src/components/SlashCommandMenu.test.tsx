import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SlashCommandMenu } from "./SlashCommandMenu.js";

describe("SlashCommandMenu", () => {
  beforeEach(() => {
    cleanup();
  });

  it("shows builtin groups when visible with empty query", () => {
    render(
      <div className="relative h-32">
        <SlashCommandMenu query="" visible selectedIndex={0} onSelect={vi.fn()} />
      </div>,
    );
    expect(screen.getByTestId("slash-command-menu")).toBeInTheDocument();
    expect(screen.getByText("/clear")).toBeInTheDocument();
    expect(screen.getByText("CC Pet")).toBeInTheDocument();
  });

  it("renders extra skill commands from bridge", () => {
    render(
      <div className="relative h-32">
        <SlashCommandMenu
          query=""
          visible
          selectedIndex={0}
          onSelect={vi.fn()}
          extraCommands={[{ name: "my-skill", description: "Does thing", category: "skill", type: "send" }]}
        />
      </div>,
    );
    expect(screen.getByText("/my-skill")).toBeInTheDocument();
    expect(screen.getByText("Does thing")).toBeInTheDocument();
  });

  it("returns null when not visible", () => {
    render(
      <SlashCommandMenu query="" visible={false} selectedIndex={0} onSelect={vi.fn()} />,
    );
    expect(screen.queryByTestId("slash-command-menu")).not.toBeInTheDocument();
  });
});
