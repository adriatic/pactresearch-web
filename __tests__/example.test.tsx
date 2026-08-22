import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";

function Greeting() {
  return <h1>Hello, Vitest</h1>;
}

test("renders a heading", () => {
  render(<Greeting />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Hello, Vitest" }),
  ).toBeDefined();
});
